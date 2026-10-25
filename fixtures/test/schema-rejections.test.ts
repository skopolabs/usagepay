import { describe, expect, it } from 'vitest';
import {
  EvidenceE0Schema,
  EvidenceE1Schema,
  MeasurementChargeSchema,
  MeterReadingSchema,
  NativeCommitmentSchema,
  PayerEvidenceAckSchema,
  TariffSnapshotSchema,
  VerificationResultSchema,
} from '@usagepay/contracts';
import { buildGoldenSession, duplicateReadingE0, offlineE1, reorderedSequenceE0, reusedNonceE0 } from '../src/index.js';

const golden = buildGoldenSession();
const reading = golden.readings[0]!;
const charge = golden.charges[0]!;
const commitment = golden.commitments[0]!;
const ack = golden.acks[0]!;

function issues(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string {
  return result.success ? '' : result.error!.issues.map((issue) => issue.message).join(' | ');
}

describe('SPEC 00 schema rejections (golden record with exactly one field corrupted)', () => {
  it.each([
    ['charge cumulativeWh as a float string', MeasurementChargeSchema, { ...charge, cumulativeWh: '250.0' }],
    ['charge amount with a leading zero', MeasurementChargeSchema, { ...charge, cumulativeChargeBaseUnits: '01000000' }],
    ['charge amount as a JSON number', MeasurementChargeSchema, { ...charge, cumulativeChargeBaseUnits: 1000000 }],
    ['negative deltaWh', MeterReadingSchema, { ...reading, deltaWh: '-250' }],
    ['tariff price in exponent form', TariffSnapshotSchema, { ...golden.tariff, pricePerKwhBaseUnits: '4e6' }],
    ['tariff price of zero', TariffSnapshotSchema, { ...golden.tariff, pricePerKwhBaseUnits: '0' }],
    ['tariff with fractional decimals', TariffSnapshotSchema, { ...golden.tariff, assetDecimals: 7.5 }],
  ])('rejects incorrect integer format: %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['commitment', NativeCommitmentSchema, { ...commitment, network: 'stellar:pubnet' }],
    ['payer ack', PayerEvidenceAckSchema, { ...ack, network: 'stellar:mainnet' }],
    ['E1', EvidenceE1Schema, { ...offlineE1(golden, 'SUCCESS', '3000000'), network: 'testnet' }],
  ])('rejects unknown network on %s (Testnet only)', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('rejects an L2 reading with an empty signature', () => {
    const result = MeterReadingSchema.safeParse({ ...reading, signatureB64: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an L2 reading with no signature at all (and no key ID)', () => {
    const { signatureB64: _sig, signerKeyId: _key, ...unsigned } = reading;
    const result = MeterReadingSchema.safeParse(unsigned);
    expect(issues(result)).toMatch(/L2 requires/);
  });

  it('rejects a signature without signerKeyId and an unsigned coverage carrying a signature', () => {
    const { signerKeyId: _key, ...noKey } = reading;
    expect(MeterReadingSchema.safeParse(noKey).success).toBe(false);
    expect(MeterReadingSchema.safeParse({ ...reading, assurance: 'L0', coverage: 'intermediate_unsigned' }).success).toBe(false);
  });

  it('rejects a 63-byte signature and an empty native signature', () => {
    expect(MeterReadingSchema.safeParse({ ...reading, signatureB64: Buffer.alloc(63).toString('base64') }).success).toBe(false);
    expect(NativeCommitmentSchema.safeParse({ ...commitment, signatureB64: '' }).success).toBe(false);
  });

  it.each([
    ['zero-length interval', { intervalEnd: reading.intervalStart }],
    ['reversed interval', { intervalStart: reading.intervalEnd, intervalEnd: reading.intervalStart }],
    ['observedAt before the interval ends', { observedAt: reading.intervalStart }],
    ['non-normalized time', { intervalStart: '2026-10-25T09:00:00Z' }],
  ])('rejects invalid interval: %s', (_label, patch) => {
    expect(MeterReadingSchema.safeParse({ ...reading, ...patch }).success).toBe(false);
  });

  it('rejects a tariff whose validUntil is not after validFrom', () => {
    expect(TariffSnapshotSchema.safeParse({ ...golden.tariff, validUntil: golden.tariff.validFrom }).success).toBe(false);
  });

  it.each([
    ['uppercase hex digest', MeasurementChargeSchema, { ...charge, evidenceDigest: charge.evidenceDigest.toUpperCase() }],
    ['0x-prefixed digest', PayerEvidenceAckSchema, { ...ack, commitmentDigest: `0x${ack.commitmentDigest.slice(2)}` }],
    ['short digest', TariffSnapshotSchema, { ...golden.tariff, versionDigest: golden.tariff.versionDigest.slice(1) }],
    ['URL-safe base64 payload', MeterReadingSchema, { ...reading, rawPayloadB64: reading.rawPayloadB64.replace(/\+/g, '-').replace(/\//g, '_') + '-' }],
    ['base64 with whitespace', NativeCommitmentSchema, { ...commitment, signedMessageB64: ` ${commitment.signedMessageB64}` }],
    ['unpadded base64 signature', PayerEvidenceAckSchema, { ...ack, signatureB64: ack.signatureB64.replace(/=+$/, '') }],
  ])('rejects invalid hex/base64: %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['classic G... issuer used as assetSac', TariffSnapshotSchema, { ...golden.tariff, assetSac: ack.payerKey }],
    ['contract C... used as commitmentKey', NativeCommitmentSchema, { ...commitment, commitmentKey: commitment.channelId }],
    ['account G... used as channelId', PayerEvidenceAckSchema, { ...ack, channelId: ack.payerKey }],
  ])('rejects wrong Stellar identity kind: %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('rejects unknown extra fields (strict objects keep the contract closed)', () => {
    expect(MeasurementChargeSchema.safeParse({ ...charge, verified: true }).success).toBe(false);
  });

  it('F3-A: rejects repeated (domain, sessionId, readingId) inside E0', () => {
    expect(issues(EvidenceE0Schema.safeParse(duplicateReadingE0(golden)))).toMatch(/repeated reading/);
  });

  it('F3-B: rejects a repeated (channelId, sessionId, nonce) inside E0', () => {
    expect(issues(EvidenceE0Schema.safeParse(reusedNonceE0(golden)))).toMatch(/repeated payer ack/);
  });

  it('F3-C: rejects reordered sequences (2, 1, 3)', () => {
    expect(issues(EvidenceE0Schema.safeParse(reorderedSequenceE0(golden)))).toMatch(/reordered or missing sequence/);
  });

  it('rejects an empty E0', () => {
    expect(EvidenceE0Schema.safeParse({ ...golden.e0, increments: [] }).success).toBe(false);
  });

  it('F5: E1 may not state a settled amount for a FAILED or NOT_FOUND transaction', () => {
    expect(EvidenceE1Schema.safeParse(offlineE1(golden, 'FAILED', '3000000')).success).toBe(false);
    expect(EvidenceE1Schema.safeParse(offlineE1(golden, 'NOT_FOUND', '3000000')).success).toBe(false);
    expect(EvidenceE1Schema.safeParse(offlineE1(golden, 'FAILED')).success).toBe(true);
  });

  it('VerificationResult requires PASS/FAIL/NOT_AVAILABLE and an UPPER_SNAKE reason code', () => {
    expect(VerificationResultSchema.safeParse({ status: 'NOT_AVAILABLE', reasonCode: 'RPC_UNAVAILABLE', details: '' }).success).toBe(true);
    expect(VerificationResultSchema.safeParse({ status: 'OK', reasonCode: 'RPC_UNAVAILABLE', details: '' }).success).toBe(false);
    expect(VerificationResultSchema.safeParse({ status: 'PASS', reasonCode: 'verified', details: '' }).success).toBe(false);
  });
});
