import { z } from 'zod';
import {
  DecimalStringSchema,
  Ed25519SignatureB64Schema,
  IdentifierSchema,
  IsoTimeSchema,
  NetworkSchema,
  NonceSchema,
  PositiveDecimalStringSchema,
  Sha256HexSchema,
  StellarAccountIdSchema,
  StellarContractIdSchema,
  base64Schema,
  isoTimeMs,
} from './primitives.js';

/**
 * Frozen SPEC 00 §4 cross-module data contract, version 1.
 *
 * Schemas enforce shape and intra-record invariants (formats, intervals, signature presence, E0 ordering and
 * uniqueness). Cross-record *binding* checks (digest recomputation, amount/channel/session equality between a
 * charge, its native commitment and its payer ack, signature validity) belong to the consuming modules and the
 * independent verifier, so that they can report precise reason codes instead of a generic schema failure.
 */

/** Upper bound for source payload bytes kept in evidence (simulated meter payloads are well below 1 KiB). */
export const MAX_RAW_PAYLOAD_BYTES = 64 * 1024;
/** Upper bound for the native signed commitment message (an XDR `ScVal::Map` in the pinned SDK). */
export const MAX_SIGNED_MESSAGE_BYTES = 4 * 1024;

export const AssuranceSchema = z.enum(['L0', 'L1', 'L2']);
export const ReadingCoverageSchema = z.enum(['intermediate_unsigned', 'intermediate_signed', 'terminal_signed']);
export const CertificationSchema = z.enum(['simulated', 'unknown', 'vendor_attested', 'independently_checked']);

export const MeterReadingSchema = z
  .strictObject({
    schema: z.literal('usagepay.reading.v1'),
    readingId: IdentifierSchema,
    sessionId: IdentifierSchema,
    machineId: IdentifierSchema,
    domain: z.literal('ev.ocpp2x'),
    observedAt: IsoTimeSchema,
    intervalStart: IsoTimeSchema,
    intervalEnd: IsoTimeSchema,
    deltaWh: DecimalStringSchema,
    rawPayloadB64: base64Schema({ min: 1, max: MAX_RAW_PAYLOAD_BYTES }),
    signatureB64: Ed25519SignatureB64Schema.optional(),
    signerKeyId: IdentifierSchema.optional(),
    assurance: AssuranceSchema,
    coverage: ReadingCoverageSchema,
    certification: CertificationSchema,
  })
  .superRefine((reading, ctx) => {
    if (isoTimeMs(reading.intervalStart) >= isoTimeMs(reading.intervalEnd)) {
      ctx.addIssue({
        code: 'custom',
        path: ['intervalEnd'],
        message: 'invalid interval: intervalStart must be strictly before intervalEnd ([start, end) is half-open)',
      });
    }
    if (isoTimeMs(reading.observedAt) < isoTimeMs(reading.intervalEnd)) {
      ctx.addIssue({ code: 'custom', path: ['observedAt'], message: 'observedAt cannot precede the end of its interval' });
    }
    const hasSignature = reading.signatureB64 !== undefined;
    if (hasSignature !== (reading.signerKeyId !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['signerKeyId'],
        message: 'signatureB64 and signerKeyId must be present together or both absent',
      });
    }
    const signedCoverage = reading.coverage !== 'intermediate_unsigned';
    if (signedCoverage !== hasSignature) {
      ctx.addIssue({
        code: 'custom',
        path: ['signatureB64'],
        message: `coverage "${reading.coverage}" ${signedCoverage ? 'requires' : 'forbids'} a source signature`,
      });
    }
    if (reading.assurance === 'L2' && !hasSignature) {
      ctx.addIssue({ code: 'custom', path: ['signatureB64'], message: 'assurance L2 requires a non-empty source signature' });
    }
  });
export type MeterReading = z.output<typeof MeterReadingSchema>;

