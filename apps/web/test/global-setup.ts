import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { buildBundle, findLatestRun, loadRealRun, toJson, type DemoBundle } from '@usagepay/demo';
import type { ChainReader } from '@usagepay/verification';
import { honestLedger } from '../../demo/test/ledger-double.ts';

/** The bundle variants the UI must render honestly (SPEC 05 UI-AC06), each built by the real SPEC 04 code. */
export interface TestBundles {
  /** Real committed rehearsal run, verified PASS against a ledger double that answers like Testnet did. */
  readonly live: DemoBundle;
  /** Same run, `--offline`: V08 and the overall verdict NOT_AVAILABLE. */
  readonly offline: DemoBundle;
  /** Same run, ledger unreachable: observation UNAVAILABLE, V08 NOT_AVAILABLE. */
  readonly unavailable: DemoBundle;
  /** Ledger contradicts the evidence: V08 FAIL. */
  readonly fail: DemoBundle;
  /** No captured run at all. */
  readonly missing: DemoBundle;
  /** The live bundle written to disk, for the production build test. */
  readonly liveFile: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    bundles: TestBundles;
  }
}

const ROOT = new URL('../../../', import.meta.url).pathname;

export default async function setup(project: TestProject) {
  const latest = findLatestRun(join(ROOT, 'scripts/testnet/runs'));
  if (latest === undefined) throw new Error('no committed g2-* run with e1.json under scripts/testnet/runs');
  const run = loadRealRun(latest);
  const now = () => new Date('2026-10-25T10:00:00.000Z');
  const down: ChainReader = {
    getTransaction: () => Promise.reject(new Error('ECONNREFUSED')),
    getTransactionEvents: () => Promise.reject(new Error('ECONNREFUSED')),
    readChannel: () => Promise.reject(new Error('ECONNREFUSED')),
  };
  // Round-trip through JSON exactly like `pnpm demo` writes the file (bigints become strings).
  const json = async (options: Parameters<typeof buildBundle>[0]) => JSON.parse(toJson(await buildBundle({ ...options, now }))) as DemoBundle;
  // Sequential: the offline scenario ledger patches the SDK RPC client and allows one install at a time.
  const live = await json({ run, chain: honestLedger(run) });
  const offline = await json({ run });
  const unavailable = await json({ run, chain: down, timeoutMs: 200 });
  const fail = await json({ run, chain: honestLedger(run, { withdrawn: 1_000_000n }) });
  const missing = await json({ missingReason: 'no g2-* run directory with e1.json' });
  const liveFile = join(mkdtempSync(join(tmpdir(), 'upay-web-')), 'demo-bundle.json');
  writeFileSync(liveFile, JSON.stringify(live));
  project.provide('bundles', { live, offline, unavailable, fail, missing, liveFile });
}
