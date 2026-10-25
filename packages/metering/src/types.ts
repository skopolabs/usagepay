import { z } from 'zod';
import { IdentifierSchema, IsoTimeSchema, type MeasurementCharge, type MeterReading } from '@usagepay/contracts';

/**
 * SPEC 01 §3.1 OCPP 2.x-*shaped* transport event. `usagepaySimulator` is not an OCPP field: it carries the
 * separately signed simulator payload. Not OCPP-compliant and not an OCMF record.
 */
export const SimulatedOcppEventSchema = z.strictObject({
  eventType: z.enum(['Started', 'Updated', 'Ended']),
  timestamp: IsoTimeSchema,
  transactionInfo: z.strictObject({ transactionId: IdentifierSchema }),
  meterValue: z
    .array(
      z.strictObject({
        timestamp: IsoTimeSchema,
        sampledValue: z
          .array(
            z.strictObject({
              measurand: z.literal('Energy.Active.Import.Register'),
              unitOfMeasure: z.strictObject({ unit: z.literal('Wh') }),
              value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            }),
          )
          .length(1),
      }),
    )
    .max(1),
  usagepaySimulator: z
    .strictObject({
      readingId: IdentifierSchema,
      rawPayloadB64: z.string(),
      signatureB64: z.string(),
      signerKeyId: IdentifierSchema,
    })
    .optional(),
});
export type SimulatedOcppEvent = z.output<typeof SimulatedOcppEventSchema>;

export const METERING_REFUSAL_CODES = [
  'INVALID_SOURCE_BYTES',
  'UNKNOWN_METER_KEY',
  'INVALID_METER_SIGNATURE',
  'SIGNED_PAYLOAD_MISMATCH',
  'INVALID_INTERVAL',
  'NON_MONOTONIC_COUNTER',
  'COUNTER_GAP',
  'DUPLICATE_READING',
  'OUT_OF_ORDER',
  'SESSION_CLOSED',
  'TARIFF_NOT_ACTIVE',
  'TARIFF_CHANGED',
  'ZERO_VALUE_INCREMENT',
  'UNSUPPORTED_EVENT',
] as const;
export type MeteringRefusalCode = (typeof METERING_REFUSAL_CODES)[number];

export type MeteringOutcome =
  | { kind: 'SESSION_STARTED'; sessionId: string }
  | { kind: 'ACCEPTED'; reading: MeterReading; charge: MeasurementCharge }
  | { kind: 'SESSION_ENDED'; sessionId: string }
  | { kind: 'REJECTED'; reasonCode: MeteringRefusalCode; details: string };

export interface MeteringPort {
  apply(event: SimulatedOcppEvent): Promise<MeteringOutcome>;
}

/** The only holder of meter signing capability. The verification path never sees it. */
export interface MeterSigner {
  readonly keyId: string;
  sign(message: Uint8Array): Uint8Array;
}
