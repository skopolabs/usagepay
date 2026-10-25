import {
  NETWORK,
  base64ToBytes,
  bytesToBase64,
  computeE0Digest,
  sha256Hex,
  utf8Bytes,
  type AuthorizedIncrement,
  type EvidenceE0,
  type EvidenceE1,
  type MeterReading,
  type PayerEvidenceAck,
} from '@usagepay/contracts';
import { buildSignedReading, fixtureNonce, signPayerAck, type GoldenSession } from './golden.js';
import { TEST_ONLY_PAYER_KEY, TEST_ONLY_UNTRUSTED_METER_KEY } from './test-keys.js';

/**
 * Negative OFFLINE_FIXTURE variants derived from the S1 golden session (SPEC 00 §8 F1–F5).
 * Each returns plain data; whether it is rejected by a schema, a signature check or a business module is
 * documented in `v1/scenarios.json`.
 */

/** F1-A: change one byte of r-002's signed source bytes after signing (meterEndWh 10500 -> 19500). */
export function tamperedReading(golden: GoldenSession, index = 1): MeterReading {
  const reading = golden.readings[index]!;
  const bytes = base64ToBytes(reading.rawPayloadB64);
  const marker = '"meterEndWh":"1';
  const position = new TextDecoder().decode(bytes).indexOf(marker) + marker.length;
  const tampered = Uint8Array.from(bytes);
  tampered[position] = '9'.charCodeAt(0);
  return { ...reading, rawPayloadB64: bytesToBase64(tampered) };
}

/** F1-B: r-002 validly signed by a key outside the trusted registry, while claiming the trusted key ID. */
export function untrustedKeyReading(golden: GoldenSession, index = 1): MeterReading {
  const interval = golden.inputs.intervals[index]!;
  return buildSignedReading(golden.payloads[index]!, interval.coverage, golden.inputs.meter.signerKeyId, TEST_ONLY_UNTRUSTED_METER_KEY);
}

function e0With(golden: GoldenSession, increments: AuthorizedIncrement[]): EvidenceE0 {
  return { ...golden.e0, increments };
}

/** F3-A: r-002 delivered twice inside one E0 (sequence numbers kept contiguous). */
export function duplicateReadingE0(golden: GoldenSession): EvidenceE0 {
  const [first, second, third] = golden.increments as [AuthorizedIncrement, AuthorizedIncrement, AuthorizedIncrement];
  return e0With(golden, [first, second, { ...second, sequence: 3 }, { ...third, sequence: 4 }]);
}

/** F3-B: the third payer ack reuses the second ack's nonce (validly re-signed, so only the replay rule catches it). */
export function reusedNonceE0(golden: GoldenSession): EvidenceE0 {
  const [first, second, third] = golden.increments as [AuthorizedIncrement, AuthorizedIncrement, AuthorizedIncrement];
  const { signatureB64: _drop, ...unsigned } = third.payerAck;
  const replayed = signPayerAck({ ...unsigned, nonce: second.payerAck.nonce }, TEST_ONLY_PAYER_KEY);
  return e0With(golden, [first, second, { ...third, payerAck: replayed }]);
}

/** F3-C: increments listed with sequences 2, 1, 3. */
export function reorderedSequenceE0(golden: GoldenSession): EvidenceE0 {
  const [first, second, third] = golden.increments as [AuthorizedIncrement, AuthorizedIncrement, AuthorizedIncrement];
  return e0With(golden, [second, first, third]);
}

/** F4-A: ack evidenceDigest changed after signing; the payer signature no longer covers the content. */
export function ackFieldMutated(golden: GoldenSession, index = 1): PayerEvidenceAck {
  const ack = golden.acks[index]!;
  return { ...ack, evidenceDigest: sha256Hex(utf8Bytes('usagepay.offline-fixture.substituted-evidence')) };
}

/** F4-B: ack validly signed, but over the *previous* increment's evidence digest (wrong binding). */
export function ackWrongBinding(golden: GoldenSession, index = 1): PayerEvidenceAck {
  const { signatureB64: _drop, ...unsigned } = golden.acks[index]!;
  return signPayerAck(
    { ...unsigned, evidenceDigest: golden.charges[index - 1]!.evidenceDigest, nonce: fixtureNonce(unsigned.sessionId, 'wrong-binding') },
    TEST_ONLY_PAYER_KEY,
  );
}

/**
 * F5 parser fixtures: an E1 referencing the golden E0 with a synthetic, NON-EXISTENT close transaction hash.
 * Such an E1 can exercise parser/verifier branches only; it is never evidence of settlement.
 */
export function offlineE1(golden: GoldenSession, txStatus: EvidenceE1['txStatus'], settledCumulativeBaseUnits?: string): EvidenceE1 {
  return {
    schema: 'usagepay.e1.v1',
    e0Digest: computeE0Digest(golden.e0),
    network: NETWORK,
    channelId: golden.commitments[0]!.channelId,
    assetSac: golden.tariff.assetSac,
    closeTxHash: sha256Hex(utf8Bytes('usagepay.offline-fixture.close-tx.NOT-A-REAL-TRANSACTION')),
    txStatus,
    ...(settledCumulativeBaseUnits === undefined ? {} : { settledCumulativeBaseUnits }),
    verifierVersion: 'usagepay-verifier.v1',
  };
}
