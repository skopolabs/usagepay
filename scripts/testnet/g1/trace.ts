import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Who produced a trace event. `network` marks facts read from or submitted to Stellar Testnet. */
export type TraceSide = 'payer' | 'payee' | 'verifier' | 'network';

export interface TraceEvent {
  readonly seq: number;
  readonly at: string;
  readonly side: TraceSide;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/**
 * Append-only JSONL trace that the demo UI replays (payer panel, payee panel, network CLI panel).
 * Only public data may be emitted: addresses, hashes, digests, signatures, amounts. Never secrets.
 */
export class Trace {
  private seq = 0;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  emit(side: TraceSide, event: string, data: Record<string, unknown> = {}): void {
    const entry: TraceEvent = { seq: ++this.seq, at: new Date().toISOString(), side, event, data };
    appendFileSync(this.path, JSON.stringify(entry, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)) + '\n');
    console.log(`${entry.at.slice(11, 23)}  ${side.padEnd(8)} ${event}${summarize(data)}`);
  }
}

function summarize(data: Record<string, unknown>): string {
  const parts = Object.entries(data)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
    .slice(0, 4)
    .map(([key, value]) => `${key}=${shorten(String(value))}`);
  return parts.length > 0 ? `  ${parts.join(' ')}` : '';
}

function shorten(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}
