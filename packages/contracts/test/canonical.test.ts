import canonicalizeModule from 'canonicalize';
import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalize, jcsDigest, sha256Hex, utf8Bytes } from '../src/index.js';

// canonicalize@2.1.0 is CommonJS (`module.exports = fn`) but its d.ts declares `export default`; the default import is the function.
const canonicalizeReference = canonicalizeModule as unknown as (input: unknown) => string | undefined;

describe('RFC 8785 JCS canonicalization', () => {
  it('sorts properties by UTF-16 code units (RFC 8785 §3.2.3 example) so equal data has one byte encoding', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      'דּ': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      'ö': 'Latin Small Letter O With Diaeresis',
    };
    const order = Object.keys(JSON.parse(canonicalize(input)) as object);
    // JSON.parse re-orders integer-like keys, so check the raw text order instead.
    expect(order).toHaveLength(7);
    const text = canonicalize(input);
    const positions = ['\\r', '"1"', '\u0080', 'ö', '€', '😀', 'דּ'].map((key) => text.indexOf(key));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('escapes strings exactly as RFC 8785 §3.2.2.2 requires (lowercase \\u000f, short escapes, unescaped "/")', () => {
    // Built from code points: the RFC sample contains backslashes and quotes that are easy to mis-escape.
    const input = String.fromCharCode(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f);
    const expected = String.fromCharCode(
      0x22, 0x20ac, 0x24, 0x5c, 0x75, 0x30, 0x30, 0x30, 0x66, 0x5c, 0x6e, 0x41, 0x27, 0x42,
      0x5c, 0x22, 0x5c, 0x5c, 0x5c, 0x5c, 0x5c, 0x22, 0x2f, 0x22,
    );
    expect(canonicalize(input)).toBe(expected);
  });

  it('serializes literals and nested arrays without whitespace', () => {
    expect(canonicalize({ b: [true, false, null], a: { d: 'x', c: 1 } })).toBe('{"a":{"c":1,"d":"x"},"b":[true,false,null]}');
  });

  it('agrees byte-for-byte with the erdtman/canonicalize reference implementation on the supported value space', () => {
    const samples: unknown[] = [
      { z: '1', a: [1, 2, { y: null, x: 'é' }], m: { 'é': 1, e: 2, E: 3, '10': 4, '9': 5 } },
      [' ', '\u0000', 'tab\tline\n', 'emoji 😀', -9007199254740991, 9007199254740991, 0],
      { schema: 'usagepay.reading.v1', deltaWh: '250', nested: { b: false, a: true } },
    ];
    for (const sample of samples) expect(canonicalize(sample)).toBe(canonicalizeReference(sample));
  });

  it('is deterministic: the same value always yields the same digest, regardless of property insertion order', () => {
    const a = { amount: '3000000', channel: 'C', network: 'stellar:testnet' };
    const b = { network: 'stellar:testnet', channel: 'C', amount: '3000000' };
    expect(jcsDigest(a)).toBe(jcsDigest(b));
    expect(jcsDigest(a)).toBe(sha256Hex(utf8Bytes('{"amount":"3000000","channel":"C","network":"stellar:testnet"}')));
  });

  it.each([
    ['a non-integer number (money must be a DecimalString)', { amount: 0.1 }],
    ['an unsafe integer (precision would silently change)', { amount: 2 ** 53 }],
    ['negative zero', { n: -0 }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['a bigint', { n: 1n }],
    ['an undefined property (JSON.stringify would drop it silently)', { a: undefined }],
    ['a lone UTF-16 surrogate in a value', { s: '\ud800' }],
    ['a lone UTF-16 surrogate in a key', { ['\udc00']: 1 }],
    ['a Date (non-plain object)', { d: new Date(0) }],
    ['a Map (non-plain object)', { m: new Map() }],
    ['a function', { f: () => 1 }],
  ])('refuses %s instead of producing an ambiguous encoding', (_label, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });
});
