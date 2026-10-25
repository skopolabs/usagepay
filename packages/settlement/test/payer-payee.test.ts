import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorizedIncrementSchema,
  EvidenceE0Schema,
  accountIdToPublicKey,
  base64ToBytes,
  verifyEd25519,
  type MeasurementCharge,
  type MeterReading,
} from '@usagepay/contracts';
import { TEST_ONLY_METER_KEY, TRUSTED_METER_KEYS, loadGoldenInputs, tamperedReading } from '@usagepay/fixtures';
import { createMeteringSession, createSimulatedCharger } from '@usagepay/metering';
import { xdrCommitmentEncoding } from '../src/index.js';
import { cumulativeOf, golden, goldenEvidence, harness, randomContractId, rewriteChallenge, sessionId } from './helpers.js';

const [ev1, ev2, ev3] = goldenEvidence as [(typeof goldenEvidence)[0], (typeof goldenEvidence)[0], (typeof goldenEvidence)[0]];
const input = (evidence: { reading: MeterReading; charge: MeasurementCharge }, channelId: string) => ({ ...evidence, tariff: golden.tariff, channelId });

let restore: (() => void) | undefined;
afterEach(() => restore?.());
function setup(options?: Parameters<typeof harness>[0]) {
  const h = harness(options);
  restore = h.chain.restore;
  return h;
}

