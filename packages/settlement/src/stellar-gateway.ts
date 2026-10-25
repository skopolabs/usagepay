import { close, getChannelState } from '@stellar/mpp/channel/server';
import { Account, Contract, StrKey, TransactionBuilder, rpc, scValToNative, type Keypair } from '@stellar/stellar-sdk';
import { TESTNET_PASSPHRASE } from './commitment.js';
import type { ChannelFacts } from './policy.js';
import type { ChainGateway } from './settlement.js';

export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
const SIMULATION_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

/**
 * Stellar Testnet gateway built only from upstream primitives: the SDK's standalone `close()` signed by the
 * recipient as envelope signer (the contract requires `to.require_auth()`), `getTransaction` and a read-only
 * `withdrawn()` simulation. The recipient secret stays inside this gateway.
 */
export function createStellarChainGateway(config: { readonly recipient: Keypair; readonly rpcUrl?: string }): ChainGateway {
  const rpcUrl = config.rpcUrl ?? TESTNET_RPC_URL;
  const server = new rpc.Server(rpcUrl);
  return {
    async close({ channelId, amount, signature }) {
      try {
        const txHash = await close({
          channel: channelId,
          amount,
          signature: Buffer.from(signature),
          feePayer: { envelopeSigner: config.recipient },
          network: 'stellar:testnet',
          rpcUrl,
        });
        return { kind: 'SUBMITTED', txHash };
      } catch (error) {
        // The SDK attaches the hash once broadcast; without one the close may still have reached the chain.
        const hash = (error as { details?: { hash?: unknown } } | null)?.details?.hash;
        return {
          kind: 'UNKNOWN',
          ...(typeof hash === 'string' ? { txHash: hash } : {}),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async getTransaction(txHash) {
      const tx = await server.getTransaction(txHash);
      return tx.status === 'NOT_FOUND' ? { status: 'NOT_FOUND' } : { status: tx.status, ledger: tx.ledger };
    },
    async readWithdrawn(channelId) {
      const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), { fee: '100', networkPassphrase: TESTNET_PASSPHRASE })
        .addOperation(new Contract(channelId).call('withdrawn'))
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(sim) || sim.result === undefined) throw new Error(`withdrawn() simulation failed on ${channelId}`);
      return BigInt(scValToNative(sim.result.retval) as bigint);
    },
  };
}

/** Reads the channel facts the payer pins before its first increment. */
export async function readChannelFacts(channelId: string, rpcUrl?: string): Promise<ChannelFacts & { readonly from: string }> {
  const state = await getChannelState({ channel: channelId, network: 'stellar:testnet', ...(rpcUrl === undefined ? {} : { rpcUrl }) });
  return { token: state.token, to: state.to, from: state.from, balance: state.balance, closeEffectiveAtLedger: state.closeEffectiveAtLedger };
}
