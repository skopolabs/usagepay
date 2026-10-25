import { Address, SorobanDataBuilder, nativeToScVal, rpc, scValToNative, xdr, type Transaction } from '@stellar/stellar-sdk';
import { vi } from 'vitest';
import { accountIdToPublicKey } from '@usagepay/contracts';
import { xdrCommitmentEncoding } from '../src/index.js';

/**
 * OFFLINE test double of the one-way-channel contract behind Soroban RPC. It replaces only the RPC client methods
 * (`rpc.Server.prototype`), so the pinned `@stellar/mpp` client and server run unmodified: real challenge,
 * real `prepare_commitment` round trip, real Ed25519 signing and SDK verification. Never Testnet evidence.
 */
export interface FakeChannel {
  channelId: string;
  token: string;
  from: string;
  to: string;
  commitmentKey: string;
  balance: bigint;
  closeEffectiveAtLedger: number | null;
}

export interface FakeChain {
  readonly channel: FakeChannel;
  /** Contract functions simulated so far, e.g. `prepare_commitment(2000000)`. */
  readonly calls: string[];
  /** When true every RPC call fails like an unreachable endpoint. */
  down: boolean;
  restore(): void;
}

const LATEST_LEDGER = 1000;

export function installFakeChain(channel: FakeChannel): FakeChain {
  const chain: FakeChain = { channel, calls: [], down: false, restore: () => vi.restoreAllMocks() };
  const unreachable = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:443 (fake RPC down)'));

  vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockImplementation(async (tx) => {
    if (chain.down) return unreachable();
    const invoke = (tx as Transaction).operations[0];
    if (invoke?.type !== 'invokeHostFunction') throw new Error('fake chain only simulates contract calls');
    const call = invoke.func.invokeContract();
    const contract = Address.fromScAddress(call.contractAddress()).toString();
    const fn = call.functionName().toString();
    const args = call.args().map((arg) => scValToNative(arg) as unknown);
    chain.calls.push(`${fn}(${args.map(String).join(',')})`);
    if (contract !== channel.channelId) return simulationError(`contract ${contract} is not deployed`);
    const retval = contractCall(channel, fn, args);
    if (retval === undefined) return simulationError(`unknown function ${fn}`);
    return {
      id: 'fake',
      _parsed: true,
      latestLedger: LATEST_LEDGER,
      minResourceFee: '0',
      events: [],
      transactionData: new SorobanDataBuilder(),
      result: { auth: [], retval },
    } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
  });

  vi.spyOn(rpc.Server.prototype, 'getLedgerEntries').mockImplementation(async (...keys) => {
    if (chain.down) return unreachable();
    const storage = [
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CommitmentKey')]),
        val: xdr.ScVal.scvBytes(Buffer.from(accountIdToPublicKey(channel.commitmentKey))),
      }),
      ...(channel.closeEffectiveAtLedger === null
        ? []
        : [new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CloseEffectiveAtLedger')]), val: xdr.ScVal.scvU32(channel.closeEffectiveAtLedger) })]),
    ];
    const val = xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: new Address(channel.channelId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableStellarAsset(), storage }),
        ),
      }),
    );
    return { latestLedger: LATEST_LEDGER, entries: [{ key: keys[0]!, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 2 * LATEST_LEDGER }] };
  });

  vi.spyOn(rpc.Server.prototype, 'getLatestLedger').mockImplementation(async () => {
    if (chain.down) return unreachable();
    return { id: 'fake', protocolVersion: 23, sequence: LATEST_LEDGER } as unknown as rpc.Api.GetLatestLedgerResponse;
  });

  return chain;
}

function contractCall(channel: FakeChannel, fn: string, args: unknown[]): xdr.ScVal | undefined {
  switch (fn) {
    case 'prepare_commitment':
      return xdr.ScVal.scvBytes(Buffer.from(xdrCommitmentEncoding(channel.channelId, BigInt(args[0] as bigint))));
    case 'balance':
      return nativeToScVal(channel.balance, { type: 'i128' });
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

function simulationError(error: string): rpc.Api.SimulateTransactionErrorResponse {
  return { id: 'fake', _parsed: true, latestLedger: LATEST_LEDGER, events: [], error } as unknown as rpc.Api.SimulateTransactionErrorResponse;
}
