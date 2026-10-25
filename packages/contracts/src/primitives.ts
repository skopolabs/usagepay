import { z } from 'zod';
import { base64ToBytes, isStellarAccountId, isStellarContractId } from './encoding.js';

/** The only network UsagePay v1 accepts anywhere (CAIP-2 identifier used by `@stellar/mpp`). */
export const NETWORK = 'stellar:testnet' as const;
export const NetworkSchema = z.literal(NETWORK, { error: `network must be exactly "${NETWORK}"` });

/** Largest Soroban i128 value; every amount and energy counter must fit the on-chain integer type. */
export const MAX_DECIMAL_VALUE = 2n ** 127n - 1n;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,38})$/;

/** Nonnegative base-10 integer string: no sign, exponent, decimal point, whitespace or leading zero. */
export const DecimalStringSchema = z
  .string()
  .regex(DECIMAL_PATTERN, 'expected a nonnegative base-10 integer string (no sign, exponent, point or leading zero)')
  .refine((value) => !DECIMAL_PATTERN.test(value) || BigInt(value) <= MAX_DECIMAL_VALUE, 'integer exceeds the i128 maximum (2^127 - 1)');

export const PositiveDecimalStringSchema = DecimalStringSchema.refine(
  (value) => value !== '0',
  'expected a strictly positive integer string',
);

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** SHA-256 digest: 64 lowercase hex characters, no `0x`. */
export const Sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN, 'expected 64 lowercase hex characters (SHA-256, no 0x)');

/** Standard padded canonical base64 decoding to at least `min` and at most `max` bytes. */
export function base64Schema(options: { min: number; max: number; exact?: number }) {
  return z.string().superRefine((value, ctx) => {
    let length: number;
    try {
      length = base64ToBytes(value).length;
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: `invalid base64: ${(error as Error).message}` });
      return;
    }
    if (options.exact !== undefined && length !== options.exact) {
      ctx.addIssue({ code: 'custom', message: `expected exactly ${options.exact} decoded bytes, got ${length}` });
    } else if (length < options.min || length > options.max) {
      ctx.addIssue({ code: 'custom', message: `expected ${options.min}..${options.max} decoded bytes, got ${length}` });
    }
  });
}

/** Detached Ed25519 signature: exactly 64 bytes as canonical base64. */
export const Ed25519SignatureB64Schema = base64Schema({ min: 64, max: 64, exact: 64 });

const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** UTC instant in the single normalized form `YYYY-MM-DDTHH:mm:ss.sssZ` (what `Date#toISOString` emits). */
export const IsoTimeSchema = z
  .string()
  .regex(ISO_TIME_PATTERN, 'expected normalized UTC time YYYY-MM-DDTHH:mm:ss.sssZ')
  .refine((value) => {
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.toISOString() === value;
  }, 'not a real calendar instant');

export function isoTimeMs(value: string): number {
  return new Date(value).getTime();
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Stable identifier (session, reading, machine, tariff, key): 1..128 chars of `[A-Za-z0-9._:-]`. */
export const IdentifierSchema = z
  .string()
  .regex(IDENTIFIER_PATTERN, 'expected identifier of 1..128 chars [A-Za-z0-9._:-] starting with an alphanumeric');

/** Minimum ack nonce entropy: 16 bytes from a cryptographically secure RNG. */
export const MIN_NONCE_BYTES = 16;
export const MAX_NONCE_BYTES = 64;
const NONCE_PATTERN = /^(?:[0-9a-f]{2}){16,64}$/;

/**
 * Payer ack nonce: lowercase hex of 16..64 bytes. The schema can only check the encoding and length; the payer
 * must produce it with `generateAckNonce()` (CSPRNG), and uniqueness per (channelId, sessionId) is enforced by
 * the payer before signing and re-checked by the verifier.
 */
export const NonceSchema = z
  .string()
  .regex(NONCE_PATTERN, 'nonce must be lowercase hex encoding 16..64 random bytes (32..128 hex characters)');

export const StellarAccountIdSchema = z
  .string()
  .refine(isStellarAccountId, 'expected a checksummed Stellar ed25519 account ID (G...)');

export const StellarContractIdSchema = z
  .string()
  .refine(isStellarContractId, 'expected a checksummed Stellar contract address (C...); a classic G... issuer is not a SAC');
