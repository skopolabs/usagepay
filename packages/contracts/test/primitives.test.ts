import { describe, expect, it } from 'vitest';
import {
  DecimalStringSchema,
  IdentifierSchema,
  IsoTimeSchema,
  MAX_DECIMAL_VALUE,
  MAX_NONCE_BYTES,
  MIN_NONCE_BYTES,
  NetworkSchema,
  NonceSchema,
  PositiveDecimalStringSchema,
  Sha256HexSchema,
  generateAckNonce,
} from '../src/index.js';

describe('DecimalString (integer amounts and Wh as strings, never floats)', () => {
  it.each(['0', '1', '250', '3000000', MAX_DECIMAL_VALUE.toString()])('accepts canonical integer %s', (value) => {
    expect(DecimalStringSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['leading zero', '0250'],
    ['negative sign', '-1'],
    ['plus sign', '+1'],
    ['decimal point', '1.0'],
    ['fractional kWh', '0.25'],
    ['exponent', '1e6'],
    ['whitespace', ' 1'],
    ['empty string', ''],
    ['hex', '0x10'],
    ['above i128 max', (MAX_DECIMAL_VALUE + 1n).toString()],
  ])('rejects %s (%s)', (_label, value) => {
    expect(DecimalStringSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a JSON number in place of a DecimalString', () => {
    expect(DecimalStringSchema.safeParse(250).success).toBe(false);
  });

  it('PositiveDecimalString rejects zero', () => {
    expect(PositiveDecimalStringSchema.safeParse('0').success).toBe(false);
    expect(PositiveDecimalStringSchema.safeParse('1').success).toBe(true);
  });
});

describe('IsoTime (single normalized UTC spelling)', () => {
  it('accepts YYYY-MM-DDTHH:mm:ss.sssZ', () => {
    expect(IsoTimeSchema.safeParse('2026-10-25T09:00:00.000Z').success).toBe(true);
  });

  it.each([
    ['missing milliseconds', '2026-10-25T09:00:00Z'],
    ['numeric offset instead of Z', '2026-10-25T09:00:00.000+00:00'],
    ['impossible date', '2026-02-30T09:00:00.000Z'],
    ['date only', '2026-10-25'],
    ['lowercase z', '2026-10-25T09:00:00.000z'],
  ])('rejects %s', (_label, value) => {
    expect(IsoTimeSchema.safeParse(value).success).toBe(false);
  });
});

describe('network, digests, identifiers and nonces', () => {
  it.each(['stellar:pubnet', 'stellar:mainnet', 'testnet', 'Stellar:Testnet'])('rejects network %s (Testnet only)', (value) => {
    expect(NetworkSchema.safeParse(value).success).toBe(false);
  });

  it('accepts only 64 lowercase hex characters as a SHA-256 digest', () => {
    expect(Sha256HexSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(Sha256HexSchema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(Sha256HexSchema.safeParse(`0x${'a'.repeat(64)}`).success).toBe(false);
    expect(Sha256HexSchema.safeParse('a'.repeat(63)).success).toBe(false);
  });

  it('accepts fixture-style identifiers and rejects whitespace/slashes/empty', () => {
    for (const id of ['ev-session-001', 'r-001', 'sim-charger-01', 'demo-tariff-usdc-0.40-kwh-v1']) {
      expect(IdentifierSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ['', ' r-001', 'r/001', '-r', 'a'.repeat(129)]) expect(IdentifierSchema.safeParse(id).success).toBe(false);
  });

  it('accepts a CSPRNG nonce of 16..64 bytes as lowercase hex', () => {
    const nonce = generateAckNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(NonceSchema.safeParse(nonce).success).toBe(true);
    expect(NonceSchema.safeParse(generateAckNonce(MAX_NONCE_BYTES)).success).toBe(true);
  });

  it.each([
    ['15 bytes (below the 16-byte minimum)', 'ab'.repeat(15)],
    ['65 bytes (above the maximum)', 'ab'.repeat(65)],
    ['odd hex length', 'a'.repeat(33)],
    ['uppercase hex', 'AB'.repeat(16)],
    ['a human-readable identifier', 'ack-ev-session-001-r-001'],
  ])('rejects nonce with %s', (_label, nonce) => {
    expect(NonceSchema.safeParse(nonce).success).toBe(false);
  });

  it('generateAckNonce returns fresh values and refuses fewer than 16 bytes', () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => generateAckNonce()));
    expect(nonces.size).toBe(1000);
    expect(() => generateAckNonce(MIN_NONCE_BYTES - 1)).toThrow(RangeError);
    expect(() => generateAckNonce(MAX_NONCE_BYTES + 1)).toThrow(RangeError);
  });
});
