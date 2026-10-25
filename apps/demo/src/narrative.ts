import type { CheckId } from '@usagepay/verification';
import { explorerLinks, formatAmount, short } from './format.js';

/**
 * Plain-language layer for judges and non-technical readers. Every technical event, check and reason code maps
 * to who did it, whether it touched the public ledger, and one sentence of what it means. The terminal walkthrough
 * and the demo UI render only these strings; the technical fields stay attached for anyone who wants to check.
 */

export type Actor = 'meter' | 'fleet' | 'station' | 'stellar' | 'auditor';

export const ACTORS: Record<Actor, { readonly name: string; readonly role: string }> = {
  meter: { name: 'Charger meter', role: 'Measures the energy delivered and signs every reading. Simulated device with a test key, not a certified meter.' },
  fleet: { name: 'Fleet wallet (payer)', role: 'Checks each reading against the tariff and its budget, then signs a payment voucher plus a receipt tying it to that reading.' },
  station: { name: 'Charging station (payee)', role: 'Accepts a voucher only if the fleet receipt matches the exact reading, then closes the channel to get paid.' },
  stellar: { name: 'Stellar Testnet', role: 'Public ledger. Holds the fleet deposit in a payment channel and pays the station when the channel closes.' },
  auditor: { name: 'Independent auditor (verifier)', role: 'Re-checks everything from the published evidence and the public ledger. Holds no keys and trusts no stored "verified" flag.' },
};

/** OFF_CHAIN: signed messages between the parties. ON_CHAIN: read from or written to Stellar Testnet. */
export type Layer = 'OFF_CHAIN' | 'ON_CHAIN';
export type StoryStatus = 'OK' | 'REJECTED' | 'PENDING' | 'INFO';

export interface StoryEvent {
  readonly actor: Actor;
  readonly layer: Layer;
  readonly status: StoryStatus;
  readonly title: string;
  readonly detail: string;
  /** Source event name and public technical values (hashes, keys, amounts in base units). Never secrets. */
  readonly technical: Readonly<Record<string, string>>;
  readonly links?: readonly { readonly label: string; readonly url: string }[];
  readonly at?: string;
}

export interface CheckExplanation {
  readonly title: string;
  readonly question: string;
  readonly layer: Layer;
}

export const CHECK_EXPLANATIONS: Record<CheckId, CheckExplanation> = {
  V01_SCHEMA: { title: 'Evidence format', question: 'Is the evidence package complete and well formed, with no self-declared "verified" flags?', layer: 'OFF_CHAIN' },
  V02_METER: { title: 'Meter signatures', question: 'Was every reading signed by the registered meter, byte for byte, with no gaps in the counter?', layer: 'OFF_CHAIN' },
  V03_TARIFF: { title: 'Price and budget', question: 'Does re-pricing the energy with the published tariff give exactly the billed amounts, within the fleet budget?', layer: 'OFF_CHAIN' },
  V04_EVIDENCE: { title: 'Evidence fingerprints', question: 'Do the fingerprints of every reading and charge match, with totals that only go up?', layer: 'OFF_CHAIN' },
  V05_MPP: { title: 'Payment vouchers', question: 'Is each Stellar channel voucher genuinely signed by the fleet key, for that exact channel and amount?', layer: 'OFF_CHAIN' },
  V06_PAYER_ACK: { title: 'Fleet receipts', question: 'Did the fleet sign a receipt binding each voucher to its exact reading?', layer: 'OFF_CHAIN' },
  V07_E0_E1_LINK: { title: 'Package link', question: 'Does the settlement record point to this exact, unmodified evidence package?', layer: 'OFF_CHAIN' },
  V08_CHAIN: { title: 'On-chain payment', question: 'Does the public Stellar ledger show the channel closed with the right amount paid to the right station?', layer: 'ON_CHAIN' },
};

/** What each scenario evidence class (SPEC 04 §2) proves, in plain words. */
export const EVIDENCE_CLASSES: Record<'OFFLINE_FIXTURE' | 'SDK_INTEGRATION' | 'REAL_TESTNET', { readonly label: string; readonly plain: string }> = {
  OFFLINE_FIXTURE: { label: 'Offline fixture', plain: 'Deterministic test data with test-only keys; proves the formats and the arithmetic, not a payment.' },
  SDK_INTEGRATION: { label: 'Real code, simulated ledger', plain: 'Real meter, fleet and station code and real Stellar MPP SDK signatures; only the ledger is simulated offline.' },
  REAL_TESTNET: { label: 'Real Stellar Testnet', plain: 'Signed and settled on the public Stellar Testnet with test USDC; anyone can look it up.' },
};