const tariffFieldShape = {
  schema: z.literal('usagepay.tariff.v1'),
  tariffId: IdentifierSchema,
  assetSac: StellarContractIdSchema,
  assetDecimals: z.number().int().min(1).max(38),
  currencyCode: z.literal('USDC'),
  unit: z.literal('kWh'),
  pricePerKwhBaseUnits: PositiveDecimalStringSchema,
  rounding: z.literal('floor_cumulative'),
  validFrom: IsoTimeSchema,
  validUntil: IsoTimeSchema.optional(),
};

function refineTariffValidity(tariff: { validFrom: string; validUntil?: string | undefined }, ctx: z.RefinementCtx): void {
  if (tariff.validUntil !== undefined && isoTimeMs(tariff.validUntil) <= isoTimeMs(tariff.validFrom)) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'validUntil must be strictly after validFrom' });
  }
}

/** Tariff fields that form the `versionDigest` preimage (the snapshot without `versionDigest`). */
export const TariffFieldsSchema = z.strictObject(tariffFieldShape).superRefine(refineTariffValidity);
export type TariffFields = z.output<typeof TariffFieldsSchema>;

export const TariffSnapshotSchema = z
  .strictObject({ ...tariffFieldShape, versionDigest: Sha256HexSchema })
  .superRefine(refineTariffValidity);
export type TariffSnapshot = z.output<typeof TariffSnapshotSchema>;

export const MeasurementChargeSchema = z.strictObject({
  schema: z.literal('usagepay.charge.v1'),
  readingId: IdentifierSchema,
  sessionId: IdentifierSchema,
  readingDigest: Sha256HexSchema,
  tariffVersionDigest: Sha256HexSchema,
  cumulativeWh: DecimalStringSchema,
  cumulativeChargeBaseUnits: DecimalStringSchema,
  deltaChargeBaseUnits: DecimalStringSchema,
  evidenceDigest: Sha256HexSchema,
});
export type MeasurementCharge = z.output<typeof MeasurementChargeSchema>;

export const NativeCommitmentSchema = z.strictObject({
  schema: z.literal('usagepay.native-commitment.v1'),
  channelId: StellarContractIdSchema,
  network: NetworkSchema,
  cumulativeAmountBaseUnits: PositiveDecimalStringSchema,
  signedMessageB64: base64Schema({ min: 1, max: MAX_SIGNED_MESSAGE_BYTES }),
  signatureB64: Ed25519SignatureB64Schema,
  commitmentKey: StellarAccountIdSchema,
  commitmentDigest: Sha256HexSchema,
});
export type NativeCommitment = z.output<typeof NativeCommitmentSchema>;

export const PayerEvidenceAckSchema = z.strictObject({
  schema: z.literal('usagepay.payer-ack.v1'),
  sessionId: IdentifierSchema,
  network: NetworkSchema,
  channelId: StellarContractIdSchema,
  evidenceDigest: Sha256HexSchema,
  commitmentDigest: Sha256HexSchema,
  approvedCumulativeBaseUnits: PositiveDecimalStringSchema,
  nonce: NonceSchema,
  payerKey: StellarAccountIdSchema,
  signatureB64: Ed25519SignatureB64Schema,
});
export type PayerEvidenceAck = z.output<typeof PayerEvidenceAckSchema>;
export type PayerEvidenceAckUnsigned = Omit<PayerEvidenceAck, 'signatureB64'>;

export const AuthorizedIncrementSchema = z.strictObject({
  schema: z.literal('usagepay.increment.v1'),
  sequence: z.number().int().min(1),
  reading: MeterReadingSchema,
  charge: MeasurementChargeSchema,
  commitment: NativeCommitmentSchema,
  payerAck: PayerEvidenceAckSchema,
});
export type AuthorizedIncrement = z.output<typeof AuthorizedIncrementSchema>;

