import type { DemoBundle, RealRunView } from './bundle.js';
import { formatAmount, formatEnergy, short } from './format.js';

/**
 * Terminal rendering of the judge walkthrough (SPEC 04 §6): five labelled steps, each tagged OFF-CHAIN or ON-CHAIN,
 * in plain words first and with the public technical value next to it.
 */
export function renderWalkthrough(bundle: DemoBundle, options: { color?: boolean } = {}): string {
  const c = palette(options.color ?? false);
  const out: string[] = [];
  const line = (text = '') => out.push(text);
  const step = (n: number, title: string, layer: 'OFF-CHAIN' | 'ON-CHAIN' | 'OFF + ON-CHAIN') => {
    line();
    line(`${c.bold(`STEP ${n} · ${title}`)}  ${layer === 'ON-CHAIN' ? c.blue(`[${layer}]`) : c.dim(`[${layer}]`)}`);
  };
  const mark = (status: string) =>
    status === 'PASS' || status === 'OK' ? c.green('✔') : status === 'NOT_AVAILABLE' || status === 'PENDING' ? c.yellow('…') : c.red('✘');

  line(c.bold('UsagePay · pay-per-kWh EV charging, settled on Stellar'));
  line('An EV charges; a meter signs every reading; the fleet wallet pays the station step by step through a');
  line('Stellar payment channel; one transaction settles; an independent auditor re-checks everything.');

  const run = bundle.realRun;
  if (run.status === 'MISSING') {
    line();
    line(c.red(`No real Testnet run available: ${run.reason}`));
  } else {
    line();
    line(c.yellow(`REPLAY of real Stellar Testnet run ${run.runId}, recorded ${run.recordedAt.replace('T', ' ').slice(0, 16)} UTC.`));
    line(c.yellow(`Nothing is paid again now. Steps 1-3 show what happened; step 4 re-checks it ${run.verification.mode === 'LIVE' ? 'live against the ledger' : 'OFFLINE (ledger not queried)'}.`));
    line();
    line(c.bold('Who is involved'));
    for (const actor of Object.values(bundle.actors)) line(`  ${actor.name.padEnd(32)} ${c.dim(actor.role)}`);
    renderRealRun(run, line, step, mark, c);
  }

  step(5, 'What if something goes wrong?', 'OFF + ON-CHAIN');
  line(c.dim('  Deterministic offline scenarios: real meter, fleet and station code and real MPP SDK signatures; the ledger is simulated.'));
  for (const s of bundle.scenarios) {
    const expected = `${s.expected.status}${s.expected.reasonCode === undefined ? '' : ` ${s.expected.reasonCode}`}`;
    line(`  ${s.result === 'PASS' ? c.green('✔') : c.red('✘')} ${c.bold(`${s.id} ${s.title}`)}  ${c.dim(`[${s.evidenceClass}]`)}`);
    line(`      Q: ${s.question}`);
    line(`      A: ${s.answer}`);
    line(c.dim(`      expected ${expected} · actual ${s.actual.status}${s.actual.reasonCode === undefined ? '' : ` ${s.actual.reasonCode}`} · ${s.checkpoints.filter((p) => p.ok).length}/${s.checkpoints.length} checkpoints`));
  }

  line();
  line(c.bold('Limits, stated plainly'));
  for (const limit of bundle.limits) line(`  - ${limit}`);
  line();
  const verdict = bundle.result.status === 'PASS' ? c.green : bundle.result.status === 'FAIL' ? c.red : c.yellow;
  line(verdict(c.bold(`DEMO ${bundle.result.status}`)) + `  ${bundle.result.detail}`);
  return out.join('\n') + '\n';
}

type Line = (text?: string) => void;
type Step = (n: number, title: string, layer: 'OFF-CHAIN' | 'ON-CHAIN' | 'OFF + ON-CHAIN') => void;