describe('SPEC 01 -> SPEC 02 integration with the real @stellar/mpp client and server (offline fake chain)', () => {
  it('S1-B: signed meter events become three accepted native cumulative commitments and an immutable E0', async () => {
    const h = setup();
    // SPEC 01 produces the evidence the payee serves and the payer independently re-checks.
    const inputs = loadGoldenInputs();
    const charger = createSimulatedCharger({
      sessionId,
      machineId: inputs.session.machineId,
      startedAt: inputs.session.startedAt,
      meterStartWh: inputs.session.meterStartWh,
      signer: { keyId: inputs.meter.signerKeyId, sign: (bytes) => TEST_ONLY_METER_KEY.sign(bytes) },
    });
    const metering = createMeteringSession({
      machineId: inputs.session.machineId,
      expectedAssetSac: golden.tariff.assetSac,
      trustedMeterKeys: TRUSTED_METER_KEYS,
      currentTariff: () => golden.tariff,
    });
    await metering.apply(charger.started());
    const results = [];
    for (const [index, interval] of inputs.intervals.entries()) {
      const outcome = await metering.apply(charger.interval({ ...interval, final: index === inputs.intervals.length - 1 }));
      if (outcome.kind !== 'ACCEPTED') throw new Error(`metering refused ${interval.readingId}: ${JSON.stringify(outcome)}`);
      expect(outcome.charge).toEqual(goldenEvidence[index]?.charge);
      results.push(await h.payer.authorize(input(outcome, h.channelId)));
    }

    expect(results.map((r) => r.kind)).toEqual(['AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED']);
    const increments = h.payer.ledger.increments();
    expect(increments.map(cumulativeOf)).toEqual(['1000000', '2000000', '3000000']);
    expect(await h.payee.storedCumulative()).toBe('3000000');
    expect(h.payee.accepted()).toEqual(increments);
    for (const increment of increments) {
      expect(AuthorizedIncrementSchema.safeParse(increment).success).toBe(true);
      const message = base64ToBytes(increment.commitment.signedMessageB64);
      const amount = BigInt(increment.commitment.cumulativeAmountBaseUnits);
      // The captured signature is the SDK's own, over the bytes prepare_commitment returned.
      expect(h.chain.calls).toContain(`prepare_commitment(${amount})`);
      expect(Buffer.from(message).equals(Buffer.from(xdrCommitmentEncoding(h.channelId, amount)))).toBe(true);
      expect(verifyEd25519(accountIdToPublicKey(h.commitmentKey.publicKey()), message, base64ToBytes(increment.commitment.signatureB64))).toBe(true);
    }
    // The ack is signed only after the native artifact exists, and only acknowledged increments are accepted.
    const order = h.events.map((e) => `${e.event}#${String(e.data['sequence'] ?? '')}`);
    for (const sequence of [1, 2, 3]) {
      const signed = order.indexOf(`payer.native.signed#${sequence}`);
      const acked = order.indexOf(`payer.ack.signed#${sequence}`);
      const verified = order.indexOf(`payee.preflight.verified#${sequence}`);
      const accepted = order.indexOf(`payee.accepted#${sequence}`);
      expect(signed).toBeGreaterThanOrEqual(0);
      expect([signed < acked, acked < verified, verified < accepted]).toEqual([true, true, true]);
    }

    const e0 = h.payer.finalizeE0('2026-10-25T09:05:00.000Z');
    expect(EvidenceE0Schema.safeParse(e0).success).toBe(true);
    expect(h.payer.state).toBe('E0_FINALIZED');
    expect(Object.isFrozen(e0.increments[0]?.commitment)).toBe(true);
    expect(() => {
      (e0.increments as unknown as unknown[]).push(e0.increments[0]);
    }).toThrow(TypeError);
    expect(await h.payer.authorize(input(ev3, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'E0_ALREADY_FINALIZED' });
  });

  it('F2-B: cap 2500000 refuses r-003 before any native signature or ack; the highest commitment stays 2000000', async () => {
    const h = setup({ trust: { budgetCapBaseUnits: golden.inputs.budgetCase.capBaseUnits } });
    expect((await h.payer.authorize(input(ev1, h.channelId))).kind).toBe('AUTHORIZED');
    expect((await h.payer.authorize(input(ev2, h.channelId))).kind).toBe('AUTHORIZED');
    const callsBefore = h.chain.calls.length;
    expect(await h.payer.authorize(input(ev3, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'BUDGET_EXCEEDED' });
    expect(h.chain.calls.length).toBe(callsBefore);
    expect(h.events.some((e) => e.data['sequence'] === 3 && /native|ack|preflight/.test(e.event))).toBe(false);
    expect(cumulativeOf(h.payer.ledger.highest())).toBe('2000000');
    expect(await h.payee.storedCumulative()).toBe('2000000');
    expect(h.payer.state).toBe('READY');
  });

  it('F3-B: a replayed r-002 is refused with no additional payment', async () => {
    const h = setup();
    await h.payer.authorize(input(ev1, h.channelId));
    await h.payer.authorize(input(ev2, h.channelId));
    expect(await h.payer.authorize(input(ev2, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'DUPLICATE_READING' });
    expect(h.payee.accepted()).toHaveLength(2);
    expect(await h.payee.storedCumulative()).toBe('2000000');
  });

  it('F3-B: a repeating ack nonce is refused by the payer itself, and by the payee when sent raw', async () => {
    const h = setup({ payer: { nonce: () => '0123456789abcdef0123456789abcdef' } });
    expect((await h.payer.authorize(input(ev1, h.channelId))).kind).toBe('AUTHORIZED');
    expect(await h.payer.authorize(input(ev2, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'REPLAY_NONCE' });
    const raw = await h.rawIncrement({ sequence: 2, cumulative: 2000000n, charge: ev2.charge, ackPatch: { nonce: '0123456789abcdef0123456789abcdef' } });
    expect(raw.status).toBe(409);
    expect(await raw.json()).toMatchObject({ code: 'REPLAY_NONCE' });
    expect(await h.payee.storedCumulative()).toBe('1000000');
  });
});

describe('F4-B: the payee refuses an altered evidence authorization before SDK acceptance', () => {
  const tampered: [string, string, Partial<Parameters<ReturnType<typeof harness>['rawIncrement']>[0]>][] = [
    ['ack binds the previous evidence', 'INVALID_PAYER_ACK', { ackPatch: { evidenceDigest: ev1.charge.evidenceDigest } }],
    ['ack approves another amount', 'INVALID_PAYER_ACK', { ackPatch: { approvedCumulativeBaseUnits: '2500000' } }],
    ['ack names another channel', 'INVALID_PAYER_ACK', { ackPatch: { channelId: randomContractId() } }],
    ['ack names another session', 'INVALID_PAYER_ACK', { ackPatch: { sessionId: 'ev-session-002' } }],
    ['ack binds another native commitment', 'INVALID_PAYER_ACK', { ackPatch: { commitmentDigest: ev1.charge.evidenceDigest } }],
    ['ack edited after signing', 'INVALID_PAYER_ACK', { ackAfterSigning: (ack) => ({ ...ack, evidenceDigest: ev1.charge.evidenceDigest }) }],
    ['ack signed by a foreign key', 'INVALID_PAYER_ACK', { ackSigner: Keypair.random() }],
    ['ack missing', 'INVALID_PAYER_ACK', { omitAck: true }],
    ['credential amount differs from the evidence', 'INVALID_NATIVE_SIGNATURE', { cumulative: 2500000n }],
    ['stale cumulative re-sent for the next increment', 'INVALID_NATIVE_SIGNATURE', { cumulative: 1000000n }],
  ];

  it.each(tampered)('%s -> %s, nothing reaches the SDK store', async (_label, code, patch) => {
    const h = setup();
    expect((await h.payer.authorize(input(ev1, h.channelId))).kind).toBe('AUTHORIZED');
    const response = await h.rawIncrement({ sequence: 2, cumulative: 2000000n, charge: ev2.charge, ...patch });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code });
    expect(await h.payee.storedCumulative()).toBe('1000000');
    expect(h.payee.accepted()).toHaveLength(1);
    // The refusal leaves no damage: the genuine increment 2 is still accepted afterwards.
    expect(await h.payer.authorize(input(ev2, h.channelId))).toMatchObject({ kind: 'AUTHORIZED' });
  });

  it('a replay of the already-accepted request is refused as non-monotonic', async () => {
    const h = setup();
    await h.payer.authorize(input(ev1, h.channelId));
    const response = await h.rawIncrement({ sequence: 1, cumulative: 1000000n, charge: ev1.charge });
    expect(await response.json()).toMatchObject({ code: 'CUMULATIVE_NOT_MONOTONIC' });
    expect(h.payee.accepted()).toHaveLength(1);
  });
});

describe('F4-C: wrong credentials yield a typed rejection and no accepted increment', () => {
  it('a challenge for an unpinned channel is refused before the SDK signs', async () => {
    const h = setup({ payee: { channelId: randomContractId() } });
    expect(await h.payer.authorize(input(ev1, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'CHANNEL_NOT_PINNED' });
    expect(h.chain.calls).toEqual([]);
  });

  it('a challenge for another network is refused before the SDK signs', async () => {
    const h = setup({
      wrapFetch: (handle) =>
        rewriteChallenge(handle, (request) => ({ ...request, methodDetails: { ...(request['methodDetails'] as object), network: 'stellar:pubnet' } })),
    });
    expect(await h.payer.authorize(input(ev1, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'NETWORK_MISMATCH' });
    expect(h.chain.calls).toEqual([]);
  });

  it('a challenge for a different amount is refused before the SDK signs', async () => {
    const h = setup({ wrapFetch: (handle) => rewriteChallenge(handle, (request) => ({ ...request, amount: '1500000' })) });
    expect(await h.payer.authorize(input(ev1, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'CHARGE_MISMATCH' });
    expect(h.chain.calls).toEqual([]);
  });

  it('a payer signing with a key other than the channel commitment key is refused by the payee', async () => {
    const h = setup({ payerKey: Keypair.random() });
    expect(await h.payer.authorize(input(ev1, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'INVALID_NATIVE_SIGNATURE' });
    expect(await h.payee.storedCumulative()).toBe('0');
  });

  it('the SDK refuses a voucher above the on-chain balance even after the ack preflight passes', async () => {
    const h = setup();
    h.chain.channel.balance = 1_500_000n;
    expect((await h.payer.authorize(input(ev1, h.channelId))).kind).toBe('AUTHORIZED');
    expect(await h.payer.authorize(input(ev2, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'PAYMENT_NOT_ACCEPTED' });
    expect(h.events.map((e) => e.event)).toContain('payee.sdk.refused');
    expect(await h.payee.storedCumulative()).toBe('1000000');
  });

  it('the SDK refuses a channel that pays out to another recipient (G1 D1)', async () => {
    const h = setup();
    h.chain.channel.to = Keypair.random().publicKey();
    expect(await h.payer.authorize(input(ev1, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'PAYMENT_NOT_ACCEPTED' });
    expect(h.payee.accepted()).toEqual([]);
  });
});

describe('failure propagation and unknown outcomes', () => {
  it('a tampered source reading never reaches native signing', async () => {
    const h = setup();
    await h.payer.authorize(input(ev1, h.channelId));
    const calls = h.chain.calls.length;
    const reading = tamperedReading(golden);
    expect(await h.payer.authorize({ ...input(ev2, h.channelId), reading })).toMatchObject({ kind: 'REJECTED', reasonCode: 'INVALID_METER_SIGNATURE' });
    expect(h.chain.calls.length).toBe(calls);
  });

  it('an incorrect tariff never reaches native signing', async () => {
    const h = setup();
    const tariff = { ...golden.tariff, pricePerKwhBaseUnits: '5000000' };
    expect(await h.payer.authorize({ ...input(ev1, h.channelId), tariff })).toMatchObject({ kind: 'REJECTED', reasonCode: 'TARIFF_DIGEST_MISMATCH' });
    expect(h.chain.calls).toEqual([]);
  });

  it('RPC unavailable before signing is a safe rejection with nothing signed', async () => {
    const h = setup();
    h.chain.down = true;
    expect(await h.payer.authorize(input(ev1, h.channelId))).toMatchObject({ kind: 'REJECTED', reasonCode: 'RPC_UNAVAILABLE' });
    expect(h.events.some((e) => e.event === 'payer.native.signed')).toBe(false);
    h.chain.down = false;
    expect((await h.payer.authorize(input(ev1, h.channelId))).kind).toBe('AUTHORIZED');
  });

  it('a lost answer after the credential was sent is PENDING until reconciled from the payee receipt', async () => {
    let dropNext = true;
    const h = setup({
      wrapFetch: (handle) => async (request) => {
        const response = await handle(request);
        if (dropNext && request.headers.has('authorization')) {
          dropNext = false;
          throw new Error('socket hang up');
        }
        return response;
      },
    });
    expect(await h.payer.authorize(input(ev1, h.channelId))).toMatchObject({ kind: 'PENDING', reasonCode: 'PAYMENT_OUTCOME_UNKNOWN' });
    expect(h.payer.state).toBe('PENDING');
    expect(await h.payer.authorize(input(ev2, h.channelId))).toMatchObject({ kind: 'PENDING' });
    expect(() => h.payer.finalizeE0('2026-10-25T09:05:00.000Z')).toThrow(/PENDING/);
    expect(await h.payer.reconcile()).toMatchObject({ kind: 'AUTHORIZED' });
    expect(cumulativeOf(h.payer.ledger.highest())).toBe('1000000');
    expect((await h.payer.authorize(input(ev2, h.channelId))).kind).toBe('AUTHORIZED');
  });

  it('a credential that never reached the payee reconciles to a safe rejection', async () => {
    let failNext = true;
    const h = setup({
      wrapFetch: (handle) => async (request) => {
        if (failNext && request.headers.has('authorization')) {
          failNext = false;
          throw new Error('connect ECONNRESET');
        }
        return handle(request);
      },
    });
    expect((await h.payer.authorize(input(ev1, h.channelId))).kind).toBe('PENDING');
    expect(await h.payer.reconcile()).toMatchObject({ kind: 'REJECTED', reasonCode: 'PAYMENT_NOT_ACCEPTED' });
    expect(h.payer.state).toBe('READY');
    expect((await h.payer.authorize(input(ev1, h.channelId))).kind).toBe('AUTHORIZED');
  });
});
