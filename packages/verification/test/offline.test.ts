import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  computeCommitmentDigest,
  computeE0Digest,
  computeEvidenceDigest,
  sha256Hex,
  utf8Bytes,
  type AuthorizedIncrement,
  type EvidenceE0,
} from '@usagepay/contracts';
import {
  TEST_ONLY_METER_KEY,
  TEST_ONLY_UNTRUSTED_METER_KEY,
  buildGoldenSession,
  buildSignedReading,
  duplicateReadingE0,
  reorderedSequenceE0,
  reusedNonceE0,
  tamperedReading,
  untrustedKeyReading,
} from '@usagepay/fixtures';
import { CHECK_IDS, createVerifier, type VerificationReport, type VerifierTrust } from '../src/index.js';
import { e0With, e1For, golden, goldenTrust, mutateIncrement, offlineEncoding, resignedCommitment } from './helpers.js';

/** Offline verifier (no chain reader): V01-V07 can pass, V08 and the overall verdict can never be PASS. */
async function verifyOffline(e0: unknown, e1: unknown = e1For(e0 as EvidenceE0), trust: VerifierTrust = goldenTrust()): Promise<VerificationReport> {
  return createVerifier({ trust, encoding: offlineEncoding }).verify({ e0, e1 });
}

const statuses = (report: VerificationReport) => Object.fromEntries(CHECK_IDS.map((id) => [id, report.checks[id].status]));
const OFFLINE_CHECKS = CHECK_IDS.filter((id) => id !== 'V08_CHAIN');

describe('S1-C: genuine golden session', () => {
  it('passes V01-V07, replays 1000000/2000000/3000000 and is NOT_AVAILABLE overall without a chain proof', async () => {
    const report = await verifyOffline(golden.e0);
    for (const id of OFFLINE_CHECKS) expect(report.checks[id], id).toMatchObject({ status: 'PASS' });
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'CHAIN_NOT_QUERIED' });
    expect(report.overall).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'CHAIN_NOT_QUERIED' });
    expect(report.subject).toEqual({
      sessionId: 'ev-session-001',
      e0Digest: computeE0Digest(golden.e0),
      closeTxHash: e1For(golden.e0).closeTxHash,
      increments: [
        { readingId: 'r-001', cumulativeWh: '250', cumulativeChargeBaseUnits: '1000000' },
        { readingId: 'r-002', cumulativeWh: '500', cumulativeChargeBaseUnits: '2000000' },
        { readingId: 'r-003', cumulativeWh: '750', cumulativeChargeBaseUnits: '3000000' },
      ],
    });
  });

  it('labels the meter as simulated even when its signature is valid', async () => {
    const report = await verifyOffline(golden.e0);
    expect(report.checks.V02_METER.details).toMatch(/certification: simulated/);
  });

  it('is reproducible: the same artifacts give the same report', async () => {
    expect(await verifyOffline(golden.e0)).toEqual(await verifyOffline(golden.e0));
  });
});

