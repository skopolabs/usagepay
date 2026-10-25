/**
 * SPEC 02 §4 module-local refusal codes, plus the three SPEC 01 meter-evidence codes that the frozen
 * authorization catalogue (`AUTHORIZATION_CRITICAL_CONDITIONS`) assigns to the payer for AC05, AC06 and AC10.
 */
export const PAYER_REFUSAL_CODES = [
  'BUDGET_EXCEEDED',
  'CHANNEL_NOT_PINNED',
  'NETWORK_MISMATCH',
  'ASSET_MISMATCH',
  'RECIPIENT_MISMATCH',
  'DEPOSIT_INSUFFICIENT',
  'TARIFF_DIGEST_MISMATCH',
  'EVIDENCE_DIGEST_MISMATCH',
  'CHARGE_MISMATCH',
  'CUMULATIVE_NOT_MONOTONIC',
  'INVALID_NATIVE_CREDENTIAL',
  'INVALID_NATIVE_SIGNATURE',
  'INVALID_PAYER_ACK',
  'REPLAY_NONCE',
  'PAYMENT_NOT_ACCEPTED',
  'E0_ALREADY_FINALIZED',
  'SETTLEMENT_PENDING',
  'SETTLEMENT_FAILED',
  'RPC_UNAVAILABLE',
  'SDK_CAPTURE_UNAVAILABLE',
  'INVALID_METER_SIGNATURE',
  'SIGNED_PAYLOAD_MISMATCH',
  'DUPLICATE_READING',
] as const;
export type PayerRefusalCode = (typeof PAYER_REFUSAL_CODES)[number];

/** A typed refusal. `null` from a check function means "no violation". */
export interface Refusal {
  readonly code: PayerRefusalCode;
  readonly details: string;
}

export function refusal(code: PayerRefusalCode, details: string): Refusal {
  return { code, details };
}
