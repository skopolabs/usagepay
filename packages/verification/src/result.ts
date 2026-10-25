import type { VerificationResult, VerifierCheckId } from '@usagepay/contracts';

/** SPEC 03 §3 checks, in normative order. */
export const CHECK_IDS = [
  'V01_SCHEMA',
  'V02_METER',
  'V03_TARIFF',
  'V04_EVIDENCE',
  'V05_MPP',
  'V06_PAYER_ACK',
  'V07_E0_E1_LINK',
  'V08_CHAIN',
] as const satisfies readonly VerifierCheckId[];
export type CheckId = (typeof CHECK_IDS)[number];

/** Stable, module-local reason codes (SPEC 03 §4 plus the precise codes this module adds). */
export const VERIFIER_REASON_CODES = [
  'CHECK_PASSED',
  'ALL_CHECKS_PASSED',
  'INVALID_SCHEMA',
  'UNKNOWN_METER_KEY',
  'INVALID_METER_SIGNATURE',
  'SIGNED_PAYLOAD_MISMATCH',
  'COUNTER_DISCONTINUITY',
  'TARIFF_DIGEST_MISMATCH',
  'TARIFF_NOT_ACTIVE',
  'ASSET_MISMATCH',
  'CHARGE_REPLAY_MISMATCH',
  'BUDGET_EXCEEDED',
  'SESSION_MISMATCH',
  'EVIDENCE_DIGEST_MISMATCH',
  'NON_MONOTONIC_CUMULATIVE',
  'NATIVE_COMMITMENT_INVALID',
  'PAYER_ACK_INVALID',
  'E0_DIGEST_MISMATCH',
  'CHAIN_MISMATCH',
  'SETTLEMENT_FAILED',
  'RPC_UNAVAILABLE',
  'SETTLEMENT_NOT_PROVABLE',
  'CHAIN_NOT_QUERIED',
  'PRECONDITION_FAILED',
] as const;
export type VerifierReasonCode = (typeof VERIFIER_REASON_CODES)[number];

/** One violated condition. A check reports its first issue's code and every issue in `details`. */
export interface Issue {
  readonly code: VerifierReasonCode;
  readonly detail: string;
}

export function pass(details: string): VerificationResult {
  return { status: 'PASS', reasonCode: 'CHECK_PASSED', details };
}

export function notAvailable(code: VerifierReasonCode, details: string): VerificationResult {
  return { status: 'NOT_AVAILABLE', reasonCode: code, details };
}

/** FAIL on any issue (never hidden behind a later pass), otherwise PASS with `passDetails`. */
export function fromIssues(issues: readonly Issue[], passDetails: string): VerificationResult {
  const [first] = issues;
  if (first === undefined) return pass(passDetails);
  return { status: 'FAIL', reasonCode: first.code, details: issues.map((issue) => issue.detail).join('; ') };
}

/** SPEC 03 §4 verdict precedence: FAIL > NOT_AVAILABLE > PASS; PASS only when every check passes. */
export function overallVerdict(checks: Readonly<Record<CheckId, VerificationResult>>): VerificationResult {
  const failed = CHECK_IDS.filter((id) => checks[id].status === 'FAIL');
  const firstFailed = failed[0];
  if (firstFailed !== undefined) {
    return { status: 'FAIL', reasonCode: checks[firstFailed].reasonCode, details: `failed: ${failed.join(', ')}` };
  }
  const unavailable = CHECK_IDS.filter((id) => checks[id].status === 'NOT_AVAILABLE');
  const firstUnavailable = unavailable[0];
  if (firstUnavailable !== undefined) {
    return { status: 'NOT_AVAILABLE', reasonCode: checks[firstUnavailable].reasonCode, details: `not provable: ${unavailable.join(', ')}` };
  }
  return { status: 'PASS', reasonCode: 'ALL_CHECKS_PASSED', details: 'V01-V08 passed for the one-close Testnet scope' };
}
