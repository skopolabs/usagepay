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

/** The channel deposit as read from the ledger before charging (`read.channel-state`), if recorded. */
export function depositOf(run: RealRunView): string | undefined {
  return run.story.find((e) => e.technical['event'] === 'read.channel-state')?.technical['balance'];
}

/** `2026-10-25T16:52:25.654Z` -> `2026-10-25 16:52 UTC`. */
export function utc(iso: string, withSeconds = false): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, withSeconds ? 19 : 16)} UTC`;
}

/** `18.4000000` -> `18.40`: trims a recorded decimal for display, keeping two places. */
export function trimDecimal(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

export type { DemoBundle, RealRunView, StoryEvent };
