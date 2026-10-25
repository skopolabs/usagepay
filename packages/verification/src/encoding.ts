import { Address, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
/** Domain symbol of one-way-channel commitments (`symbol_short!("chancmmt")`). */
export const COMMITMENT_DOMAIN = 'chancmmt';

/** Exact bytes the channel commitment key signs for `(channel, cumulative amount)`. */
export type CommitmentEncoding = (channelId: string, amount: bigint) => Uint8Array;

/**
 * The verifier's own rebuild of the pinned one-way-channel commitment (no signing): XDR `ScVal::Map` of the contract
 * `Commitment` struct with symbol keys in sorted order {amount: i128, channel: Address, domain: Symbol,
 * network: BytesN<32> = SHA-256(passphrase)}. It is byte-equal to the SDK-signed messages captured on Testnet.
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
