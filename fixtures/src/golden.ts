import {
  AuthorizedIncrementSchema,
  EvidenceE0Schema,
  MeasurementChargeSchema,
  MeterReadingSchema,
  NETWORK,
  NativeCommitmentSchema,
  PayerEvidenceAckSchema,
  TariffSnapshotSchema,
  bigIntToDecimal,
  bytesToBase64,
  canonicalize,
  computeCommitmentDigest,
  computeEvidenceDigest,
  computeReadingDigest,
  computeTariffVersionDigest,
  contractIdFromBytes,
  cumulativeChargeBaseUnits,
  decimalToBigInt,
  encodeSimMeterPayload,
  hexToBytes,
  payerAckSigningMessage,
  sha256Hex,
  utf8Bytes,
  type AuthorizedIncrement,
  type EvidenceE0,
  type MeasurementCharge,
  type MeterReading,
  type NativeCommitment,
  type PayerEvidenceAck,
  type PayerEvidenceAckUnsigned,
  type SimMeterPayload,
  type TariffSnapshot,
} from '@usagepay/contracts';
import { loadGoldenInputs, type GoldenInputs } from './inputs.js';
import { TEST_ONLY_METER_KEY, TEST_ONLY_PAYER_KEY, type TestKey } from './test-keys.js';

/**
 * Deterministic S1 golden session built from committed inputs and TEST-ONLY keys (evidence class OFFLINE_FIXTURE).
 *
 * The meter side mirrors the SPEC 01 §3.2 simulator profile so module owners can compare against exact vectors.
 * The "native commitment" here is an explicitly labelled offline stand-in: its signed message is NOT the pinned
 * SDK's XDR `ScVal::Map` commitment and it must fail any real V05_MPP check. Real commitments are captured in G1+.
 */
export const OFFLINE_COMMITMENT_DOMAIN = 'usagepay.offline-fixture.NOT-AN-MPP-COMMITMENT.v1\n';

/** Synthetic, schema-valid channel contract address used only by offline fixtures. */
export const OFFLINE_FIXTURE_CHANNEL_ID = contractIdFromBytes(
  hexToBytes(sha256Hex(utf8Bytes('usagepay.offline-fixture.channel.v1'))),
);

export interface GoldenSession {
  readonly inputs: GoldenInputs;
  readonly tariff: TariffSnapshot;
  readonly payloads: readonly SimMeterPayload[];
  readonly readings: readonly MeterReading[];
  readonly charges: readonly MeasurementCharge[];
  readonly commitments: readonly NativeCommitment[];
  readonly acks: readonly PayerEvidenceAck[];
  readonly increments: readonly AuthorizedIncrement[];
  readonly e0: EvidenceE0;
}

export function buildTariff(inputs: GoldenInputs): TariffSnapshot {
  return TariffSnapshotSchema.parse({ ...inputs.tariff, versionDigest: computeTariffVersionDigest(inputs.tariff) });
}

export function buildSignedReading(
  payload: SimMeterPayload,
  coverage: MeterReading['coverage'],
  signerKeyId: string,
  signer: TestKey,
): MeterReading {
  const raw = encodeSimMeterPayload(payload);
  return MeterReadingSchema.parse({
    schema: 'usagepay.reading.v1',
    readingId: payload.readingId,
    sessionId: payload.sessionId,
    machineId: payload.machineId,
    domain: payload.domain,
    observedAt: payload.observedAt,
    intervalStart: payload.intervalStart,
    intervalEnd: payload.intervalEnd,
    deltaWh: bigIntToDecimal(decimalToBigInt(payload.meterEndWh) - decimalToBigInt(payload.meterStartWh)),
    rawPayloadB64: bytesToBase64(raw),
    signatureB64: bytesToBase64(signer.sign(raw)),
    signerKeyId,
    assurance: 'L2',
    coverage,
    certification: 'simulated',
  });
}

export function buildOfflineCommitment(channelId: string, cumulativeAmountBaseUnits: string, payer: TestKey): NativeCommitment {
  const message = utf8Bytes(
    OFFLINE_COMMITMENT_DOMAIN + canonicalize({ channelId, network: NETWORK, cumulativeAmountBaseUnits }),
  );
  const signedMessageB64 = bytesToBase64(message);
  const signatureB64 = bytesToBase64(payer.sign(message));
  return NativeCommitmentSchema.parse({
    schema: 'usagepay.native-commitment.v1',
    channelId,
    network: NETWORK,
    cumulativeAmountBaseUnits,
    signedMessageB64,
    signatureB64,
    commitmentKey: payer.accountId,
    commitmentDigest: computeCommitmentDigest({ signedMessageB64, signatureB64 }),
  });
}

export function signPayerAck(unsigned: PayerEvidenceAckUnsigned, payer: TestKey): PayerEvidenceAck {
  return PayerEvidenceAckSchema.parse({
    ...unsigned,
    signatureB64: bytesToBase64(payer.sign(payerAckSigningMessage(unsigned))),
  });
}

