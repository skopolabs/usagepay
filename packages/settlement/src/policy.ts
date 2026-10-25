import {
  MeasurementChargeSchema,
  MeterReadingSchema,
  NETWORK,
  TariffSnapshotSchema,
  base64ToBytes,
  computeEvidenceDigest,
  computeReadingDigest,
  computeTariffVersionDigest,
  cumulativeChargeBaseUnits,
  decimalToBigInt,
  decodeSimMeterPayload,
  isoTimeMs,
  verifyMeterReadingSignature,
  type AuthorizedIncrement,
  type MeasurementCharge,
  type MeterReading,
  type SimMeterPayload,
  type TariffSnapshot,
} from '@usagepay/contracts';
import { refusal, type Refusal } from './codes.js';

/**
 * Trust inputs the fleet pins independently of the payee. Field names match `ConformanceTrust` in
 * `@usagepay/fixtures` so the frozen authorization conformance cases apply unchanged.
 */
export interface PayerTrust {
  readonly network: typeof NETWORK;
  readonly sessionId: string;
  readonly channelId: string;
  /** Channel commitment key, which also signs the payer evidence ack (G-address). */
  readonly payerAccountId: string;
  readonly assetSac: string;
  readonly tariffVersionDigest: string;
  readonly meterKeys: ReadonlyMap<string, Uint8Array>;
  readonly budgetCapBaseUnits: string;
}

/** On-chain facts of the channel contract, read through `getChannelState` before the first increment. */
export interface ChannelFacts {
  readonly token: string;
  readonly to: string;
  readonly balance: bigint;
  readonly closeEffectiveAtLedger: number | null;
}

export interface IncrementCandidate {
  readonly reading: MeterReading;
  readonly charge: MeasurementCharge;
  readonly tariff: TariffSnapshot;
  readonly channelId: string;
}

export type PolicyDecision =
  | { readonly approved: true; readonly cumulative: bigint; readonly delta: bigint }
  | { readonly approved: false; readonly refusal: Refusal };

/** Channel pinning that does not depend on any reading: the payee cannot redirect the payout or the token. */
export function checkChannelFacts(trust: PayerTrust & { readonly recipient: string }, facts: ChannelFacts): Refusal | null {
  if (facts.token !== trust.assetSac) return refusal('ASSET_MISMATCH', `channel token ${facts.token} is not the pinned asset SAC`);
  if (facts.to !== trust.recipient) return refusal('RECIPIENT_MISMATCH', `channel pays ${facts.to}, not the pinned recipient`);
  if (facts.closeEffectiveAtLedger !== null) {
    return refusal('DEPOSIT_INSUFFICIENT', `channel is closing at ledger ${facts.closeEffectiveAtLedger}; its deposit is no longer available`);
  }
  return null;
}

/**
 * Every `before-native-commitment` condition of the frozen catalogue (AC01, AC03-AC13), plus the channel deposit.
 * Pure and offline: it decides whether the payer may let the SDK sign a new cumulative commitment at all.
 */
