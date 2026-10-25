import { describe, expect, it } from 'vitest';
import {
  AuthorizedIncrementSchema,
  EvidenceE0Schema,
  MeasurementChargeSchema,
  MeterReadingSchema,
  NativeCommitmentSchema,
  PayerEvidenceAckSchema,
  TariffSnapshotSchema,
  base64ToBytes,
  canonicalize,
  computeCommitmentDigest,
  computeE0Digest,
  computeEvidenceDigest,
  computeReadingDigest,
  computeTariffVersionDigest,
  decodeSimMeterPayload,
  verifyMeterReadingSignature,
  verifyPayerAckSignature,
} from '@usagepay/contracts';
import { OFFLINE_COMMITMENT_DOMAIN, TRUSTED_METER_KEYS, buildGoldenSession } from '../src/index.js';

const golden = buildGoldenSession();
const fixtureId = golden.inputs.session.fixtureId;

describe(`S1 [OFFLINE_FIXTURE ${fixtureId}] three signed 250 Wh intervals at 0.40 USDC/kWh`, () => {
  it('every artifact validates against the frozen SPEC 00 runtime schemas', () => {
    expect(TariffSnapshotSchema.safeParse(golden.tariff).success).toBe(true);
    for (const increment of golden.increments) {
      expect(MeterReadingSchema.safeParse(increment.reading).success).toBe(true);
      expect(MeasurementChargeSchema.safeParse(increment.charge).success).toBe(true);
      expect(NativeCommitmentSchema.safeParse(increment.commitment).success).toBe(true);
      expect(PayerEvidenceAckSchema.safeParse(increment.payerAck).success).toBe(true);
      expect(AuthorizedIncrementSchema.safeParse(increment).success).toBe(true);
    }
    expect(EvidenceE0Schema.safeParse(golden.e0).success).toBe(true);
  });

  it.each(golden.inputs.intervals.map((interval, index) => [interval.readingId, index] as const))(
    '%s: computed deltaWh / cumulative Wh / cumulative and delta charge equal the independently written expected values',
    (_readingId, index) => {
      const expected = golden.inputs.intervals[index]!.expected;
      const charge = golden.charges[index]!;
      expect({
        deltaWh: golden.readings[index]!.deltaWh,
        cumulativeWh: charge.cumulativeWh,
        cumulativeChargeBaseUnits: charge.cumulativeChargeBaseUnits,
        deltaChargeBaseUnits: charge.deltaChargeBaseUnits,
      }).toEqual(expected);
    },
  );

  it('cumulative amounts are exactly 1000000 -> 2000000 -> 3000000 base units and strictly increasing', () => {
    expect(golden.commitments.map((c) => c.cumulativeAmountBaseUnits)).toEqual(['1000000', '2000000', '3000000']);
  });

  it('meter signatures verify against the pinned registry key over the exact decoded source bytes', () => {
    for (const reading of golden.readings) {
      const key = TRUSTED_METER_KEYS.get(reading.signerKeyId!);
      expect(key, `signer ${reading.signerKeyId} must be pinned`).toBeDefined();
      expect(verifyMeterReadingSignature(reading, key!)).toBe(true);
    }
  });

  it('normalized reading fields reproduce from the signed source bytes (signed data cannot be overridden)', () => {
    for (const reading of golden.readings) {
      const payload = decodeSimMeterPayload(base64ToBytes(reading.rawPayloadB64));
      expect(payload.readingId).toBe(reading.readingId);
      expect(payload.sessionId).toBe(reading.sessionId);
      expect(payload.machineId).toBe(reading.machineId);
      expect(payload.intervalStart).toBe(reading.intervalStart);
      expect(payload.intervalEnd).toBe(reading.intervalEnd);
      expect(BigInt(payload.meterEndWh) - BigInt(payload.meterStartWh)).toBe(BigInt(reading.deltaWh));
    }
  });

  it('labels assurance honestly: L2 simulated, intermediate_signed then terminal_signed', () => {
    expect(golden.readings.map((r) => [r.assurance, r.certification, r.coverage])).toEqual([
      ['L2', 'simulated', 'intermediate_signed'],
      ['L2', 'simulated', 'intermediate_signed'],
      ['L2', 'simulated', 'terminal_signed'],
    ]);
  });

  it('every stored digest recomputes from its SPEC 00 preimage', () => {
    expect(computeTariffVersionDigest(golden.tariff)).toBe(golden.tariff.versionDigest);
    golden.increments.forEach(({ reading, charge, commitment }) => {
      expect(computeReadingDigest(reading)).toBe(charge.readingDigest);
      const { schema: _s, evidenceDigest, ...rest } = charge;
      const { readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits, deltaChargeBaseUnits, sessionId, readingId } = rest;
      expect(
        computeEvidenceDigest({ readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits, deltaChargeBaseUnits, sessionId, readingId }),
      ).toBe(evidenceDigest);
      expect(computeCommitmentDigest(commitment)).toBe(commitment.commitmentDigest);
    });
  });

  it('each payer ack verifies and binds the exact evidence digest, commitment digest, amount, channel and network', () => {
    golden.increments.forEach(({ charge, commitment, payerAck }) => {
      expect(verifyPayerAckSignature(payerAck)).toBe(true);
      expect(payerAck.evidenceDigest).toBe(charge.evidenceDigest);
      expect(payerAck.commitmentDigest).toBe(commitment.commitmentDigest);
      expect(payerAck.approvedCumulativeBaseUnits).toBe(commitment.cumulativeAmountBaseUnits);
      expect(payerAck.channelId).toBe(commitment.channelId);
      expect(payerAck.network).toBe(commitment.network);
      expect(payerAck.payerKey).toBe(commitment.commitmentKey);
    });
  });

  it('offline commitments are explicitly labelled as NOT native MPP commitments', () => {
    for (const commitment of golden.commitments) {
      const message = new TextDecoder().decode(base64ToBytes(commitment.signedMessageB64));
      expect(message.startsWith(OFFLINE_COMMITMENT_DOMAIN)).toBe(true);
    }
  });

  it('E0 contains no settlement transaction hash and its digest is stable across rebuilds', () => {
    expect(canonicalize(golden.e0)).not.toMatch(/closeTxHash|txHash|txStatus/);
    expect(computeE0Digest(buildGoldenSession().e0)).toBe(computeE0Digest(golden.e0));
  });
});
