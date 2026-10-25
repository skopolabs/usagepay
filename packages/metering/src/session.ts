import {
  EncodingError,
  MeasurementChargeSchema,
  MeterReadingSchema,
  SourcePayloadError,
  TariffSnapshotSchema,
  base64ToBytes,
  bigIntToDecimal,
  computeEvidenceDigest,
  computeReadingDigest,
  computeTariffVersionDigest,
  cumulativeChargeBaseUnits,
  decimalToBigInt,
  decodeSimMeterPayload,
  isoTimeMs,
  verifyEd25519,
  type MeasurementCharge,
  type MeterReading,
  type SimMeterPayload,
  type TariffSnapshot,
} from '@usagepay/contracts';
import {
  SimulatedOcppEventSchema,
  type MeteringOutcome,
  type MeteringPort,
  type MeteringRefusalCode,
  type SimulatedOcppEvent,
} from './types.js';

export interface MeteringSessionConfig {
  /** Known simulator identity; a signed payload from any other machine is refused. */
  readonly machineId: string;
  /** Testnet asset SAC fixed by the integration coordinator; the tariff must price in it. */
  readonly expectedAssetSac: string;
  /** Pinned meter public keys by key ID. Public keys only: this module never holds a meter secret. */
  readonly trustedMeterKeys: ReadonlyMap<string, Uint8Array>;
  /** Tariff currently published. Pinned at `Started`; any later version change is refused (P0). */
  readonly currentTariff: () => TariffSnapshot;
}

/** Accepted per-session projection. Local single-process state, not production durability. */
interface Projection {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly tariff: TariffSnapshot;
  readonly price: bigint;
  readonly seenReadingIds: ReadonlySet<string>;
  readonly lastCounterWh: bigint;
  readonly lastIntervalEnd: string;
  readonly cumulativeWh: bigint;
  readonly cumulativeCharge: bigint;
  readonly ended: boolean;
}

class Refusal extends Error {
  readonly reasonCode: MeteringRefusalCode;
  constructor(reasonCode: MeteringRefusalCode, details: string) {
    super(details);
    this.reasonCode = reasonCode;
  }
}

const refuse = (reasonCode: MeteringRefusalCode, details: string): never => {
  throw new Refusal(reasonCode, details);
};

/**
 * SPEC 01 metering core for one simulated EV session. Each event is fully validated against a snapshot of the
 * projection and only a successful outcome replaces it, so a rejected event never mutates accepted usage.
 */
export function createMeteringSession(config: MeteringSessionConfig): MeteringPort {
  let projection: Projection | undefined;

  return {
    async apply(input) {
      try {
        const parsed = SimulatedOcppEventSchema.safeParse(input);
        if (!parsed.success) refuse('UNSUPPORTED_EVENT', `malformed OCPP-shaped event: ${parsed.error.issues[0]?.message ?? ''}`);
        const event = parsed.data as SimulatedOcppEvent;
        const next = step(config, projection, event);
        projection = next.projection;
        return next.outcome;
      } catch (error) {
        if (error instanceof Refusal) return { kind: 'REJECTED', reasonCode: error.reasonCode, details: error.message };
        throw error;
      }
    },
  };
}

function step(
  config: MeteringSessionConfig,
  current: Projection | undefined,
  event: SimulatedOcppEvent,
): { projection: Projection; outcome: MeteringOutcome } {
  if (current?.ended === true) refuse('SESSION_CLOSED', `session ${current.sessionId} has ended`);
  if (event.eventType === 'Started') return start(config, current, event);
  if (current === undefined) return refuse('OUT_OF_ORDER', `${event.eventType} before Started`);
  if (event.usagepaySimulator === undefined) {
    if (event.eventType === 'Updated') refuse('UNSUPPORTED_EVENT', 'Updated event without a signed meter reading');
    if (event.transactionInfo.transactionId !== current.sessionId) {
      refuse('SIGNED_PAYLOAD_MISMATCH', 'Ended event names another transaction');
    }
    return { projection: { ...current, ended: true }, outcome: { kind: 'SESSION_ENDED', sessionId: current.sessionId } };
  }
  return accept(config, current, event);
}