export function evaluateCandidate(
  trust: PayerTrust,
  prior: readonly AuthorizedIncrement[],
  candidate: IncrementCandidate,
  channel?: ChannelFacts,
): PolicyDecision {
  const reject = (code: Refusal['code'], details: string): PolicyDecision => ({ approved: false, refusal: refusal(code, details) });

  if (candidate.channelId !== trust.channelId) return reject('CHANNEL_NOT_PINNED', `channel ${candidate.channelId} is not the pinned channel`);

  const tariffParse = TariffSnapshotSchema.safeParse(candidate.tariff);
  if (!tariffParse.success) return reject('TARIFF_DIGEST_MISMATCH', `tariff is not a SPEC 00 TariffSnapshot: ${tariffParse.error.message}`);
  const readingParse = MeterReadingSchema.safeParse(candidate.reading);
  const chargeParse = MeasurementChargeSchema.safeParse(candidate.charge);
  if (!readingParse.success || !chargeParse.success) {
    return reject('EVIDENCE_DIGEST_MISMATCH', 'reading or charge is not a SPEC 00 record, so its digests cannot be recomputed');
  }
  const tariff = tariffParse.data;
  const reading = readingParse.data;
  const charge = chargeParse.data;

  // AC03, AC04
  if (tariff.assetSac !== trust.assetSac) return reject('ASSET_MISMATCH', `tariff asset ${tariff.assetSac} is not the pinned asset SAC`);
  const { versionDigest: _claimed, ...tariffFields } = tariff;
  const recomputedTariff = computeTariffVersionDigest(tariffFields);
  if (recomputedTariff !== tariff.versionDigest || recomputedTariff !== trust.tariffVersionDigest || charge.tariffVersionDigest !== recomputedTariff) {
    return reject('TARIFF_DIGEST_MISMATCH', 'tariff digest does not recompute, or differs from the pinned tariff or the charge');
  }
  const active =
    isoTimeMs(reading.intervalStart) >= isoTimeMs(tariff.validFrom) &&
    (tariff.validUntil === undefined || isoTimeMs(reading.intervalEnd) <= isoTimeMs(tariff.validUntil));
  if (!active) return reject('TARIFF_DIGEST_MISMATCH', 'pinned tariff is not active for the whole reading interval');

  // AC11
  if (reading.sessionId !== trust.sessionId || charge.sessionId !== trust.sessionId || charge.readingId !== reading.readingId) {
    return reject('CHARGE_MISMATCH', 'reading or charge does not belong to the pinned session and reading');
  }

  // AC05, AC06
  const meterKey = reading.signerKeyId === undefined ? undefined : trust.meterKeys.get(reading.signerKeyId);
  if (meterKey === undefined || !verifyMeterReadingSignature(reading, meterKey)) {
    return reject('INVALID_METER_SIGNATURE', `reading ${reading.readingId} is not signed by a pinned meter key`);
  }
  const payload = signedPayload(reading);
  if (payload === undefined || !payloadMatchesReading(payload, reading)) {
    return reject('SIGNED_PAYLOAD_MISMATCH', `reading ${reading.readingId} fields differ from its signed source bytes`);
  }

  // AC07, AC09
  if (charge.readingDigest !== computeReadingDigest(reading)) return reject('EVIDENCE_DIGEST_MISMATCH', 'readingDigest does not recompute');
  const { schema: _schema, evidenceDigest, ...preimage } = charge;
  if (computeEvidenceDigest(preimage) !== evidenceDigest) return reject('EVIDENCE_DIGEST_MISMATCH', 'evidenceDigest does not recompute');

  // AC10
  const last = prior.at(-1);
  if (prior.some((p) => p.reading.domain === reading.domain && p.reading.sessionId === reading.sessionId && p.reading.readingId === reading.readingId)) {
    return reject('DUPLICATE_READING', `reading ${reading.readingId} was already authorized`);
  }
  if (last !== undefined) {
    if (last.reading.coverage === 'terminal_signed') return reject('DUPLICATE_READING', `reading ${last.reading.readingId} already ended the session`);
    const lastPayload = signedPayload(last.reading);
    if (reading.intervalStart !== last.reading.intervalEnd || lastPayload === undefined || payload.meterStartWh !== lastPayload.meterEndWh) {
      return reject('DUPLICATE_READING', `reading ${reading.readingId} does not continue ${last.reading.readingId} (interval or counter gap)`);
    }
  }

  // AC08, AC12
  const priorWh = last === undefined ? 0n : decimalToBigInt(last.charge.cumulativeWh);
  const priorCumulative = last === undefined ? 0n : decimalToBigInt(last.charge.cumulativeChargeBaseUnits);
  const cumulativeWh = priorWh + decimalToBigInt(reading.deltaWh);
  const cumulative = cumulativeChargeBaseUnits(cumulativeWh, decimalToBigInt(tariff.pricePerKwhBaseUnits));
  if (
    decimalToBigInt(charge.cumulativeWh) !== cumulativeWh ||
    decimalToBigInt(charge.cumulativeChargeBaseUnits) !== cumulative ||
    decimalToBigInt(charge.deltaChargeBaseUnits) !== cumulative - priorCumulative
  ) {
    return reject('CHARGE_MISMATCH', `charge does not replay: expected cumulative ${cumulative} for ${cumulativeWh} Wh`);
  }
  if (cumulative <= priorCumulative) return reject('CUMULATIVE_NOT_MONOTONIC', `cumulative ${cumulative} does not exceed ${priorCumulative}`);

  // AC13 and the channel's funded balance (a budget cap never replaces the deposit)
  if (cumulative > decimalToBigInt(trust.budgetCapBaseUnits)) {
    return reject('BUDGET_EXCEEDED', `cumulative ${cumulative} exceeds the fleet cap ${trust.budgetCapBaseUnits}`);
  }
  if (channel !== undefined && cumulative > channel.balance) {
    return reject('DEPOSIT_INSUFFICIENT', `cumulative ${cumulative} exceeds the channel balance ${channel.balance}`);
  }
  return { approved: true, cumulative, delta: cumulative - priorCumulative };
}

function signedPayload(reading: MeterReading): SimMeterPayload | undefined {
  try {
    return decodeSimMeterPayload(base64ToBytes(reading.rawPayloadB64));
  } catch {
    return undefined;
  }
}

function payloadMatchesReading(payload: SimMeterPayload, reading: MeterReading): boolean {
  return (
    payload.domain === reading.domain &&
    payload.sessionId === reading.sessionId &&
    payload.machineId === reading.machineId &&
    payload.readingId === reading.readingId &&
    payload.observedAt === reading.observedAt &&
    payload.intervalStart === reading.intervalStart &&
    payload.intervalEnd === reading.intervalEnd &&
    decimalToBigInt(payload.meterEndWh) - decimalToBigInt(payload.meterStartWh) === decimalToBigInt(reading.deltaWh)
  );
}
