import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountIdToPublicKey, bytesToHex } from '@usagepay/contracts';
import type { ChainReader, ObservedChannel } from '@usagepay/verification';
import {
  explainEvent,
  explainTrace,
  findLatestRun,
  formatAmount,
  formatEnergy,
  loadRealRun,
  meterRows,
  runDemo,
  type DemoBundle,
  type RealRun,
} from '../src/index.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const RUNS = join(ROOT, 'scripts/testnet/runs');
const latest = findLatestRun(RUNS)!;
const run = loadRealRun(latest);

/** Read-only ledger double answering what Testnet reports for an honest close of `run` (the real values are in G3). */
function honestLedger(r: RealRun, patch: Partial<ObservedChannel> = {}): ChainReader {
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

function demo(argv: string[], chain: ChainReader = honestLedger(run)) {
  const out = mkdtempSync(join(tmpdir(), 'upay-demo-'));
  const files = new Map<string, string>();
  let stdout = '';
  let stderr = '';
  const exit = runDemo([...argv, '--out', join(out, 'bundle.json')], {
    cwd: ROOT,
    chainReader: () => chain,
    writeFile: (path, text) => files.set(path, text),
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    now: () => new Date('2026-10-25T10:00:00.000Z'),
  });
  return exit.then((code) => ({ code, stdout, stderr, bundle: files.has(join(out, 'bundle.json')) ? (JSON.parse(files.get(join(out, 'bundle.json'))!) as DemoBundle) : undefined }));
}

describe('display formatting (integer only)', () => {
  it.each([['3000000', '0.30 USDC'], ['10000000', '1.00 USDC'], ['1234567', '0.1234567 USDC'], ['0', '0.00 USDC'], ['25000000', '2.50 USDC']])('%s base units -> %s', (units, text) => {
    expect(formatAmount(units)).toBe(text);
  });
  it.each([['250', '0.25 kWh'], ['1000', '1.00 kWh'], ['750', '0.75 kWh']])('%s Wh -> %s', (wh, text) => {
    expect(formatEnergy(wh)).toBe(text);
  });
});

describe('plain-language narrative', () => {
  it('narrates the real G2 trace in order and marks the ledger steps ON_CHAIN', () => {
    const story = explainTrace(run.trace);
    const onChain = story.filter((e) => e.layer === 'ON_CHAIN').map((e) => e.title);
    expect(onChain[0]).toMatch(/^Payment channel holds 1.00 USDC/);
    expect(onChain).toContain('Ledger confirms: station paid 0.30 USDC');
    expect(story.filter((e) => e.title.startsWith('Fleet signs voucher')).map((e) => e.title)).toEqual([
      'Fleet signs voucher #1 for 0.10 USDC total',
      'Fleet signs voucher #2 for 0.20 USDC total',
      'Fleet signs voucher #3 for 0.30 USDC total',
    ]);
    expect(story.every((e) => e.title.length > 0 && e.detail.length > 0 && e.technical['event'] !== undefined)).toBe(true);
  });

  it('every event of the real trace is either explained or deliberately bookkeeping', () => {
    const bookkeeping = new Set(['run.start', 'run.end', 'check', 'payer.accepted']);
    const unexplained = run.trace.filter((e) => explainEvent(e.event, e.data) === null && !bookkeeping.has(e.event)).map((e) => e.event);
    expect(unexplained).toEqual([]);
  });

  it('links to the explorer only for the real Testnet ledger, never for the simulated one', () => {
    const data = { txHash: 'ab'.repeat(32) };
    expect(explainEvent('settlement.close.submitted', data, { ledger: 'TESTNET' })?.links?.[0]?.url).toBe(`https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}`);
    const simulated = explainEvent('settlement.close.submitted', data, { ledger: 'SIMULATED' });
    expect(simulated?.links).toBeUndefined();
    expect(simulated?.title).toMatch(/simulated ledger/);
  });
});

describe('real run loading', () => {
  it('decodes the meter readings from the exact signed bytes in E0', () => {
    expect(meterRows(run.e0).map((r) => `${r.readingId} ${r.meterStartWh}->${r.meterEndWh} ${r.cumulativeChargeBaseUnits}`)).toEqual([
      'r-001 10000->10250 1000000',
      'r-002 10250->10500 2000000',
      'r-003 10500->10750 3000000',
    ]);
  });

  it('refuses a run without a pinned trust file instead of deriving trust from the evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upay-run-'));
    for (const name of ['e0.json', 'e1.json', 'summary.json', 'trace.jsonl']) writeFileSync(join(dir, name), readFileSync(join(latest, name)));
    expect(() => loadRealRun(dir)).toThrow(/no pinned trust file/);
  });
});

describe('pnpm demo (walkthrough + bundle)', () => {
  it('live: replays the real run, verifies V01-V08 PASS, runs S1/F1-F7 and exits 0', async () => {
    const { code, stdout, bundle } = await demo([]);
    expect(code).toBe(0);
    for (const step of ['STEP 1', 'STEP 2', 'STEP 3', 'STEP 4', 'STEP 5']) expect(stdout).toContain(step);
    expect(stdout).toContain(`REPLAY of real Stellar Testnet run ${run.runId}`);
    expect(stdout).toContain('AUDITOR VERDICT: PASS');
    expect(stdout).toContain('DEMO PASS');
    expect(bundle?.schema).toBe('upay.demo-bundle.v1');
    expect(bundle?.realRun).toMatchObject({ status: 'REPLAY', evidenceClass: 'REAL_TESTNET', runId: run.runId, verification: { mode: 'LIVE', overall: { status: 'PASS' } } });
    expect(bundle?.scenarios.map((s) => `${s.id}:${s.result}`)).toEqual(['S1:PASS', 'F1:PASS', 'F2:PASS', 'F3:PASS', 'F4:PASS', 'F5:PASS', 'F6:PASS', 'F7:PASS']);
  });

  it('offline: never PASS; V08 NOT_AVAILABLE and exit 2', async () => {
    const { code, stdout, bundle } = await demo(['--offline']);
    expect(code).toBe(2);
    expect(stdout).toContain('AUDITOR VERDICT: NOT_AVAILABLE');
    expect(bundle?.result.status).toBe('NOT_AVAILABLE');
  });

  it('ledger unreachable: NOT_AVAILABLE, exit 2', async () => {
    const down: ChainReader = { getTransaction: () => Promise.reject(new Error('ECONNREFUSED')), getTransactionEvents: () => Promise.reject(new Error('x')), readChannel: () => Promise.reject(new Error('x')) };
    const { code, bundle } = await demo([], down);
    expect(code).toBe(2);
    expect(bundle?.realRun).toMatchObject({ verification: { overall: { status: 'NOT_AVAILABLE' } }, ledger: { status: 'UNAVAILABLE' } });
  });

  it('ledger contradicts the record: FAIL, exit 1', async () => {
    const { code, stdout } = await demo([], honestLedger(run, { withdrawn: 1_000_000n }));
    expect(code).toBe(1);
    expect(stdout).toContain('AUDITOR VERDICT: FAIL');
    expect(stdout).toContain('DEMO FAIL');
  });

  it('usage errors exit 3 without a verdict', async () => {
    expect((await demo(['--nope'])).code).toBe(3);
    expect((await demo(['--run', 'scripts/testnet/runs/does-not-exist'])).code).toBe(3);
  });

  it('the bundle holds public data only', async () => {
    const { bundle } = await demo([]);
    const text = JSON.stringify(bundle);
    expect(text).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    expect(text).not.toMatch(/secret/i);
  });
});
