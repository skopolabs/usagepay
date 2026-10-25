/**
 * G3 / SPEC 03 opt-in Testnet E2E, READ-ONLY (no transaction is built, signed or submitted). The independent verifier
 * re-checks the genuine SPEC 02 G2 artifacts against live Soroban RPC with trust inputs pinned outside the evidence:
 *   S1   genuine E0/E1                                  -> overall PASS (V01-V08)
 *   F1-C copied E0 with one flipped meter source byte  -> FAIL (V02)
 *   F5-C E1 pointing to a real but unrelated close     -> FAIL (V08 CHAIN_MISMATCH)
 *   F5-D E1 pointing to a transaction that never existed -> NOT_AVAILABLE (V08)
 * Output: scripts/testnet/runs/<runId>/{s1-report.txt,s1-report.json,summary.json}.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64ToBytes, bytesToBase64, type EvidenceE0, type EvidenceE1 } from '@usagepay/contracts';
import {
  CHECK_IDS,
  createStellarChainReader,
  createVerifier,
  formatReport,
  trustFromFile,
  type CheckId,
  type VerificationReport,
} from '@usagepay/verification';

const ROOT = new URL('../../../', import.meta.url).pathname;
/** Default: the newest G2 run that completed with an E1, verified against the trust file it pinned before signing. */
const G2_RUN = process.argv[2] ?? latestG2Run();
const TRUST_FILE = process.argv[3] ?? join(G2_RUN, 'trust.json');
/** The G1 channel's real, successful close (see the g1 run summary): genuine, but unrelated to the G2 evidence. */
const UNRELATED_REAL_CLOSE = process.env['UPAY_UNRELATED_TX'] ?? 'ee5598ca5f5ea5fda213282bd7f2fc23a0ab53bf947ae28b2c0393ff4ff74543';

function latestG2Run(): string {
  const runs = join(ROOT, 'scripts/testnet/runs');
  const latest = readdirSync(runs).filter((name) => name.startsWith('g2-') && existsSync(join(runs, name, 'e1.json'))).sort().at(-1);
  if (latest === undefined) throw new Error('no completed g2-* run; run pnpm g2:settlement first');
  return join('scripts/testnet/runs', latest);
}

const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as unknown;
const e0 = readJson(join(G2_RUN, 'e0.json')) as EvidenceE0;
const e1 = readJson(join(G2_RUN, 'e1.json')) as EvidenceE1;
const trust = trustFromFile(readJson(TRUST_FILE));
const verifier = createVerifier({ trust, chain: createStellarChainReader(), timeoutMs: 20_000 });

const runId = `g3-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const runDir = join(ROOT, 'scripts/testnet/runs', runId);
mkdirSync(runDir, { recursive: true });

interface Expectation {
  readonly overall: VerificationReport['overall']['status'];
  readonly checks: Partial<Record<CheckId, { status: string; reasonCode?: string }>>;
}

const scenarios: { id: string; description: string; e0: unknown; e1: unknown; expect: Expectation }[] = [];

scenarios.push({
  id: 'S1',
  description: 'genuine G2 E0/E1 against live Testnet RPC',
  e0,
  e1,
  expect: { overall: 'PASS', checks: Object.fromEntries(CHECK_IDS.map((id) => [id, { status: 'PASS' }])) },
});

const tampered = structuredClone(e0);
const raw = base64ToBytes(tampered.increments[1]!.reading.rawPayloadB64);
raw[raw.length - 3] = (raw[raw.length - 3] ?? 0) ^ 0x01;
tampered.increments[1]!.reading.rawPayloadB64 = bytesToBase64(raw);
scenarios.push({
  id: 'F1-C',
  description: 'copied E0, one meter source byte of r-002 flipped under the original signature',
  e0: tampered,
  e1,
  expect: { overall: 'FAIL', checks: { V02_METER: { status: 'FAIL', reasonCode: 'INVALID_METER_SIGNATURE' }, V07_E0_E1_LINK: { status: 'FAIL', reasonCode: 'E0_DIGEST_MISMATCH' } } },
});

scenarios.push({
  id: 'F5-C',
  description: `E1 points to a real SUCCESS close of another channel (${UNRELATED_REAL_CLOSE})`,
  e0,
  e1: { ...e1, closeTxHash: UNRELATED_REAL_CLOSE },
  expect: { overall: 'FAIL', checks: { V08_CHAIN: { status: 'FAIL', reasonCode: 'CHAIN_MISMATCH' } } },
});

scenarios.push({
  id: 'F5-D',
  description: 'E1 points to a transaction hash that does not exist on Testnet',
  e0,
  e1: { ...e1, closeTxHash: randomBytes(32).toString('hex') },
  expect: { overall: 'NOT_AVAILABLE', checks: { V08_CHAIN: { status: 'NOT_AVAILABLE', reasonCode: 'SETTLEMENT_NOT_PROVABLE' } } },
});

const results = [];
for (const scenario of scenarios) {
  const report = await verifier.verify({ e0: scenario.e0, e1: scenario.e1 });
  const mismatches = [
    ...(report.overall.status === scenario.expect.overall ? [] : [`overall ${report.overall.status} != ${scenario.expect.overall}`]),
    ...Object.entries(scenario.expect.checks).flatMap(([id, want]) => {
      const got = report.checks[id as CheckId];
      const ok = got.status === want.status && (want.reasonCode === undefined || got.reasonCode === want.reasonCode);
      return ok ? [] : [`${id} ${got.status}/${got.reasonCode} != ${want.status}/${want.reasonCode ?? '*'}`];
    }),
  ];
  const result = mismatches.length === 0 ? 'PASS' : 'FAIL';
  console.log(`${result}  ${scenario.id}  overall ${report.overall.status} (${report.overall.reasonCode})${mismatches.length ? `  ${mismatches.join('; ')}` : ''}`);
  if (scenario.id === 'S1') {
    writeFileSync(join(runDir, 's1-report.txt'), formatReport(report));
    writeFileSync(join(runDir, 's1-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n${formatReport(report)}`);
  }
  results.push({
    id: scenario.id,
    description: scenario.description,
    result,
    overall: report.overall,
    checks: Object.fromEntries(CHECK_IDS.map((id) => [id, { status: report.checks[id].status, reasonCode: report.checks[id].reasonCode }])),
    mismatches,
  });
}

const passed = results.every((r) => r.result === 'PASS');
writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
  schema: 'upay.g3-verification-run.v1',
  runId,
  result: passed ? 'PASS' : 'FAIL',
  network: 'stellar:testnet',
  evidenceClass: 'TESTNET_LIVE read-only RPC (meter data: SIMULATED, runtime meter key)',
  inputs: { g2Run: G2_RUN, trustFile: TRUST_FILE, e0Digest: e1.e0Digest, closeTxHash: e1.closeTxHash, channelId: trust.channelId },
  scenarios: results,
}, null, 2) + '\n');
console.log(`\n${passed ? 'PASS' : 'FAIL'}  ${runDir}`);
process.exit(passed ? 0 : 1);