describe('F1-C: meter source bytes', () => {
  it('one modified source byte under the original signature fails V02 and the overall verdict', async () => {
    const e0 = e0With(golden.increments.map((inc, i) => (i === 1 ? { ...inc, reading: tamperedReading(golden) } : inc)));
    const report = await verifyOffline(e0);
    expect(report.checks.V02_METER).toMatchObject({ status: 'FAIL', reasonCode: 'INVALID_METER_SIGNATURE' });
    expect(report.checks.V02_METER.details).toMatch(/r-002/);
    expect(report.overall.status).toBe('FAIL');
  });

  it('a stored "verified: true" flag cannot rescue tampered evidence', async () => {
    const e0 = e0With(golden.increments.map((inc, i) => (i === 1 ? { ...inc, reading: tamperedReading(golden) } : inc)));
    const flagged = { ...e0, verified: true, increments: e0.increments.map((inc) => ({ ...inc, verified: true })) };
    const report = await verifyOffline(flagged, e1For(e0));
    expect(report.checks.V01_SCHEMA).toMatchObject({ status: 'FAIL', reasonCode: 'INVALID_SCHEMA' });
    expect(report.overall.status).toBe('FAIL');
  });

  it('a reading validly signed by an unpinned key claiming the pinned key ID fails V02', async () => {
    const e0 = e0With(golden.increments.map((inc, i) => (i === 1 ? { ...inc, reading: untrustedKeyReading(golden) } : inc)));
    expect((await verifyOffline(e0)).checks.V02_METER).toMatchObject({ status: 'FAIL', reasonCode: 'INVALID_METER_SIGNATURE' });
  });

  it('an unknown signer key ID fails V02 with UNKNOWN_METER_KEY', async () => {
    const trust = goldenTrust({ meterKeys: new Map([['other-meter', TEST_ONLY_UNTRUSTED_METER_KEY.publicKey]]) });
    expect((await verifyOffline(golden.e0, undefined, trust)).checks.V02_METER).toMatchObject({ status: 'FAIL', reasonCode: 'UNKNOWN_METER_KEY' });
  });

  it('an envelope field that differs from the signed bytes fails V02 with SIGNED_PAYLOAD_MISMATCH', async () => {
    const e0 = mutateIncrement(1, (inc) => ({ ...inc, reading: { ...inc.reading, machineId: 'other-charger' } }));
    expect((await verifyOffline(e0)).checks.V02_METER).toMatchObject({ status: 'FAIL', reasonCode: 'SIGNED_PAYLOAD_MISMATCH' });
  });
});

describe('F3-C: replay, order and continuity', () => {
  it.each([
    ['duplicate reading ID', () => duplicateReadingE0(golden)],
    ['reused ack nonce', () => reusedNonceE0(golden)],
    ['reordered increments', () => reorderedSequenceE0(golden)],
  ])('%s fails V01 and never reaches a verdict from the last balance', async (_name, build) => {
    const e0 = build();
    const report = await verifyOffline(e0, e1For(golden.e0));
    expect(report.checks.V01_SCHEMA).toMatchObject({ status: 'FAIL', reasonCode: 'INVALID_SCHEMA' });
    for (const id of CHECK_IDS.filter((c) => c !== 'V01_SCHEMA')) {
      expect(report.checks[id], id).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'PRECONDITION_FAILED' });
    }
    expect(report.overall.status).toBe('FAIL');
  });

  it('a counter gap between signed readings fails V02 with COUNTER_DISCONTINUITY', async () => {
    // r-003 dropped: r-002 -> (old r-003 renumbered 2) leaves the signed counter and interval discontinuous.
    const [first, , third] = golden.increments as [AuthorizedIncrement, AuthorizedIncrement, AuthorizedIncrement];
    const report = await verifyOffline(e0With([first, { ...third, sequence: 2 }]));
    expect(report.checks.V02_METER).toMatchObject({ status: 'FAIL', reasonCode: 'COUNTER_DISCONTINUITY' });
    expect(report.overall.status).toBe('FAIL');
  });

  it('a validly signed reading whose interval leaves a gap (counters contiguous) fails V02', async () => {
    const payload = { ...golden.payloads[1]!, intervalStart: '2026-10-25T09:01:30.000Z' };
    const reading = buildSignedReading(payload, golden.readings[1]!.coverage, golden.inputs.meter.signerKeyId, TEST_ONLY_METER_KEY);
    const e0 = e0With(golden.increments.map((inc, i) => (i === 1 ? { ...inc, reading } : inc)));
    const report = await verifyOffline(e0);
    expect(report.checks.V02_METER).toMatchObject({ status: 'FAIL', reasonCode: 'COUNTER_DISCONTINUITY' });
    expect(report.checks.V02_METER.details).toMatch(/r-002: interval starts at 2026-10-25T09:01:30.000Z/);
  });

  it('an increment after a terminal_signed reading fails V02', async () => {
    const [first, second, third] = golden.increments as [AuthorizedIncrement, AuthorizedIncrement, AuthorizedIncrement];
    const e0 = e0With([first, { ...second, reading: { ...second.reading, coverage: 'terminal_signed' } }, third]);
    expect((await verifyOffline(e0)).checks.V02_METER).toMatchObject({ status: 'FAIL', reasonCode: 'COUNTER_DISCONTINUITY' });
  });
});

