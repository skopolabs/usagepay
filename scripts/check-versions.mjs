// Offline check that installed packages match implementation-versions.json and that the pinned SDK still
// exposes the constants the frozen contracts depend on. Performs no network calls and no transactions.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('../', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('implementation-versions.json', root), 'utf8'));
const failures = [];

function installedVersion(name, fromPackage) {
  const require = createRequire(new URL(`${fromPackage}/package.json`, root));
  let dir = require.resolve(name);
  // Walk up from the resolved entry to the package root.
  while (!dir.endsWith(`/node_modules/${name}`)) dir = dir.slice(0, dir.lastIndexOf('/'));
  return JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version;
}

const owners = {
  '@stellar/mpp': '.', mppx: '.', '@stellar/stellar-sdk': '.', viem: '.',
  '@stellar/stellar-base': 'packages/contracts', zod: 'packages/contracts', '@noble/curves': 'packages/contracts',
  '@noble/hashes': 'packages/contracts', canonicalize: 'packages/contracts',
};
for (const [name, expected] of Object.entries(pins.dependencies)) {
  const actual = installedVersion(name, owners[name]);
  console.log(`${actual === expected ? 'PASS' : 'FAIL'} ${name} pinned=${expected} installed=${actual}`);
  if (actual !== expected) failures.push(name);
}

// SPEC 05 demo UI (apps/web): pinned exact in its package.json and installed as such.
const web = JSON.parse(readFileSync(new URL('apps/web/package.json', root), 'utf8'));
const webDeclared = { ...web.dependencies, ...web.devDependencies };
for (const [name, expected] of Object.entries(pins.uiDependencies)) {
  // Direct dependencies are linked under apps/web/node_modules (type-only packages have no resolvable entry point).
  const actual = JSON.parse(readFileSync(new URL(`apps/web/node_modules/${name}/package.json`, root), 'utf8')).version;
  const ok = actual === expected && webDeclared[name] === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} pinned=${expected} declared=${webDeclared[name]} installed=${actual}`);
  if (!ok) failures.push(name);
}

const mpp = await import('@stellar/mpp');
const server = await import('@stellar/mpp/channel/server');
const checks = [
  ['STELLAR_TESTNET equals pinned network', mpp.STELLAR_TESTNET === pins.network.id],
  ['USDC_SAC_TESTNET equals pinned asset SAC', mpp.USDC_SAC_TESTNET === pins.network.assetSac],
  ['DEFAULT_DECIMALS equals pinned (unverified on-chain) decimals', mpp.DEFAULT_DECIMALS === pins.network.assetDecimals],
  ['Testnet passphrase equals pinned passphrase', mpp.NETWORK_PASSPHRASE[mpp.STELLAR_TESTNET] === pins.network.networkPassphrase],
  ['channel/server exports close, getChannelState, watchChannel', ['close', 'getChannelState', 'watchChannel'].every((k) => typeof server[k] === 'function')],
];
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
}

const fixtureInputs = JSON.parse(readFileSync(new URL('fixtures/v1/golden-inputs.json', root), 'utf8'));
const sacOk = fixtureInputs.tariff.assetSac === pins.network.assetSac;
console.log(`${sacOk ? 'PASS' : 'FAIL'} fixture tariff assetSac equals pinned SDK USDC_SAC_TESTNET`);
if (!sacOk) failures.push('fixture assetSac');

if (failures.length > 0) {
  console.error(`versions:check FAILED (${failures.length})`);
  process.exit(1);
}
console.log('versions:check PASSED');
