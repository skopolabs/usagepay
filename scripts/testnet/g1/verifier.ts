import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  NETWORK,
  accountIdToPublicKey,
  base64ToBytes,
  bytesToHex,
  computeCommitmentDigest,
  verifyEd25519,
  verifyPayerAckSignature,
  type NativeCommitment,
  type PayerEvidenceAck,
} from '@usagepay/contracts';
import { buildCommitmentMessage, readInstanceStorage, readView, rpcServer } from './chain.ts';
import type { Trace } from './trace.ts';

export type CheckStatus = 'PASS' | 'FAIL' | 'NOT_AVAILABLE';
export interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface VerifierInput {
  readonly channel: string;
  readonly closeTxHash: string;
  readonly expected: { readonly token: string; readonly from: string; readonly to: string; readonly deposit: bigint };
  /** Public artifacts handed over by the payee; the verifier trusts none of their claims and holds no secrets. */
  readonly increments: readonly { readonly commitment: NativeCommitment; readonly ack: PayerEvidenceAck }[];
  readonly trace: Trace;
}

/**
 * Independent post-close verification from public data only: recomputes every message, digest and signature,
 * pins the commitment key from on-chain storage, and checks the close transaction, its events and the getters.
 */
export async function verifyRun(input: VerifierInput): Promise<{ checks: Check[]; events: unknown[]; ledger: number | null }> {
  const { channel, trace } = input;
  const server = rpcServer();
  const checks: Check[] = [];
  const check = (id: string, ok: boolean, detail: string) => {
    const entry: Check = { id, status: ok ? 'PASS' : 'FAIL', detail };
    checks.push(entry);
    trace.emit('verifier', 'check', { ...entry });
  };

  const storage = await readInstanceStorage(server, channel);
  const storedKeyHex = String(storage['CommitmentKey'] ?? '');
  trace.emit('network', 'read.instance-storage', { channel, CommitmentKey: storedKeyHex, CloseEffectiveAtLedger: String(storage['CloseEffectiveAtLedger'] ?? '') });
  const storedKey = storedKeyHex.length === 64 ? Uint8Array.from(Buffer.from(storedKeyHex, 'hex')) : new Uint8Array();

  let previous = 0n;
  for (const [index, { commitment, ack }] of input.increments.entries()) {
    const n = index + 1;
    const amount = BigInt(commitment.cumulativeAmountBaseUnits);
    const message = base64ToBytes(commitment.signedMessageB64);
    check(`V-COMMIT-${n}-MESSAGE`, Buffer.from(message).equals(Buffer.from(buildCommitmentMessage(channel, amount))),
      'signed message equals the locally rebuilt chancmmt XDR map for (channel, amount, network)');
    check(`V-COMMIT-${n}-SIGNATURE`, verifyEd25519(storedKey, message, base64ToBytes(commitment.signatureB64)),
      'native signature verifies under the on-chain CommitmentKey');
    check(`V-COMMIT-${n}-KEY`, bytesToHex(accountIdToPublicKey(commitment.commitmentKey)) === storedKeyHex,
      'record commitmentKey equals on-chain CommitmentKey');
    check(`V-COMMIT-${n}-DIGEST`, computeCommitmentDigest(commitment) === commitment.commitmentDigest, 'commitmentDigest recomputes');
    check(`V-COMMIT-${n}-MONOTONIC`, amount > previous, `cumulative ${amount} > previous ${previous}`);
    previous = amount;
    check(`V-ACK-${n}-SIGNATURE`, verifyPayerAckSignature(ack), 'payer ack signature verifies under payerKey');
    check(`V-ACK-${n}-BINDING`,
      bytesToHex(accountIdToPublicKey(ack.payerKey)) === storedKeyHex &&
        ack.commitmentDigest === commitment.commitmentDigest &&
        ack.approvedCumulativeBaseUnits === commitment.cumulativeAmountBaseUnits &&
        ack.channelId === channel && ack.network === NETWORK,
      'ack binds on-chain key, exact commitment digest, amount, channel and network');
  }
  const highest = input.increments.at(-1)?.commitment;
  if (highest === undefined) throw new Error('verifier received no increments');
  const highestAmount = BigInt(highest.cumulativeAmountBaseUnits);

  const tx = await server.getTransaction(input.closeTxHash);
  trace.emit('network', 'read.transaction', { txHash: input.closeTxHash, status: tx.status, ledger: 'ledger' in tx ? tx.ledger : null });
  let ledger: number | null = null;
  if (tx.status === 'NOT_FOUND') {
    checks.push({ id: 'V-CLOSE-TX', status: 'NOT_AVAILABLE', detail: 'transaction not found (outside RPC retention or not yet ingested)' });
  } else {
    ledger = tx.ledger;
    check('V-CLOSE-TX-STATUS', tx.status === 'SUCCESS', `getTransaction status ${tx.status} in ledger ${tx.ledger}`);
    const envelope = tx.envelopeXdr;
    const op = (envelope.switch() === xdr.EnvelopeType.envelopeTypeTxFeeBump()
      ? envelope.feeBump().tx().innerTx().v1().tx()
      : envelope.v1().tx()).operations()[0];
    const invoke = op?.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const args = invoke?.args() ?? [];
    const closeAmount = args[0] ? BigInt(scValToNative(args[0]) as bigint) : -1n;
    const closeSig = args[1] ? Buffer.from(args[1].bytes()).toString('base64') : '';
    check('V-CLOSE-TX-CALL',
      invoke !== undefined && Address.fromScAddress(invoke.contractAddress()).toString() === channel &&
        invoke.functionName().toString() === 'close' && closeAmount === highestAmount && closeSig === highest.signatureB64,
      `close(${closeAmount}, sig) on the channel uses the highest captured commitment`);
  }

  const events: unknown[] = [];
  if (ledger !== null) {
    const response = await server.getEvents({ startLedger: ledger, endLedger: ledger + 1, filters: [{ type: 'contract', contractIds: [channel] }], limit: 20 });
    for (const event of response.events.filter((e) => e.txHash === input.closeTxHash)) {
      const decoded = { topic: event.topic.map((t) => scValToNative(t) as unknown), value: scValToNative(event.value) as unknown };
      events.push(decoded);
      trace.emit('network', 'read.event', { txHash: event.txHash, name: String(decoded.topic[0]), value: decoded.value });
    }
    const withdraw = events.find((e) => (e as { topic: unknown[] }).topic[0] === 'withdraw') as { value: { to?: string; amount?: bigint } } | undefined;
    check('V-EVENT-WITHDRAW', withdraw?.value.to === input.expected.to && withdraw.value.amount === highestAmount,
      `Withdraw event pays ${withdraw?.value.amount ?? 'none'} to ${withdraw?.value.to ?? 'none'}`);
  }

  const [withdrawn, to, token, from, balance] = await Promise.all(
    ['withdrawn', 'to', 'token', 'from', 'balance'].map((fn) => readView(server, channel, fn)),
  );
  trace.emit('network', 'read.getters', { withdrawn, to, token, from, balance });
  check('V-GETTER-WITHDRAWN', withdrawn === highestAmount, `withdrawn() = ${String(withdrawn)}`);
  check('V-GETTER-PARTIES', to === input.expected.to && from === input.expected.from && token === input.expected.token,
    'to/from/token getters equal the expected recipient, funder and USDC SAC');
  check('V-GETTER-BALANCE', balance === 0n, `balance() = ${String(balance)} after close auto-refund`);
  return { checks, events, ledger };
}
