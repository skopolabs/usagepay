import { CHECK_IDS, createVerifier, type ChainReader, type CheckId, type VerificationReport } from '@usagepay/verification';
import { explorerLinks, formatAmount } from './format.js';
import { ACTORS, CHECK_EXPLANATIONS, EVIDENCE_CLASSES, explainReason, explainTrace, type CheckExplanation, type StoryEvent } from './narrative.js';
import { cliEquivalents, meterRows, observeLedger, type CliEquivalent, type LedgerObservation, type MeterRow, type RealRun, type RunSummary } from './real-run.js';
import { runScenarios, type ScenarioResult } from './scenarios.js';

/**
 * The single data source of the judge walkthrough: the terminal renders it and the demo UI will render the same
 * JSON. It holds public values only (addresses, hashes, amounts, signatures), never key material.
 */
export interface DemoBundle {
  readonly schema: 'upay.demo-bundle.v1';
  readonly generatedAt: string;
  readonly result: DemoVerdict;
  readonly actors: typeof ACTORS;
  readonly checks: Readonly<Record<CheckId, CheckExplanation>>;
  readonly evidenceClasses: typeof EVIDENCE_CLASSES;
  readonly realRun: RealRunView | { readonly status: 'MISSING'; readonly reason: string };
  readonly scenarios: readonly ScenarioResult[];
  readonly limits: readonly string[];
}

export type DemoStatus = 'PASS' | 'FAIL' | 'NOT_AVAILABLE';

export interface DemoVerdict {
  readonly status: DemoStatus;
  readonly detail: string;
}

export interface CheckView extends CheckExplanation {
  readonly id: CheckId;
  readonly status: string;
  readonly reasonCode: string;
  readonly plain: string;
  readonly details: string;
}

export interface RealRunView {
  readonly status: 'REPLAY';
  readonly evidenceClass: 'REAL_TESTNET';
  readonly runId: string;
  readonly recordedAt: string;
  readonly network: 'stellar:testnet';
  readonly parties: RunSummary['parties'] & { readonly channelId: string };
  readonly links: Readonly<Record<'channel' | 'closeTx' | 'station' | 'fleet' | 'asset', string>>;
  readonly tariff: { readonly tariffId: string; readonly pricePerKwh: string; readonly validFrom: string; readonly validUntil: string };
  readonly meter: readonly MeterRow[];
  readonly e0Digest: string;
  readonly settlement: {
    readonly closeTxHash: string;
    readonly recordedStatus: string;
    readonly settled: string;
    readonly balances?: RunSummary['balances'];
  };
  readonly story: readonly StoryEvent[];
  readonly ledger: LedgerObservation;
  readonly cli: readonly CliEquivalent[];
  readonly verification: {
    readonly mode: 'LIVE' | 'OFFLINE';
    readonly at: string;
    readonly overall: { readonly status: string; readonly reasonCode: string; readonly plain: string };
    readonly checks: readonly CheckView[];
  };
}

export const LIMITS: readonly string[] = [
  'One adapter today: energy in Wh, shown as EV charging. UsagePay is built for any metered service, but this code accepts energy readings only; a second adapter is on the roadmap.',
  'Meter data is simulated: a software charger signs readings with a disposable test key. Not a certified meter, not OCPP or OCMF conformant.',
  'Stellar Testnet only: test USDC with no real value; Testnet software is not audited for production.',
  'The Stellar channel contract enforces the payment, not the metering. The payer receipt links each payment to its reading, and the auditor re-checks that link.',
  'Channel deposits, payouts and parties are public on the ledger; ordinary USDC channels are not confidential.',
  'Demo storage lives in one process: no production durability, recovery or reconciliation.',
];

