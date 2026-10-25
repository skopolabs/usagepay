import { beforeAll, describe, expect, it } from 'vitest';
import { CHECK_IDS } from '@usagepay/verification';
import { runScenarios, type ScenarioResult } from '../src/index.js';

/**
 * SPEC 04 §5 acceptance table, offline: every scenario runs the real SPEC 01 -> SPEC 02 -> SPEC 03 ports with the
 * pinned MPP SDK and a simulated ledger. Each row reports scenario ID, session, expected vs actual and evidence class.
 */
let results: ScenarioResult[];
beforeAll(async () => {
  results = await runScenarios();
}, 120_000);

const byId = (id: string) => results.find((r) => r.id === id)!;

describe('SPEC 04 integration scenarios (SDK_INTEGRATION, offline ledger)', () => {
  it('runs S1 and F1-F7 in order, each identifying session, expectation, outcome and evidence class', () => {
    expect(results.map((r) => r.id)).toEqual(['S1', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);
    for (const r of results) {
      expect(r.sessionId).toBe('ev-session-001');
      expect(r.evidenceClass).toBe('SDK_INTEGRATION');
      expect(r.question.length).toBeGreaterThan(0);
      expect(r.answer.length).toBeGreaterThan(0);
      expect(r.story.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['S1', 'PASS', 'ALL_CHECKS_PASSED'],
    ['F1', 'REJECTED', 'INVALID_METER_SIGNATURE'],
    ['F2', 'REJECTED', 'BUDGET_EXCEEDED'],
    ['F3', 'REJECTED', 'DUPLICATE_READING'],
    ['F4', 'REJECTED', 'INVALID_PAYER_ACK'],
    ['F5', 'FAIL', 'CHAIN_MISMATCH'],
    ['F6', 'FAIL', 'E0_DIGEST_MISMATCH'],
    ['F7', 'PENDING', 'PAYMENT_OUTCOME_UNKNOWN'],
  ])('%s: actual %s / %s and every checkpoint holds', (id, status, reasonCode) => {
    const r = byId(id);
    expect(r.actual).toEqual({ status, reasonCode });
    expect(r.checkpoints.filter((c) => !c.ok)).toEqual([]);
    expect(r.result).toBe('PASS');
  });

  it('S1: V01-V08 all PASS against the ledger the close actually changed', () => {
    const s1 = byId('S1');
    expect(CHECK_IDS.map((id) => s1.verification?.checks[id].status)).toEqual(CHECK_IDS.map(() => 'PASS'));
    expect(s1.story.some((e) => e.layer === 'ON_CHAIN' && e.title.includes('station paid 0.30 USDC'))).toBe(true);
  });

  it('F1/F2/F4: no refused scenario ever reports a payment success for the refused step', () => {
    for (const id of ['F1', 'F2', 'F4']) {
      const refusals = byId(id).story.filter((e) => e.status === 'REJECTED');
      expect(refusals.length).toBeGreaterThan(0);
    }
    expect(byId('F2').checkpoints.find((c) => c.label.startsWith('No third voucher'))?.actual).toBe('false');
  });

  it('F5: missing ledger data is NOT_AVAILABLE, never PASS', () => {
    expect(byId('F5').checkpoints.find((c) => c.label === 'Never reported as PASS')?.actual).toBe('FAIL,FAIL,NOT_AVAILABLE');
  });

  it('stories carry only public data: no secret seeds or private keys', () => {
    const text = JSON.stringify(results);
    expect(text).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    expect(text).not.toMatch(/secret/i);
  });
});
