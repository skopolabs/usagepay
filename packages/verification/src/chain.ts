import { accountIdToPublicKey, bytesToHex, type EvidenceE0, type EvidenceE1, type VerificationResult } from '@usagepay/contracts';
import { short } from './offline.js';
import { fromIssues, notAvailable, type Issue } from './result.js';
import type { VerifierTrust } from './trust.js';

/** The contract call a transaction envelope actually made (first operation), as observed on chain. */
export interface ObservedInvocation {
  readonly contractId: string;
  readonly functionName: string;
  /** First argument as i128, when it is one (`close(amount, signature)`). */
  readonly amount: bigint | null;
  /** Second argument as bytes, base64, when it is one. */
  readonly signatureB64: string | null;
}

export type ObservedTransaction =
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'SUCCESS' | 'FAILED'; readonly ledger: number; readonly invocation: ObservedInvocation | null };

/** A decoded contract event of the close transaction (`withdraw {to, amount}`, `close`, `refund {from, amount}`). */
export interface ObservedEvent {
  readonly name: string;
  readonly to?: string;
  readonly from?: string;
  readonly amount?: bigint;
}

/** Channel state read independently: `CommitmentKey` from instance storage (G1 D2) and the read-only getters. */
export interface ObservedChannel {
  readonly commitmentKeyHex: string | null;
  readonly from: string;
  readonly to: string;
  readonly token: string;
  readonly balance: bigint;
  readonly withdrawn: bigint;
}

