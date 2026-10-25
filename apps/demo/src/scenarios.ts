import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import {
  NETWORK,
  base64ToBytes,
  bytesToBase64,
  computeE0Digest,
  type EvidenceE0,
  type EvidenceE1,
  type MeasurementCharge,
  type MeterReading,
} from '@usagepay/contracts';
import { TEST_ONLY_METER_KEY, TRUSTED_METER_KEYS, buildTariff, loadGoldenInputs } from '@usagepay/fixtures';
import { createMeteringSession, createSimulatedCharger, type SimulatedOcppEvent } from '@usagepay/metering';
import {
  ACK_HEADER,
  createChannelSettlement,
  createPayee,
  createPayer,
  decodeAckHeader,
  encodeAckHeader,
  type AuthorizeResult,
  type Payee,
  type Payer,
  type PayerTrust,
} from '@usagepay/settlement';
import { CHECK_IDS, createVerifier, type CheckId, type VerificationReport, type VerifierTrust } from '@usagepay/verification';
import { formatAmount } from './format.js';
import { CHECK_EXPLANATIONS, explainEvent, explainReason, type StoryEvent } from './narrative.js';
import { installOfflineChain, type OfflineChain } from './offline-chain.js';

/**
 * SPEC 04 §5 cross-package scenarios. Each one wires the real public ports of SPEC 01 metering, SPEC 02 payer/payee
 * (the pinned @stellar/mpp client and server, genuine runtime-signed commitments) and the SPEC 03 verifier against
 * the offline channel stand-in. Evidence class SDK_INTEGRATION: real signatures and module logic, simulated ledger.
 */
export type EvidenceClass = 'OFFLINE_FIXTURE' | 'SDK_INTEGRATION' | 'REAL_TESTNET';
export type ScenarioId = 'S1' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7';

export interface Checkpoint {
  readonly label: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

export interface Outcome {
  readonly status: string;
  readonly reasonCode?: string;
}

export interface VerdictSummary {
  readonly overall: Outcome;
  readonly checks: Readonly<Record<CheckId, Outcome>>;
}

export interface ScenarioResult {
  readonly id: ScenarioId;
  readonly title: string;
  /** The question a judge would ask, in plain words. */
  readonly question: string;
  /** What actually happened, in plain words. */
  readonly answer: string;
  readonly sessionId: string;
  readonly evidenceClass: EvidenceClass;
  readonly expected: Outcome;
  readonly actual: Outcome;
  /** PASS when every checkpoint matched its expectation. */
  readonly result: 'PASS' | 'FAIL';
  readonly checkpoints: readonly Checkpoint[];
  readonly story: readonly StoryEvent[];
  readonly verification?: VerdictSummary;
}

const FINALIZED_AT = '2026-10-25T09:05:00.000Z';
const DEPOSIT = 10_000_000n;

const inputs = loadGoldenInputs();
const tariff = buildTariff(inputs);
const sessionId = inputs.session.sessionId;

interface Evidence {
  readonly reading: MeterReading;
  readonly charge: MeasurementCharge;
}

/** Records checkpoints and the plain-language story of one scenario. */
class Recorder {
  readonly checkpoints: Checkpoint[] = [];
  readonly story: StoryEvent[] = [];

  check(label: string, expected: string, actual: string): boolean {
    const ok = expected === actual;
    this.checkpoints.push({ label, expected, actual, ok });
    return ok;
  }

  event(event: string, data: Record<string, unknown>): void {
    const story = explainEvent(event, data, { ledger: 'SIMULATED' });
    if (story !== null) this.story.push(story);
  }

