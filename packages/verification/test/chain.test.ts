import { describe, expect, it } from 'vitest';
import type { EvidenceE0 } from '@usagepay/contracts';
import { createVerifier, type ChainReader, type ObservedChannel, type VerifierTrust } from '../src/index.js';
import { FUNDER, e1For, fakeChain, golden, goldenTrust, offlineEncoding, type FakeChainState } from './helpers.js';

const trust = goldenTrust();
const highest = golden.e0.increments.at(-1)!.commitment;
const honestChannel = fakeChain(golden.e0, trust).state.channel as ObservedChannel;
const UNRELATED = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

async function verifyWithChain(patch: Partial<FakeChainState> = {}, options: { e0?: EvidenceE0; e1?: unknown; trust?: VerifierTrust; reader?: ChainReader; timeoutMs?: number } = {}) {
  const e0 = options.e0 ?? golden.e0;
  const pinned = options.trust ?? trust;
  const chain = fakeChain(options.reader === undefined ? e0 : golden.e0, pinned, patch);
  const report = await createVerifier({ trust: pinned, encoding: offlineEncoding, chain: options.reader ?? chain.reader, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
    .verify({ e0, e1: options.e1 ?? e1For(e0) });
  return { report, chain };
}

describe('V08: observed Testnet close and payout', () => {
  it('an honest close of the highest commitment passes V08 and the overall verdict', async () => {
    const { report, chain } = await verifyWithChain();
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'PASS', reasonCode: 'CHECK_PASSED' });
    expect(report.checks.V08_CHAIN.details).toContain(e1For(golden.e0).closeTxHash);
    expect(report.overall).toMatchObject({ status: 'PASS' });
    expect(chain.calls).toEqual([
      `getTransaction(${e1For(golden.e0).closeTxHash})`,
      `readChannel(${trust.channelId})`,
      `getTransactionEvents(${trust.channelId},1234,${e1For(golden.e0).closeTxHash})`,
    ]);
  });

  it('never queries the chain for a malformed E0', async () => {
    const chain = fakeChain(golden.e0, trust);
    const { report } = await verifyWithChain({}, { e1: e1For(golden.e0), e0: { ...golden.e0, increments: [] } as unknown as EvidenceE0, reader: chain.reader });
    expect(report.checks.V08_CHAIN.status).toBe('NOT_AVAILABLE');
    expect(chain.calls).toEqual([]);
  });
});

describe('F5-C: E1 points to an unrelated or mismatched settlement', () => {
  it.each<[string, Partial<FakeChainState>]>([
    ['an unrelated SUCCESS transaction on another contract', { transaction: { status: 'SUCCESS', ledger: 1234, invocation: { contractId: UNRELATED, functionName: 'transfer', amount: 3000000n, signatureB64: null } } }],
    ['a close with a lower amount', { transaction: { status: 'SUCCESS', ledger: 1234, invocation: { contractId: trust.channelId, functionName: 'close', amount: 2000000n, signatureB64: highest.signatureB64 } } }],
    ['a close with another signature', { transaction: { status: 'SUCCESS', ledger: 1234, invocation: { contractId: trust.channelId, functionName: 'close', amount: 3000000n, signatureB64: golden.e0.increments[0]!.commitment.signatureB64 } } }],
    ['a payout to another recipient', { events: [{ name: 'withdraw', to: FUNDER, amount: 3000000n }] }],
    ['a payout of another amount', { events: [{ name: 'withdraw', to: trust.recipient, amount: 2000000n }] }],
    ['a channel paying another recipient', { channel: { ...honestChannel, to: FUNDER } }],
    ['a channel on another asset', { channel: { ...honestChannel, token: UNRELATED } }],
    ['an on-chain commitment key that is not the pinned signer', { channel: { ...honestChannel, commitmentKeyHex: '00'.repeat(32) } }],
    ['withdrawn() differing from the highest commitment', { channel: { ...honestChannel, withdrawn: 2000000n } }],
    ['a residual channel balance after close', { channel: { ...honestChannel, balance: 5n } }],
  ])('%s fails V08 with CHAIN_MISMATCH', async (_name, patch) => {
    const { report } = await verifyWithChain(patch);
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'FAIL', reasonCode: 'CHAIN_MISMATCH' });
    expect(report.overall.status).toBe('FAIL');
  });

  it('a confirmed FAILED close fails V08 with SETTLEMENT_FAILED', async () => {
    const { report } = await verifyWithChain({ transaction: { status: 'FAILED', ledger: 1234, invocation: { contractId: trust.channelId, functionName: 'close', amount: 3000000n, signatureB64: highest.signatureB64 } } });
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'FAIL', reasonCode: 'SETTLEMENT_FAILED' });
  });

  it('an E1 that overstates the settled amount fails V08', async () => {
    const { report } = await verifyWithChain({}, { e1: e1For(golden.e0, { settledCumulativeBaseUnits: '4000000' }) });
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'FAIL', reasonCode: 'CHAIN_MISMATCH' });
  });

  it('an E1 that claims SUCCESS for an observed FAILED close fails V08', async () => {
    const { report } = await verifyWithChain({ transaction: { status: 'FAILED', ledger: 1234, invocation: null } });
    expect(report.checks.V08_CHAIN.status).toBe('FAIL');
    expect(report.checks.V08_CHAIN.details).toMatch(/E1 states SUCCESS/);
  });

  it('a conclusive offline FAIL wins over a chain PASS', async () => {
    const { report } = await verifyWithChain({}, { trust: goldenTrust({ budgetCapBaseUnits: '2500000' }) });
    expect(report.checks.V08_CHAIN.status).toBe('PASS');
    expect(report.overall).toMatchObject({ status: 'FAIL', reasonCode: 'BUDGET_EXCEEDED' });
  });
});

