import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_CRITICAL_CONDITIONS,
  AuthorizedIncrementSchema,
  NETWORK,
  accountIdToPublicKey,
  base64ToBytes,
  canonicalize,
  computeCommitmentDigest,
  computeEvidenceDigest,
  computeReadingDigest,
  computeTariffVersionDigest,
  cumulativeChargeBaseUnits,
  decodeSimMeterPayload,
  isoTimeMs,
  verifyEd25519,
  verifyMeterReadingSignature,
  type AuthorizationConditionId,
  type SimMeterPayload,
} from '@usagepay/contracts';
import { OFFLINE_COMMITMENT_DOMAIN, buildAuthorizationConformanceCases, type ConformanceCase } from '../src/index.js';

/**
 * TEST-ONLY reference oracle. It exists to prove that each conformance fixture violates exactly the declared
 * conditions. It is not the payer or verifier implementation (SPEC 02/03 implement their own checks) and the
 * offline commitment-message check stands in for the pinned SDK XDR encoding used with real credentials.
 */
function violatedConditions({ trust, tariff, prior, candidate }: ConformanceCase): Set<AuthorizationConditionId> {
  const violated = new Set<AuthorizationConditionId>();
  const { reading, charge, commitment, payerAck } = candidate;
  const last = prior.at(-1);
  const big = BigInt;

  if (commitment.channelId !== trust.channelId || payerAck.channelId !== trust.channelId) violated.add('AC01_CHANNEL_PINNED');
  if (commitment.network !== trust.network || payerAck.network !== trust.network) violated.add('AC02_NETWORK_PINNED');
  if (tariff.assetSac !== trust.assetSac) violated.add('AC03_ASSET_PINNED');

  const recomputedTariff = computeTariffVersionDigest(tariff);
  const intervalActive =
    isoTimeMs(reading.intervalStart) >= isoTimeMs(tariff.validFrom) &&
    (tariff.validUntil === undefined || isoTimeMs(reading.intervalEnd) <= isoTimeMs(tariff.validUntil));
  if (recomputedTariff !== tariff.versionDigest || recomputedTariff !== trust.tariffVersionDigest || charge.tariffVersionDigest !== recomputedTariff || !intervalActive) {
    violated.add('AC04_TARIFF_PINNED_AND_ACTIVE');
  }

  const meterKey = reading.signerKeyId === undefined ? undefined : trust.meterKeys.get(reading.signerKeyId);
  if (meterKey === undefined || !verifyMeterReadingSignature(reading, meterKey)) violated.add('AC05_METER_SIGNATURE');

  let payload: SimMeterPayload | undefined;
  try {
    payload = decodeSimMeterPayload(base64ToBytes(reading.rawPayloadB64));
  } catch {
    payload = undefined;
  }
  if (
    payload === undefined ||
    payload.domain !== reading.domain ||
    payload.sessionId !== reading.sessionId ||
    payload.machineId !== reading.machineId ||
    payload.readingId !== reading.readingId ||
    payload.observedAt !== reading.observedAt ||
    payload.intervalStart !== reading.intervalStart ||
    payload.intervalEnd !== reading.intervalEnd ||
    big(payload.meterEndWh) - big(payload.meterStartWh) !== big(reading.deltaWh)
  ) {
    violated.add('AC06_SIGNED_SOURCE_MATCHES_READING');
  }

  if (computeReadingDigest(reading) !== charge.readingDigest) violated.add('AC07_READING_DIGEST');

  const priorWh = last ? big(last.charge.cumulativeWh) : 0n;
  const priorCharge = last ? big(last.charge.cumulativeChargeBaseUnits) : 0n;
  const expectedWh = priorWh + big(reading.deltaWh);
  const expectedCharge = cumulativeChargeBaseUnits(expectedWh, big(tariff.pricePerKwhBaseUnits));
  if (
    big(charge.cumulativeWh) !== expectedWh ||
    big(charge.cumulativeChargeBaseUnits) !== expectedCharge ||
    big(charge.deltaChargeBaseUnits) !== big(charge.cumulativeChargeBaseUnits) - priorCharge
  ) {
    violated.add('AC08_CHARGE_REPLAY');
  }

  const { readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits: cc, deltaChargeBaseUnits, sessionId, readingId } = charge;
  if (computeEvidenceDigest({ readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits: cc, deltaChargeBaseUnits, sessionId, readingId }) !== charge.evidenceDigest) {
    violated.add('AC09_EVIDENCE_DIGEST');
  }

  const lastPayload = last ? decodeSimMeterPayload(base64ToBytes(last.reading.rawPayloadB64)) : undefined;
  if (
    prior.some((p) => p.reading.domain === reading.domain && p.reading.sessionId === reading.sessionId && p.reading.readingId === reading.readingId) ||
    prior.some((p) => p.reading.coverage === 'terminal_signed') ||
    (last !== undefined && reading.intervalStart !== last.reading.intervalEnd) ||
    (lastPayload !== undefined && payload !== undefined && payload.meterStartWh !== lastPayload.meterEndWh)
  ) {
    violated.add('AC10_READING_NEW_AND_CONTIGUOUS');
  }

  if (reading.sessionId !== trust.sessionId || charge.sessionId !== trust.sessionId) violated.add('AC11_SESSION_CONSISTENT');

  const priorApproved = last ? big(last.commitment.cumulativeAmountBaseUnits) : 0n;
  if (big(charge.cumulativeChargeBaseUnits) <= priorApproved || big(commitment.cumulativeAmountBaseUnits) <= priorApproved) {
    violated.add('AC12_CUMULATIVE_STRICTLY_INCREASING');
  }

  if (big(commitment.cumulativeAmountBaseUnits) > big(trust.budgetCapBaseUnits)) violated.add('AC13_BUDGET_CAP');

  const expectedMessage = OFFLINE_COMMITMENT_DOMAIN + canonicalize({ channelId: commitment.channelId, network: commitment.network, cumulativeAmountBaseUnits: commitment.cumulativeAmountBaseUnits });
  const message = base64ToBytes(commitment.signedMessageB64);
  if (
    commitment.commitmentKey !== trust.payerAccountId ||
    !verifyEd25519(accountIdToPublicKey(trust.payerAccountId), message, base64ToBytes(commitment.signatureB64)) ||
    new TextDecoder().decode(message) !== expectedMessage ||
    commitment.cumulativeAmountBaseUnits !== charge.cumulativeChargeBaseUnits
  ) {
    violated.add('AC14_NATIVE_COMMITMENT_BINDS');
  }

  const recomputedCommitment = computeCommitmentDigest(commitment);
  if (recomputedCommitment !== commitment.commitmentDigest || payerAck.commitmentDigest !== recomputedCommitment) violated.add('AC15_COMMITMENT_DIGEST');

  if (
    payerAck.evidenceDigest !== charge.evidenceDigest ||
    payerAck.approvedCumulativeBaseUnits !== commitment.cumulativeAmountBaseUnits ||
    payerAck.approvedCumulativeBaseUnits !== charge.cumulativeChargeBaseUnits ||
    payerAck.sessionId !== charge.sessionId ||
    payerAck.channelId !== commitment.channelId ||
    payerAck.network !== commitment.network ||
    payerAck.payerKey !== trust.payerAccountId
  ) {
    violated.add('AC16_ACK_BINDING');
  }

  if (prior.some((p) => p.payerAck.channelId === payerAck.channelId && p.payerAck.sessionId === payerAck.sessionId && p.payerAck.nonce === payerAck.nonce)) {
    violated.add('AC17_NONCE_FRESH');
  }
  return violated;
}