function renderRealRun(run: RealRunView, line: Line, step: Step, mark: (status: string) => string, c: Palette): void {
  step(1, 'The charger measures energy and signs each reading', 'OFF-CHAIN');
  line(`  Price list ${run.tariff.tariffId}: ${run.tariff.pricePerKwh} per kWh.`);
  for (const row of run.meter) {
    line(`  ${c.green('✔')} ${row.readingId}  ${row.intervalStart.slice(11, 16)}-${row.intervalEnd.slice(11, 16)}  register ${row.meterStartWh} -> ${row.meterEndWh} Wh  `
      + `+${formatEnergy(row.deltaWh)}  running total ${c.bold(formatAmount(row.cumulativeChargeBaseUnits))}`);
  }
  const first = run.meter[0];
  if (first !== undefined) line(c.dim(`  Signed by meter key ${first.signerKeyId} (${short(run.parties.meterKey)}), certification: ${first.certification}.`));

  step(2, 'The fleet approves each step and signs a voucher plus a receipt', 'OFF-CHAIN');
  line(c.dim('  A voucher is a Stellar MPP channel commitment for the running total. It stays off-chain; only the last one is ever submitted.'));
  for (const [index, row] of run.meter.entries()) {
    line(`  ${c.green('✔')} #${index + 1} voucher for ${formatAmount(row.cumulativeChargeBaseUnits)} total ${c.dim(`(${short(row.voucherDigest)})`)}`
      + ` + receipt binding it to ${row.readingId} ${c.dim(`(nonce ${short(row.receiptNonce)})`)} -> station accepted`);
  }
  line(`  Evidence package sealed before payment (E0): ${c.dim(short(run.e0Digest, 12, 8))}`);

  step(3, 'One payment on Stellar Testnet', 'ON-CHAIN');
  const settled = BigInt(run.settlement.settled);
  line(`  Payment channel ${short(run.parties.channelId)} holds the fleet deposit and can only pay station ${short(run.parties.recipient)}.`);
  line(`  The station submitted ONE close transaction with the highest voucher: ${c.bold(formatAmount(settled))}.`);
  if (run.ledger.status === 'OBSERVED' && run.ledger.tx.status !== 'NOT_FOUND') {
    const withdraw = run.ledger.events.find((e) => e.name === 'withdraw');
    const refund = run.ledger.events.find((e) => e.name === 'refund');
    line(`  ${mark('OK')} Ledger now: transaction ${run.ledger.tx.status} in ledger ${run.ledger.tx.ledger}; station paid ${formatAmount(withdraw?.amount ?? 0n)}`
      + `${refund?.amount === undefined ? '' : `, fleet refunded ${formatAmount(refund.amount)}`}.`);
  } else {
    line(`  ${mark('NOT_AVAILABLE')} Recorded status ${run.settlement.recordedStatus}; ledger not observed now (${run.ledger.status === 'UNAVAILABLE' ? run.ledger.error : 'transaction not found'}).`);
  }
  const balances = run.settlement.balances;
  if (balances !== undefined) {
    line(c.dim(`  Recorded wallet balances: station ${balances.before['recipient']} -> ${balances.after['recipient']} USDC, fleet ${balances.before['funder']} -> ${balances.after['funder']} USDC.`));
  }
  line(`  ${c.blue(run.links.closeTx)}`);
  line(c.dim('  Check it yourself with the Stellar CLI (read-only):'));
  for (const cli of run.cli) {
    line(c.dim(`    $ ${cli.command}`));
    for (const observed of cli.observed) line(`      ${observed}`);
  }

  step(4, 'An independent auditor re-checks everything', 'OFF + ON-CHAIN');
  line(c.dim(`  ${run.verification.mode === 'LIVE' ? 'Live, read-only' : 'OFFLINE'} at ${run.verification.at}. The auditor holds no keys and trusts nothing it cannot recompute.`));
  for (const check of run.verification.checks) {
    line(`  ${mark(check.status)} ${check.id.slice(0, 3)} ${check.title.padEnd(22)} ${check.layer === 'ON_CHAIN' ? c.blue('[ON-CHAIN] ') : ''}${check.question}`);
    if (check.status !== 'PASS') line(`        ${check.status}: ${check.plain}`);
  }
  const overall = run.verification.overall;
  line(`  ${c.bold(`AUDITOR VERDICT: ${overall.status}`)}  ${overall.plain}`);
}

interface Palette {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
}

function palette(enabled: boolean): Palette {
  const wrap = (code: string) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return { bold: wrap('1'), dim: wrap('2'), green: wrap('32'), red: wrap('31'), yellow: wrap('33'), blue: wrap('34') };
}
