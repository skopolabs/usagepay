import { join } from 'node:path';
import { DEFAULT_RPC_TIMEOUT_MS, TESTNET_RPC_URL, type ChainReader } from '@usagepay/verification';
import { buildBundle, type DemoBundle } from './bundle.js';
import { toJson } from './format.js';
import { findLatestRun, loadRealRun, type RealRun } from './real-run.js';
import { renderWalkthrough } from './walkthrough.js';

export const USAGE = 'usage: demo [--run <g2-run-dir>] [--trust <trust.json>] [--offline] [--json] [--out <bundle.json>] [--rpc <url>] [--timeout <ms>]';

/** Same mapping as the verifier CLI: 0 PASS, 1 FAIL, 2 NOT_AVAILABLE (offline or ledger unreachable), 3 usage. */
export const EXIT_CODES = { PASS: 0, FAIL: 1, NOT_AVAILABLE: 2, USAGE: 3 } as const;

export const DEFAULT_RUNS_DIR = 'scripts/testnet/runs';
export const DEFAULT_OUT = 'apps/demo/out/demo-bundle.json';

export interface DemoDeps {
  readonly cwd: string;
  chainReader(rpcUrl: string): ChainReader;
  writeFile(path: string, text: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
  readonly color?: boolean;
  readonly now?: () => Date;
}

interface DemoArgs {
  readonly run?: string;
  readonly trust?: string;
  readonly offline: boolean;
  readonly json: boolean;
  readonly out: string;
  readonly rpcUrl: string;
  readonly timeoutMs: number;
}

function parseArgs(argv: readonly string[]): DemoArgs | string {
  const args: { -readonly [K in keyof DemoArgs]: DemoArgs[K] } = { offline: false, json: false, out: DEFAULT_OUT, rpcUrl: TESTNET_RPC_URL, timeoutMs: DEFAULT_RPC_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    try {
      if (arg === '--run') args.run = value();
      else if (arg === '--trust') args.trust = value();
      else if (arg === '--out') args.out = value();
      else if (arg === '--rpc') args.rpcUrl = value();
      else if (arg === '--timeout') args.timeoutMs = Number.parseInt(value(), 10);
      else if (arg === '--offline') args.offline = true;
      else if (arg === '--json') args.json = true;
      else return `unknown argument ${arg}`;
    } catch (error) {
      return (error as Error).message;
    }
  }
  if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0) return '--timeout must be a positive integer (ms)';
  return args;
}

/**
 * `pnpm demo`: replays the latest real Testnet run (labelled REPLAY), verifies it live and read-only, runs the
 * offline S1/F1-F7 scenarios, prints the walkthrough and writes the bundle the demo UI renders.
 */
export async function runDemo(argv: readonly string[], deps: DemoDeps): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    deps.stderr(`${args}\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  const resolve = (path: string) => (path.startsWith('/') ? path : join(deps.cwd, path));
  const runDir = args.run === undefined ? findLatestRun(resolve(DEFAULT_RUNS_DIR)) : resolve(args.run);
  let run: RealRun | undefined;
  let missingReason: string | undefined;
  if (runDir === undefined) {
    missingReason = `no g2-* run with e1.json under ${DEFAULT_RUNS_DIR}; run pnpm test:e2e:testnet first`;
  } else {
    try {
      run = loadRealRun(runDir, args.trust === undefined ? undefined : resolve(args.trust));
    } catch (error) {
      deps.stderr(`cannot load run ${runDir}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_CODES.USAGE;
    }
  }
  const bundle: DemoBundle = await buildBundle({
    ...(run === undefined ? {} : { run }),
    ...(missingReason === undefined ? {} : { missingReason }),
    ...(args.offline ? {} : { chain: deps.chainReader(args.rpcUrl) }),
    timeoutMs: args.timeoutMs,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const json = toJson(bundle);
  deps.writeFile(resolve(args.out), json);
  deps.stdout(args.json ? json : renderWalkthrough(bundle, { color: deps.color ?? false }) + `Bundle for the demo UI: ${args.out}\n`);
  return EXIT_CODES[bundle.result.status];
}
