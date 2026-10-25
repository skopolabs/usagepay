import { Account, Address, Contract, StrKey, TransactionBuilder, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { ChainReader, ObservedEvent, ObservedInvocation } from './chain.js';
import { TESTNET_PASSPHRASE } from './encoding.js';

export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
/** Read-only simulations need a syntactically valid source account; nothing is signed or submitted. */
const SIMULATION_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

/**
 * Read-only Soroban RPC adapter for V08: `getTransaction` (decoded envelope), `getEvents` for the close ledger, the
 * channel's instance storage and its getters through simulation. It holds no keys.
 */
export function createStellarChainReader(config: { readonly rpcUrl?: string } = {}): ChainReader {
  const server = new rpc.Server(config.rpcUrl ?? TESTNET_RPC_URL);

  async function view(channelId: string, fn: string): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), { fee: '100', networkPassphrase: TESTNET_PASSPHRASE })
      .addOperation(new Contract(channelId).call(fn))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || sim.result === undefined) {
      throw new Error(`${fn}() simulation failed on ${channelId}: ${'error' in sim ? String(sim.error) : 'no result'}`);
    }
    return scValToNative(sim.result.retval);
  }

  const expect = <T>(fn: string, value: unknown, type: 'string' | 'bigint'): T => {
    if (typeof value !== type) throw new Error(`${fn}() returned ${typeof value}, expected ${type}`);
    return value as T;
  };

  return {
    async getTransaction(txHash) {
      const tx = await server.getTransaction(txHash);
      if (tx.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
      return { status: tx.status, ledger: tx.ledger, invocation: decodeInvocation(tx.envelopeXdr) };
    },

    async getTransactionEvents(channelId, ledger, txHash) {
      const response = await server.getEvents({
        startLedger: ledger,
        endLedger: ledger + 1,
        filters: [{ type: 'contract', contractIds: [channelId] }],
        limit: 100,
      });
      return response.events.filter((event) => event.txHash === txHash).map((event) => decodeEvent(event.topic, event.value));
    },

    async readChannel(channelId) {
      const entry = await server.getContractData(channelId, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
      const storage = entry.val.contractData().val().instance().storage() ?? [];
      const keyEntry = storage.find((item) => {
        const key = scValToNative(item.key()) as unknown;
        return Array.isArray(key) && key[0] === 'CommitmentKey';
      });
      const keyVal = keyEntry?.val();
      const commitmentKeyHex = keyVal?.switch() === xdr.ScValType.scvBytes() ? Buffer.from(keyVal.bytes()).toString('hex') : null;
      const [from, to, token, balance, withdrawn] = await Promise.all(['from', 'to', 'token', 'balance', 'withdrawn'].map((fn) => view(channelId, fn)));
      return {
        commitmentKeyHex,
        from: expect<string>('from', from, 'string'),
        to: expect<string>('to', to, 'string'),
        token: expect<string>('token', token, 'string'),
        balance: expect<bigint>('balance', balance, 'bigint'),
        withdrawn: expect<bigint>('withdrawn', withdrawn, 'bigint'),
      };
    },
  };
}

/** The first operation's contract call, or null when the envelope makes no contract invocation. */
function decodeInvocation(envelope: xdr.TransactionEnvelope): ObservedInvocation | null {
  try {
    const tx = envelope.switch() === xdr.EnvelopeType.envelopeTypeTxFeeBump() ? envelope.feeBump().tx().innerTx().v1().tx() : envelope.v1().tx();
    const call = tx.operations()[0]?.body().invokeHostFunctionOp().hostFunction().invokeContract();
    if (call === undefined) return null;
    const [first, second] = call.args();
    const amount = first === undefined ? undefined : (scValToNative(first) as unknown);
    return {
      contractId: Address.fromScAddress(call.contractAddress()).toString(),
      functionName: call.functionName().toString(),
      amount: typeof amount === 'bigint' ? amount : null,
      signatureB64: second?.switch() === xdr.ScValType.scvBytes() ? Buffer.from(second.bytes()).toString('base64') : null,
    };
  } catch {
    return null;
  }
}

function decodeEvent(topic: readonly xdr.ScVal[], value: xdr.ScVal): ObservedEvent {
  const name = topic[0] === undefined ? '' : String(scValToNative(topic[0]));
  const body = scValToNative(value) as unknown;
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return {
    name,
    ...(typeof fields['to'] === 'string' ? { to: fields['to'] } : {}),
    ...(typeof fields['from'] === 'string' ? { from: fields['from'] } : {}),
    ...(typeof fields['amount'] === 'bigint' ? { amount: fields['amount'] } : {}),
  };
}
