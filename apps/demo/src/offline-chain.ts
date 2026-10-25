import { createHash } from 'node:crypto';
import { Address, SorobanDataBuilder, nativeToScVal, rpc, scValToNative, xdr, type Transaction } from '@stellar/stellar-sdk';
import { accountIdToPublicKey, bytesToBase64, bytesToHex, verifyEd25519 } from '@usagepay/contracts';
import { xdrCommitmentEncoding, type ChainGateway } from '@usagepay/settlement';
import type { ChainReader, ObservedEvent, ObservedTransaction } from '@usagepay/verification';

/**
 * OFFLINE stand-in for one one-way-channel contract behind Soroban RPC, for the SDK_INTEGRATION scenarios. The pinned
 * `@stellar/mpp` client and server run unmodified (real challenge, real `prepare_commitment` round trip, real Ed25519
 * signing and SDK verification); only `rpc.Server.prototype` network methods are answered locally while installed.
 * Its close checks the commitment signature like the contract does. Nothing here is Testnet evidence.
 */
export interface OfflineChannel {
  readonly channelId: string;
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly commitmentKey: string;
  readonly deposit: bigint;
}

interface RecordedTransaction {
  readonly observed: ObservedTransaction;
  readonly events: readonly ObservedEvent[];
}

export interface OfflineChain {
  readonly channel: OfflineChannel;
  /** Contract functions simulated or invoked, e.g. `prepare_commitment(2000000)`, `close(3000000)`. */
  readonly calls: string[];
  /** When true every RPC answer fails like an unreachable endpoint. */
  down: boolean;
  /** When set, the next close is lost in transit with no transaction hash (unknown outcome). */
  loseNextClose: boolean;
  readonly gateway: ChainGateway;
  readonly reader: ChainReader;
  /** Records an unrelated transaction (e.g. another channel's successful close) for false-settlement scenarios. */
  recordForeign(status: 'SUCCESS' | 'FAILED', invocation?: { contractId: string; amount: bigint }): string;
  restore(): void;
}

const LATEST_LEDGER = 1000;
type Simulate = rpc.Server['simulateTransaction'];
type LedgerEntries = rpc.Server['getLedgerEntries'];
type LatestLedger = rpc.Server['getLatestLedger'];

let installed = false;