export const EvidenceE0Schema = z
  .strictObject({
    schema: z.literal('usagepay.e0.v1'),
    sessionId: IdentifierSchema,
    tariff: TariffSnapshotSchema,
    increments: z.array(AuthorizedIncrementSchema).min(1, 'E0 must contain at least one authorized increment'),
    finalizedAt: IsoTimeSchema,
  })
  .superRefine((e0, ctx) => {
    const readingKeys = new Set<string>();
    const nonceKeys = new Set<string>();
    e0.increments.forEach((increment, index) => {
      const expectedSequence = index + 1;
      if (increment.sequence !== expectedSequence) {
        ctx.addIssue({
          code: 'custom',
          path: ['increments', index, 'sequence'],
          message: `reordered or missing sequence: expected ${expectedSequence}, got ${increment.sequence}`,
        });
      }
      const { reading, payerAck } = increment;
      const readingKey = JSON.stringify([reading.domain, reading.sessionId, reading.readingId]);
      if (readingKeys.has(readingKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['increments', index, 'reading', 'readingId'],
          message: `repeated reading (domain, sessionId, readingId) = (${reading.domain}, ${reading.sessionId}, ${reading.readingId})`,
        });
      }
      readingKeys.add(readingKey);
      const nonceKey = JSON.stringify([payerAck.channelId, payerAck.sessionId, payerAck.nonce]);
      if (nonceKeys.has(nonceKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['increments', index, 'payerAck', 'nonce'],
          message: `repeated payer ack (channelId, sessionId, nonce) nonce "${payerAck.nonce}"`,
        });
      }
      nonceKeys.add(nonceKey);
    });
  });
export type EvidenceE0 = z.output<typeof EvidenceE0Schema>;

export const TxStatusSchema = z.enum(['SUCCESS', 'FAILED', 'NOT_FOUND']);

export const EvidenceE1Schema = z
  .strictObject({
    schema: z.literal('usagepay.e1.v1'),
    e0Digest: Sha256HexSchema,
    network: NetworkSchema,
    channelId: StellarContractIdSchema,
    assetSac: StellarContractIdSchema,
    closeTxHash: Sha256HexSchema,
    txStatus: TxStatusSchema,
    settledCumulativeBaseUnits: DecimalStringSchema.optional(),
    verifierVersion: z.literal('usagepay-verifier.v1'),
  })
  .superRefine((e1, ctx) => {
    if (e1.txStatus !== 'SUCCESS' && e1.settledCumulativeBaseUnits !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['settledCumulativeBaseUnits'],
        message: `a settled amount cannot be stated for a ${e1.txStatus} transaction`,
      });
    }
  });
export type EvidenceE1 = z.output<typeof EvidenceE1Schema>;

export const VerificationResultSchema = z.strictObject({
  status: z.enum(['PASS', 'FAIL', 'NOT_AVAILABLE']),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'reasonCode must be a stable UPPER_SNAKE_CASE code'),
  details: z.string(),
});
export type VerificationResult = z.output<typeof VerificationResultSchema>;

/**
 * Signed source payload of the SPEC 01 §3.2 simulator profile. Shared here because both the metering adapter
 * (producer) and the independent verifier (consumer) must parse the exact same signed bytes without importing
 * each other. Shape only: counter monotonicity and envelope consistency are SPEC 01 / SPEC 03 checks.
 */
export const SimMeterPayloadSchema = z.strictObject({
  schema: z.literal('usagepay.sim-meter-payload.v1'),
  domain: z.literal('ev.ocpp2x'),
  sessionId: IdentifierSchema,
  machineId: IdentifierSchema,
  readingId: IdentifierSchema,
  observedAt: IsoTimeSchema,
  intervalStart: IsoTimeSchema,
  intervalEnd: IsoTimeSchema,
  meterStartWh: DecimalStringSchema,
  meterEndWh: DecimalStringSchema,
  unit: z.literal('Wh'),
});
export type SimMeterPayload = z.output<typeof SimMeterPayloadSchema>;
