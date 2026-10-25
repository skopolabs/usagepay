import { accountIdToPublicKey, bytesToHex } from '@usagepay/contracts';
import type { ChainReader, ObservedChannel } from '@usagepay/verification';
import type { RealRun } from '../src/index.js';

/** Read-only ledger double answering what Testnet reports for an honest close of `run` (the real values are in G3). */
export function honestLedger(r: RealRun, patch: Partial<ObservedChannel> = {}): ChainReader {
  const highest = r.e0.increments.at(-1)!.commitment;
  const amount = BigInt(highest.cumulativeAmountBaseUnits);
  return {
    getTransaction: async () => ({ status: 'SUCCESS', ledger: 4242, invocation: { contractId: r.trust.channelId, functionName: 'close', amount, signatureB64: highest.signatureB64 } }),
    getTransactionEvents: async () => [{ name: 'withdraw', to: r.trust.recipient, amount }, { name: 'close' }, { name: 'refund', from: r.trust.funder, amount: 10_000_000n - amount }],
    readChannel: async () => ({
      commitmentKeyHex: bytesToHex(accountIdToPublicKey(r.trust.commitmentKey)),
      from: r.trust.funder,
      to: r.trust.recipient,
      token: r.trust.assetSac,
      balance: 0n,
      withdrawn: amount,
      ...patch,
    }),
  };
}
