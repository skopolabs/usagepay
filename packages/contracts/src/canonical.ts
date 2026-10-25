import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), restricted to the value space used by UsagePay contracts.
 *
 * Accepted: null, booleans, well-formed strings, safe integers, arrays and plain objects.
 * Rejected: non-integer or unsafe numbers, -0, NaN/Infinity, bigint, undefined, functions, symbols,
 * lone UTF-16 surrogates and non-plain objects. Monetary and energy values are decimal *strings*, so
 * JSON number precision can never change a digest or signature preimage.
 */
export class CanonicalizationError extends Error {
  constructor(path: string, reason: string) {
    super(`JCS canonicalization refused value at ${path}: ${reason}`);
    this.name = 'CanonicalizationError';
  }
}

export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      if (!value.isWellFormed()) throw new CanonicalizationError(path, 'string contains a lone UTF-16 surrogate');
      // ECMAScript JSON.stringify string escaping is exactly the RFC 8785 string serialization.
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalizationError(path, `number ${String(value)} is not a safe integer; use a DecimalString`);
      }
      if (Object.is(value, -0)) throw new CanonicalizationError(path, 'negative zero is not allowed');
      return String(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError(path, 'only plain objects can be canonicalized');
      }
      const record = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units, which is the RFC 8785 property ordering.
      const keys = Object.keys(record).sort();
      const members = keys.map((key) => {
        if (!key.isWellFormed()) throw new CanonicalizationError(path, 'property name contains a lone UTF-16 surrogate');
        const member = record[key];
        if (member === undefined) {
          throw new CanonicalizationError(`${path}.${key}`, 'undefined is not JSON; omit the property instead');
        }
        return `${JSON.stringify(key)}:${serialize(member, `${path}.${key}`)}`;
      });
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalizationError(path, `${typeof value} is not a JSON value`);
  }
}

const utf8Encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8Bytes(canonicalize(value));
}

/** Lowercase hex SHA-256 of raw bytes. Use this for original source payload bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** Lowercase hex `SHA-256(JCS(value))` (SPEC 00 §5). */
export function jcsDigest(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}