export function installOfflineChain(channel: OfflineChannel): OfflineChain {
  if (installed) throw new Error('an offline chain is already installed; restore it first');
  installed = true;
  const proto = rpc.Server.prototype;
  const original = { simulate: proto.simulateTransaction, entries: proto.getLedgerEntries, latest: proto.getLatestLedger };
  const state = { balance: channel.deposit, withdrawn: 0n, ledger: LATEST_LEDGER };
  const transactions = new Map<string, RecordedTransaction>();
  const calls: string[] = [];
  const unreachable = () => Promise.reject(new Error('connect ECONNREFUSED (offline chain is down)'));

  const chain: OfflineChain = {
    channel,
    calls,
    down: false,
    loseNextClose: false,
    gateway: {
      async close({ channelId, amount, signature }) {
        if (chain.down) return { kind: 'UNKNOWN', error: 'offline chain is down' };
        calls.push(`close(${amount})`);
        if (chain.loseNextClose) {
          chain.loseNextClose = false;
          return { kind: 'UNKNOWN', error: 'connection reset before the submission was acknowledged' };
        }
        const valid = channelId === channel.channelId
          && amount <= state.balance + state.withdrawn
          && verifyEd25519(accountIdToPublicKey(channel.commitmentKey), xdrCommitmentEncoding(channelId, amount), signature);
        const invocation = { contractId: channelId, functionName: 'close', amount, signatureB64: bytesToBase64(signature) };
        const hash = txHash(`close:${channelId}:${amount}:${bytesToHex(signature)}`);
        state.ledger += 1;
        if (!valid) {
          transactions.set(hash, { observed: { status: 'FAILED', ledger: state.ledger, invocation }, events: [] });
          return { kind: 'SUBMITTED', txHash: hash };
        }
        const refund = state.balance + state.withdrawn - amount;
        state.withdrawn = amount;
        state.balance = 0n;
        transactions.set(hash, {
          observed: { status: 'SUCCESS', ledger: state.ledger, invocation },
          events: [{ name: 'withdraw', to: channel.to, amount }, { name: 'close' }, { name: 'refund', from: channel.from, amount: refund }],
        });
        return { kind: 'SUBMITTED', txHash: hash };
      },
      async getTransaction(hash) {
        if (chain.down) return unreachable();
        const tx = transactions.get(hash)?.observed;
        return tx === undefined || tx.status === 'NOT_FOUND' ? { status: 'NOT_FOUND' } : { status: tx.status, ledger: tx.ledger };
      },
      async readWithdrawn() {
        if (chain.down) return unreachable();
        return state.withdrawn;
      },
    },
    reader: {
      async getTransaction(hash) {
        if (chain.down) return unreachable();
        return transactions.get(hash)?.observed ?? { status: 'NOT_FOUND' };
      },
      async getTransactionEvents(_channelId, _ledger, hash) {
        if (chain.down) return unreachable();
        return transactions.get(hash)?.events ?? [];
      },
      async readChannel() {
        if (chain.down) return unreachable();
        return {
          commitmentKeyHex: bytesToHex(accountIdToPublicKey(channel.commitmentKey)),
          from: channel.from,
          to: channel.to,
          token: channel.token,
          balance: state.balance,
          withdrawn: state.withdrawn,
        };
      },
    },
    recordForeign(status, invocation) {
      state.ledger += 1;
      const hash = txHash(`foreign:${state.ledger}:${status}`);
      transactions.set(hash, {
        observed: {
          status,
          ledger: state.ledger,
          invocation: invocation === undefined ? null : { contractId: invocation.contractId, functionName: 'close', amount: invocation.amount, signatureB64: null },
        },
        events: [],
      });
      return hash;
    },
    restore() {
      proto.simulateTransaction = original.simulate;
      proto.getLedgerEntries = original.entries;
      proto.getLatestLedger = original.latest;
      installed = false;
    },
  };

  proto.simulateTransaction = (async (tx: Parameters<Simulate>[0]) => {
    if (chain.down) return unreachable();
    const invoke = (tx as Transaction).operations[0];
    if (invoke?.type !== 'invokeHostFunction') throw new Error('offline chain only simulates contract calls');
    const call = invoke.func.invokeContract();
    const contract = Address.fromScAddress(call.contractAddress()).toString();
    const fn = call.functionName().toString();
    const args = call.args().map((arg) => scValToNative(arg) as unknown);
    calls.push(`${fn}(${args.map(String).join(',')})`);
    const retval = contract === channel.channelId ? view(fn, args) : undefined;
    if (retval === undefined) {
      return { id: 'offline', _parsed: true, latestLedger: state.ledger, events: [], error: `cannot simulate ${fn} on ${contract}` } as unknown as rpc.Api.SimulateTransactionErrorResponse;
    }
    return {
      id: 'offline',
      _parsed: true,
      latestLedger: state.ledger,
      minResourceFee: '0',
      events: [],
      transactionData: new SorobanDataBuilder(),
      result: { auth: [], retval },
    } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
  }) as Simulate;

  proto.getLedgerEntries = (async (...keys: Parameters<LedgerEntries>) => {
    if (chain.down) return unreachable();
    const storage = [
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CommitmentKey')]),
        val: xdr.ScVal.scvBytes(Buffer.from(accountIdToPublicKey(channel.commitmentKey))),
      }),
    ];
    const val = xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: new Address(channel.channelId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableStellarAsset(), storage })),
      }),
    );
    return { latestLedger: state.ledger, entries: [{ key: keys[0]!, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 2 * state.ledger }] };
  }) as LedgerEntries;

  proto.getLatestLedger = (async () => {
    if (chain.down) return unreachable();
    return { id: 'offline', protocolVersion: 23, sequence: state.ledger };
  }) as unknown as LatestLedger;

  function view(fn: string, args: unknown[]): xdr.ScVal | undefined {
    switch (fn) {
      case 'prepare_commitment':
        return xdr.ScVal.scvBytes(Buffer.from(xdrCommitmentEncoding(channel.channelId, BigInt(args[0] as bigint))));
      case 'balance':
        return nativeToScVal(state.balance, { type: 'i128' });
      case 'withdrawn':
        return nativeToScVal(state.withdrawn, { type: 'i128' });
      case 'refund_waiting_period':
        return xdr.ScVal.scvU32(100);
      case 'token':
        return new Address(channel.token).toScVal();
      case 'from':
        return new Address(channel.from).toScVal();
      case 'to':
        return new Address(channel.to).toScVal();
      default:
        return undefined;
    }
  }

  return chain;
}

function txHash(seed: string): string {
  return createHash('sha256').update(`upay-offline-tx:${seed}`).digest('hex');
}
