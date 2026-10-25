/**
 * G1 Testnet feasibility run: three genuine MPP channel commitments (1,000,000 -> 2,000,000 -> 3,000,000 base units),
 * each bound by a payer-signed evidence ack that the payee checks before the SDK verifies the credential, two
 * negative ack cases, an on-chain close with the highest commitment and an independent verification.
 *
 * Roles share one process for G1 but never share secrets: the payer holds only the commitment secret, the payee only
 * the recipient secret, and the verifier none. Output: scripts/testnet/runs/<runId>/{trace.jsonl,summary.json}.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getChannelState } from '@stellar/mpp/channel/server';
import { Keypair } from '@stellar/stellar-sdk';
import { buildGoldenSession } from '@usagepay/fixtures';
import { horizonUsdcBalance } from './chain.ts';
import { IDENTITIES, channelAddress, identityAddress, identitySecret } from './identities.ts';
import { startPayee } from './payee.ts';
import { createPayer, type AckTamper } from './payer.ts';
import { Trace } from './trace.ts';
import { verifyRun, type Check } from './verifier.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const CHANNEL_ALIAS = 'upay-g1-channel';
const DEPOSIT = 10_000_000n;

const versions = JSON.parse(readFileSync(join(ROOT, 'implementation-versions.json'), 'utf8')) as {
  network: { assetSac: string; assetClassic: string };
};
const runId = `g1-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const runDir = join(ROOT, 'scripts/testnet/runs', runId);
const trace = new Trace(join(runDir, 'trace.jsonl'));
const checks: Check[] = [];
const gate = (id: string, ok: boolean, detail: string) => {
  const entry: Check = { id, status: ok ? 'PASS' : 'FAIL', detail };
  checks.push(entry);
  trace.emit('verifier', 'check', { ...entry });
  return ok;
};

const channel = channelAddress(CHANNEL_ALIAS);
const token = versions.network.assetSac;
const usdcIssuer = versions.network.assetClassic.split(':')[1] ?? '';
const funder = identityAddress(IDENTITIES.funder);
const recipient = identityAddress(IDENTITIES.recipient);
const commitmentKey = identityAddress(IDENTITIES.commitment);
const session = buildGoldenSession();
const sessionId = session.inputs.session.sessionId;
const increments = session.readings.map((reading, index) => {
  const charge = session.charges[index];
  if (charge === undefined) throw new Error(`golden session has no charge for reading ${index}`);
  return { reading, charge };
});

trace.emit('network', 'run.start', { runId, channel, funder, recipient, commitmentKey, token, sessionId, meterData: 'OFFLINE_FIXTURE golden S1' });

const state = await getChannelState({ channel, network: 'stellar:testnet' });
trace.emit('network', 'read.channel-state', { ...state });
const channelOpen = gate('G1-CHANNEL-OPEN',
  state.closeEffectiveAtLedger === null && state.balance === DEPOSIT && state.to === recipient && state.from === funder && state.token === token,
  `balance ${state.balance}, closeEffectiveAtLedger ${state.closeEffectiveAtLedger}`);
if (!channelOpen) finish(1);

const balancesBefore = { funder: await horizonUsdcBalance(funder, usdcIssuer), recipient: await horizonUsdcBalance(recipient, usdcIssuer) };
trace.emit('network', 'read.balances', { phase: 'before', ...balancesBefore });

const payee = await startPayee({
  channel, token, recipient, commitmentKey, sessionId, increments, trace,
  recipientSecret: identitySecret(IDENTITIES.recipient),
});
const payer = createPayer({ channel, sessionId, payeeUrl: payee.url, trace, commitmentSecret: identitySecret(IDENTITIES.commitment) });

for (const sequence of [1, 2]) {
  const outcome = await payer.payIncrement(sequence);
  gate(`G1-INCREMENT-${sequence}`, outcome.status === 200 && outcome.simulationEqualsLocalXdr,
    `HTTP ${outcome.status}; payee stored cumulative ${await payee.storedCumulative()}`);
}

const negatives: { label: string; status: number; code: unknown; storedCumulativeAfter: string; nativeSignature: string }[] = [];
const negativeCases: { tamper: AckTamper; expectedCode: string }[] = [
  { tamper: { label: 'stale-evidence', evidenceDigest: increments[1]?.charge.evidenceDigest ?? '' }, expectedCode: 'ACK_EVIDENCE_MISMATCH' },
  { tamper: { label: 'foreign-signer', signer: Keypair.random() }, expectedCode: 'ACK_PAYER_KEY_MISMATCH' },
];
for (const [index, { tamper, expectedCode }] of negativeCases.entries()) {
  const outcome = await payer.payIncrement(3, tamper);
  const code = (outcome.body as { code?: unknown } | null)?.code;
  const storedCumulativeAfter = await payee.storedCumulative();
  negatives.push({ label: tamper.label, status: outcome.status, code, storedCumulativeAfter, nativeSignature: Buffer.from(outcome.commitment.signatureB64, 'base64').toString('hex') });
  gate(`G1-NEGATIVE-${index + 1}`, outcome.status === 409 && code === expectedCode && storedCumulativeAfter === '2000000',
    `${tamper.label}: HTTP ${outcome.status} ${String(code)}; stored cumulative stays ${storedCumulativeAfter}`);
}

const third = await payer.payIncrement(3);
gate('G1-INCREMENT-3', third.status === 200, `HTTP ${third.status}; payee stored cumulative ${await payee.storedCumulative()}`);

const closed = await payee.closeWithHighestCommitment();
await payee.stop();
// Persist the public capture before verifying, so a verifier bug never costs a second channel.
writeFileSync(join(runDir, 'capture.json'), JSON.stringify({ channel, close: closed, increments: payee.accepted, negatives }, null, 2) + '\n');

const verification = await verifyRun({
  channel,
  closeTxHash: closed.txHash,
  expected: { token, from: funder, to: recipient, deposit: DEPOSIT },
  increments: payee.accepted,
  trace,
});
checks.push(...verification.checks);

const balancesAfter = { funder: await horizonUsdcBalance(funder, usdcIssuer), recipient: await horizonUsdcBalance(recipient, usdcIssuer) };
trace.emit('network', 'read.balances', { phase: 'after', ...balancesAfter });
const units = (value: string) => BigInt(value.replace('.', ''));
gate('V-BALANCE-RECIPIENT', units(balancesAfter.recipient) - units(balancesBefore.recipient) === BigInt(closed.amount),
  `recipient USDC ${balancesBefore.recipient} -> ${balancesAfter.recipient}`);
gate('V-BALANCE-FUNDER-REFUND', units(balancesAfter.funder) - units(balancesBefore.funder) === DEPOSIT - BigInt(closed.amount),
  `funder USDC ${balancesBefore.funder} -> ${balancesAfter.funder}`);

// Each tx is read from its own section of the latest deployment: the CLI sends no upload tx when the content-addressed
// wasm is already installed, so the first signed tx in the log is not necessarily the upload.
const deployLog = join(ROOT, 'scripts/testnet/runs/g1-deploy.log');
const deployLogText = existsSync(deployLog) ? readFileSync(deployLog, 'utf8') : '';
const deployTx = (marker: string): string | null => {
  const start = deployLogText.lastIndexOf(`] ${marker}`);
  if (start < 0) return null;
  const end = deployLogText.indexOf('\n[', start);
  return /Signing transaction: ([0-9a-f]{64})/.exec(deployLogText.slice(start, end < 0 ? undefined : end))?.[1] ?? null;
};

writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
  schema: 'upay.g1-run-summary.v1',
  runId,
  result: checks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL',
  network: 'stellar:testnet',
  evidenceClass: 'TESTNET_LIVE (meter data: OFFLINE_FIXTURE golden S1)',
  channel,
  parties: { funder, recipient, commitmentKey, token },
  transactions: { wasmUpload: deployTx('upload wasm'), channelDeploy: deployTx('deploy '), close: closed.txHash, closeLedger: verification.ledger },
  balances: { before: balancesBefore, after: balancesAfter },
  increments: payee.accepted.map(({ sequence, commitment, ack, credentialAuthorization }) => ({ sequence, commitment, ack, credentialAuthorization })),
  negatives,
  closeEvents: verification.events,
  checks,
}, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2) + '\n');

finish(checks.every((c) => c.status === 'PASS') ? 0 : 1);

function finish(code: number): never {
  trace.emit('network', 'run.end', { runId, result: code === 0 ? 'PASS' : 'FAIL', checks: checks.length, failed: checks.filter((c) => c.status !== 'PASS').length });
  console.log(`\n${code === 0 ? 'PASS' : 'FAIL'}  ${runDir}`);
  process.exit(code);
}
