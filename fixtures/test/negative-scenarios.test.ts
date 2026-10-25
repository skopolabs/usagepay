import { describe, expect, it } from 'vitest';
import {
  EvidenceE1Schema,
  MeterReadingSchema,
  PayerEvidenceAckSchema,
  computeE0Digest,
  cumulativeChargeBaseUnits,
  decimalToBigInt,
  verifyMeterReadingSignature,
  verifyPayerAckSignature,
} from '@usagepay/contracts';
import {
  TRUSTED_METER_KEYS,
  ackFieldMutated,
  ackWrongBinding,
  buildGoldenSession,
  offlineE1,
  tamperedReading,
  untrustedKeyReading,
} from '../src/index.js';

const golden = buildGoldenSession();
const pinnedMeterKey = TRUSTED_METER_KEYS.get(golden.inputs.meter.signerKeyId)!;

describe('negative scenarios at the contract level [OFFLINE_FIXTURE]', () => {
  it('F1-A tampered r-002: still schema-shaped, but the pinned-key signature over the exact bytes fails (INVALID_METER_SIGNATURE)', () => {
    const tampered = tamperedReading(golden);
    expect(tampered.rawPayloadB64).not.toBe(golden.readings[1]!.rawPayloadB64);
    expect(MeterReadingSchema.safeParse(tampered).success).toBe(true);
    expect(verifyMeterReadingSignature(tampered, pinnedMeterKey)).toBe(false);
  });

  it('F1-B r-002 signed by an untrusted key: verification against the pinned key fails (UNKNOWN_METER_KEY / INVALID_METER_SIGNATURE)', () => {
    const forged = untrustedKeyReading(golden);
    expect(forged.signatureB64).not.toBe(golden.readings[1]!.signatureB64);
    expect(verifyMeterReadingSignature(forged, pinnedMeterKey)).toBe(false);
  });

  it('F2 data: with cap 2500000 the third increment (3000000) exceeds the budget; highest approved stays 2000000', () => {
    const { budgetCase } = golden.inputs;
    const cap = decimalToBigInt(budgetCase.capBaseUnits);
    const price = decimalToBigInt(golden.tariff.pricePerKwhBaseUnits);
    const admitted = golden.charges.filter((charge) => cumulativeChargeBaseUnits(decimalToBigInt(charge.cumulativeWh), price) <= cap);
    expect(admitted.map((charge) => charge.readingId)).toEqual(budgetCase.approvedReadingIds);
    expect(admitted.at(-1)!.cumulativeChargeBaseUnits).toBe(budgetCase.expectedHighestApprovedBaseUnits);
    expect(budgetCase.rejectedReadingId).toBe('r-003');
  });

  it('F4-A ack field changed after signing: schema-valid but the payer signature no longer verifies (PAYER_ACK_INVALID)', () => {
    const mutated = ackFieldMutated(golden);
    expect(PayerEvidenceAckSchema.safeParse(mutated).success).toBe(true);
    expect(verifyPayerAckSignature(mutated)).toBe(false);
  });

  it('F4-B ack validly signed over the wrong evidence: signature passes, binding to its own charge does not (EVIDENCE_DIGEST_MISMATCH)', () => {
    const wrong = ackWrongBinding(golden);
    expect(verifyPayerAckSignature(wrong)).toBe(true);
    expect(wrong.evidenceDigest).not.toBe(golden.charges[1]!.evidenceDigest);
  });

  it('F5/F6 shapes: an offline E1 parses, links to E0 by digest, and a mutated E0 breaks that link', () => {
    const e1 = EvidenceE1Schema.parse(offlineE1(golden, 'SUCCESS', '3000000'));
    expect(e1.e0Digest).toBe(computeE0Digest(golden.e0));
    const mutatedE0 = { ...golden.e0, finalizedAt: '2026-10-25T09:05:00.000Z' };
    expect(computeE0Digest(mutatedE0)).not.toBe(e1.e0Digest);
  });
});
