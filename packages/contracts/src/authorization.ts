/**
 * Frozen catalogue of authorization-critical conditions (contract v1).
 *
 * Schemas stay structural. Every condition below is semantic and MUST be evaluated by the payer (SPEC 02)
 * before it signs — the native MPP commitment for stage `before-native-commitment`, the payer evidence ack for
 * stage `before-payer-ack` — and MUST be re-evaluated by the independent verifier (SPEC 03) from E0/E1 and its
 * own pinned trust inputs. Neither side may rely on the other's result or on a stored flag.
 *
 * This file is data, not an implementation: the payer and the verifier implement their checks independently and
 * both must reject every case in `@usagepay/fixtures` `buildAuthorizationConformanceCases()`.
 */
export type AuthorizationStage = 'before-native-commitment' | 'before-payer-ack';
export type VerifierCheckId =
  | 'V01_SCHEMA'
  | 'V02_METER'
  | 'V03_TARIFF'
  | 'V04_EVIDENCE'
  | 'V05_MPP'
  | 'V06_PAYER_ACK'
  | 'V07_E0_E1_LINK'
  | 'V08_CHAIN';

export interface AuthorizationCondition {
  readonly id: string;
  readonly stage: AuthorizationStage;
  readonly rule: string;
  /** Refusal code the payer returns (SPEC 01/02 vocabulary). */
  readonly payerReasonCode: string;
  /** Verifier checks that must re-evaluate the condition. */
  readonly verifierChecks: readonly VerifierCheckId[];
  /** Present only where the current SPEC 03 trust inputs cannot yet express the re-check. */
  readonly verifierGap?: string;
}