/** Stable reason codes from all modules, in plain words. Unknown codes fall back to the code itself. */
const REASONS: Record<string, string> = {
  CHECK_PASSED: 'Check passed.',
  ALL_CHECKS_PASSED: 'All eight checks passed.',
  INVALID_METER_SIGNATURE: 'The reading no longer matches the meter signature: someone changed the data after the meter signed it.',
  UNKNOWN_METER_KEY: 'The reading was signed by a key that is not the registered meter.',
  SIGNED_PAYLOAD_MISMATCH: 'The reading shown differs from what the meter actually signed.',
  COUNTER_DISCONTINUITY: 'The meter counter has a gap or jump between readings.',
  DUPLICATE_READING: 'The same reading was sent twice; it is never paid twice.',
  REPLAY_NONCE: 'A receipt number was reused; replays are refused.',
  BUDGET_EXCEEDED: 'Paying this reading would exceed the fleet budget, so the fleet refused to sign.',
  TARIFF_DIGEST_MISMATCH: 'The price list differs from the one the fleet agreed to.',
  TARIFF_NOT_ACTIVE: 'The reading falls outside the price list validity window.',
  ASSET_MISMATCH: 'The payment asset is not the agreed USDC.',
  CHARGE_REPLAY_MISMATCH: 'Re-pricing the energy does not give the billed amount.',
  SESSION_MISMATCH: 'The evidence belongs to another charging session.',
  EVIDENCE_DIGEST_MISMATCH: 'An evidence fingerprint does not match its content.',
  NON_MONOTONIC_CUMULATIVE: 'A running total went down or stayed flat.',
  NATIVE_COMMITMENT_INVALID: 'A payment voucher signature is not valid for that channel and amount.',
  INVALID_NATIVE_SIGNATURE: 'A payment voucher signature is not valid for that channel and amount.',
  PAYER_ACK_INVALID: 'The fleet receipt does not bind this voucher to this exact reading.',
  INVALID_PAYER_ACK: 'The fleet receipt does not bind this voucher to this exact reading, so the station refused it.',
  E0_DIGEST_MISMATCH: 'The evidence package was modified after it was sealed.',
  CHAIN_MISMATCH: 'The ledger contradicts the claim: wrong transaction, amount, recipient or channel.',
  SETTLEMENT_FAILED: 'The ledger shows the settlement transaction failed.',
  RPC_UNAVAILABLE: 'The Stellar network could not be reached, so the payment cannot be confirmed right now.',
  SETTLEMENT_NOT_PROVABLE: 'The ledger has no record of this transaction, so the payment cannot be proven.',
  CHAIN_NOT_QUERIED: 'The ledger was not queried (offline mode), so the payment is not confirmed.',
  PRECONDITION_FAILED: 'Not checked, because the evidence package itself is malformed.',
  INVALID_SCHEMA: 'The evidence package is malformed or carries unexpected fields.',
  PAYMENT_OUTCOME_UNKNOWN: 'The station answer was lost after the voucher was sent; nothing is counted as paid until the station receipt confirms it.',
  PAYMENT_NOT_ACCEPTED: 'The station did not accept the voucher.',
  SETTLEMENT_PENDING: 'The close outcome is unknown; it is not reported as paid and is never retried blindly.',
  CHANNEL_NOT_PINNED: 'The payment request names a channel the fleet did not agree to.',
};

export function explainReason(code: string | undefined): string {
  if (code === undefined) return '';
  return REASONS[code] ?? code;
}

/** One line of the G1/G2 Testnet runner trace (`trace.jsonl`). */
export interface TraceEvent {
  readonly seq: number;
  readonly at: string;
  readonly side: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

const str = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
};
const amount = (value: unknown): string => (/^\d+$/.test(str(value)) ? formatAmount(str(value)) : str(value));

function technical(event: string, data: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries([['event', event], ...keys.filter((key) => data[key] !== undefined).map((key) => [key, str(data[key])])]);
}

/** Which ledger a story describes: the real Stellar Testnet, or the offline stand-in of the SDK_INTEGRATION scenarios. */
export type LedgerKind = 'TESTNET' | 'SIMULATED';

/**
 * Plain-language view of one runner or module event, or `null` for bookkeeping that adds nothing for a reader
 * (runner self-checks other than observed balances, start/end markers, duplicate acknowledgements). Explorer links
 * are attached only for the real Testnet ledger.
 */
