import { StrKey } from '@stellar/stellar-base';

/**
 * Strict, round-trip-testable byte/string conversions shared by every module.
 * Each decoder rejects any input whose re-encoding differs, so a value has exactly one accepted spelling.
 */
export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodingError';
  }
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/;

/** Encodes bytes as standard, padded RFC 4648 base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decodes standard, padded, canonical base64 (no whitespace, URL alphabet or non-zero trailing bits). */
export function base64ToBytes(text: string): Uint8Array {
  if (!BASE64_PATTERN.test(text)) {
    throw new EncodingError('expected standard padded base64 without whitespace or URL-safe characters');
  }
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytesToBase64(bytes) !== text) throw new EncodingError('base64 is not canonical (non-zero trailing bits)');
  return bytes;
}

export function isCanonicalBase64(text: string): boolean {
  try {
    base64ToBytes(text);
    return true;
  } catch {
    return false;
  }
}

/** Encodes bytes as lowercase hex without a `0x` prefix. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Decodes lowercase, even-length hex without a `0x` prefix. */
export function hexToBytes(text: string): Uint8Array {
  if (!HEX_PATTERN.test(text)) throw new EncodingError('expected lowercase even-length hex without 0x prefix');
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** True for a checksummed Stellar ed25519 account public key (`G...`). */
export function isStellarAccountId(text: string): boolean {
  return StrKey.isValidEd25519PublicKey(text);
}

/** True for a checksummed Stellar contract address (`C...`), e.g. a SAC or channel contract. */
export function isStellarContractId(text: string): boolean {
  return StrKey.isValidContract(text);
}

/** Raw 32-byte ed25519 public key behind a `G...` account ID. */
export function accountIdToPublicKey(accountId: string): Uint8Array {
  if (!isStellarAccountId(accountId)) throw new EncodingError(`not a Stellar ed25519 account ID: ${accountId}`);
  return Uint8Array.from(StrKey.decodeEd25519PublicKey(accountId));
}

export function publicKeyToAccountId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new EncodingError('ed25519 public key must be 32 bytes');
  return StrKey.encodeEd25519PublicKey(Buffer.from(publicKey));
}

export function contractIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new EncodingError('contract ID must be 32 bytes');
  return StrKey.encodeContract(Buffer.from(bytes));
}