  audit(report: VerificationReport, context: string): VerdictSummary {
    const summary = summarize(report);
    const failing = CHECK_IDS.filter((id) => report.checks[id].status !== 'PASS');
    const status = report.overall.status;
    this.story.push({
      actor: 'auditor',
      layer: failing.includes('V08_CHAIN') || status === 'PASS' ? 'ON_CHAIN' : 'OFF_CHAIN',
      status: status === 'PASS' ? 'OK' : status === 'FAIL' ? 'REJECTED' : 'PENDING',
      title: `Auditor verdict on ${context}: ${status}`,
      detail: status === 'PASS'
        ? 'All eight independent checks passed, including the payment on the ledger.'
        : failing.map((id) => `${CHECK_EXPLANATIONS[id].title}: ${report.checks[id].status}. ${explainReason(report.checks[id].reasonCode)}`).join(' '),
      technical: Object.fromEntries([['overall', `${status} ${report.overall.reasonCode}`], ...CHECK_IDS.map((id) => [id, `${report.checks[id].status} ${report.checks[id].reasonCode}`])]),
    });
    return summary;
  }
}

function summarize(report: VerificationReport): VerdictSummary {
  const outcome = (r: { status: string; reasonCode: string }): Outcome => ({ status: r.status, reasonCode: r.reasonCode });
  return { overall: outcome(report.overall), checks: Object.fromEntries(CHECK_IDS.map((id) => [id, outcome(report.checks[id])])) as Record<CheckId, Outcome> };
}

const outcomeOf = (result: AuthorizeResult): string => (result.kind === 'AUTHORIZED' ? `AUTHORIZED ${result.increment.commitment.cumulativeAmountBaseUnits}` : `${result.kind} ${result.reasonCode}`);
const verdict = (report: VerificationReport, id?: CheckId): string => {
  const r = id === undefined ? report.overall : report.checks[id];
  return `${r.status} ${r.reasonCode}`;
};

/** Simulated charger -> SPEC 01 metering session, with the fixture's test-only meter key. */
function charger() {
  const simulated = createSimulatedCharger({
    sessionId,
    machineId: inputs.session.machineId,
    startedAt: inputs.session.startedAt,
    meterStartWh: inputs.session.meterStartWh,
    signer: { keyId: inputs.meter.signerKeyId, sign: (bytes) => TEST_ONLY_METER_KEY.sign(bytes) },
  });
  const metering = createMeteringSession({
    machineId: inputs.session.machineId,
    expectedAssetSac: tariff.assetSac,
    trustedMeterKeys: TRUSTED_METER_KEYS,
    currentTariff: () => tariff,
  });
  const events = inputs.intervals.map((interval, index) => simulated.interval({ ...interval, final: index === inputs.intervals.length - 1 }));
  return { metering, started: simulated.started(), events };
}

async function meterAll(recorder: Recorder): Promise<Evidence[]> {
  const { metering, started, events } = charger();
  await metering.apply(started);
  const evidence: Evidence[] = [];
  for (const event of events) {
    const outcome = await metering.apply(event);
    if (outcome.kind !== 'ACCEPTED') throw new Error(`metering refused a genuine reading: ${JSON.stringify(outcome)}`);
    evidence.push({ reading: outcome.reading, charge: outcome.charge });
    recorder.event('metering.accepted', { readingId: outcome.reading.readingId, cumulative: outcome.charge.cumulativeChargeBaseUnits, evidenceDigest: outcome.charge.evidenceDigest });
  }
  return evidence;
}

/** F1-A: one byte of the signed source changed after signing (`meterEndWh` 10500 -> 19500), signature kept. */
function tamperBytes(rawPayloadB64: string): string {
  const bytes = base64ToBytes(rawPayloadB64);
  const marker = '"meterEndWh":"1';
  const position = new TextDecoder().decode(bytes).indexOf(marker) + marker.length;
  const tampered = Uint8Array.from(bytes);
  tampered[position] = '9'.charCodeAt(0);
  return bytesToBase64(tampered);
}

interface World {
  readonly chain: OfflineChain;
  readonly payer: Payer;
  readonly payee: Payee;
  readonly evidence: readonly Evidence[];
  readonly verifierTrust: VerifierTrust;
  readonly recorder: Recorder;
  authorize(evidence: Evidence): Promise<AuthorizeResult>;
  settlement(): ReturnType<typeof createChannelSettlement>;
}

interface WorldOptions {
  readonly budgetCapBaseUnits?: string;
  readonly nonce?: () => string;
  readonly wrapFetch?: (handle: Payee['handle']) => (request: Request) => Promise<Response>;
}

/** Fresh disposable roles and channel for one scenario. The commitment key exists only in memory. */
async function world(recorder: Recorder, options: WorldOptions = {}): Promise<World> {
  const commitmentKey = Keypair.random();
  const channel = {
    channelId: StrKey.encodeContract(randomBytes(32)),
    token: tariff.assetSac,
    from: Keypair.random().publicKey(),
    to: Keypair.random().publicKey(),
    commitmentKey: commitmentKey.publicKey(),
    deposit: DEPOSIT,
  };
  const chain = installOfflineChain(channel);
  const budgetCapBaseUnits = options.budgetCapBaseUnits ?? '5000000';
  const onEvent = (event: string, data: Record<string, unknown>) => recorder.event(event, data);
  recorder.event('read.channel-state', { balance: DEPOSIT.toString(), to: channel.to, from: channel.from, token: channel.token });
  let evidence: Evidence[];
  try {
    evidence = await meterAll(recorder);
  } catch (error) {
    chain.restore();
    throw error;
  }
  const payee = createPayee({
    channelId: channel.channelId,
    sessionId,
    commitmentKey: channel.commitmentKey,
    recipient: channel.to,
    assetSac: tariff.assetSac,
    evidence: (sequence) => evidence[sequence - 1],
    onEvent,
  });
  const trust: PayerTrust = {
    network: NETWORK,
    sessionId,
    channelId: channel.channelId,
    payerAccountId: commitmentKey.publicKey(),
    assetSac: tariff.assetSac,
    tariffVersionDigest: tariff.versionDigest,
    meterKeys: TRUSTED_METER_KEYS,
    budgetCapBaseUnits,
  };
  const payer = createPayer({
    trust,
    tariff,
    commitmentKey,
    payeeUrl: 'http://station.offline',
    channel: { token: channel.token, to: channel.to, balance: DEPOSIT, closeEffectiveAtLedger: null },
    fetch: options.wrapFetch?.(payee.handle) ?? payee.handle,
    onEvent,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });
  return {
    chain,
    payer,
    payee,
    evidence,
    recorder,
    verifierTrust: {
      network: NETWORK,
      sessionId,
      channelId: channel.channelId,
      recipient: channel.to,
      funder: channel.from,
      assetSac: tariff.assetSac,
      commitmentKey: channel.commitmentKey,
      tariffVersionDigest: tariff.versionDigest,
      budgetCapBaseUnits,
      meterKeys: TRUSTED_METER_KEYS,
    },
    authorize: (item) => payer.authorize({ ...item, tariff, channelId: channel.channelId }),
    settlement: () => createChannelSettlement({
      channelId: channel.channelId,
      assetSac: tariff.assetSac,
      commitmentKey: channel.commitmentKey,
      gateway: chain.gateway,
      highestAccepted: () => payee.highestAccepted(),
      onEvent,
    }),
  };
}

async function inWorld<T>(recorder: Recorder, options: WorldOptions, body: (w: World) => Promise<T>): Promise<T> {
  const w = await world(recorder, options);
  try {
    return await body(w);
  } finally {
    w.chain.restore();
  }
}

const has = (calls: readonly string[], call: string) => calls.includes(call);

interface Built {
  readonly result: ScenarioResult;
  readonly artifacts?: { e0: EvidenceE0; e1: EvidenceE1; chain: OfflineChain; trust: VerifierTrust };
}

function finish(
  base: Pick<ScenarioResult, 'id' | 'title' | 'question'>,
  recorder: Recorder,
  expected: Outcome,
  actual: Outcome,
  answer: string,
  verification?: VerdictSummary,
): ScenarioResult {
  const headline = recorder.check('Headline outcome', `${expected.status} ${expected.reasonCode ?? ''}`.trim(), `${actual.status} ${actual.reasonCode ?? ''}`.trim());
  return {
    ...base,
    answer,
    sessionId,
    evidenceClass: 'SDK_INTEGRATION',
    expected,
    actual,
    result: headline && recorder.checkpoints.every((c) => c.ok) ? 'PASS' : 'FAIL',
    checkpoints: recorder.checkpoints,
    story: recorder.story,
    ...(verification === undefined ? {} : { verification }),
  };
}

async function s1(): Promise<Built> {
  const r = new Recorder();
  return inWorld(r, {}, async (w) => {
    const results = [];
    for (const item of w.evidence) results.push(await w.authorize(item));
    r.check('Fleet-approved running totals', 'AUTHORIZED 1000000 | AUTHORIZED 2000000 | AUTHORIZED 3000000', results.map(outcomeOf).join(' | '));
    r.check('Vouchers produced by the real MPP SDK', 'true', String(['1000000', '2000000', '3000000'].every((a) => has(w.chain.calls, `prepare_commitment(${a})`))));
    r.check('Station SDK store total', '3000000', await w.payee.storedCumulative());
    const e0 = w.payer.finalizeE0(FINALIZED_AT);
    r.event('e0.written', { e0Digest: computeE0Digest(e0), increments: e0.increments.length });
    const closed = await w.settlement().closeLatest({ channelId: w.verifierTrust.channelId, e0 });
    if (closed.kind !== 'OBSERVED') throw new Error(`S1 close not observed: ${JSON.stringify(closed)}`);
    r.event('settlement.result', { kind: closed.kind, e1: closed.e1 });
    const e1 = closed.e1;
    r.check('Single close on the ledger', 'SUCCESS 3000000 via close(3000000)', `${e1.txStatus} ${e1.settledCumulativeBaseUnits ?? '-'} via ${w.chain.calls.filter((c) => c.startsWith('close(')).join(',')}`);
    r.check('E1 references the sealed E0', computeE0Digest(e0), e1.e0Digest);
    const report = await createVerifier({ trust: w.verifierTrust, chain: w.chain.reader }).verify({ e0, e1 });
    const summary = r.audit(report, 'the completed session');
    r.check('Every check passed', CHECK_IDS.map(() => 'PASS').join(','), CHECK_IDS.map((id) => report.checks[id].status).join(','));
    const result = finish(
      { id: 'S1', title: 'Happy path: three readings, one payment', question: 'Does a normal charging session get paid correctly and provably?' },
      r,
      { status: 'PASS', reasonCode: 'ALL_CHECKS_PASSED' },
      { status: report.overall.status, reasonCode: report.overall.reasonCode },
      `0.75 kWh were billed as ${formatAmount(3000000n)} in three signed steps; one close paid the station and returned ${formatAmount(DEPOSIT - 3000000n)} to the fleet; the auditor confirmed all eight checks.`,
      summary,
    );
    return { result, artifacts: { e0, e1, chain: w.chain, trust: w.verifierTrust } };
  });
}

async function f1(s1Artifacts: NonNullable<Built['artifacts']>): Promise<ScenarioResult> {
  const r = new Recorder();
  // Meter gate: the station's own SPEC 01 metering refuses the edited bytes.
  const { metering, started, events } = charger();
  await metering.apply(started);
  await metering.apply(events[0]!);
  const edited: SimulatedOcppEvent = { ...events[1]!, usagepaySimulator: { ...events[1]!.usagepaySimulator!, rawPayloadB64: tamperBytes(events[1]!.usagepaySimulator!.rawPayloadB64) } };
  const meterGate = await metering.apply(edited);
  const meterOutcome = meterGate.kind === 'REJECTED' ? `REJECTED ${meterGate.reasonCode}` : meterGate.kind;
  r.event('metering.rejected', { readingId: 'r-002', reasonCode: meterGate.kind === 'REJECTED' ? meterGate.reasonCode : meterGate.kind });
  r.check('Meter gate on the edited r-002 (10500 -> 19500 Wh)', 'REJECTED INVALID_METER_SIGNATURE', meterOutcome);

  // Fleet gate: even if a station forwarded the edited reading, the fleet re-checks the meter signature first.
  const fleet = await inWorld(r, {}, async (w) => {
    await w.authorize(w.evidence[0]!);
    const before = w.chain.calls.length;
    const tampered = { ...w.evidence[1]!, reading: { ...w.evidence[1]!.reading, rawPayloadB64: tamperBytes(w.evidence[1]!.reading.rawPayloadB64) } };
    const refused = await w.authorize(tampered);
    r.check('Fleet gate on the forwarded edited reading', 'REJECTED INVALID_METER_SIGNATURE', outcomeOf(refused));
    r.check('No voucher signed for it (no ledger simulation call)', String(before), String(w.chain.calls.length));
    r.check('Station total unchanged', '1000000', await w.payee.storedCumulative());
    return refused;
  });

  // Auditor: the same one-byte edit inside an already sealed evidence package is caught too.
  const e0 = structuredClone(s1Artifacts.e0);
  e0.increments[1]!.reading.rawPayloadB64 = tamperBytes(e0.increments[1]!.reading.rawPayloadB64);
  const report = await createVerifier({ trust: s1Artifacts.trust, chain: s1Artifacts.chain.reader }).verify({ e0, e1: s1Artifacts.e1 });
  const summary = r.audit(report, 'an evidence package with r-002 edited');
  r.check('Auditor meter check on edited package', 'FAIL INVALID_METER_SIGNATURE', verdict(report, 'V02_METER'));
  r.check('Auditor overall verdict', 'FAIL', report.overall.status);
  return finish(
    { id: 'F1', title: 'Tampered meter reading', question: 'What if someone edits a meter reading after the meter signed it?' },
    r,
    { status: 'REJECTED', reasonCode: 'INVALID_METER_SIGNATURE' },
    fleet.kind === 'AUTHORIZED' ? { status: 'AUTHORIZED' } : { status: fleet.kind, reasonCode: fleet.reasonCode },
    'Changing 10500 Wh to 19500 Wh broke the meter signature: the station, the fleet and the auditor each refused it, and no payment was signed.',
    summary,
  );
}

async function f2(): Promise<ScenarioResult> {
  const r = new Recorder();
  const cap = inputs.budgetCase.capBaseUnits;
  return inWorld(r, { budgetCapBaseUnits: cap }, async (w) => {
    const first = [await w.authorize(w.evidence[0]!), await w.authorize(w.evidence[1]!)];
    r.check('r-001 and r-002 within the budget', 'AUTHORIZED 1000000 | AUTHORIZED 2000000', first.map(outcomeOf).join(' | '));
    const refused = await w.authorize(w.evidence[2]!);
    r.check(`r-003 would reach 3000000 > cap ${cap}`, 'REJECTED BUDGET_EXCEEDED', outcomeOf(refused));
    r.check('No third voucher was prepared or signed', 'false', String(has(w.chain.calls, 'prepare_commitment(3000000)')));
    r.check('Highest approved total', '2000000', w.payer.ledger.highest()?.commitment.cumulativeAmountBaseUnits ?? '-');
    r.check('Station total', '2000000', await w.payee.storedCumulative());
    const e0 = w.payer.finalizeE0(FINALIZED_AT);
    const closed = await w.settlement().closeLatest({ channelId: w.verifierTrust.channelId, e0 });
    const e1 = closed.kind === 'OBSERVED' ? closed.e1 : undefined;
    r.check('Station is paid exactly what was approved', 'SUCCESS 2000000', `${e1?.txStatus ?? closed.kind} ${e1?.settledCumulativeBaseUnits ?? '-'}`);
    const report = await createVerifier({ trust: w.verifierTrust, chain: w.chain.reader }).verify({ e0, e1 });
    const summary = r.audit(report, 'the budget-capped session');
    r.check('Auditor verdict on the capped session', 'PASS', report.overall.status);
    return finish(
      { id: 'F2', title: 'Fleet budget cap', question: 'What if charging continues past the fleet budget?' },
      r,
      { status: 'REJECTED', reasonCode: 'BUDGET_EXCEEDED' },
      refused.kind === 'AUTHORIZED' ? { status: 'AUTHORIZED' } : { status: refused.kind, reasonCode: refused.reasonCode },
      `With a ${formatAmount(cap)} cap the fleet refused the third reading before signing anything; the station was paid ${formatAmount(2000000n)}, exactly what was approved.`,
      summary,
    );
  });
}

async function f3(s1Artifacts: NonNullable<Built['artifacts']>): Promise<ScenarioResult> {
  const r = new Recorder();
  const duplicate = await inWorld(r, {}, async (w) => {
    await w.authorize(w.evidence[0]!);
    await w.authorize(w.evidence[1]!);
    const again = await w.authorize(w.evidence[1]!);
    r.check('r-002 delivered twice', 'REJECTED DUPLICATE_READING', outcomeOf(again));
    r.check('Station total unchanged', '2000000', await w.payee.storedCumulative());
    return again;
  });
  await inWorld(r, { nonce: () => '0123456789abcdef0123456789abcdef' }, async (w) => {
    await w.authorize(w.evidence[0]!);
    r.check('Receipt number reused', 'REJECTED REPLAY_NONCE', outcomeOf(await w.authorize(w.evidence[1]!)));
    r.check('Station total unchanged', '1000000', await w.payee.storedCumulative());
  });
  const [i1, i2] = s1Artifacts.e0.increments as [EvidenceE0['increments'][0], EvidenceE0['increments'][0]];
  const e0 = { ...s1Artifacts.e0, increments: [i1, i2, i2] };
  const report = await createVerifier({ trust: s1Artifacts.trust, chain: s1Artifacts.chain.reader }).verify({ e0, e1: s1Artifacts.e1 });
  const summary = r.audit(report, 'a package listing r-002 twice');
  r.check('Auditor format check on a doubled package', 'FAIL', report.checks.V01_SCHEMA.status);
  return finish(
    { id: 'F3', title: 'Replay and duplicates', question: 'What if the same reading or receipt is sent twice?' },
    r,
    { status: 'REJECTED', reasonCode: 'DUPLICATE_READING' },
    duplicate.kind === 'AUTHORIZED' ? { status: 'AUTHORIZED' } : { status: duplicate.kind, reasonCode: duplicate.reasonCode },
    'A repeated reading and a reused receipt number were both refused; nothing was paid twice.',
    summary,
  );
}

async function f4(s1Artifacts: NonNullable<Built['artifacts']>): Promise<ScenarioResult> {
  const r = new Recorder();
  // A man in the middle rewrites the fleet receipt on voucher #2 so it points to r-001's evidence.
  let swapped = false;
  let swappedDigest = '';
  const refused = await inWorld(r, {
    wrapFetch: (handle) => async (request) => {
      const header = request.headers.get(ACK_HEADER);
      if (header === null || !request.url.endsWith('/increments/2')) return handle(request);
      const ack = decodeAckHeader(header) as Record<string, unknown>;
      const headers = new Headers(request.headers);
      headers.set(ACK_HEADER, encodeAckHeader({ ...ack, evidenceDigest: swappedDigest }));
      swapped = true;
      return handle(new Request(request.url, { method: request.method, headers }));
    },
  }, async (w) => {
    await w.authorize(w.evidence[0]!);
    swappedDigest = w.evidence[0]!.charge.evidenceDigest;
    const result = await w.authorize(w.evidence[1]!);
    r.check('Receipt rewritten in transit', 'true', String(swapped));
    r.check('Fleet voucher #2 itself was genuine (signed by the SDK)', 'true', String(has(w.chain.calls, 'prepare_commitment(2000000)')));
    r.check('Station refuses before SDK acceptance', 'REJECTED INVALID_PAYER_ACK', outcomeOf(result));
    r.check('Station total unchanged', '1000000', await w.payee.storedCumulative());
    return result;
  });
  // Auditor: a genuine voucher whose receipt was re-pointed after sealing.
  const e0 = structuredClone(s1Artifacts.e0);
  e0.increments[1]!.payerAck.evidenceDigest = e0.increments[0]!.charge.evidenceDigest;
  const report = await createVerifier({ trust: s1Artifacts.trust, chain: s1Artifacts.chain.reader }).verify({ e0, e1: s1Artifacts.e1 });
  const summary = r.audit(report, 'a package with a re-pointed receipt');
  r.check('Auditor: the voucher signature alone still verifies', 'PASS', report.checks.V05_MPP.status);
  r.check('Auditor: the receipt binding fails', 'FAIL', report.checks.V06_PAYER_ACK.status);
  r.check('Auditor overall verdict', 'FAIL', report.overall.status);
  return finish(
    { id: 'F4', title: 'Payment detached from its evidence', question: 'What if a valid payment voucher is re-used for different meter data?' },
    r,
    { status: 'REJECTED', reasonCode: 'INVALID_PAYER_ACK' },
    refused.kind === 'AUTHORIZED' ? { status: 'AUTHORIZED' } : { status: refused.kind, reasonCode: refused.reasonCode },
    'The Stellar voucher signature was valid, but the separate fleet receipt no longer matched the reading, so the station refused it and the auditor failed the package.',
    summary,
  );
}

async function f5(s1Artifacts: NonNullable<Built['artifacts']>): Promise<ScenarioResult> {
  const r = new Recorder();
  const { e0, e1, chain, trust } = s1Artifacts;
  const verifier = createVerifier({ trust, chain: chain.reader, timeoutMs: 2_000 });
  const foreign = chain.recordForeign('SUCCESS', { contractId: StrKey.encodeContract(randomBytes(32)), amount: 3000000n });
  const unrelated = await verifier.verify({ e0, e1: { ...e1, closeTxHash: foreign } });
  const unrelatedSummary = r.audit(unrelated, 'a receipt pointing to an unrelated successful transaction');
  r.check('Unrelated SUCCESS transaction', 'FAIL CHAIN_MISMATCH', verdict(unrelated, 'V08_CHAIN'));
  const overstated = await verifier.verify({ e0, e1: { ...e1, settledCumulativeBaseUnits: '5000000' } });
  r.audit(overstated, 'a receipt claiming more than was paid');
  r.check('Receipt claims 5000000 but ledger paid 3000000', 'FAIL CHAIN_MISMATCH', verdict(overstated, 'V08_CHAIN'));
  chain.down = true;
  const offline = await verifier.verify({ e0, e1 });
  chain.down = false;
  r.audit(offline, 'the genuine package while the ledger is unreachable');
  r.check('Ledger unreachable', 'NOT_AVAILABLE RPC_UNAVAILABLE', verdict(offline, 'V08_CHAIN'));
  r.check('Never reported as PASS', 'FAIL,FAIL,NOT_AVAILABLE', [unrelated, overstated, offline].map((x) => x.overall.status).join(','));
  return finish(
    { id: 'F5', title: 'False or missing settlement', question: 'What if someone shows a real but unrelated transaction, or the ledger is unreachable?' },
    r,
    { status: 'FAIL', reasonCode: 'CHAIN_MISMATCH' },
    { status: unrelated.checks.V08_CHAIN.status, reasonCode: unrelated.checks.V08_CHAIN.reasonCode },
    'A transaction hash alone proves nothing: the auditor reads the ledger itself. Contradicting data fails; missing data is "not available", never a pass.',
    unrelatedSummary,
  );
}

async function f6(s1Artifacts: NonNullable<Built['artifacts']>): Promise<ScenarioResult> {
  const r = new Recorder();
  const { e0, e1, chain, trust } = s1Artifacts;
  const verifier = createVerifier({ trust, chain: chain.reader });
  const edited = await verifier.verify({ e0: { ...e0, finalizedAt: '2026-10-25T09:06:00.000Z' }, e1 });
  const summary = r.audit(edited, 'a package edited after sealing');
  r.check('Package edited after sealing', 'FAIL E0_DIGEST_MISMATCH', verdict(edited, 'V07_E0_E1_LINK'));
  const failedTx = chain.recordForeign('FAILED', { contractId: trust.channelId, amount: 3000000n });
  const forged = await verifier.verify({ e0, e1: { ...e1, closeTxHash: failedTx, txStatus: 'SUCCESS' } });
  r.audit(forged, 'a receipt that claims SUCCESS for a failed transaction');
  r.check('Receipt says SUCCESS, ledger says FAILED', 'FAIL SETTLEMENT_FAILED', verdict(forged, 'V08_CHAIN'));
  return finish(
    { id: 'F6', title: 'Edited records', question: 'What if the sealed evidence or the settlement record is edited afterwards?' },
    r,
    { status: 'FAIL', reasonCode: 'E0_DIGEST_MISMATCH' },
    { status: edited.checks.V07_E0_E1_LINK.status, reasonCode: edited.checks.V07_E0_E1_LINK.reasonCode },
    'Any edit to the sealed package changes its fingerprint, and a "SUCCESS" written in the record never overrides what the ledger says.',
    summary,
  );
}

async function f7(): Promise<ScenarioResult> {
  const r = new Recorder();
  let drop = true;
  const pending = await inWorld(r, {
    wrapFetch: (handle) => async (request) => {
      const response = await handle(request);
      if (drop && request.headers.has('authorization')) {
        drop = false;
        throw new Error('socket hang up');
      }
      return response;
    },
  }, async (w) => {
    const first = await w.authorize(w.evidence[0]!);
    r.check('Answer lost after the voucher was sent', 'PENDING PAYMENT_OUTCOME_UNKNOWN', outcomeOf(first));
    r.check('Next reading waits while one is pending', 'PENDING PAYMENT_OUTCOME_UNKNOWN', outcomeOf(await w.authorize(w.evidence[1]!)));
    let sealed = 'sealed';
    try {
      w.payer.finalizeE0(FINALIZED_AT);
    } catch {
      sealed = 'refused';
    }
    r.check('Evidence cannot be sealed while pending', 'refused', sealed);
    r.check('Reconciled from the station receipt', 'AUTHORIZED 1000000', outcomeOf(await w.payer.reconcile()));
    await w.authorize(w.evidence[1]!);
    await w.authorize(w.evidence[2]!);
    const e0 = w.payer.finalizeE0(FINALIZED_AT);
    w.chain.loseNextClose = true;
    const settlement = w.settlement();
    const lost = await settlement.closeLatest({ channelId: w.verifierTrust.channelId, e0 });
    r.check('Close submission lost in transit', 'PENDING SETTLEMENT_PENDING', lost.kind === 'OBSERVED' ? `OBSERVED ${lost.e1.txStatus}` : `${lost.kind} ${lost.reasonCode}`);
    const again = await settlement.closeLatest({ channelId: w.verifierTrust.channelId, e0 });
    r.check('Not reported as settled, not blindly retried', 'PENDING, 1 close', `${again.kind}, ${w.chain.calls.filter((c) => c.startsWith('close(')).length} close`);
    return first;
  });
  return finish(
    { id: 'F7', title: 'Lost connection', question: 'What if the connection drops in the middle of a payment?' },
    r,
    { status: 'PENDING', reasonCode: 'PAYMENT_OUTCOME_UNKNOWN' },
    pending.kind === 'AUTHORIZED' ? { status: 'AUTHORIZED' } : { status: pending.kind, reasonCode: pending.reasonCode },
    'Unknown outcomes stay "pending": nothing is counted as accepted or paid until a receipt or the ledger confirms it. Production recovery is out of scope.',
  );
}

/** Runs S1 then F1-F7 in order (F1, F3-F6 reuse S1's genuine artifacts for the auditor half). */
export async function runScenarios(): Promise<ScenarioResult[]> {
  const happy = await s1();
  const artifacts = happy.artifacts!;
  return [happy.result, await f1(artifacts), await f2(), await f3(artifacts), await f4(artifacts), await f5(artifacts), await f6(artifacts), await f7()];
}