function start(
  config: MeteringSessionConfig,
  current: Projection | undefined,
  event: SimulatedOcppEvent,
): { projection: Projection; outcome: MeteringOutcome } {
  if (current !== undefined) refuse('OUT_OF_ORDER', `session ${current.sessionId} already started`);
  if (event.usagepaySimulator !== undefined) refuse('UNSUPPORTED_EVENT', 'Started must not carry a chargeable reading');
  const register = transportRegisterWh(event);
  if (register === undefined) return refuse('UNSUPPORTED_EVENT', 'Started must carry the initial register value');

  const tariff = pinnableTariff(config, event.timestamp);
  return {
    projection: {
      sessionId: event.transactionInfo.transactionId,
      startedAt: event.timestamp,
      tariff,
      price: decimalToBigInt(tariff.pricePerKwhBaseUnits),
      seenReadingIds: new Set(),
      lastCounterWh: register,
      lastIntervalEnd: event.timestamp,
      cumulativeWh: 0n,
      cumulativeCharge: 0n,
      ended: false,
    },
    outcome: { kind: 'SESSION_STARTED', sessionId: event.transactionInfo.transactionId },
  };
}

function pinnableTariff(config: MeteringSessionConfig, at: string): TariffSnapshot {
  const parsed = TariffSnapshotSchema.safeParse(config.currentTariff());
  if (!parsed.success) return refuse('TARIFF_NOT_ACTIVE', 'published tariff violates the SPEC 00 schema');
  const tariff = parsed.data;
  if (computeTariffVersionDigest(tariff) !== tariff.versionDigest) refuse('TARIFF_NOT_ACTIVE', 'tariff versionDigest does not recompute');
  if (tariff.assetSac !== config.expectedAssetSac) refuse('TARIFF_NOT_ACTIVE', `tariff asset ${tariff.assetSac} is not the pinned SAC`);
  requireActive(tariff, at, at);
  return tariff;
}

function requireActive(tariff: TariffSnapshot, from: string, until: string): void {
  if (isoTimeMs(from) < isoTimeMs(tariff.validFrom) || (tariff.validUntil !== undefined && isoTimeMs(until) > isoTimeMs(tariff.validUntil))) {
    refuse('TARIFF_NOT_ACTIVE', `tariff ${tariff.tariffId} is not valid for [${from}, ${until})`);
  }
}

function transportRegisterWh(event: SimulatedOcppEvent): bigint | undefined {
  const value = event.meterValue[0]?.sampledValue[0]?.value;
  return value === undefined ? undefined : BigInt(value);
}