const cases = buildAuthorizationConformanceCases();
const conditionIds = AUTHORIZATION_CRITICAL_CONDITIONS.map((condition) => condition.id);

// SPEC 01 §5 and SPEC 02 §3 refusal vocabularies.
const KNOWN_PAYER_REASON_CODES = new Set([
  'BUDGET_EXCEEDED', 'CHANNEL_NOT_PINNED', 'NETWORK_MISMATCH', 'ASSET_MISMATCH', 'RECIPIENT_MISMATCH', 'DEPOSIT_INSUFFICIENT',
  'TARIFF_DIGEST_MISMATCH', 'EVIDENCE_DIGEST_MISMATCH', 'CHARGE_MISMATCH', 'CUMULATIVE_NOT_MONOTONIC', 'INVALID_NATIVE_CREDENTIAL',
  'INVALID_NATIVE_SIGNATURE', 'INVALID_PAYER_ACK', 'REPLAY_NONCE', 'INVALID_METER_SIGNATURE', 'UNKNOWN_METER_KEY',
  'SIGNED_PAYLOAD_MISMATCH', 'DUPLICATE_READING',
]);

describe('authorization-critical condition catalogue (frozen v1)', () => {
  it('has unique IDs, a payer signing stage and a known payer refusal code for every condition', () => {
    expect(new Set(conditionIds).size).toBe(conditionIds.length);
    for (const condition of AUTHORIZATION_CRITICAL_CONDITIONS) {
      expect(['before-native-commitment', 'before-payer-ack']).toContain(condition.stage);
      expect(KNOWN_PAYER_REASON_CODES.has(condition.payerReasonCode), condition.id).toBe(true);
    }
  });

  it('requires an independent verifier re-check for every condition, or an explicitly declared gap', () => {
    for (const condition of AUTHORIZATION_CRITICAL_CONDITIONS) {
      const gap = 'verifierGap' in condition ? condition.verifierGap : undefined;
      expect(condition.verifierChecks.length > 0 || (gap !== undefined && gap.length > 0), condition.id).toBe(true);
    }
    const gaps = AUTHORIZATION_CRITICAL_CONDITIONS.filter((condition) => condition.verifierChecks.length === 0).map((c) => c.id);
    expect(gaps).toEqual(['AC13_BUDGET_CAP']);
  });
});

describe('authorization conformance cases [OFFLINE_FIXTURE]', () => {
  it('cover every authorization-critical condition with at least one negative case', () => {
    const covered = new Set(cases.map((c) => c.conditionId));
    for (const id of conditionIds) expect(covered.has(id), `${id} has no conformance case`).toBe(true);
  });

  it.each(cases.filter((c) => c.conditionId === null).map((c) => [c.caseId, c] as const))(
    '%s: positive control is structurally valid and violates no condition',
    (_id, testCase) => {
      expect(AuthorizedIncrementSchema.safeParse(testCase.candidate).success).toBe(true);
      expect([...violatedConditions(testCase)]).toEqual([]);
    },
  );

  it.each(cases.filter((c) => c.conditionId !== null && !c.structurallyRejected).map((c) => [c.caseId, c] as const))(
    '%s: passes the structural schema, so only the semantic payer/verifier check can refuse it',
    (_id, testCase) => {
      expect(AuthorizedIncrementSchema.safeParse(testCase.candidate).success).toBe(true);
      const expected = [testCase.conditionId!, ...testCase.alsoViolates].sort();
      expect([...violatedConditions(testCase)].sort()).toEqual(expected);
    },
  );

  it.each(cases.filter((c) => c.structurallyRejected).map((c) => [c.caseId, c] as const))(
    '%s: rejected already by the structural schema (the payer must still never sign it)',
    (_id, testCase) => {
      expect(AuthorizedIncrementSchema.safeParse(testCase.candidate).success).toBe(false);
      expect(testCase.candidate.commitment.network).not.toBe(NETWORK);
    },
  );
});