/** Read-only Stellar RPC port. Implementations never sign or submit; failures reject and become NOT_AVAILABLE. */
export interface ChainReader {
  getTransaction(txHash: string): Promise<ObservedTransaction>;
  getTransactionEvents(channelId: string, ledger: number, txHash: string): Promise<readonly ObservedEvent[]>;
  readChannel(channelId: string): Promise<ObservedChannel>;
}

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** One RPC read bounded by an explicit timeout; an unknown answer is never retried into a verdict. */
async function bounded<T>(what: string, timeoutMs: number, call: () => Promise<T>): Promise<Read<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return { ok: true, value: await Promise.race([call(), timeout]) };
  } catch (error) {
    return { ok: false, error: `${what}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function describeInvocation(invocation: ObservedInvocation | null): string {
  if (invocation === null) return 'no contract invocation';
  return `${invocation.functionName}(${invocation.amount ?? '?'}) on ${short(invocation.contractId)}`;
}

/**
 * V08: the observed Stellar Testnet close, independent of E1's own claims. It requires a successful `close` of the
 * pinned channel with E0's highest commitment, a `withdraw` event paying that amount to the pinned recipient, and
 * channel state with the pinned commitment key, parties and token, `withdrawn()` equal to the amount and a zero
 * balance (G1 D6). Unobtainable evidence is NOT_AVAILABLE; contradicting evidence is FAIL.
 */
export async function checkChain(input: {
  readonly e0: EvidenceE0;
  readonly e1: EvidenceE1;
  readonly trust: VerifierTrust;
  readonly chain: ChainReader;
  readonly timeoutMs: number;
}): Promise<VerificationResult> {
  const { e0, e1, trust, chain, timeoutMs } = input;
  const highest = e0.increments.at(-1)!.commitment;
  const amount = BigInt(highest.cumulativeAmountBaseUnits);
  const issues: Issue[] = [];
  const unproven: Issue[] = [];
  const observed: string[] = [];
  const mismatch = (detail: string) => issues.push({ code: 'CHAIN_MISMATCH', detail });

  const [txRead, channelRead] = await Promise.all([
    bounded('getTransaction', timeoutMs, () => chain.getTransaction(e1.closeTxHash)),
    bounded('channel state', timeoutMs, () => chain.readChannel(trust.channelId)),
  ]);

  if (!txRead.ok) {
    unproven.push({ code: 'RPC_UNAVAILABLE', detail: txRead.error });
  } else if (txRead.value.status === 'NOT_FOUND') {
    unproven.push({ code: 'SETTLEMENT_NOT_PROVABLE', detail: `close tx ${e1.closeTxHash} NOT_FOUND (not yet ingested or outside RPC retention)` });
  } else {
    const tx = txRead.value;
    if (tx.status === 'FAILED') issues.push({ code: 'SETTLEMENT_FAILED', detail: `close tx ${e1.closeTxHash} FAILED in ledger ${tx.ledger}` });
    if (e1.txStatus !== tx.status) mismatch(`E1 states ${e1.txStatus}, RPC observes ${tx.status} in ledger ${tx.ledger}`);
    const inv = tx.invocation;
    const isHighestClose =
      inv !== null && inv.contractId === trust.channelId && inv.functionName === 'close' && inv.amount === amount && inv.signatureB64 === highest.signatureB64;
    if (!isHighestClose) {
      mismatch(`tx is not close(${amount}, highest captured signature) on the pinned channel; observed ${describeInvocation(inv)}`);
    } else if (tx.status === 'SUCCESS') {
      observed.push(`close tx ${e1.closeTxHash} SUCCESS in ledger ${tx.ledger} with the highest SDK-signed commitment ${amount}`);
      const eventsRead = await bounded('getEvents', timeoutMs, () => chain.getTransactionEvents(trust.channelId, tx.ledger, e1.closeTxHash));
      if (!eventsRead.ok) {
        unproven.push({ code: 'RPC_UNAVAILABLE', detail: eventsRead.error });
      } else {
        const withdraw = eventsRead.value.find((event) => event.name === 'withdraw');
        if (withdraw === undefined) {
          unproven.push({ code: 'SETTLEMENT_NOT_PROVABLE', detail: 'no withdraw event observed for the close tx' });
        } else if (withdraw.to !== trust.recipient || withdraw.amount !== amount) {
          mismatch(`withdraw event pays ${withdraw.amount ?? '?'} to ${short(withdraw.to ?? '?')}, expected ${amount} to ${short(trust.recipient)}`);
        } else {
          observed.push(`withdraw event pays ${amount} to ${short(trust.recipient)}`);
        }
      }
    }
  }

  if (!channelRead.ok) {
    unproven.push({ code: 'RPC_UNAVAILABLE', detail: channelRead.error });
  } else {
    const channel = channelRead.value;
    if (channel.commitmentKeyHex === null) {
      unproven.push({ code: 'SETTLEMENT_NOT_PROVABLE', detail: 'on-chain CommitmentKey could not be read from instance storage' });
    } else if (channel.commitmentKeyHex !== bytesToHex(accountIdToPublicKey(trust.commitmentKey))) {
      mismatch(`on-chain CommitmentKey ${short(channel.commitmentKeyHex)} is not the pinned signer ${short(trust.commitmentKey)}`);
    }
    if (channel.from !== trust.funder) mismatch(`channel from() ${short(channel.from)} is not the pinned funder`);
    if (channel.to !== trust.recipient) mismatch(`channel to() ${short(channel.to)} is not the pinned recipient`);
    if (channel.token !== trust.assetSac) mismatch(`channel token() ${short(channel.token)} is not the pinned asset SAC`);
    if (channel.withdrawn !== amount) mismatch(`withdrawn() = ${channel.withdrawn}, expected the highest commitment ${amount}`);
    if (channel.balance !== 0n) mismatch(`balance() = ${channel.balance} after close, expected 0 (refunded)`);
    observed.push(`channel key/parties/token pinned, withdrawn() = ${channel.withdrawn}, balance() = ${channel.balance}`);
  }

  if (e1.settledCumulativeBaseUnits !== undefined && BigInt(e1.settledCumulativeBaseUnits) !== amount) {
    mismatch(`E1 states settled ${e1.settledCumulativeBaseUnits}, the proven payout is ${amount}`);
  }

  if (issues.length > 0) return fromIssues(issues, '');
  const [firstUnproven] = unproven;
  if (firstUnproven !== undefined) return notAvailable(firstUnproven.code, unproven.map((issue) => issue.detail).join('; '));
  return fromIssues([], observed.join('; '));
}