describe('F4-C: evidence mutated after payer signing', () => {
  const otherDigest = sha256Hex(utf8Bytes('usagepay.test.substituted'));

  it('a substituted evidenceDigest fails V04 and V06 while the native MPP signature stays genuine', async () => {
    const e0 = e0With(golden.increments.map((inc, i) => (i === 1 ? { ...inc, charge: { ...inc.charge, evidenceDigest: otherDigest } } : inc)));
    const report = await verifyOffline(e0);
    expect(report.checks.V04_EVIDENCE).toMatchObject({ status: 'FAIL', reasonCode: 'EVIDENCE_DIGEST_MISMATCH' });
    expect(report.checks.V05_MPP.status).toBe('PASS');
    expect(report.checks.V06_PAYER_ACK).toMatchObject({ status: 'FAIL', reasonCode: 'PAYER_ACK_INVALID' });
    expect(report.overall.status).toBe('FAIL');
  });

  it('an ack field changed after signing fails V06 (signature no longer covers it)', async () => {
    const e0 = e0With(golden.increments.map((inc, i) => (i === 1 ? { ...inc, payerAck: { ...inc.payerAck, evidenceDigest: otherDigest } } : inc)));
    const report = await verifyOffline(e0);
    expect(report.checks.V06_PAYER_ACK).toMatchObject({ status: 'FAIL', reasonCode: 'PAYER_ACK_INVALID' });
    expect(report.checks.V06_PAYER_ACK.details).toMatch(/signature/);
  });

  it('a validly re-signed ack bound to the previous evidence fails V06', async () => {
    const e0 = mutateIncrement(1, (inc) => inc, { evidenceDigest: golden.charges[0]!.evidenceDigest });
    expect((await verifyOffline(e0)).checks.V06_PAYER_ACK).toMatchObject({ status: 'FAIL', reasonCode: 'PAYER_ACK_INVALID' });
  });

  it('a modified price fails V03 (pinned tariff digest)', async () => {
    const e0 = { ...golden.e0, tariff: { ...golden.e0.tariff, pricePerKwhBaseUnits: '5000000' } };
    const report = await verifyOffline(e0);
    expect(report.checks.V03_TARIFF).toMatchObject({ status: 'FAIL', reasonCode: 'TARIFF_DIGEST_MISMATCH' });
    expect(report.overall.status).toBe('FAIL');
  });

  it('rounding drift in an approved cumulative fails V03 with CHARGE_REPLAY_MISMATCH', async () => {
    const e0 = mutateIncrement(1, (inc) => ({ ...inc, charge: { ...inc.charge, cumulativeChargeBaseUnits: '2000001' } }));
    expect((await verifyOffline(e0)).checks.V03_TARIFF).toMatchObject({ status: 'FAIL', reasonCode: 'CHARGE_REPLAY_MISMATCH' });
  });

  it('an approved cumulative above the pinned budget cap fails V03 with BUDGET_EXCEEDED (AC13)', async () => {
    const report = await verifyOffline(golden.e0, undefined, goldenTrust({ budgetCapBaseUnits: '2500000' }));
    expect(report.checks.V03_TARIFF).toMatchObject({ status: 'FAIL', reasonCode: 'BUDGET_EXCEEDED' });
  });

  it('an asset other than the pinned SAC fails V03 with ASSET_MISMATCH', async () => {
    const report = await verifyOffline(golden.e0, undefined, goldenTrust({ assetSac: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' }));
    expect(report.checks.V03_TARIFF).toMatchObject({ status: 'FAIL', reasonCode: 'ASSET_MISMATCH' });
  });

  it('a consistently signed session under a tariff that is not yet active fails V03 with TARIFF_NOT_ACTIVE', async () => {
    const inputs = structuredClone(golden.inputs);
    inputs.tariff.validFrom = '2026-10-25T09:01:30.000Z';
    const session = buildGoldenSession(inputs);
    const report = await verifyOffline(session.e0, e1For(session.e0), goldenTrust({ tariffVersionDigest: session.tariff.versionDigest }));
    expect(report.checks.V03_TARIFF).toMatchObject({ status: 'FAIL', reasonCode: 'TARIFF_NOT_ACTIVE' });
    expect(report.checks.V03_TARIFF.details).toMatch(/r-001/);
  });

  it('a session other than the pinned one fails V04 with SESSION_MISMATCH', async () => {
    const report = await verifyOffline(golden.e0, undefined, goldenTrust({ sessionId: 'ev-session-999' }));
    expect(report.checks.V04_EVIDENCE).toMatchObject({ status: 'FAIL', reasonCode: 'SESSION_MISMATCH' });
  });

  it('a recomputed readingDigest mismatch fails V04', async () => {
    const e0 = mutateIncrement(0, (inc) => ({ ...inc, charge: { ...inc.charge, readingDigest: otherDigest } }));
    expect((await verifyOffline(e0)).checks.V04_EVIDENCE).toMatchObject({ status: 'FAIL', reasonCode: 'EVIDENCE_DIGEST_MISMATCH' });
  });

  it('an approved cumulative that does not exceed the previous one fails V04 with NON_MONOTONIC_CUMULATIVE', async () => {
    // r-002 restates r-001's cumulative 1000000 with a consistently recomputed evidence digest.
    const e0 = mutateIncrement(1, (inc) => {
      const { schema: _schema, evidenceDigest: _digest, ...preimage } = { ...inc.charge, cumulativeChargeBaseUnits: '1000000', deltaChargeBaseUnits: '0' };
      return { ...inc, charge: { ...inc.charge, ...preimage, evidenceDigest: computeEvidenceDigest(preimage) } };
    });
    const report = await verifyOffline(e0);
    expect(report.checks.V04_EVIDENCE).toMatchObject({ status: 'FAIL', reasonCode: 'NON_MONOTONIC_CUMULATIVE' });
    expect(report.overall.status).toBe('FAIL');
  });

  it('an unpinned channel fails V05, V06 and V07 even with every signature valid', async () => {
    const other = goldenTrust({ channelId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' });
    const report = await verifyOffline(golden.e0, undefined, other);
    expect(report.checks.V05_MPP).toMatchObject({ status: 'FAIL', reasonCode: 'NATIVE_COMMITMENT_INVALID' });
    expect(report.checks.V06_PAYER_ACK).toMatchObject({ status: 'FAIL', reasonCode: 'PAYER_ACK_INVALID' });
    expect(report.checks.V07_E0_E1_LINK).toMatchObject({ status: 'FAIL', reasonCode: 'CHAIN_MISMATCH' });
  });

  it('a network other than stellar:testnet is a schema failure', async () => {
    const e0 = mutateIncrement(1, (inc) => ({ ...inc, commitment: { ...inc.commitment, network: 'stellar:pubnet' as 'stellar:testnet' } }));
    expect((await verifyOffline(e0)).checks.V01_SCHEMA).toMatchObject({ status: 'FAIL', reasonCode: 'INVALID_SCHEMA' });
  });
});

describe('F4-D: native MPP commitment', () => {
  it('a signed message for a different amount fails V05 with NATIVE_COMMITMENT_INVALID', async () => {
    const e0 = mutateIncrement(1, (inc) => ({ ...inc, commitment: resignedCommitment(inc.commitment.channelId, '2500000') }), {});
    const report = await verifyOffline(e0);
    expect(report.checks.V05_MPP).toMatchObject({ status: 'FAIL', reasonCode: 'NATIVE_COMMITMENT_INVALID' });
    expect(report.overall.status).toBe('FAIL');
  });

  it('a signed message for a different channel fails V05', async () => {
    const other = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const e0 = mutateIncrement(1, (inc) => {
      const commitment = resignedCommitment(other, inc.commitment.cumulativeAmountBaseUnits);
      return { ...inc, commitment: { ...commitment, channelId: inc.commitment.channelId } };
    });
    expect((await verifyOffline(e0)).checks.V05_MPP).toMatchObject({ status: 'FAIL', reasonCode: 'NATIVE_COMMITMENT_INVALID' });
  });

  it('a replaced signature fails V05', async () => {
    const e0 = mutateIncrement(2, (inc) => {
      const signature = base64ToBytes(inc.commitment.signatureB64);
      signature[0] = (signature[0] ?? 0) ^ 0xff;
      return { ...inc, commitment: { ...inc.commitment, signatureB64: bytesToBase64(signature) } };
    });
    const report = await verifyOffline(e0);
    expect(report.checks.V05_MPP).toMatchObject({ status: 'FAIL', reasonCode: 'NATIVE_COMMITMENT_INVALID' });
    expect(report.checks.V05_MPP.details).toMatch(/r-003/);
  });

  it('a signature by another key over the correct message (digest recomputed) fails V05 on the signature alone', async () => {
    const e0 = mutateIncrement(2, (inc) => {
      const signatureB64 = bytesToBase64(TEST_ONLY_UNTRUSTED_METER_KEY.sign(base64ToBytes(inc.commitment.signedMessageB64)));
      const commitment = { ...inc.commitment, signatureB64, commitmentDigest: computeCommitmentDigest({ signedMessageB64: inc.commitment.signedMessageB64, signatureB64 }) };
      return { ...inc, commitment };
    });
    const report = await verifyOffline(e0);
    expect(report.checks.V05_MPP).toMatchObject({ status: 'FAIL', reasonCode: 'NATIVE_COMMITMENT_INVALID' });
    expect(report.checks.V05_MPP.details).toBe('r-003: native signature does not verify under the pinned commitment key');
  });

  it('a commitment key other than the pinned key fails V05 and V06', async () => {
    const report = await verifyOffline(golden.e0, undefined, goldenTrust({ commitmentKey: 'GB6XZYHIGRQPG7L7CHZYFM3HFHKSJNBDXQZ5W5ZCDG5QEM32EEBAPOJC' }));
    expect(report.checks.V05_MPP.status).toBe('FAIL');
    expect(report.checks.V06_PAYER_ACK.status).toBe('FAIL');
  });

  it('the offline fixture commitment is rejected by the pinned XDR encoding (it is not a real MPP commitment)', async () => {
    const report = await createVerifier({ trust: goldenTrust() }).verify({ e0: golden.e0, e1: e1For(golden.e0) });
    expect(report.checks.V05_MPP).toMatchObject({ status: 'FAIL', reasonCode: 'NATIVE_COMMITMENT_INVALID' });
  });
});

describe('V07: E0 <-> E1 link', () => {
  it('an E1 that references another E0 digest fails V07', async () => {
    const report = await verifyOffline(golden.e0, e1For(golden.e0, { e0Digest: sha256Hex(utf8Bytes('other e0')) }));
    expect(report.checks.V07_E0_E1_LINK).toMatchObject({ status: 'FAIL', reasonCode: 'E0_DIGEST_MISMATCH' });
  });

  it('an E1 for another asset fails V07 with CHAIN_MISMATCH', async () => {
    const report = await verifyOffline(golden.e0, e1For(golden.e0, { assetSac: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' }));
    expect(report.checks.V07_E0_E1_LINK).toMatchObject({ status: 'FAIL', reasonCode: 'CHAIN_MISMATCH' });
  });

  it('a malformed E1 fails V01 but every E0-only check is still reported', async () => {
    const report = await verifyOffline(golden.e0, { ...e1For(golden.e0), network: 'stellar:pubnet' });
    expect(statuses(report)).toEqual({
      V01_SCHEMA: 'FAIL',
      V02_METER: 'PASS',
      V03_TARIFF: 'PASS',
      V04_EVIDENCE: 'PASS',
      V05_MPP: 'PASS',
      V06_PAYER_ACK: 'PASS',
      V07_E0_E1_LINK: 'NOT_AVAILABLE',
      V08_CHAIN: 'NOT_AVAILABLE',
    });
    expect(report.overall.status).toBe('FAIL');
  });

  it('missing inputs are a schema failure, never an exception', async () => {
    const report = await verifyOffline(undefined, null);
    expect(report.checks.V01_SCHEMA).toMatchObject({ status: 'FAIL', reasonCode: 'INVALID_SCHEMA' });
    expect(report.overall.status).toBe('FAIL');
  });
});
