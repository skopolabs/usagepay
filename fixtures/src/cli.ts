import { readFileSync, writeFileSync } from 'node:fs';
import { FIXTURES_V1_DIR } from './inputs.js';
import { computeVectors, serializeVectors } from './vectors.js';

/** `generate` rewrites v1/vectors.json; `check` regenerates in this fresh process and fails on any difference. */
const VECTORS_FILE = new URL('vectors.json', FIXTURES_V1_DIR);
const mode = process.argv[2];
const fresh = serializeVectors(computeVectors());

if (mode === 'generate') {
  writeFileSync(VECTORS_FILE, fresh);
  console.log(`wrote ${VECTORS_FILE.pathname}`);
} else if (mode === 'check') {
  const committed = readFileSync(VECTORS_FILE, 'utf8');
  if (committed !== fresh) {
    console.error('FAIL fixtures:check — regenerated vectors differ from committed v1/vectors.json (non-deterministic or stale)');
    process.exit(1);
  }
  console.log('PASS fixtures:check — regenerated vectors are byte-identical to committed v1/vectors.json');
} else {
  console.error('usage: node fixtures/dist/cli.js <generate|check>');
  process.exit(2);
}
