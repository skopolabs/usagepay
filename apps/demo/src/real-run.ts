import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { base64ToBytes, decodeSimMeterPayload, type EvidenceE0, type EvidenceE1 } from '@usagepay/contracts';
import { trustFromFile, type ChainReader, type ObservedChannel, type ObservedEvent, type ObservedTransaction, type VerifierTrust } from '@usagepay/verification';
import type { TraceEvent } from './narrative.js';

/**
 * A captured real Stellar Testnet run (SPEC 02 G2 runner output). The demo REPLAYS it, labelled as such, and never
 * presents it as a fresh payment; only the independent verification and the ledger reads are performed live.
 */
export interface RealRun {
  readonly runId: string;
  readonly dir: string;
  readonly trace: readonly TraceEvent[];
  readonly e0: EvidenceE0;
  readonly e1: EvidenceE1;
  readonly summary: RunSummary;
  readonly trust: VerifierTrust;
  /** Path of the pinned public trust file used for verification. */
  readonly trustFile: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly result: string;
  readonly channelId: string;
  readonly parties: { readonly funder: string; readonly recipient: string; readonly commitmentKey: string; readonly assetSac: string; readonly meterKey: string };
  readonly e0Digest: string;
  readonly closeTxHash: string;
  readonly balances?: { readonly before: Readonly<Record<string, string>>; readonly after: Readonly<Record<string, string>> };
}

/** Newest `g2-*` run directory that holds a completed E1, by its ISO-timestamp name. */
export function findLatestRun(runsDir: string): string | undefined {
  if (!existsSync(runsDir)) return undefined;
  const runs = readdirSync(runsDir)
    .filter((name) => name.startsWith('g2-') && existsSync(join(runsDir, name, 'e1.json')))
    .sort();
  const latest = runs.at(-1);
  return latest === undefined ? undefined : join(runsDir, latest);
}

/** Loads a run directory. Trust comes from `trustFile`, else the run's own `trust.json`; it is never derived from E0/E1. */
export function loadRealRun(dir: string, trustFile?: string): RealRun {
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown;
  const trustPath = trustFile ?? join(dir, 'trust.json');
  if (!existsSync(trustPath)) throw new Error(`no pinned trust file: ${trustPath} (pass --trust <file>)`);
  const trace = readFileSync(join(dir, 'trace.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TraceEvent);
  return {
    runId: basename(dir),
    dir,
    trace,
    e0: read('e0.json') as EvidenceE0,
    e1: read('e1.json') as EvidenceE1,
    summary: read('summary.json') as RunSummary,
    trust: trustFromFile(JSON.parse(readFileSync(trustPath, 'utf8'))),
    trustFile: trustPath,
  };
}

/** One signed meter reading as the charger reported it, decoded from the exact signed bytes in E0. */
export interface MeterRow {
  readonly readingId: string;
  readonly intervalStart: string;
  readonly intervalEnd: string;
  readonly meterStartWh: string;
  readonly meterEndWh: string;
  readonly deltaWh: string;
  readonly cumulativeWh: string;
  readonly cumulativeChargeBaseUnits: string;
  readonly signerKeyId: string;
  readonly certification: string;
  readonly voucherDigest: string;
  readonly receiptNonce: string;
}

export function meterRows(e0: EvidenceE0): MeterRow[] {
  return e0.increments.map((increment) => {
    const payload = decodeSimMeterPayload(base64ToBytes(increment.reading.rawPayloadB64));
    return {
      readingId: increment.reading.readingId,
      intervalStart: payload.intervalStart,
      intervalEnd: payload.intervalEnd,
      meterStartWh: payload.meterStartWh,
      meterEndWh: payload.meterEndWh,
      deltaWh: increment.reading.deltaWh,
      cumulativeWh: increment.charge.cumulativeWh,
      cumulativeChargeBaseUnits: increment.charge.cumulativeChargeBaseUnits,
      signerKeyId: increment.reading.signerKeyId ?? '(none)',
      certification: increment.reading.certification,
      voucherDigest: increment.commitment.commitmentDigest,
      receiptNonce: increment.payerAck.nonce,
    };
  });
}

/** What the ledger says right now about the run's close, read through the verifier's read-only port. */
export type LedgerObservation =
  | { readonly status: 'OBSERVED'; readonly tx: ObservedTransaction; readonly events: readonly ObservedEvent[]; readonly channel: ObservedChannel }
  | { readonly status: 'UNAVAILABLE'; readonly error: string };

export async function observeLedger(reader: ChainReader, run: RealRun): Promise<LedgerObservation> {
  try {
    const tx = await reader.getTransaction(run.e1.closeTxHash);
    const events = tx.status === 'NOT_FOUND' ? [] : await reader.getTransactionEvents(run.trust.channelId, tx.ledger, run.e1.closeTxHash);
    const channel = await reader.readChannel(run.trust.channelId);
    return { status: 'OBSERVED', tx, events, channel };
  } catch (error) {
    return { status: 'UNAVAILABLE', error: error instanceof Error ? error.message : String(error) };
  }
}

/** A Stellar CLI command anyone can run to see the same on-chain fact, with the value the demo observed. */
export interface CliEquivalent {
  readonly purpose: string;
  readonly command: string;
  readonly observed: readonly string[];
}

/** Read-only `stellar` CLI commands mirroring each ledger read (any public account works as simulation source). */
export function cliEquivalents(run: RealRun, observation: LedgerObservation): CliEquivalent[] {
  const { channelId, recipient } = run.trust;
  const observed = observation.status === 'OBSERVED' ? observation : undefined;
  const ledger = observed !== undefined && observed.tx.status !== 'NOT_FOUND' ? observed.tx.ledger : undefined;
  const view = (fn: string, value: string | undefined): CliEquivalent => ({
    purpose: `Channel ${fn}() now`,
    command: `stellar contract invoke --id ${channelId} --source-account ${recipient} --network testnet --send=no -- ${fn}`,
    observed: [value === undefined ? '(not observed)' : `"${value}"`],
  });
  const eventLines = (observed?.events ?? []).map((event) => {
    const params = [event.to === undefined ? '' : `to: "${event.to}"`, event.from === undefined ? '' : `from: "${event.from}"`, event.amount === undefined ? '' : `amount: "${event.amount}"`]
      .filter((p) => p !== '')
      .join(', ');
    return `Event: ${event.name}${params === '' ? '' : `  ${params}`}`;
  });
  return [
    {
      purpose: 'Close transaction result',
      command: `stellar tx fetch result --hash ${run.e1.closeTxHash} --network testnet`,
      observed: [observed === undefined ? '(not observed)' : `status ${observed.tx.status}${ledger === undefined ? '' : `, ledger ${ledger}`}`],
    },
    {
      purpose: 'Contract events emitted by the close',
      command: `stellar events --start-ledger ${ledger ?? '<close ledger>'} --id ${channelId} --network testnet --output plain`,
      observed: eventLines.length > 0 ? eventLines : ['(not observed)'],
    },
    view('withdrawn', observed?.channel.withdrawn.toString()),
    view('balance', observed?.channel.balance.toString()),
  ];
}
