import { ed25519 } from '@noble/curves/ed25519.js';
import { payerAckSigningMessage } from './digests.js';
import { accountIdToPublicKey, base64ToBytes } from './encoding.js';
import type { MeterReading, PayerEvidenceAck } from './schemas.js';

/**
 * Strict RFC 8032 Ed25519 verification (ZIP-215 relaxations disabled). Returns false, never throws, for
 * malformed keys or signatures so callers can map the outcome to their own reason codes.
 */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Verifies a reading's source signature over the exact decoded `rawPayloadB64` bytes with a pinned meter key. */
export function verifyMeterReadingSignature(reading: MeterReading, pinnedMeterPublicKey: Uint8Array): boolean {
  if (reading.signatureB64 === undefined) return false;
  return verifyEd25519(pinnedMeterPublicKey, base64ToBytes(reading.rawPayloadB64), base64ToBytes(reading.signatureB64));
}

/**
 * Verifies the payer ack signature against the ack's own `payerKey`. Callers must separately require that
 * `payerKey` equals the independently pinned channel commitment key.
 */
export function verifyPayerAckSignature(ack: PayerEvidenceAck): boolean {
  return verifyEd25519(
    accountIdToPublicKey(ack.payerKey),
    payerAckSigningMessage(ack),
    base64ToBytes(ack.signatureB64),
  );
}
