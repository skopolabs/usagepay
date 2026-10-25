import {
  NETWORK,
  PayerEvidenceAckSchema,
  bytesToBase64,
  payerAckSigningMessage,
  verifyPayerAckSignature,
  type MeasurementCharge,
  type NativeCommitment,
  type PayerEvidenceAck,
  type PayerEvidenceAckUnsigned,
} from '@usagepay/contracts';
import { refusal, type Refusal } from './codes.js';

/** Signs the domain-separated SPEC 00 ack message. Only the fleet holds this capability. */
export type AckSigner = (message: Uint8Array) => Uint8Array;

/** Builds and signs the payer evidence ack for a native commitment that already exists (SPEC 02 §3). */
export function signPayerAck(input: {
  readonly sessionId: string;
  readonly charge: MeasurementCharge;
  readonly commitment: NativeCommitment;
  readonly payerAccountId: string;
  readonly nonce: string;
  readonly sign: AckSigner;
}): PayerEvidenceAck {
  const unsigned: PayerEvidenceAckUnsigned = {
    schema: 'usagepay.payer-ack.v1',
    sessionId: input.sessionId,
    network: NETWORK,
    channelId: input.commitment.channelId,
    evidenceDigest: input.charge.evidenceDigest,
    commitmentDigest: input.commitment.commitmentDigest,
    approvedCumulativeBaseUnits: input.commitment.cumulativeAmountBaseUnits,
    nonce: input.nonce,
    payerKey: input.payerAccountId,
  };
  return PayerEvidenceAckSchema.parse({ ...unsigned, signatureB64: bytesToBase64(input.sign(payerAckSigningMessage(unsigned))) });
}

/**
 * AC16, AC17: the ack is signed by the pinned payer key and binds exactly this evidence, this native commitment,
 * the pinned session, channel and network, with a nonce never used before in this (channel, session).
 */
export function checkPayerAck(input: {
  readonly ack: unknown;
  readonly sessionId: string;
  readonly channelId: string;
  readonly payerAccountId: string;
  readonly charge: MeasurementCharge;
  readonly commitment: NativeCommitment;
  readonly usedNonces: ReadonlySet<string>;
}): Refusal | null {
  const parsed = PayerEvidenceAckSchema.safeParse(input.ack);
  if (!parsed.success) return refusal('INVALID_PAYER_ACK', `ack is not a SPEC 00 PayerEvidenceAck: ${parsed.error.message}`);
  const ack = parsed.data;
  if (ack.payerKey !== input.payerAccountId) return refusal('INVALID_PAYER_ACK', 'ack payerKey is not the pinned payer key');
  if (!verifyPayerAckSignature(ack)) return refusal('INVALID_PAYER_ACK', 'ack signature does not verify under payerKey');
  if (ack.sessionId !== input.sessionId || ack.channelId !== input.channelId || ack.network !== NETWORK) {
    return refusal('INVALID_PAYER_ACK', 'ack session, channel or network differs from the pinned values');
  }
  if (ack.evidenceDigest !== input.charge.evidenceDigest) {
    return refusal('INVALID_PAYER_ACK', 'ack evidenceDigest is not the evidence of this increment');
  }
  if (ack.commitmentDigest !== input.commitment.commitmentDigest) {
    return refusal('INVALID_PAYER_ACK', 'ack commitmentDigest does not bind this native commitment');
  }
  if (
    ack.approvedCumulativeBaseUnits !== input.commitment.cumulativeAmountBaseUnits ||
    ack.approvedCumulativeBaseUnits !== input.charge.cumulativeChargeBaseUnits
  ) {
    return refusal('INVALID_PAYER_ACK', 'ack amount differs from the native commitment or the cumulative charge');
  }
  if (input.usedNonces.has(ack.nonce)) return refusal('REPLAY_NONCE', `ack nonce ${ack.nonce} was already used in this channel and session`);
  return null;
}
