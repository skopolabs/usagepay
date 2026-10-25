import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  DecimalStringSchema,
  IdentifierSchema,
  IsoTimeSchema,
  ReadingCoverageSchema,
  TariffFieldsSchema,
} from '@usagepay/contracts';

const ExpectedValuesSchema = z.strictObject({
  deltaWh: DecimalStringSchema,
  cumulativeWh: DecimalStringSchema,
  cumulativeChargeBaseUnits: DecimalStringSchema,
  deltaChargeBaseUnits: DecimalStringSchema,
});

export const GoldenInputsSchema = z.strictObject({
  schema: z.literal('usagepay.fixture-inputs.v1'),
  evidenceClass: z.literal('OFFLINE_FIXTURE'),
  notice: z.string(),
  session: z.strictObject({
    fixtureId: z.string(),
    sessionId: IdentifierSchema,
    machineId: IdentifierSchema,
    domain: z.literal('ev.ocpp2x'),
    startedAt: IsoTimeSchema,
    meterStartWh: DecimalStringSchema,
  }),
  meter: z.strictObject({ signerKeyId: IdentifierSchema }),
  tariff: TariffFieldsSchema,
  tariffNotes: z.string(),
  intervals: z.array(
    z.strictObject({
      readingId: IdentifierSchema,
      observedAt: IsoTimeSchema,
      intervalStart: IsoTimeSchema,
      intervalEnd: IsoTimeSchema,
      meterStartWh: DecimalStringSchema,
      meterEndWh: DecimalStringSchema,
      coverage: ReadingCoverageSchema,
      expected: ExpectedValuesSchema,
    }),
  ),
  e0FinalizedAt: IsoTimeSchema,
  budgetCase: z.strictObject({
    fixtureId: z.string(),
    capBaseUnits: DecimalStringSchema,
    approvedReadingIds: z.array(IdentifierSchema),
    rejectedReadingId: IdentifierSchema,
    expectedReasonCode: z.string(),
    expectedHighestApprovedBaseUnits: DecimalStringSchema,
  }),
});
export type GoldenInputs = z.output<typeof GoldenInputsSchema>;

/** Directory of the committed v1 fixture files (works from both `src/` and `dist/`). */
export const FIXTURES_V1_DIR = new URL('../v1/', import.meta.url);

export function readFixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES_V1_DIR), 'utf8'));
}

export function loadGoldenInputs(): GoldenInputs {
  return GoldenInputsSchema.parse(readFixtureJson('golden-inputs.json'));
}
