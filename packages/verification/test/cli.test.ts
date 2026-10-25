import { describe, expect, it } from 'vitest';
import { runCli, type CliDeps } from '../src/index.js';
import { fakeChain, g2Artifacts } from './helpers.js';

// The pinned public trust file the G2 runner wrote before its first increment, read like the CLI reads it.
const { e0, e1, trust, trustFile: pinned } = g2Artifacts();
const trustFile = pinned as Record<string, unknown>;

function run(argv: string[], files: Record<string, unknown> = { 'e0.json': e0, 'e1.json': e1, 'trust.json': trustFile }) {
  const out: string[] = [];
  const err: string[] = [];
  const rpcUrls: string[] = [];
  const deps: CliDeps = {
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      const value = files[path];
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    chainReader: (rpcUrl) => (rpcUrls.push(rpcUrl), fakeChain(e0, trust).reader),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return runCli(argv, deps).then((code) => ({ code, out: out.join(''), err: err.join(''), rpcUrls }));
}

describe('verify CLI', () => {
  it('exits 0 with a PASS report when every check passes', async () => {
    const result = await run(['e0.json', 'e1.json', '--trust', 'trust.json']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/OVERALL: PASS/);
    expect(result.rpcUrls).toEqual(['https://soroban-testnet.stellar.org']);
  });

  it('--offline never queries the chain and exits 2 (NOT_AVAILABLE)', async () => {
    const result = await run(['e0.json', 'e1.json', '--trust', 'trust.json', '--offline']);
    expect(result.code).toBe(2);
    expect(result.rpcUrls).toEqual([]);
    expect(result.out).toMatch(/V08_CHAIN\s+NOT_AVAILABLE/);
  });

  it('exits 1 for tampered evidence and --json prints the machine-readable report', async () => {
    const tampered = { ...e0, sessionId: 'ev-session-002' };
    const result = await run(['e0.json', 'e1.json', '--trust', 'trust.json', '--json', '--rpc', 'https://rpc.example'], { 'e0.json': tampered, 'e1.json': e1, 'trust.json': trustFile });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { overall: { status: string }; checks: Record<string, { status: string }> };
    expect(report.overall.status).toBe('FAIL');
    expect(report.checks.V07_E0_E1_LINK!.status).toBe('FAIL');
    expect(result.rpcUrls).toEqual(['https://rpc.example']);
  });

  it('invalid JSON evidence is reported as a schema failure (exit 1), not a crash', async () => {
    const result = await run(['e0.json', 'e1.json', '--trust', 'trust.json', '--offline'], { 'e0.json': '{not json', 'e1.json': e1, 'trust.json': trustFile });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/V01_SCHEMA\s+FAIL/);
  });

  it('a missing or invalid trust file is a usage error (exit 3), never an implicit trust of E0/E1', async () => {
    expect((await run(['e0.json', 'e1.json'])).code).toBe(3);
    const bad = await run(['e0.json', 'e1.json', '--trust', 'trust.json'], { 'e0.json': e0, 'e1.json': e1, 'trust.json': { ...trustFile, network: 'stellar:pubnet' } });
    expect(bad.code).toBe(3);
    expect(bad.err).toMatch(/trust/);
  });
});
