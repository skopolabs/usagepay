import { describe, expect, it } from 'vitest';
import { canonicalize, jcsDigest } from '@usagepay/contracts';
import { buildGoldenSession, computeVectors, readFixtureJson, serializeVectors } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { FIXTURES_V1_DIR } from '../src/inputs.js';

describe('deterministic fixture vectors', () => {
  it('two independent builds produce byte-identical vectors', () => {
    expect(serializeVectors(computeVectors(buildGoldenSession()))).toBe(serializeVectors(computeVectors(buildGoldenSession())));
  });

  it('committed v1/vectors.json (written by a separate CLI process) equals a fresh in-test computation', () => {
    const committed = readFileSync(new URL('vectors.json', FIXTURES_V1_DIR), 'utf8');
    expect(committed).toBe(serializeVectors(computeVectors()));
  });

  it('JCS vectors re-verify from the committed file alone', () => {
    const vectors = readFixtureJson('vectors.json') as { jcs: Array<{ input: unknown; canonical: string; sha256: string }> };
    for (const vector of vectors.jcs) {
      expect(canonicalize(vector.input)).toBe(vector.canonical);
      expect(jcsDigest(vector.input)).toBe(vector.sha256);
    }
  });

  it('committed vectors contain no private keys and no native commitment signatures', () => {
    const text = readFileSync(new URL('vectors.json', FIXTURES_V1_DIR), 'utf8');
    expect(text).not.toMatch(/secret|privateKey|seed"/i);
    const golden = buildGoldenSession();
    for (const commitment of golden.commitments) expect(text).not.toContain(commitment.signatureB64);
    for (const ack of golden.acks) expect(text).not.toContain(ack.signatureB64);
  });

  it('scenario catalogue covers S1 and F1–F5 with expected outcome and reason code', () => {
    const catalogue = readFixtureJson('scenarios.json') as { scenarios: Array<{ id: string; expected: string; reasonCode: string }> };
    const ids = catalogue.scenarios.map((scenario) => scenario.id.split('-')[0]);
    for (const id of ['S1', 'F1', 'F2', 'F3', 'F4', 'F5']) expect(ids).toContain(id);
    for (const scenario of catalogue.scenarios) expect(scenario.reasonCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
