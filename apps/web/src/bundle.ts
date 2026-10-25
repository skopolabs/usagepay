import type { DemoBundle, RealRunView, StoryEvent } from '@usagepay/demo';

/**
 * The UI renders `upay.demo-bundle.v1` exactly as `pnpm demo` wrote it (SPEC 05 D2/D3). Nothing here computes an
 * amount, digest, signature or verdict: these helpers only check the shape, count recorded events and format text.
 */
export const BUNDLE_SCHEMA = 'upay.demo-bundle.v1';

export type LoadedBundle = { readonly ok: true; readonly bundle: DemoBundle } | { readonly ok: false; readonly error: string };

const REQUIRED = ['generatedAt', 'result', 'actors', 'checks', 'realRun', 'scenarios', 'limits'] as const;

export function parseBundle(raw: unknown): LoadedBundle {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'The demo bundle is not a JSON object.' };
  const fields = raw as Record<string, unknown>;
  if (fields['schema'] !== BUNDLE_SCHEMA) return { ok: false, error: `Unsupported demo bundle schema "${String(fields['schema'])}"; this page reads ${BUNDLE_SCHEMA}.` };
  const missing = REQUIRED.find((key) => fields[key] === undefined);
  if (missing !== undefined) return { ok: false, error: `The demo bundle has no "${missing}" field.` };
  if (!Array.isArray(fields['scenarios']) || !Array.isArray(fields['limits'])) return { ok: false, error: 'The demo bundle scenarios or limits are not lists.' };
  return { ok: true, bundle: raw as DemoBundle };
}

/** Base-unit amounts arrive as decimal strings in JSON even where the source type says `bigint`. */
export const units = (value: unknown): string => (value === undefined || value === null ? '0' : String(value));

/** Recorded milestones of a story, counted from the events played so far (never inferred). */
export interface Progress {
  readonly readings: number;
  readonly vouchers: number;
  readonly receipts: number;
  readonly accepted: number;
  readonly transactions: number;
  readonly sealed: boolean;
}

export function progressOf(events: readonly StoryEvent[]): Progress {
  const count = (name: string) => events.filter((e) => e.technical['event'] === name).length;
  return {
    readings: count('metering.accepted'),
    vouchers: count('payer.native.signed'),
    receipts: count('payer.ack.signed'),
    accepted: count('payee.accepted'),
    transactions: count('settlement.close.submitted'),
    sealed: count('payer.e0.finalized') > 0,
  };
}

/** A run of recorded events that repeats the same steps back to back, such as one voucher round per reading. */
export interface Round {
  /** Index of the round's first event in the story. */
  readonly start: number;
  /** Events in one round. */
  readonly length: number;
  /** Round numbers shown by this step: 1 for the first occurrence, which is replayed event by event. */
  readonly first: number;
  readonly last: number;
  /** How many rounds repeat back to back. */
  readonly of: number;
}

/** One replay tick: the events `[start, end)` appear together. `round.start` is the first event of the step's rounds. */
export interface ReplayStep {
  readonly start: number;
  readonly end: number;
  readonly round?: Round;
}

/** Only completed steps repeat; a refusal or an unknown outcome is always its own step. */
const signature = (e: StoryEvent): string | undefined =>
  e.technical['event'] === undefined || (e.status !== 'OK' && e.status !== 'INFO') ? undefined : [e.actor, e.layer, e.status, e.technical['event'], e.technical['id'] ?? ''].join('|');

/**
 * Replay steps over the recorded events, in their recorded order. Back-to-back rounds with the same actors, event kinds
 * and statuses are found by shape only: the first round plays one event per step, every repeat plays as a single step,
 * and repeats of a single event play together.
 * No event is dropped, merged or reordered.
 */
export function replaySteps(events: readonly StoryEvent[]): readonly ReplayStep[] {
  const sigs = events.map(signature);
  const same = (a: number, b: number, length: number) => {
    for (let k = 0; k < length; k++) if (sigs[a + k] === undefined || sigs[a + k] !== sigs[b + k]) return false;
    return true;
  };
  const steps: ReplayStep[] = [];
  let i = 0;
  while (i < events.length) {
    let length = 0;
    for (let l = 1; i + 2 * l <= events.length; l++) {
      if (same(i, i + l, l)) {
        length = l;
        break;
      }
    }
    if (length === 0) {
      steps.push({ start: i, end: i + 1 });
      i += 1;
      continue;
    }
    let of = 2;
    while (i + (of + 1) * length <= events.length && same(i, i + of * length, length)) of += 1;
    const first: Round = { start: i, length, first: 1, last: 1, of };
    for (let k = 0; k < length; k++) steps.push({ start: i + k, end: i + k + 1, round: first });
    if (length === 1) steps.push({ start: i + 1, end: i + of, round: { start: i + 1, length, first: 2, last: of, of } });
    else {
      for (let n = 2; n <= of; n++) {
        const start = i + (n - 1) * length;
        steps.push({ start, end: start + length, round: { start, length, first: n, last: n, of } });
      }
    }
    i += of * length;
  }
  return steps;
}

/** The channel deposit as read from the ledger before charging (`read.channel-state`), if recorded. */
export function depositOf(run: RealRunView): string | undefined {
  return run.story.find((e) => e.technical['event'] === 'read.channel-state')?.technical['balance'];
}

/** `2026-10-25T16:52:25.654Z` -> `2026-10-25 16:52 UTC`. */
export function utc(iso: string, withSeconds = false): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, withSeconds ? 19 : 16)} UTC`;
}

export type { DemoBundle, RealRunView, StoryEvent };
