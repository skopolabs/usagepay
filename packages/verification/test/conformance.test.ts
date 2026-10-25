import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_CRITICAL_CONDITIONS, type EvidenceE0 } from '@usagepay/contracts';
import { buildAuthorizationConformanceCases, type ConformanceCase } from '@usagepay/fixtures';
import { CHECK_IDS, createVerifier } from '../src/index.js';
import { FUNDER, RECIPIENT, e1For, golden, offlineEncoding } from './helpers.js';

const cases = buildAuthorizationConformanceCases(golden);

/** The verifier re-checks each frozen case as the E0 the payer would have finalized with that candidate. */
async function verifyCase(testCase: ConformanceCase) {
  const { trust, tariff, prior, candidate } = testCase;
  const e0 = { ...golden.e0, tariff, increments: [...prior, candidate] } as EvidenceE0;
  const verifier = createVerifier({
    trust: {
      network: trust.network,
      sessionId: trust.sessionId,
      channelId: trust.channelId,
      recipient: RECIPIENT,
      funder: FUNDER,
      assetSac: trust.assetSac,
      commitmentKey: trust.payerAccountId,
      tariffVersionDigest: trust.tariffVersionDigest,
      budgetCapBaseUnits: trust.budgetCapBaseUnits,
      meterKeys: trust.meterKeys,
    },
    encoding: offlineEncoding,
  });
  return verifier.verify({ e0, e1: e1For(e0, { channelId: trust.channelId, assetSac: trust.assetSac }) });
}

/** SPEC 03 re-checks AC13 in V03 with the pinned budget cap (the catalogue still records the original gap). */
const verifierChecksOf = (conditionId: string) =>
  conditionId === 'AC13_BUDGET_CAP' ? ['V03_TARIFF'] : AUTHORIZATION_CRITICAL_CONDITIONS.find((c) => c.id === conditionId)!.verifierChecks;

describe('frozen authorization conformance catalogue, re-checked independently', () => {
  it('covers every AC01-AC17 condition', () => {
    const covered = new Set(cases.map((c) => c.conditionId).filter((id) => id !== null));
    expect([...covered].sort()).toEqual(AUTHORIZATION_CRITICAL_CONDITIONS.map((c) => c.id).sort());
  });

  it.each(cases.filter((c) => c.conditionId === null).map((c) => [c.caseId, c] as const))('control %s passes V01-V07', async (_id, testCase) => {
    const report = await verifyCase(testCase);
    for (const id of CHECK_IDS.filter((c) => c !== 'V08_CHAIN')) expect(report.checks[id], id).toMatchObject({ status: 'PASS' });
  });

  it.each(cases.filter((c) => c.conditionId !== null).map((c) => [c.caseId, c] as const))('%s fails a catalogue check and the overall verdict', async (_id, testCase) => {
    const report = await verifyCase(testCase);
    const expected = testCase.structurallyRejected ? ['V01_SCHEMA'] : verifierChecksOf(testCase.conditionId!);
    const failed = CHECK_IDS.filter((id) => report.checks[id].status === 'FAIL');
    expect(failed.filter((id) => (expected as readonly string[]).includes(id)), `failed: ${failed.join(', ')}`).not.toEqual([]);
    expect(report.overall.status).toBe('FAIL');
  });
});
