import { Address, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  NETWORK,
  NativeCommitmentSchema,
  accountIdToPublicKey,
  base64ToBytes,
  bytesToBase64,
  computeCommitmentDigest,
  hexToBytes,
  verifyEd25519,
  type NativeCommitment,
} from '@usagepay/contracts';
import { refusal, type Refusal } from './codes.js';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
/** Domain symbol of one-way-channel commitments (`symbol_short!("chancmmt")`). */
export const COMMITMENT_DOMAIN = 'chancmmt';

/** Produces the exact bytes the channel commitment key signs for `(channel, cumulative amount)`. */
export type CommitmentEncoding = (channelId: string, amount: bigint) => Uint8Array;

/**
 * The pinned one-way-channel encoding: XDR `ScVal::Map` of the contract `Commitment` struct with symbol keys in
 * sorted order {amount: i128, channel: Address, domain: Symbol, network: BytesN<32>}. G1 proved it byte-equal to
 * the contract's read-only `prepare_commitment` on Testnet, which is what the SDK signs.
 */
export const xdrCommitmentEncoding: CommitmentEncoding = (channelId, amount) => {
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  const map = xdr.ScVal.scvMap([
    entry('amount', nativeToScVal(amount, { type: 'i128' })),
    entry('channel', new Address(channelId).toScVal()),
    entry('domain', xdr.ScVal.scvSymbol(COMMITMENT_DOMAIN)),
    entry('network', xdr.ScVal.scvBytes(hash(Buffer.from(TESTNET_PASSPHRASE)))),
  ]);
  return new Uint8Array(map.toXDR());
};

/** Shapes a captured native credential (hex signature from the MPP wire format) into the SPEC 00 record. */
export function nativeCommitmentRecord(input: {
  channelId: string;
  amount: bigint;
  message: Uint8Array;
  signatureHex: string;
  commitmentKey: string;
}): NativeCommitment {
  const signedMessageB64 = bytesToBase64(input.message);
  const signatureB64 = bytesToBase64(hexToBytes(input.signatureHex));
  return NativeCommitmentSchema.parse({
    schema: 'usagepay.native-commitment.v1',
    channelId: input.channelId,
    network: NETWORK,
    cumulativeAmountBaseUnits: input.amount.toString(),
    signedMessageB64,
    signatureB64,
    commitmentKey: input.commitmentKey,
    commitmentDigest: computeCommitmentDigest({ signedMessageB64, signatureB64 }),
  });
}

/**
 * AC01, AC02, AC14, AC15: the native commitment binds the pinned channel and network, an amount equal to the
 * approved cumulative charge, the pinned encoding of exactly those values, and verifies under the pinned key.
 */
export function checkNativeCommitment(input: {
  readonly commitment: unknown;
  readonly channelId: string;
  readonly commitmentKey: string;
  readonly expectedCumulative: bigint;
  readonly encoding: CommitmentEncoding;
}): Refusal | null {
  const parsed = NativeCommitmentSchema.safeParse(input.commitment);
  if (!parsed.success) {
    const network = (input.commitment as { network?: unknown } | null)?.network;
    return network !== undefined && network !== NETWORK
      ? refusal('NETWORK_MISMATCH', `commitment network ${String(network)} is not ${NETWORK}`)
      : refusal('INVALID_NATIVE_CREDENTIAL', `commitment is not a SPEC 00 NativeCommitment: ${parsed.error.message}`);
  }
  const commitment = parsed.data;
  if (commitment.channelId !== input.channelId) {
    return refusal('CHANNEL_NOT_PINNED', `commitment channel ${commitment.channelId} is not the pinned channel`);
  }
  if (computeCommitmentDigest(commitment) !== commitment.commitmentDigest) {
    return refusal('INVALID_NATIVE_CREDENTIAL', 'commitmentDigest does not recompute from the signed message and signature');
  }
  if (BigInt(commitment.cumulativeAmountBaseUnits) !== input.expectedCumulative) {
    return refusal(
      'INVALID_NATIVE_SIGNATURE',
      `commitment amount ${commitment.cumulativeAmountBaseUnits} is not the approved cumulative ${input.expectedCumulative}`,
    );
  }
  const message = base64ToBytes(commitment.signedMessageB64);
  const expected = input.encoding(input.channelId, input.expectedCumulative);
  if (!Buffer.from(message).equals(Buffer.from(expected))) {
    return refusal('INVALID_NATIVE_SIGNATURE', 'signed message is not the pinned encoding of (channel, amount, network)');
  }
  if (commitment.commitmentKey !== input.commitmentKey) {
    return refusal('INVALID_NATIVE_SIGNATURE', 'commitmentKey is not the pinned channel commitment key');
  }
  if (!verifyEd25519(accountIdToPublicKey(input.commitmentKey), message, base64ToBytes(commitment.signatureB64))) {
    return refusal('INVALID_NATIVE_SIGNATURE', 'native signature does not verify under the pinned commitment key');
  }
  return null;
}
