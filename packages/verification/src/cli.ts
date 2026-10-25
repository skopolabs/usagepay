import type { ChainReader } from './chain.js';
import { formatReport } from './report.js';
import { TESTNET_RPC_URL } from './stellar-reader.js';
import { trustFromFile } from './trust.js';
import { DEFAULT_RPC_TIMEOUT_MS, createVerifier } from './verifier.js';

export const USAGE = 'usage: verify <e0.json> <e1.json> --trust <trust.json> [--offline] [--json] [--rpc <url>] [--timeout <ms>]';

/** Exit codes: the verdict maps to 0/1/2; 3 is a usage or trust-input error (no verdict was produced). */
export const EXIT_CODES = { PASS: 0, FAIL: 1, NOT_AVAILABLE: 2, USAGE: 3 } as const;

export interface CliDeps {
  readFile(path: string): string;
  chainReader(rpcUrl: string): ChainReader;
  stdout(text: string): void;
  stderr(text: string): void;
}

interface CliArgs {
  readonly files: string[];
  readonly trust?: string;
  readonly offline: boolean;
  readonly json: boolean;
  readonly rpcUrl: string;
  readonly timeoutMs: number;
}

function parseArgs(argv: readonly string[]): CliArgs | string {
  const files: string[] = [];
  let trust: string | undefined;
  let offline = false;
  let json = false;
  let rpcUrl = TESTNET_RPC_URL;
  let timeoutMs = DEFAULT_RPC_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    try {
      if (arg === '--trust') trust = value();
      else if (arg === '--rpc') rpcUrl = value();
      else if (arg === '--timeout') timeoutMs = Number.parseInt(value(), 10);
      else if (arg === '--offline') offline = true;
      else if (arg === '--json') json = true;
      else if (arg.startsWith('--')) return `unknown option ${arg}`;
      else files.push(arg);
    } catch (error) {
      return (error as Error).message;
    }
  }
  if (files.length !== 2) return 'expected exactly two evidence files: <e0.json> <e1.json>';
  if (trust === undefined) return '--trust is required: trust inputs are pinned outside the evidence, never read from E0/E1';
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return '--timeout must be a positive integer (ms)';
  return { files, trust, offline, json, rpcUrl, timeoutMs };
}

/** Evidence that is not JSON stays `undefined` and fails V01 instead of aborting the run. */
function readJson(deps: CliDeps, path: string): unknown {
  const text = deps.readFile(path);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    deps.stderr(`${args}\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  let trust;
  let e0: unknown;
  let e1: unknown;
  try {
    trust = trustFromFile(JSON.parse(deps.readFile(args.trust!)));
  } catch (error) {
    deps.stderr(`invalid trust file ${args.trust}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.USAGE;
  }
  try {
    e0 = readJson(deps, args.files[0]!);
    e1 = readJson(deps, args.files[1]!);
  } catch (error) {
    deps.stderr(`cannot read evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.USAGE;
  }
  const verifier = createVerifier({
    trust,
    timeoutMs: args.timeoutMs,
    ...(args.offline ? {} : { chain: deps.chainReader(args.rpcUrl) }),
  });
  const report = await verifier.verify({ e0, e1 });
  deps.stdout(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return EXIT_CODES[report.overall.status];
}
