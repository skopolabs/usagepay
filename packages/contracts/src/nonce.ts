import { bytesToHex } from './encoding.js';
import { MAX_NONCE_BYTES, MIN_NONCE_BYTES } from './primitives.js';

/** Fresh payer ack nonce from the platform CSPRNG (`crypto.getRandomValues`), lowercase hex. */
export function generateAckNonce(byteLength: number = MIN_NONCE_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < MIN_NONCE_BYTES || byteLength > MAX_NONCE_BYTES) {
    throw new RangeError(`nonce length must be ${MIN_NONCE_BYTES}..${MAX_NONCE_BYTES} bytes`);
  }
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}
