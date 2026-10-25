import {
  Account,
  Address,
  Contract,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  NETWORK,
  NativeCommitmentSchema,
  bytesToBase64,
  computeCommitmentDigest,
  hexToBytes,
  type NativeCommitment,
} from '@usagepay/contracts';

export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
/** Domain symbol of one-way-channel commitments (`symbol_short!("chancmmt")`). */
export const COMMITMENT_DOMAIN = 'chancmmt';

const SIMULATION_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

export function rpcServer(): rpc.Server {
  return new rpc.Server(RPC_URL);
}

/**
 * Locally builds the exact bytes one-way-channel signs: XDR `ScVal::Map` of the `Commitment` struct with
 * symbol keys in sorted order {amount: i128, channel: Address, domain: Symbol, network: BytesN<32>}.
 */
export function buildCommitmentMessage(channel: string, amount: bigint): Uint8Array {
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  const map = xdr.ScVal.scvMap([
    entry('amount', nativeToScVal(amount, { type: 'i128' })),
    entry('channel', new Address(channel).toScVal()),
    entry('domain', xdr.ScVal.scvSymbol(COMMITMENT_DOMAIN)),
    entry('network', xdr.ScVal.scvBytes(hash(Buffer.from(NETWORK_PASSPHRASE)))),
  ]);
  return new Uint8Array(map.toXDR());
}

/** Read-only contract call via simulation (no fees, no signature). */
export async function simulateView(server: rpc.Server, contractId: string, fn: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || sim.result === undefined) {
    throw new Error(`simulation of ${fn} on ${contractId} failed: ${'error' in sim ? sim.error : 'no result'}`);
  }
  return sim.result.retval;
}

export async function simulatePrepareCommitment(server: rpc.Server, channel: string, amount: bigint): Promise<Uint8Array> {
  const retval = await simulateView(server, channel, 'prepare_commitment', nativeToScVal(amount, { type: 'i128' }));
  return new Uint8Array(retval.bytes());
}

export async function readView(server: rpc.Server, contractId: string, fn: string): Promise<unknown> {
  return scValToNative(await simulateView(server, contractId, fn));
}

/** Instance storage of a contract as `{ "<Key>": value }`, with `Bytes` values rendered as lowercase hex. */
export async function readInstanceStorage(server: rpc.Server, contractId: string): Promise<Record<string, unknown>> {
  const entry = await server.getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
  const out: Record<string, unknown> = {};
  for (const item of entry.val.contractData().val().instance().storage() ?? []) {
    const key = scValToNative(item.key());
    const val = item.val();
    out[Array.isArray(key) ? key.join(':') : String(key)] =
      val.switch() === xdr.ScValType.scvBytes() ? Buffer.from(val.bytes()).toString('hex') : scValToNative(val);
  }
  return out;
}

/** Shapes a captured native credential into the frozen SPEC 00 `NativeCommitment` record. */
export function nativeCommitmentRecord(input: {
  channel: string;
  amount: bigint;
  message: Uint8Array;
  signatureHex: string;
  commitmentKey: string;
}): NativeCommitment {
  const signedMessageB64 = bytesToBase64(input.message);
  const signatureB64 = bytesToBase64(hexToBytes(input.signatureHex));
  return NativeCommitmentSchema.parse({
    schema: 'usagepay.native-commitment.v1',
    channelId: input.channel,
    network: NETWORK,
    cumulativeAmountBaseUnits: input.amount.toString(),
    signedMessageB64,
    signatureB64,
    commitmentKey: input.commitmentKey,
    commitmentDigest: computeCommitmentDigest({ signedMessageB64, signatureB64 }),
  });
}

export async function horizonUsdcBalance(account: string, issuer: string): Promise<string> {
  const response = await fetch(`${HORIZON_URL}/accounts/${account}`);
  if (!response.ok) throw new Error(`Horizon account ${account}: HTTP ${response.status}`);
  const body = (await response.json()) as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
  return body.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer)?.balance ?? '0';
}
