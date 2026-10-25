import { z } from 'zod';
import { canonicalize, jcsDigest, sha256Hex, utf8Bytes } from './canonical.js';
import { base64ToBytes } from './encoding.js';
import { DecimalStringSchema, IdentifierSchema, Sha256HexSchema } from './primitives.js';
import {
  SimMeterPayloadSchema,
  type EvidenceE0,
  type MeterReading,
  type PayerEvidenceAck,
  type PayerEvidenceAckUnsigned,
  type SimMeterPayload,
  type TariffSnapshot,
} from './schemas.js';

/** SPEC 00 §5 digests and signing preimages. Every digest is lowercase hex `SHA-256(JCS(value))`. */

/** `versionDigest = SHA-256(JCS(tariff without versionDigest))`. Accepts the tariff with or without the field. */
export function computeTariffVersionDigest(
  tariff: Omit<TariffSnapshot, 'versionDigest'> & { versionDigest?: string },
): string {
  const { versionDigest: _excluded, ...fields } = tariff;
  return jcsDigest(fields);
}

/** `readingDigest = SHA-256(JCS(entire frozen MeterReading))`. */
export function computeReadingDigest(reading: MeterReading): string {
  return jcsDigest(reading);
}

/** SHA-256 of the *original decoded* source bytes, never of a reparsed/reserialized payload. */
export function computeRawPayloadDigest(rawPayloadB64: string): string {
  return sha256Hex(base64ToBytes(rawPayloadB64));
}

/** The exact, closed key set of the evidence digest preimage (SPEC 00 §5). */
export const EvidencePreimageSchema = z.strictObject({
  readingDigest: Sha256HexSchema,
  tariffVersionDigest: Sha256HexSchema,
  cumulativeWh: DecimalStringSchema,
  cumulativeChargeBaseUnits: DecimalStringSchema,
  deltaChargeBaseUnits: DecimalStringSchema,
  sessionId: IdentifierSchema,
  readingId: IdentifierSchema,
});
export type EvidencePreimage = z.output<typeof EvidencePreimageSchema>;

export function computeEvidenceDigest(preimage: EvidencePreimage): string {
  return jcsDigest(EvidencePreimageSchema.parse(preimage));
}

/** `commitmentDigest = SHA-256(JCS({signedMessageB64, signatureB64}))` over the captured native credential. */
export function computeCommitmentDigest(commitment: { signedMessageB64: string; signatureB64: string }): string {
  return jcsDigest({ signedMessageB64: commitment.signedMessageB64, signatureB64: commitment.signatureB64 });
}

/** Domain separator prefixed to every payer evidence acknowledgement signing message. */
export const PAYER_ACK_DOMAIN = 'usagepay.payer-evidence-ack.v1\n';

/** Exact bytes the payer signs: `UTF8(PAYER_ACK_DOMAIN) || UTF8(JCS(ack without signatureB64))`. */
export function payerAckSigningMessage(ack: PayerEvidenceAckUnsigned | PayerEvidenceAck): Uint8Array {
  const { signatureB64: _excluded, ...unsigned } = ack as PayerEvidenceAck;
  return utf8Bytes(PAYER_ACK_DOMAIN + canonicalize(unsigned));
}

/** `E0Digest = SHA-256(JCS(E0))`. E0 never contains a settlement transaction hash. */
export function computeE0Digest(e0: EvidenceE0): string {
  return jcsDigest(e0);
}

/** Exact signed bytes of a SPEC 01 simulator payload: the UTF-8 JCS encoding. */
export function encodeSimMeterPayload(payload: SimMeterPayload): Uint8Array {
  return utf8Bytes(canonicalize(SimMeterPayloadSchema.parse(payload)));
}

export class SourcePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcePayloadError';
  }
}

/**
 * Strictly decodes signed simulator bytes: valid UTF-8, JSON, schema, and the bytes must already be the
 * canonical JCS encoding (so no two byte strings can carry the same signed meaning).
 * Call only *after* the signature over these exact bytes has been verified.
 */
export function decodeSimMeterPayload(bytes: Uint8Array): SimMeterPayload {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new SourcePayloadError('source bytes are not valid UTF-8');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourcePayloadError('source bytes are not JSON');
  }
  const parsed = SimMeterPayloadSchema.safeParse(json);
  if (!parsed.success) throw new SourcePayloadError(`source payload violates the simulator profile: ${parsed.error.message}`);
  if (canonicalize(parsed.data) !== text) throw new SourcePayloadError('source bytes are not the canonical JCS encoding');
  return parsed.data;
}