export function explainEvent(event: string, data: Record<string, unknown>, options: { at?: string; ledger?: LedgerKind } = {}): StoryEvent | null {
  const { at } = options;
  const testnet = (options.ledger ?? 'TESTNET') === 'TESTNET';
  const ledgerName = testnet ? 'Stellar Testnet' : 'the simulated ledger (offline)';
  const make = (actor: Actor, layer: Layer, status: StoryStatus, title: string, detail: string, keys: readonly string[], links?: StoryEvent['links']): StoryEvent => ({
    actor,
    layer,
    status,
    title,
    detail,
    technical: technical(event, data, keys),
    ...(links === undefined ? {} : { links }),
    ...(at === undefined ? {} : { at }),
  });
  const seq = str(data['sequence']);
  switch (event) {
    case 'read.channel-state':
      return make('stellar', 'ON_CHAIN', 'OK', `Payment channel holds ${amount(str(data['balance']))}`,
        `Read from ${ledgerName}: the fleet locked this deposit in a payment channel that can only pay station ${short(str(data['to']))}, in USDC. The fleet signs vouchers against it off-chain.`,
        ['balance', 'to', 'from', 'token']);
    case 'trust.pinned':
      return make('auditor', 'OFF_CHAIN', 'INFO', 'Trust inputs published before charging',
        `The channel ${short(str(data['channelId']))}, station ${short(str(data['recipient']))} and meter key ${short(str(data['meterKey']))} are fixed before anything is signed; the auditor checks against these, never against the evidence itself.`,
        ['file', 'channelId', 'recipient', 'meterKey']);
    case 'meter.key':
      return make('meter', 'OFF_CHAIN', 'INFO', 'Meter identity registered',
        `Meter key ${short(str(data['publicKey']))} is pinned before charging starts. Simulated meter; the key exists only for this run.`, ['keyId', 'publicKey']);
    case 'metering.accepted':
      return make('meter', 'OFF_CHAIN', 'OK', `Reading ${str(data['readingId'])} signed and validated`,
        `The signature over the original meter bytes checks out. Running total for the session: ${amount(data['cumulative'])}.`, ['readingId', 'cumulative', 'evidenceDigest']);
    case 'metering.rejected':
      return make('meter', 'OFF_CHAIN', 'REJECTED', `Reading ${str(data['readingId'])} refused`, explainReason(str(data['reasonCode'])), ['readingId', 'reasonCode']);
    case 'payer.policy.approved':
      return make('fleet', 'OFF_CHAIN', 'OK', `Fleet approves reading ${str(data['readingId'])}`,
        `Tariff, meter signature and budget all check out, so the fleet is willing to owe ${amount(data['cumulative'])} in total.`, ['sequence', 'readingId', 'cumulative']);
    case 'payee.challenge.issued':
      return make('station', 'OFF_CHAIN', 'INFO', `Station asks for the next ${amount(data['amount'])}`,
        'HTTP 402 "payment required" challenge, in the Stellar MPP channel format.', ['sequence', 'amount']);
    case 'payer.challenge.checked':
      return make('fleet', 'OFF_CHAIN', 'OK', 'Fleet checks the payment request',
        `The request names the fleet's own channel ${short(str(data['channel']))} and exactly the approved amount.`, ['sequence', 'amount', 'channel']);
    case 'payer.native.signed':
      return make('fleet', 'OFF_CHAIN', 'OK', `Fleet signs voucher #${seq} for ${amount(data['cumulative'])} total`,
        'A Stellar MPP channel commitment. It is not sent to the ledger now: only the highest voucher is ever submitted, once, at close.',
        ['sequence', 'cumulative', 'commitmentDigest', 'signatureB64']);
    case 'payer.ack.signed':
      return make('fleet', 'OFF_CHAIN', 'OK', `Fleet signs receipt #${seq}`,
        'A separate signature that ties this voucher to the exact meter reading, so the payment cannot be reused for other data.',
        ['sequence', 'nonce', 'evidenceDigest', 'commitmentDigest']);
    case 'payee.preflight.verified':
      return make('station', 'OFF_CHAIN', 'OK', `Station checks receipt #${seq}`, 'The receipt matches the exact reading, voucher, channel and network.', ['sequence', 'commitmentDigest', 'nonce']);
    case 'payee.preflight.refused':
      return make('station', 'OFF_CHAIN', 'REJECTED', `Station refuses voucher #${seq}`, explainReason(str(data['code'] ?? data['reasonCode'])), ['sequence', 'code', 'reasonCode', 'details']);
    case 'payee.sdk.refused':
      return make('station', 'OFF_CHAIN', 'REJECTED', `Station SDK refuses voucher #${seq}`, explainReason('PAYMENT_NOT_ACCEPTED'), ['sequence', 'amount']);
    case 'payee.accepted':
      return make('station', 'OFF_CHAIN', 'OK', `Station accepts voucher #${seq}`, `The station is now owed ${amount(data['cumulative'])} in total.`, ['sequence', 'cumulative', 'storedCumulative']);
    case 'payer.rejected':
      return make('fleet', 'OFF_CHAIN', 'REJECTED', str(data['details']).startsWith('payee refused') ? 'Fleet records the station refusal' : 'Fleet refuses to pay',
        explainReason(str(data['reasonCode'])), ['reasonCode', 'details']);
    case 'payer.pending':
      return make('fleet', 'OFF_CHAIN', 'PENDING', `Voucher #${seq} outcome unknown`, explainReason('PAYMENT_OUTCOME_UNKNOWN'), ['sequence', 'details']);
    case 'payer.e0.finalized':
      return make('fleet', 'OFF_CHAIN', 'OK', 'Evidence package sealed (E0)',
        `All ${str(data['increments'])} approved readings, vouchers and receipts are frozen before any payment touches the ledger.`, ['increments', 'highest']);
    case 'e0.written':
      return make('fleet', 'OFF_CHAIN', 'INFO', 'E0 fingerprint recorded', `SHA-256 ${short(str(data['e0Digest']), 10, 6)}. Any later edit changes this fingerprint.`, ['e0Digest', 'increments']);
    case 'settlement.close.submitting':
      return make('station', 'ON_CHAIN', 'INFO', `Station submits one close for ${amount(data['amount'])}`,
        'A single Stellar transaction carries the highest voucher. The channel contract checks the fleet signature itself.', ['amount', 'commitmentDigest', 'e0Digest']);
    case 'settlement.close.submitted':
      return make('stellar', 'ON_CHAIN', 'INFO', `Close transaction sent to ${ledgerName}`, `Transaction ${short(str(data['txHash']), 10, 6)}.`, ['txHash'],
        testnet && typeof data['txHash'] === 'string' ? [{ label: 'View transaction on stellar.expert', url: explorerLinks.tx(data['txHash']) }] : undefined);
    case 'settlement.observed': {
      const ok = data['txStatus'] === 'SUCCESS';
      return make('stellar', 'ON_CHAIN', ok ? 'OK' : data['txStatus'] === 'FAILED' ? 'REJECTED' : 'PENDING',
        ok ? `Ledger confirms: station paid ${amount(data['settled'])}` : `Ledger reports ${str(data['txStatus'])}`,
        ok ? `Read back from ${ledgerName} after the close, not assumed from the submission.` : explainReason(data['txStatus'] === 'FAILED' ? 'SETTLEMENT_FAILED' : 'SETTLEMENT_NOT_PROVABLE'),
        ['txHash', 'txStatus', 'settled']);
    }
    case 'settlement.pending':
      return make('station', 'ON_CHAIN', 'PENDING', 'Close outcome unknown', explainReason(str(data['reasonCode'])), ['txHash', 'reasonCode']);
    case 'settlement.result': {
      const e1 = (data['e1'] ?? {}) as Record<string, unknown>;
      if (data['kind'] !== 'OBSERVED') return null;
      return make('station', 'OFF_CHAIN', 'OK', 'Settlement record written (E1)',
        `Points to the sealed package (${short(str(e1['e0Digest']), 10, 6)}) and to the observed transaction. Nothing in it is trusted without re-checking.`, ['kind']);
    }
    case 'check': {
      const id = str(data['id']);
      if (!id.startsWith('S1-BALANCE-')) return null;
      const recipient = id === 'S1-BALANCE-RECIPIENT';
      return make('stellar', 'ON_CHAIN', data['status'] === 'PASS' ? 'OK' : 'REJECTED',
        recipient ? 'Station wallet balance went up' : 'Unused deposit returned to the fleet',
        `${str(data['detail'])} (read from Horizon after the close).`, ['id', 'status', 'detail']);
    }
    default:
      return null;
  }
}

/** Narrates a runner trace in order, dropping bookkeeping events. */
export function explainTrace(trace: readonly TraceEvent[]): StoryEvent[] {
  return trace.flatMap((entry) => {
    const story = explainEvent(entry.event, entry.data, { at: entry.at, ledger: 'TESTNET' });
    return story === null ? [] : [story];
  });
}
