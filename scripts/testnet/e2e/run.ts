/**
 * SPEC 04 `pnpm test:e2e:testnet`: EXPLICIT OPT-IN (UPAY_TESTNET_E2E=1), Stellar Testnet only. One command for the
 * complete REAL_TESTNET flow with fresh evidence:
 *   1. deploy and fund a fresh `upay-e2e-*` one-way-channel (deploy-channel.sh, 1 USDC deposit)
 *   2. G2: three SDK-signed cumulative commitments through the payee ack gate, E0, one real close, E1, trust.json
 *   3. G3: independent read-only verification of that run (S1 PASS, F1-C FAIL, F5-C FAIL, F5-D NOT_AVAILABLE)
 * Output: scripts/testnet/runs/e2e-<timestamp>/summary.json, next to the g2-* and g3-* run directories.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { rpc } from '@stellar/stellar-sdk';
import { testnetGuard } from '@usagepay/demo';
import { HORIZON_URL, RPC_URL, horizonUsdcBalance } from '../g1/chain.ts';
import { IDENTITIES, identityAddress } from '../g1/identities.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const DEPOSIT_USDC = 1n;
const versions = JSON.parse(readFileSync(join(ROOT, 'implementation-versions.json'), 'utf8')) as {
  network?: { id?: string; networkPassphrase?: string; assetClassic?: string };
};

function refuse(reason: string): never {
  console.error(reason);
  process.exit(3);
}

const offline = testnetGuard({ env: process.env, network: versions.network, rpcUrl: RPC_URL });
if (offline !== null) refuse(offline);
const live = testnetGuard({ env: process.env, network: versions.network, rpcUrl: RPC_URL, rpcPassphrase: (await new rpc.Server(RPC_URL).getNetwork()).passphrase });
if (live !== null) refuse(live);

const funder = identityAddress(IDENTITIES.funder);
const usdcIssuer = versions.network?.assetClassic?.split(':')[1] ?? '';
const usdc = await horizonUsdcBalance(funder, usdcIssuer);
if (BigInt(usdc.split('.')[0] ?? '0') < DEPOSIT_USDC) refuse(`refusing: funder ${funder} holds ${usdc} USDC, needs ${DEPOSIT_USDC} for the channel deposit (Circle Testnet faucet)`);
const xlm = (await (await fetch(`${HORIZON_URL}/accounts/${funder}`)).json() as { balances: { asset_type: string; balance: string }[] })
  .balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
console.log(`preflight  Testnet RPC ${RPC_URL}, funder ${funder}: ${usdc} USDC, ${xlm} XLM`);

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).toLowerCase();
const alias = `upay-e2e-${stamp}`;
const runId = `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`;

function step(label: string, command: string, args: string[], env: Record<string, string>): string {
  console.log(`\n== ${label}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(result.stdout ?? '');
  if (result.status !== 0) finish('FAIL', `${label} exited ${result.status}`);
  return result.stdout ?? '';
}

const results: Record<string, unknown> = { alias };

step('1. deploy fresh channel', 'bash', ['scripts/testnet/deploy-channel.sh'], { CHANNEL_ALIAS: alias });

const g2Out = step('2. G2 settlement (real close)', 'node', ['scripts/testnet/g2/run.ts'], { UPAY_CHANNEL_ALIAS: alias });
const g2Dir = /^PASS\s+(\S*g2-\S+)$/m.exec(g2Out)?.[1];
if (g2Dir === undefined) finish('FAIL', 'G2 did not report a PASS run directory');
const g2Run = relative(ROOT, g2Dir);
const { channelId, closeTxHash, e0Digest } = JSON.parse(readFileSync(join(g2Dir, 'summary.json'), 'utf8')) as { channelId: string; closeTxHash: string; e0Digest: string };
results['g2'] = { runDir: g2Run, channelId, closeTxHash, e0Digest };

const g3Out = step('3. G3 independent verification (read-only)', 'node', ['scripts/testnet/g3/run.ts', g2Run, join(g2Run, 'trust.json')], {});
const g3Dir = /^PASS\s+(\S*g3-\S+)$/m.exec(g3Out)?.[1];
if (g3Dir === undefined) finish('FAIL', 'G3 did not report a PASS run directory');
const g3Summary = JSON.parse(readFileSync(join(g3Dir, 'summary.json'), 'utf8')) as { scenarios: { id: string; result: string; overall: { status: string; reasonCode: string } }[] };
results['g3'] = { runDir: relative(ROOT, g3Dir), scenarios: g3Summary.scenarios.map((s) => ({ id: s.id, result: s.result, overall: s.overall })) };
finish('PASS', `channel ${alias} closed once; G3 S1 PASS with V01-V08`);

function finish(result: 'PASS' | 'FAIL', detail: string): never {
  const dir = join(ROOT, 'scripts/testnet/runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({
    schema: 'upay.testnet-e2e-run.v1',
    runId,
    result,
    detail,
    network: 'stellar:testnet',
    evidenceClass: 'REAL_TESTNET',
    ...results,
  }, null, 2) + '\n');
  console.log(`\n${result}  ${detail}\n${result}  ${dir}`);
  process.exit(result === 'PASS' ? 0 : 1);
}