/**
 * Deterministic 16-byte nonce for OFFLINE_FIXTURE acks only, so vectors stay reproducible. A real payer must use
 * `generateAckNonce()` (CSPRNG); a predictable nonce like this one is never acceptable outside fixtures.
 */
export function fixtureNonce(sessionId: string, readingId: string): string {
  return sha256Hex(utf8Bytes(`usagepay.test-only.fixture-nonce.v1:${sessionId}:${readingId}`)).slice(0, 32);
}

export interface GoldenSessionOptions {
  /** Meter key that signs the source payloads (defaults to the pinned TEST_ONLY_METER_KEY). */
  readonly meterSigner?: TestKey;
}

export function buildGoldenSession(
  inputs: GoldenInputs = loadGoldenInputs(),
  options: GoldenSessionOptions = {},
): GoldenSession {
  const tariff = buildTariff(inputs);
  const price = decimalToBigInt(tariff.pricePerKwhBaseUnits);
  const { session } = inputs;

  const payloads: SimMeterPayload[] = [];
  const readings: MeterReading[] = [];
  const charges: MeasurementCharge[] = [];
  const commitments: NativeCommitment[] = [];
  const acks: PayerEvidenceAck[] = [];
  const increments: AuthorizedIncrement[] = [];

  let cumulativeWh = 0n;
  let priorCharge = 0n;
  inputs.intervals.forEach((interval, index) => {
    const payload: SimMeterPayload = {
      schema: 'usagepay.sim-meter-payload.v1',
      domain: session.domain,
      sessionId: session.sessionId,
      machineId: session.machineId,
      readingId: interval.readingId,
      observedAt: interval.observedAt,
      intervalStart: interval.intervalStart,
      intervalEnd: interval.intervalEnd,
      meterStartWh: interval.meterStartWh,
      meterEndWh: interval.meterEndWh,
      unit: 'Wh',
    };
    const reading = buildSignedReading(
      payload,
      interval.coverage,
      inputs.meter.signerKeyId,
      options.meterSigner ?? TEST_ONLY_METER_KEY,
    );

    cumulativeWh += decimalToBigInt(reading.deltaWh);
    const cumulativeCharge = cumulativeChargeBaseUnits(cumulativeWh, price);
    const readingDigest = computeReadingDigest(reading);
    const evidence = {
      readingDigest,
      tariffVersionDigest: tariff.versionDigest,
      cumulativeWh: bigIntToDecimal(cumulativeWh),
      cumulativeChargeBaseUnits: bigIntToDecimal(cumulativeCharge),
      deltaChargeBaseUnits: bigIntToDecimal(cumulativeCharge - priorCharge),
      sessionId: session.sessionId,
      readingId: reading.readingId,
    };
    const charge = MeasurementChargeSchema.parse({
      schema: 'usagepay.charge.v1',
      readingId: reading.readingId,
      sessionId: session.sessionId,
      readingDigest,
      tariffVersionDigest: tariff.versionDigest,
      cumulativeWh: evidence.cumulativeWh,
      cumulativeChargeBaseUnits: evidence.cumulativeChargeBaseUnits,
      deltaChargeBaseUnits: evidence.deltaChargeBaseUnits,
      evidenceDigest: computeEvidenceDigest(evidence),
    });
    priorCharge = cumulativeCharge;

    const commitment = buildOfflineCommitment(OFFLINE_FIXTURE_CHANNEL_ID, charge.cumulativeChargeBaseUnits, TEST_ONLY_PAYER_KEY);
    const ack = signPayerAck(
      {
        schema: 'usagepay.payer-ack.v1',
        sessionId: session.sessionId,
        network: NETWORK,
        channelId: commitment.channelId,
        evidenceDigest: charge.evidenceDigest,
        commitmentDigest: commitment.commitmentDigest,
        approvedCumulativeBaseUnits: commitment.cumulativeAmountBaseUnits,
        nonce: fixtureNonce(session.sessionId, reading.readingId),
        payerKey: TEST_ONLY_PAYER_KEY.accountId,
      },
      TEST_ONLY_PAYER_KEY,
    );

    payloads.push(payload);
    readings.push(reading);
    charges.push(charge);
    commitments.push(commitment);
    acks.push(ack);
    increments.push(
      AuthorizedIncrementSchema.parse({
        schema: 'usagepay.increment.v1',
        sequence: index + 1,
        reading,
        charge,
        commitment,
        payerAck: ack,
      }),
    );
  });

  const e0 = EvidenceE0Schema.parse({
    schema: 'usagepay.e0.v1',
    sessionId: session.sessionId,
    tariff,
    increments,
    finalizedAt: inputs.e0FinalizedAt,
  });

  return { inputs, tariff, payloads, readings, charges, commitments, acks, increments, e0 };
}