describe('F5-D: settlement cannot be proved', () => {
  it('RPC unavailable: offline checks still run, V08 and the overall verdict are NOT_AVAILABLE', async () => {
    const down = new Error('connect ECONNREFUSED');
    const { report } = await verifyWithChain({ transaction: down, events: down, channel: down });
    for (const id of ['V01_SCHEMA', 'V02_METER', 'V03_TARIFF', 'V04_EVIDENCE', 'V05_MPP', 'V06_PAYER_ACK', 'V07_E0_E1_LINK'] as const) {
      expect(report.checks[id].status, id).toBe('PASS');
    }
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'RPC_UNAVAILABLE' });
    expect(report.overall).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'RPC_UNAVAILABLE' });
  });

  it('a transaction that is NOT_FOUND (pending or outside retention) is NOT_AVAILABLE, never PASS', async () => {
    const { settledCumulativeBaseUnits: _unknown, ...pending } = e1For(golden.e0, { txStatus: 'NOT_FOUND' });
    const { report } = await verifyWithChain({ transaction: { status: 'NOT_FOUND' } }, { e1: pending });
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'SETTLEMENT_NOT_PROVABLE' });
    expect(report.overall.status).toBe('NOT_AVAILABLE');
  });

  it('a successful close without an observable withdraw event is NOT_AVAILABLE', async () => {
    const { report } = await verifyWithChain({ events: [] });
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'SETTLEMENT_NOT_PROVABLE' });
  });

  it('events outside RPC retention are NOT_AVAILABLE, not FAIL', async () => {
    const { report } = await verifyWithChain({ events: new Error('startLedger must be within the ledger range') });
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'RPC_UNAVAILABLE' });
  });

  it('an unreadable on-chain commitment key is NOT_AVAILABLE even when the offline V05 signature passes', async () => {
    const { report } = await verifyWithChain({ channel: { ...honestChannel, commitmentKeyHex: null } });
    expect(report.checks.V05_MPP.status).toBe('PASS');
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'SETTLEMENT_NOT_PROVABLE' });
  });

  it('a hanging RPC is bounded by the timeout and reported NOT_AVAILABLE', async () => {
    const hanging: ChainReader = { getTransaction: () => new Promise(() => {}), getTransactionEvents: () => new Promise(() => {}), readChannel: () => new Promise(() => {}) };
    const { report } = await verifyWithChain({}, { reader: hanging, timeoutMs: 20 });
    expect(report.checks.V08_CHAIN).toMatchObject({ status: 'NOT_AVAILABLE', reasonCode: 'RPC_UNAVAILABLE' });
    expect(report.checks.V08_CHAIN.details).toMatch(/timed out after 20 ms/);
  });
});
