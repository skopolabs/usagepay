import { describe, expect, it } from 'vitest';
import {
  EncodingError,
  accountIdToPublicKey,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  contractIdFromBytes,
  hexToBytes,
  isCanonicalBase64,
  isStellarAccountId,
  isStellarContractId,
  publicKeyToAccountId,
} from '../src/index.js';

const USDC_SAC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
// Circle's classic testnet USDC issuer: a G... account, which must never be mistaken for the C... SAC.
const USDC_CLASSIC_ISSUER_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('strict base64', () => {
  it('round-trips arbitrary bytes, including every padding length', () => {
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it.each([
    ['whitespace', 'QUJD RA=='],
    ['a newline', 'QUJD\nRA=='],
    ['URL-safe alphabet', 'a-_b'],
    ['missing padding', 'QUJDRA'],
    ['non-zero trailing bits (non-canonical spelling of "A")', 'QR=='],
    ['a stray character', 'QUJD*A=='],
  ])('rejects %s so each byte string has exactly one accepted spelling', (_label, text) => {
    expect(() => base64ToBytes(text)).toThrow(EncodingError);
    expect(isCanonicalBase64(text)).toBe(false);
  });
});

describe('strict hex', () => {
  it('round-trips bytes as lowercase hex', () => {
    const bytes = Uint8Array.from([0, 1, 0xab, 0xff]);
    expect(bytesToHex(bytes)).toBe('0001abff');
    expect(hexToBytes('0001abff')).toEqual(bytes);
  });

  it.each([['uppercase', 'ABCD'], ['0x prefix', '0xabcd'], ['odd length', 'abc'], ['non-hex', 'zz']])(
    'rejects %s hex',
    (_label, text) => expect(() => hexToBytes(text)).toThrow(EncodingError),
  );
});

describe('Stellar StrKey identities', () => {
  it('distinguishes the USDC SAC contract (C...) from the classic issuer account (G...)', () => {
    expect(isStellarContractId(USDC_SAC_TESTNET)).toBe(true);
    expect(isStellarAccountId(USDC_SAC_TESTNET)).toBe(false);
    expect(isStellarAccountId(USDC_CLASSIC_ISSUER_TESTNET)).toBe(true);
    expect(isStellarContractId(USDC_CLASSIC_ISSUER_TESTNET)).toBe(false);
  });

  it('rejects a StrKey whose checksum was altered by one character', () => {
    const corrupted = `${USDC_SAC_TESTNET.slice(0, -1)}${USDC_SAC_TESTNET.endsWith('A') ? 'B' : 'A'}`;
    expect(isStellarContractId(corrupted)).toBe(false);
  });

  it('round-trips a raw ed25519 public key through a G... account ID', () => {
    const raw = Uint8Array.from({ length: 32 }, (_, i) => i);
    const accountId = publicKeyToAccountId(raw);
    expect(accountId.startsWith('G')).toBe(true);
    expect(accountIdToPublicKey(accountId)).toEqual(raw);
    expect(isStellarContractId(contractIdFromBytes(raw))).toBe(true);
  });
});
