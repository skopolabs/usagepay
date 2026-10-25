/**
 * G2 / SPEC 02 opt-in Testnet E2E (S1): SPEC 01 metering with a runtime meter key -> three payer-approved, genuinely
 * SDK-signed cumulative commitments (1,000,000 -> 2,000,000 -> 3,000,000) accepted through the payee ack gate ->
 * immutable E0 -> one real close of upay-g2-channel -> E1 built from observed RPC results.
 *
 * Roles share one process but never secrets: the payer holds only the commitment secret, the settlement gateway only
 * the recipient secret. Output: scripts/testnet/runs/<runId>/{trace.jsonl,e0.json,e1.json,summary.json}.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { NETWORK, computeE0Digest, type MeasurementCharge, type MeterReading } from '@usagepay/contracts';
import { buildTariff, loadGoldenInputs } from '@usagepay/fixtures';
import { createMeteringSession, createRandomMeterSigner, createSimulatedCharger } from '@usagepay/metering';
import {
  checkChannelFacts,
  createChannelSettlement,
  createPayee,
  createPayer,
  createStellarChainGateway,
  readChannelFacts,
  serveHandler,
  type PayerTrust,
} from '@usagepay/settlement';
import { horizonUsdcBalance } from '../g1/chain.ts';
import { IDENTITIES, channelAddress, identityAddress, identitySecret } from '../g1/identities.ts';
import { Trace } from '../g1/trace.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const CHANNEL_ALIAS = 'upay-g2-channel';
const DEPOSIT = 10_000_000n;
const BUDGET_CAP = '5000000';

const versions = JSON.parse(readFileSync(join(ROOT, 'implementation-versions.json'), 'utf8')) as {
  network: { assetSac: string; assetClassic: string };
};
const runId = `g2-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const runDir = join(ROOT, 'scripts/testnet/runs', runId);
const trace = new Trace(join(runDir, 'trace.jsonl'));
const checks: { id: string; status: 'PASS' | 'FAIL'; detail: string }[] = [];
const gate = (id: string, ok: boolean, detail: string) => {
  checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });
  trace.emit('verifier', 'check', { id, status: ok ? 'PASS' : 'FAIL', detail });
  return ok;
};

const channelId = channelAddress(CHANNEL_ALIAS);
const assetSac = versions.network.assetSac;
const usdcIssuer = versions.network.assetClassic.split(':')[1] ?? '';
const funder = identityAddress(IDENTITIES.funder);
const recipient = identityAddress(IDENTITIES.recipient);
const commitmentKey = Keypair.fromSecret(identitySecret(IDENTITIES.commitment));
const inputs = loadGoldenInputs();
const tariff = buildTariff(inputs);
// SPEC 01: a runtime meter key signs simulated readings; only its public key is pinned (never committed).
const meter = createRandomMeterSigner('upay-g2-meter');
const trust: PayerTrust = {
  network: NETWORK,
  sessionId: inputs.session.sessionId,
  channelId,
  payerAccountId: commitmentKey.publicKey(),
  assetSac,
  tariffVersionDigest: tariff.versionDigest,
  meterKeys: new Map([[meter.keyId, meter.publicKey]]),
  budgetCapBaseUnits: BUDGET_CAP,
};
trace.emit('network', 'run.start', { runId, channelId, funder, recipient, commitmentKey: commitmentKey.publicKey(), assetSac });

// Channel facts the fleet pins before anything is signed.
const facts = await readChannelFacts(channelId);
trace.emit('network', 'read.channel-state', { ...facts });
if (!gate('S1-CHANNEL-PINNED', checkChannelFacts({ ...trust, recipient }, facts) === null && facts.from === funder && facts.balance === DEPOSIT,
  `token ${facts.token}, to ${facts.to}, from ${facts.from}, balance ${facts.balance}, closeEffectiveAtLedger ${facts.closeEffectiveAtLedger}`)) finish(1);

trace.emit('payee', 'meter.key', { keyId: meter.keyId, publicKey: meter.accountId, evidenceClass: 'SIMULATED meter, runtime key' });
const charger = createSimulatedCharger({ sessionId: inputs.session.sessionId, machineId: inputs.session.machineId, startedAt: inputs.session.startedAt, meterStartWh: inputs.session.meterStartWh, signer: meter });
const metering = createMeteringSession({ machineId: inputs.session.machineId, expectedAssetSac: assetSac, trustedMeterKeys: new Map([[meter.keyId, meter.publicKey]]), currentTariff: () => tariff });
await metering.apply(charger.started());
const evidence: { reading: MeterReading; charge: MeasurementCharge }[] = [];
for (const [index, interval] of inputs.intervals.entries()) {
  const outcome = await metering.apply(charger.interval({ ...interval, final: index === inputs.intervals.length - 1 }));
  if (outcome.kind !== 'ACCEPTED') throw new Error(`metering refused ${interval.readingId}: ${JSON.stringify(outcome)}`);
  evidence.push({ reading: outcome.reading, charge: outcome.charge });
  trace.emit('payee', 'metering.accepted', { readingId: outcome.reading.readingId, evidenceDigest: outcome.charge.evidenceDigest, cumulative: outcome.charge.cumulativeChargeBaseUnits });
}

const emit = (side: 'payer' | 'payee' | 'network') => (event: string, data: Record<string, unknown>) => trace.emit(side, event, data);
const payee = createPayee({ channelId, sessionId: inputs.session.sessionId, commitmentKey: commitmentKey.publicKey(), recipient, assetSac, evidence: (n) => evidence[n - 1], realm: 'upay-g2', onEvent: emit('payee') });
const server = await serveHandler(payee.handle, (error) => trace.emit('payee', 'error', { message: String(error) }));
const payer = createPayer({ trust, tariff, commitmentKey, payeeUrl: server.url, channel: facts, onEvent: emit('payer') });

for (const item of evidence) {
  const result = await payer.authorize({ ...item, tariff, channelId });
  gate(`S1-INCREMENT-${item.reading.readingId}`, result.kind === 'AUTHORIZED',
    result.kind === 'AUTHORIZED' ? `cumulative ${result.increment.commitment.cumulativeAmountBaseUnits}` : `${result.kind} ${result.reasonCode}: ${result.details}`);
}
gate('S1-SDK-STORE', (await payee.storedCumulative()) === '3000000', `payee SDK store cumulative ${await payee.storedCumulative()}`);
await server.stop();

const e0 = payer.finalizeE0(new Date().toISOString());
const e0Digest = computeE0Digest(e0);
writeFileSync(join(runDir, 'e0.json'), JSON.stringify(e0, null, 2) + '\n');
trace.emit('payer', 'e0.written', { e0Digest, increments: e0.increments.length });

const balancesBefore = { funder: await horizonUsdcBalance(funder, usdcIssuer), recipient: await horizonUsdcBalance(recipient, usdcIssuer) };
const gateway = createStellarChainGateway({ recipient: Keypair.fromSecret(identitySecret(IDENTITIES.recipient)) });
const settlement = createChannelSettlement({ channelId, assetSac, commitmentKey: commitmentKey.publicKey(), gateway, highestAccepted: () => payee.highestAccepted(), onEvent: emit('network') });
const closed = await settlement.closeLatest({ channelId, e0 });
trace.emit('network', 'settlement.result', { ...closed });
if (closed.kind !== 'OBSERVED') {
  gate('S1-SETTLEMENT', false, `${closed.kind} ${closed.reasonCode}: ${closed.details}`);
  finish(1);
}
const { e1 } = closed;
writeFileSync(join(runDir, 'e1.json'), JSON.stringify(e1, null, 2) + '\n');
gate('S1-SETTLEMENT', e1.txStatus === 'SUCCESS' && settlement.state === 'SETTLED', `close ${e1.closeTxHash} ${e1.txStatus}, state ${settlement.state}`);
gate('S1-E1-LINK', e1.e0Digest === e0Digest && e1.channelId === channelId && e1.network === NETWORK && e1.assetSac === assetSac, 'E1 references the frozen E0, channel, network and asset');
gate('S1-E1-SETTLED', e1.settledCumulativeBaseUnits === '3000000', `withdrawn() observed ${e1.settledCumulativeBaseUnits}`);

const balancesAfter = { funder: await horizonUsdcBalance(funder, usdcIssuer), recipient: await horizonUsdcBalance(recipient, usdcIssuer) };
const units = (value: string) => BigInt(value.replace('.', ''));
gate('S1-BALANCE-RECIPIENT', units(balancesAfter.recipient) - units(balancesBefore.recipient) === 3000000n, `recipient USDC ${balancesBefore.recipient} -> ${balancesAfter.recipient}`);
gate('S1-BALANCE-FUNDER-REFUND', units(balancesAfter.funder) - units(balancesBefore.funder) === DEPOSIT - 3000000n, `funder USDC ${balancesBefore.funder} -> ${balancesAfter.funder}`);

// Testnet negative: an unknown transaction is observed as NOT_FOUND, never as a settlement.
const missing = await gateway.getTransaction(randomBytes(32).toString('hex'));
gate('S1-NEGATIVE-MISSING-TX', missing.status === 'NOT_FOUND', `random hash -> ${missing.status}`);

writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
  schema: 'upay.g2-settlement-run.v1',
  runId,
  result: checks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL',
  network: NETWORK,
  evidenceClass: 'TESTNET_LIVE (meter data: SIMULATED, runtime meter key)',
  channelId,
  parties: { funder, recipient, commitmentKey: commitmentKey.publicKey(), assetSac, meterKey: meter.accountId },
  e0Digest,
  closeTxHash: e1.closeTxHash,
  balances: { before: balancesBefore, after: balancesAfter },
  checks,
}, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2) + '\n');
finish(checks.every((c) => c.status === 'PASS') ? 0 : 1);

function finish(code: number): never {
  trace.emit('network', 'run.end', { runId, result: code === 0 ? 'PASS' : 'FAIL', checks: checks.length, failed: checks.filter((c) => c.status !== 'PASS').length });
  console.log(`\n${code === 0 ? 'PASS' : 'FAIL'}  ${runDir}`);
  process.exit(code);
}