export const AUTHORIZATION_CRITICAL_CONDITIONS = [
  {
    id: 'AC01_CHANNEL_PINNED',
    stage: 'before-native-commitment',
    rule: 'Commitment and ack channelId equal the independently pinned channel contract.',
    payerReasonCode: 'CHANNEL_NOT_PINNED',
    verifierChecks: ['V05_MPP', 'V06_PAYER_ACK', 'V07_E0_E1_LINK', 'V08_CHAIN'],
  },
  {
    id: 'AC02_NETWORK_PINNED',
    stage: 'before-native-commitment',
    rule: 'Commitment and ack network equal the pinned network (stellar:testnet).',
    payerReasonCode: 'NETWORK_MISMATCH',
    verifierChecks: ['V01_SCHEMA', 'V05_MPP', 'V06_PAYER_ACK', 'V07_E0_E1_LINK'],
  },
  {
    id: 'AC03_ASSET_PINNED',
    stage: 'before-native-commitment',
    rule: 'Tariff assetSac equals the pinned asset SAC (C...), never a classic issuer.',
    payerReasonCode: 'ASSET_MISMATCH',
    verifierChecks: ['V03_TARIFF', 'V07_E0_E1_LINK', 'V08_CHAIN'],
  },
  {
    id: 'AC04_TARIFF_PINNED_AND_ACTIVE',
    stage: 'before-native-commitment',
    rule:
      'Tariff versionDigest recomputes, equals the pinned tariff digest and the charge tariffVersionDigest, and the ' +
      'reading interval lies within [validFrom, validUntil).',
    payerReasonCode: 'TARIFF_DIGEST_MISMATCH',
    verifierChecks: ['V03_TARIFF'],
  },
  {
    id: 'AC05_METER_SIGNATURE',
    stage: 'before-native-commitment',
    rule: 'signerKeyId is in the pinned meter registry and its key verifies signatureB64 over the exact decoded rawPayloadB64 bytes.',
    payerReasonCode: 'INVALID_METER_SIGNATURE',
    verifierChecks: ['V02_METER'],
  },
  {
    id: 'AC06_SIGNED_SOURCE_MATCHES_READING',
    stage: 'before-native-commitment',
    rule:
      'The decoded signed payload is canonical and its domain, sessionId, machineId, readingId, observedAt, interval ' +
      'and meterEndWh - meterStartWh equal the reading fields.',
    payerReasonCode: 'SIGNED_PAYLOAD_MISMATCH',
    verifierChecks: ['V02_METER'],
  },
  {
    id: 'AC07_READING_DIGEST',
    stage: 'before-native-commitment',
    rule: 'charge.readingDigest equals SHA-256(JCS(reading)).',
    payerReasonCode: 'EVIDENCE_DIGEST_MISMATCH',
    verifierChecks: ['V04_EVIDENCE'],
  },
  {
    id: 'AC08_CHARGE_REPLAY',
    stage: 'before-native-commitment',
    rule:
      'cumulativeWh = prior cumulativeWh + deltaWh; cumulativeChargeBaseUnits = floor(cumulativeWh * price / 1000); ' +
      'deltaChargeBaseUnits = cumulative - prior approved cumulative (bigint).',
    payerReasonCode: 'CHARGE_MISMATCH',
    verifierChecks: ['V03_TARIFF'],
  },
  {
    id: 'AC09_EVIDENCE_DIGEST',
    stage: 'before-native-commitment',
    rule: 'charge.evidenceDigest equals the digest of the exact seven-key SPEC 00 preimage.',
    payerReasonCode: 'EVIDENCE_DIGEST_MISMATCH',
    verifierChecks: ['V04_EVIDENCE'],
  },
  {
    id: 'AC10_READING_NEW_AND_CONTIGUOUS',
    stage: 'before-native-commitment',
    rule:
      '(domain, sessionId, readingId) was never authorized; no increment follows a terminal_signed reading; the ' +
      'interval starts at the prior interval end and the signed start counter equals the prior signed end counter.',
    payerReasonCode: 'DUPLICATE_READING',
    verifierChecks: ['V01_SCHEMA', 'V02_METER', 'V04_EVIDENCE'],
  },
  {
    id: 'AC11_SESSION_CONSISTENT',
    stage: 'before-native-commitment',
    rule: 'reading.sessionId and charge.sessionId equal the pinned session of the channel/E0.',
    payerReasonCode: 'CHARGE_MISMATCH',
    verifierChecks: ['V04_EVIDENCE'],
  },
  {
    id: 'AC12_CUMULATIVE_STRICTLY_INCREASING',
    stage: 'before-native-commitment',
    rule: 'The new cumulative amount is strictly greater than the highest previously approved cumulative amount.',
    payerReasonCode: 'CUMULATIVE_NOT_MONOTONIC',
    verifierChecks: ['V04_EVIDENCE', 'V05_MPP'],
  },
  {
    id: 'AC13_BUDGET_CAP',
    stage: 'before-native-commitment',
    rule: 'The new cumulative amount does not exceed the fleet budget cap.',
    payerReasonCode: 'BUDGET_EXCEEDED',
    verifierChecks: [],
    verifierGap:
      'SPEC 03 trust inputs do not yet include the fleet budget cap; it must be injected as a pinned verifier trust ' +
      'input in G2 before the verifier can re-check this condition.',
  },
  {
    id: 'AC14_NATIVE_COMMITMENT_BINDS',
    stage: 'before-payer-ack',
    rule:
      'The native signed message (pinned SDK encoding) binds the pinned channel, network, domain and an amount equal to ' +
      'charge.cumulativeChargeBaseUnits, and verifies under the pinned commitment key.',
    payerReasonCode: 'INVALID_NATIVE_SIGNATURE',
    verifierChecks: ['V05_MPP', 'V08_CHAIN'],
  },
  {
    id: 'AC15_COMMITMENT_DIGEST',
    stage: 'before-payer-ack',
    rule: 'commitmentDigest recomputes from {signedMessageB64, signatureB64} and the ack binds that recomputed digest.',
    payerReasonCode: 'INVALID_NATIVE_CREDENTIAL',
    verifierChecks: ['V05_MPP', 'V06_PAYER_ACK'],
  },
  {
    id: 'AC16_ACK_BINDING',
    stage: 'before-payer-ack',
    rule:
      'ack evidenceDigest, approvedCumulativeBaseUnits, sessionId, channelId and network equal the charge/commitment ' +
      'values, and payerKey equals the pinned commitment key.',
    payerReasonCode: 'INVALID_PAYER_ACK',
    verifierChecks: ['V06_PAYER_ACK'],
  },
  {
    id: 'AC17_NONCE_FRESH',
    stage: 'before-payer-ack',
    rule: 'The nonce comes from generateAckNonce() (CSPRNG, >= 16 bytes) and is unique per (channelId, sessionId).',
    payerReasonCode: 'REPLAY_NONCE',
    verifierChecks: ['V01_SCHEMA', 'V06_PAYER_ACK'],
  },
] as const satisfies readonly AuthorizationCondition[];

export type AuthorizationConditionId = (typeof AUTHORIZATION_CRITICAL_CONDITIONS)[number]['id'];