function accept(
  config: MeteringSessionConfig,
  current: Projection,
  event: SimulatedOcppEvent,
): { projection: Projection; outcome: MeteringOutcome } {
  const signed = event.usagepaySimulator!;

  // 1. Exact source bytes and signature under a pinned key, before any parsed field is trusted.
  let raw: Uint8Array;
  let signature: Uint8Array;
  try {
    raw = base64ToBytes(signed.rawPayloadB64);
    signature = base64ToBytes(signed.signatureB64);
  } catch (error) {
    if (error instanceof EncodingError) return refuse('INVALID_SOURCE_BYTES', `source bytes or signature are not canonical base64`);
    throw error;
  }
  const meterKey = config.trustedMeterKeys.get(signed.signerKeyId);
  if (meterKey === undefined) refuse('UNKNOWN_METER_KEY', `meter key ${signed.signerKeyId} is not pinned`);
  if (!verifyEd25519(meterKey!, raw, signature)) refuse('INVALID_METER_SIGNATURE', `signature does not verify under ${signed.signerKeyId}`);

  // 2. Strict parse; the bytes must already be the canonical JCS encoding.
  let payload: SimMeterPayload;
  try {
    payload = decodeSimMeterPayload(raw);
  } catch (error) {
    if (error instanceof SourcePayloadError) return refuse('INVALID_SOURCE_BYTES', error.message);
    throw error;
  }

  // 3. Unsigned envelope must agree with the signed payload; it can never override it.
  const mismatches = [
    payload.sessionId !== current.sessionId && 'sessionId vs session',
    payload.sessionId !== event.transactionInfo.transactionId && 'sessionId vs transactionId',
    payload.readingId !== signed.readingId && 'readingId',
    payload.machineId !== config.machineId && 'machineId',
    payload.observedAt !== event.timestamp && 'observedAt vs event timestamp',
    payload.observedAt !== event.meterValue[0]?.timestamp && 'observedAt vs meterValue timestamp',
    decimalToBigInt(payload.meterEndWh) !== transportRegisterWh(event) && 'meterEndWh vs transport register',
  ].filter(Boolean);
  if (mismatches.length > 0) refuse('SIGNED_PAYLOAD_MISMATCH', `envelope disagrees with signed payload: ${mismatches.join(', ')}`);

  // 4. Idempotency by (domain, sessionId, readingId) before any usage is added.
  if (current.seenReadingIds.has(payload.readingId)) refuse('DUPLICATE_READING', `reading ${payload.readingId} already accepted`);

  // 5. Interval timeline: strictly increasing, adjacent, half-open, inside the session.
  const start = isoTimeMs(payload.intervalStart);
  const end = isoTimeMs(payload.intervalEnd);
  if (start >= end) refuse('INVALID_INTERVAL', 'intervalStart must precede intervalEnd');
  if (isoTimeMs(payload.observedAt) < end) refuse('INVALID_INTERVAL', 'observedAt precedes intervalEnd');
  if (end <= isoTimeMs(current.lastIntervalEnd)) refuse('OUT_OF_ORDER', `interval ends at or before ${current.lastIntervalEnd}`);
  if (start !== isoTimeMs(current.lastIntervalEnd)) {
    refuse('INVALID_INTERVAL', `interval must start at ${current.lastIntervalEnd} (adjacent, non-overlapping)`);
  }

  // 6. Register continuity; delta is derived from signed absolute counters, never supplied.
  const meterStart = decimalToBigInt(payload.meterStartWh);
  const meterEnd = decimalToBigInt(payload.meterEndWh);
  if (meterEnd <= meterStart || meterStart < current.lastCounterWh) {
    refuse('NON_MONOTONIC_COUNTER', `counter ${payload.meterStartWh} -> ${payload.meterEndWh} does not advance from ${current.lastCounterWh}`);
  }
  if (meterStart !== current.lastCounterWh) refuse('COUNTER_GAP', `interval starts at ${meterStart} Wh, expected ${current.lastCounterWh} Wh`);

  // 7. Pinned tariff, active for the whole interval; cumulative rounded once.
  const published = config.currentTariff();
  if (published.versionDigest !== current.tariff.versionDigest) {
    refuse('TARIFF_CHANGED', `tariff changed mid-session (${current.tariff.versionDigest} -> ${published.versionDigest})`);
  }
  requireActive(current.tariff, payload.intervalStart, payload.intervalEnd);
  const deltaWh = meterEnd - meterStart;
  const cumulativeWh = current.cumulativeWh + deltaWh;
  const cumulativeCharge = cumulativeChargeBaseUnits(cumulativeWh, current.price);
  const deltaCharge = cumulativeCharge - current.cumulativeCharge;
  if (deltaCharge <= 0n) {
    refuse('ZERO_VALUE_INCREMENT', `${deltaWh} Wh prices to ${deltaCharge} base units: unsupported P0 micro-interval`);
  }

  const reading = buildReading(signed.rawPayloadB64, signed.signatureB64, signed.signerKeyId, payload, deltaWh, event.eventType === 'Ended');
  const charge = buildCharge(reading, current.tariff, cumulativeWh, cumulativeCharge, deltaCharge);
  return {
    projection: {
      ...current,
      seenReadingIds: new Set([...current.seenReadingIds, payload.readingId]),
      lastCounterWh: meterEnd,
      lastIntervalEnd: payload.intervalEnd,
      cumulativeWh,
      cumulativeCharge,
      ended: event.eventType === 'Ended',
    },
    outcome: { kind: 'ACCEPTED', reading, charge },
  };
}

function buildReading(
  rawPayloadB64: string,
  signatureB64: string,
  signerKeyId: string,
  payload: SimMeterPayload,
  deltaWh: bigint,
  terminal: boolean,
): MeterReading {
  return MeterReadingSchema.parse({
    schema: 'usagepay.reading.v1',
    readingId: payload.readingId,
    sessionId: payload.sessionId,
    machineId: payload.machineId,
    domain: payload.domain,
    observedAt: payload.observedAt,
    intervalStart: payload.intervalStart,
    intervalEnd: payload.intervalEnd,
    deltaWh: bigIntToDecimal(deltaWh),
    rawPayloadB64,
    signatureB64,
    signerKeyId,
    // L2 only in the sense of a verified signature against the pinned *simulated* key.
    assurance: 'L2',
    coverage: terminal ? 'terminal_signed' : 'intermediate_signed',
    certification: 'simulated',
  });
}

function buildCharge(
  reading: MeterReading,
  tariff: TariffSnapshot,
  cumulativeWh: bigint,
  cumulativeCharge: bigint,
  deltaCharge: bigint,
): MeasurementCharge {
  const preimage = {
    readingDigest: computeReadingDigest(reading),
    tariffVersionDigest: tariff.versionDigest,
    cumulativeWh: bigIntToDecimal(cumulativeWh),
    cumulativeChargeBaseUnits: bigIntToDecimal(cumulativeCharge),
    deltaChargeBaseUnits: bigIntToDecimal(deltaCharge),
    sessionId: reading.sessionId,
    readingId: reading.readingId,
  };
  return MeasurementChargeSchema.parse({ schema: 'usagepay.charge.v1', ...preimage, evidenceDigest: computeEvidenceDigest(preimage) });
}
