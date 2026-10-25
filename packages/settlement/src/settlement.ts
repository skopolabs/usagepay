import {
  EvidenceE0Schema,
  EvidenceE1Schema,
  NETWORK,
  base64ToBytes,
  computeE0Digest,
  type AuthorizedIncrement,
  type EvidenceE0,
  type EvidenceE1,
} from '@usagepay/contracts';
import { checkNativeCommitment, xdrCommitmentEncoding, type CommitmentEncoding } from './commitment.js';
import type { SettlementEvent } from './payer.js';
import type { ChannelSettlementPort, CloseResult } from './ports.js';
import { createStateMachine, type SettlementState } from './state.js';

export type CloseSubmission =
  | { readonly kind: 'SUBMITTED'; readonly txHash: string }
  /** The outcome is unknown: the transaction may or may not have reached the chain. */
  | { readonly kind: 'UNKNOWN'; readonly txHash?: string; readonly error: string };

/** The only Stellar boundary of settlement. The real implementation is `createStellarChainGateway`. */
export interface ChainGateway {
  close(input: { channelId: string; amount: bigint; signature: Uint8Array }): Promise<CloseSubmission>;
  getTransaction(txHash: string): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number }>;
  /** Post-close `withdrawn()` getter of the channel: what the recipient was actually paid. */
  readWithdrawn(channelId: string): Promise<bigint>;
}

export interface ChannelSettlementConfig {
  readonly channelId: string;
  readonly assetSac: string;
  readonly commitmentKey: string;
  readonly gateway: ChainGateway;
  /** The payee's own record of its highest accepted increment; E0 must end with exactly that commitment. */
  readonly highestAccepted: () => AuthorizedIncrement | undefined;
  readonly encoding?: CommitmentEncoding;
  readonly onEvent?: SettlementEvent;
}

export interface ChannelSettlement extends ChannelSettlementPort {
  readonly state: SettlementState;
  readonly closeTxHash: string | undefined;
}

/**
 * Recipient-side close (SPEC 02 §5.2): the standalone SDK `close()` with the highest accepted voucher (G1 D4),
 * then E1 built only from what RPC reports afterwards. A hash alone never yields SETTLED; unknown means PENDING,
 * and a later `closeLatest` re-reads the same transaction instead of submitting another close.
 */
export function createChannelSettlement(config: ChannelSettlementConfig): ChannelSettlement {
  const encoding = config.encoding ?? xdrCommitmentEncoding;
  const emit: SettlementEvent = config.onEvent ?? (() => undefined);
  const machine = createStateMachine('E0_FINALIZED');
  let closeTxHash: string | undefined;
  let finalE1: EvidenceE1 | undefined;
  let pinnedE0Digest: string | undefined;

  const rejected = (reasonCode: string, details: string): CloseResult => ({ kind: 'REJECTED', reasonCode, details });

  async function observe(e0Digest: string, txHash: string): Promise<CloseResult> {
    const e1 = (txStatus: EvidenceE1['txStatus'], settled?: bigint): EvidenceE1 =>
      EvidenceE1Schema.parse({
        schema: 'usagepay.e1.v1',
        e0Digest,
        network: NETWORK,
        channelId: config.channelId,
        assetSac: config.assetSac,
        closeTxHash: txHash,
        txStatus,
        ...(settled === undefined ? {} : { settledCumulativeBaseUnits: settled.toString() }),
        verifierVersion: 'usagepay-verifier.v1',
      });
    let status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
    let withdrawn: bigint | undefined;
    try {
      status = (await config.gateway.getTransaction(txHash)).status;
      if (status === 'SUCCESS') withdrawn = await config.gateway.readWithdrawn(config.channelId);
    } catch (error) {
      if (machine.state === 'SETTLING') machine.transition('PENDING');
      emit('settlement.pending', { txHash, reasonCode: 'RPC_UNAVAILABLE' });
      return { kind: 'PENDING', reasonCode: 'RPC_UNAVAILABLE', details: `close ${txHash} submitted; RPC read failed: ${message(error)}` };
    }
    const observed = e1(status, withdrawn);
    emit('settlement.observed', { txHash, txStatus: status, settled: withdrawn });
    if (status === 'SUCCESS') {
      machine.transition('SETTLED');
      finalE1 = observed;
    } else if (status === 'FAILED') {
      machine.transition('REJECTED');
      finalE1 = observed;
    } else if (machine.state === 'SETTLING') {
      machine.transition('PENDING');
    }
    return { kind: 'OBSERVED', e1: observed };
  }

  async function closeLatest(input: { channelId: string; e0: EvidenceE0 }): Promise<CloseResult> {
    if (input.channelId !== config.channelId) return rejected('CHANNEL_NOT_PINNED', `channel ${input.channelId} is not the pinned channel`);
    const parsed = EvidenceE0Schema.safeParse(input.e0);
    if (!parsed.success) return rejected('INVALID_E0', parsed.error.message);
    const e0 = parsed.data;
    const e0Digest = computeE0Digest(e0);
    if (pinnedE0Digest !== undefined && e0Digest !== pinnedE0Digest) return rejected('E0_ALREADY_FINALIZED', 'settlement is bound to a different E0');
    if (finalE1 !== undefined) return { kind: 'OBSERVED', e1: finalE1 };
    if (closeTxHash !== undefined) {
      if (machine.state === 'PENDING') machine.transition('SETTLING');
      return observe(e0Digest, closeTxHash);
    }
    if (machine.state !== 'E0_FINALIZED') {
      return { kind: 'PENDING', reasonCode: 'SETTLEMENT_PENDING', details: 'a close was attempted with an unknown outcome; reconcile the channel before retrying' };
    }

    const highest = e0.increments.at(-1);
    const accepted = config.highestAccepted();
    if (highest === undefined || accepted === undefined || highest.commitment.commitmentDigest !== accepted.commitment.commitmentDigest) {
      return rejected('E0_NOT_LATEST_ACCEPTED', 'E0 does not end with the highest commitment the payee accepted');
    }
    if (e0.increments.some((increment) => increment.commitment.channelId !== config.channelId)) {
      return rejected('CHANNEL_NOT_PINNED', 'E0 holds a commitment for another channel');
    }
    const amount = BigInt(highest.commitment.cumulativeAmountBaseUnits);
    const native = checkNativeCommitment({ commitment: highest.commitment, channelId: config.channelId, commitmentKey: config.commitmentKey, expectedCumulative: amount, encoding });
    if (native !== null) return rejected(native.code, native.details);

    pinnedE0Digest = e0Digest;
    machine.transition('SETTLING');
    emit('settlement.close.submitting', { amount, commitmentDigest: highest.commitment.commitmentDigest, e0Digest });
    const submission = await config.gateway.close({ channelId: config.channelId, amount, signature: base64ToBytes(highest.commitment.signatureB64) });
    if (submission.txHash !== undefined) closeTxHash = submission.txHash;
    if (submission.kind === 'UNKNOWN' && submission.txHash === undefined) {
      machine.transition('PENDING');
      emit('settlement.pending', { reasonCode: 'SETTLEMENT_PENDING', error: submission.error });
      return { kind: 'PENDING', reasonCode: 'SETTLEMENT_PENDING', details: `close outcome unknown: ${submission.error}` };
    }
    emit('settlement.close.submitted', { txHash: closeTxHash });
    return observe(e0Digest, closeTxHash ?? '');
  }

  return {
    closeLatest,
    get state() {
      return machine.state;
    },
    get closeTxHash() {
      return closeTxHash;
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