export interface BundleOptions {
  readonly run?: RealRun;
  /** Why no real run is available, when `run` is absent. */
  readonly missingReason?: string;
  /** Read-only ledger access; omitted means offline (V08 and the overall verdict are NOT_AVAILABLE). */
  readonly chain?: ChainReader;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export async function buildBundle(options: BundleOptions): Promise<DemoBundle> {
  const now = options.now ?? (() => new Date());
  const scenarios = await runScenarios();
  const realRun = options.run === undefined
    ? { status: 'MISSING' as const, reason: options.missingReason ?? 'no real Testnet run found' }
    : await realRunView(options.run, options.chain, options.timeoutMs, now);
  return {
    schema: 'upay.demo-bundle.v1',
    generatedAt: now().toISOString(),
    result: demoVerdict(realRun, scenarios),
    actors: ACTORS,
    checks: CHECK_EXPLANATIONS,
    evidenceClasses: EVIDENCE_CLASSES,
    realRun,
    scenarios,
    limits: LIMITS,
  };
}

async function realRunView(run: RealRun, chain: ChainReader | undefined, timeoutMs: number | undefined, now: () => Date): Promise<RealRunView> {
  const report = await createVerifier({ trust: run.trust, ...(chain === undefined ? {} : { chain }), ...(timeoutMs === undefined ? {} : { timeoutMs }) })
    .verify({ e0: run.e0, e1: run.e1 });
  const at = now().toISOString();
  const ledger: LedgerObservation = chain === undefined ? { status: 'UNAVAILABLE', error: 'offline mode: the ledger was not queried' } : await observeLedger(chain, run);
  const { tariff } = run.e0;
  return {
    status: 'REPLAY',
    evidenceClass: 'REAL_TESTNET',
    runId: run.runId,
    recordedAt: run.trace[0]?.at ?? run.e0.finalizedAt,
    network: 'stellar:testnet',
    parties: { ...run.summary.parties, channelId: run.trust.channelId },
    links: {
      channel: explorerLinks.contract(run.trust.channelId),
      closeTx: explorerLinks.tx(run.e1.closeTxHash),
      station: explorerLinks.account(run.trust.recipient),
      fleet: explorerLinks.account(run.trust.funder),
      asset: explorerLinks.contract(run.trust.assetSac),
    },
    tariff: { tariffId: tariff.tariffId, pricePerKwh: formatAmount(tariff.pricePerKwhBaseUnits, tariff.assetDecimals, tariff.currencyCode), validFrom: tariff.validFrom, validUntil: tariff.validUntil ?? 'open-ended' },
    meter: meterRows(run.e0),
    e0Digest: run.e1.e0Digest,
    settlement: {
      closeTxHash: run.e1.closeTxHash,
      recordedStatus: run.e1.txStatus,
      settled: run.e1.settledCumulativeBaseUnits ?? '0',
      ...(run.summary.balances === undefined ? {} : { balances: run.summary.balances }),
    },
    story: explainTrace(run.trace),
    ledger,
    cli: cliEquivalents(run, ledger),
    verification: { mode: chain === undefined ? 'OFFLINE' : 'LIVE', at, ...verificationView(report) },
  };
}

function verificationView(report: VerificationReport): Pick<RealRunView['verification'], 'overall' | 'checks'> {
  return {
    overall: { status: report.overall.status, reasonCode: report.overall.reasonCode, plain: explainReason(report.overall.reasonCode) },
    checks: CHECK_IDS.map((id) => ({
      id,
      ...CHECK_EXPLANATIONS[id],
      status: report.checks[id].status,
      reasonCode: report.checks[id].reasonCode,
      plain: explainReason(report.checks[id].reasonCode),
      details: report.checks[id].details,
    })),
  };
}

/**
 * Demo smoke verdict: every scenario met its expectation, and the real run verified PASS live. Offline, the best
 * possible real-run outcome is NOT_AVAILABLE (V01-V07 PASS, ledger not queried), never PASS.
 */
function demoVerdict(realRun: DemoBundle['realRun'], scenarios: readonly ScenarioResult[]): DemoVerdict {
  const failed = scenarios.filter((s) => s.result !== 'PASS').map((s) => s.id);
  if (failed.length > 0) return { status: 'FAIL', detail: `scenario expectations not met: ${failed.join(', ')}` };
  if (realRun.status === 'MISSING') return { status: 'FAIL', detail: `no real Testnet run: ${realRun.reason}` };
  const { overall, checks } = realRun.verification;
  if (overall.status === 'PASS') return { status: 'PASS', detail: 'all scenarios met expectations; the real Testnet run verified PASS (V01-V08)' };
  const offChain = checks.filter((c) => c.id !== 'V08_CHAIN');
  if (overall.status === 'NOT_AVAILABLE' && offChain.every((c) => c.status === 'PASS')) {
    return { status: 'NOT_AVAILABLE', detail: `all scenarios met expectations; real run V01-V07 PASS, ledger proof not available (${overall.reasonCode})` };
  }
  return { status: 'FAIL', detail: `real Testnet run verification ${overall.status} (${overall.reasonCode})` };
}
