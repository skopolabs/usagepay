import { afterEach, describe, expect, it, vi } from 'vitest';
import { Account, Address, Contract, Keypair, SorobanDataBuilder, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr, type Transaction } from '@stellar/stellar-sdk';
import { createStellarChainReader } from '../src/index.js';

/**
 * OFFLINE test of the read-only RPC adapter: only `rpc.Server.prototype` methods are replaced, with answers in the
 * exact XDR shapes Soroban RPC returns. Decoding of a real close envelope, events and contract state runs for real.
 */
const CHANNEL = 'CB2GLQYWYVRD6MM2B25474GPUFQ7ZIYDRLIL7IYJMNV7FLSTTOZCKYPE';
const TOKEN = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const TO = 'GAN7YUBHSRIZ4DKNZPFHGPWMSZPNAK2RS6A6CXVWZPJJ7GGYZVTNMANG';
const FROM = 'GB6XZYHIGRQPG7L7CHZYFM3HFHKSJNBDXQZ5W5ZCDG5QEM32EEBAPOJC';
const TX_HASH = 'ab'.repeat(32);
const SIGNATURE = Buffer.alloc(64, 7);
const COMMITMENT_KEY = Buffer.alloc(32, 9);
const PASSPHRASE = 'Test SDF Network ; September 2015';

function closeEnvelope(contractId = CHANNEL, fn = 'close'): xdr.TransactionEnvelope {
  const source = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
  const tx = new TransactionBuilder(new Account(source, '1'), { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(fn, nativeToScVal(3000000n, { type: 'i128' }), xdr.ScVal.scvBytes(SIGNATURE)))
    .setTimeout(30)
    .build();
  return tx.toEnvelope();
}

const symbolMap = (entries: [string, xdr.ScVal][]) => xdr.ScVal.scvMap(entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })));

afterEach(() => vi.restoreAllMocks());

describe('createStellarChainReader (read-only Soroban RPC adapter)', () => {
  it('decodes the close invocation from the transaction envelope', async () => {
    vi.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({ status: 'SUCCESS', ledger: 99, envelopeXdr: closeEnvelope() } as unknown as rpc.Api.GetTransactionResponse);
    expect(await createStellarChainReader().getTransaction(TX_HASH)).toEqual({
      status: 'SUCCESS',
      ledger: 99,
      invocation: { contractId: CHANNEL, functionName: 'close', amount: 3000000n, signatureB64: SIGNATURE.toString('base64') },
    });
  });

  it('reports NOT_FOUND and FAILED as observed', async () => {
    const spy = vi.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({ status: 'NOT_FOUND' } as unknown as rpc.Api.GetTransactionResponse);
    expect(await createStellarChainReader().getTransaction(TX_HASH)).toEqual({ status: 'NOT_FOUND' });
    spy.mockResolvedValue({ status: 'FAILED', ledger: 7, envelopeXdr: closeEnvelope(CHANNEL, 'transfer') } as unknown as rpc.Api.GetTransactionResponse);
    expect(await createStellarChainReader().getTransaction(TX_HASH)).toMatchObject({ status: 'FAILED', ledger: 7, invocation: { functionName: 'transfer' } });
  });

  it('returns only the events of the requested transaction, decoded', async () => {
    const getEvents = vi.spyOn(rpc.Server.prototype, 'getEvents').mockResolvedValue({
      events: [
        { txHash: TX_HASH, topic: [xdr.ScVal.scvSymbol('withdraw')], value: symbolMap([['amount', nativeToScVal(3000000n, { type: 'i128' })], ['to', new Address(TO).toScVal()]]) },
        { txHash: TX_HASH, topic: [xdr.ScVal.scvSymbol('close')], value: symbolMap([['effective_at_ledger', xdr.ScVal.scvU32(5)]]) },
        { txHash: 'cd'.repeat(32), topic: [xdr.ScVal.scvSymbol('withdraw')], value: symbolMap([['amount', nativeToScVal(1n, { type: 'i128' })], ['to', new Address(FROM).toScVal()]]) },
        { txHash: TX_HASH, topic: [xdr.ScVal.scvSymbol('refund')], value: symbolMap([['amount', nativeToScVal(7000000n, { type: 'i128' })], ['from', new Address(FROM).toScVal()]]) },
      ],
    } as unknown as rpc.Api.GetEventsResponse);
    expect(await createStellarChainReader().getTransactionEvents(CHANNEL, 99, TX_HASH)).toEqual([
      { name: 'withdraw', to: TO, amount: 3000000n },
      { name: 'close' },
      { name: 'refund', from: FROM, amount: 7000000n },
    ]);
    expect(getEvents.mock.calls[0]?.[0]).toMatchObject({ startLedger: 99, filters: [{ type: 'contract', contractIds: [CHANNEL] }] });
  });

  it('reads CommitmentKey from instance storage and the channel getters through simulation', async () => {
    vi.spyOn(rpc.Server.prototype, 'getContractData').mockResolvedValue({
      val: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: new xdr.ExtensionPoint(0),
          contract: new Address(CHANNEL).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
          val: xdr.ScVal.scvContractInstance(
            new xdr.ScContractInstance({
              executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
              storage: [new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CommitmentKey')]), val: xdr.ScVal.scvBytes(COMMITMENT_KEY) })],
            }),
          ),
        }),
      ),
    } as unknown as rpc.Api.LedgerEntryResult);
    const views: Record<string, xdr.ScVal> = {
      from: new Address(FROM).toScVal(),
      to: new Address(TO).toScVal(),
      token: new Address(TOKEN).toScVal(),
      balance: nativeToScVal(0n, { type: 'i128' }),
      withdrawn: nativeToScVal(3000000n, { type: 'i128' }),
    };
    vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockImplementation(async (tx) => {
      const call = (tx as Transaction).operations[0];
      const fn = call?.type === 'invokeHostFunction' ? call.func.invokeContract().functionName().toString() : '';
      return { id: 'x', latestLedger: 1, events: [], _parsed: true, minResourceFee: '0', transactionData: new SorobanDataBuilder(), result: { auth: [], retval: views[fn]! } } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
    });
    expect(await createStellarChainReader().readChannel(CHANNEL)).toEqual({
      commitmentKeyHex: COMMITMENT_KEY.toString('hex'),
      from: FROM,
      to: TO,
      token: TOKEN,
      balance: 0n,
      withdrawn: 3000000n,
    });
    expect(scValToNative(views.withdrawn!)).toBe(3000000n);
  });

  it('propagates an unreachable RPC as an error (the verifier turns it into NOT_AVAILABLE)', async () => {
    vi.spyOn(rpc.Server.prototype, 'getTransaction').mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(createStellarChainReader().getTransaction(TX_HASH)).rejects.toThrow(/ECONNREFUSED/);
  });
});
