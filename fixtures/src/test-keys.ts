import { ed25519 } from '@noble/curves/ed25519.js';
import { publicKeyToAccountId, sha256Hex, utf8Bytes, hexToBytes } from '@usagepay/contracts';

/**
 * TEST-ONLY deterministic Ed25519 identities for OFFLINE_FIXTURE data.
 *
 * Seeds are SHA-256 of public labels, so anyone can recompute them: these keys must never hold funds, never be
 * used on Testnet and never sign anything presented as a real payment. G1+ generates disposable Testnet
 * identities at runtime instead.
 */
export interface TestKey {
  readonly label: string;
  readonly publicKey: Uint8Array;
  readonly accountId: string;
  sign(message: Uint8Array): Uint8Array;
}

function deriveTestKey(label: string): TestKey {
  const seed = hexToBytes(sha256Hex(utf8Bytes(label)));
  const publicKey = ed25519.getPublicKey(seed);
  return {
    label,
    publicKey,
    accountId: publicKeyToAccountId(publicKey),
    sign: (message) => ed25519.sign(message, seed),
  };
}

/** Simulated meter key pinned in the trusted registry under `test-meter-01`. */
export const TEST_ONLY_METER_KEY = deriveTestKey('usagepay.test-only.meter-key.v1:test-meter-01');
/** A key absent from the trusted registry (F1-B). */
export const TEST_ONLY_UNTRUSTED_METER_KEY = deriveTestKey('usagepay.test-only.untrusted-meter-key.v1');
/** Offline stand-in for the fleet-controlled channel commitment key. Never funded, never on Testnet. */
export const TEST_ONLY_PAYER_KEY = deriveTestKey('usagepay.test-only.payer-key.v1');

/** Pinned meter public-key registry (key ID → raw public key). Holds public keys only. */
export const TRUSTED_METER_KEYS: ReadonlyMap<string, Uint8Array> = new Map([['test-meter-01', TEST_ONLY_METER_KEY.publicKey]]);
