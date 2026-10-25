import { Mppx, stellar } from '@stellar/mpp/channel/client';
import type { Keypair } from '@stellar/stellar-sdk';
import { Challenge, Credential, Store } from 'mppx';
import {
  AuthorizedIncrementSchema,
  generateAckNonce,
  type AuthorizedIncrement,
  type EvidenceE0,
  type NativeCommitment,
  type PayerEvidenceAck,
  type TariffSnapshot,
} from '@usagepay/contracts';
import { checkPayerAck, signPayerAck } from './ack.js';
import { PAYER_REFUSAL_CODES, type PayerRefusalCode } from './codes.js';
import { checkNativeCommitment, nativeCommitmentRecord, xdrCommitmentEncoding, type CommitmentEncoding } from './commitment.js';
import { createIncrementLedger, type IncrementLedger } from './ledger.js';
import { evaluateCandidate, type ChannelFacts, type PayerTrust } from './policy.js';
import type { AuthorizeResult, PayerAuthorizationPort } from './ports.js';
import { createStateMachine, type SettlementState } from './state.js';
import { ACK_HEADER, encodeAckHeader, incrementPath } from './transport.js';

export type SettlementEvent = (event: string, data: Record<string, unknown>) => void;

export interface PayerConfig {
  readonly trust: PayerTrust;
  /** The pinned tariff snapshot recorded in E0. */
  readonly tariff: TariffSnapshot;
  /** Channel commitment key. It signs native commitments (inside the SDK) and payer acks; it never leaves the payer. */
  readonly commitmentKey: Keypair;
  readonly payeeUrl: string;
  /** On-chain channel facts read before the first increment; enables the deposit check. */
  readonly channel?: ChannelFacts;
  readonly fetch?: (request: Request) => Promise<Response>;
  /** Soroban RPC used by the SDK for the read-only `prepare_commitment` simulation (default: SDK Testnet RPC). */
  readonly rpcUrl?: string;
  readonly encoding?: CommitmentEncoding;
  readonly nonce?: () => string;
  readonly onEvent?: SettlementEvent;
}

export interface Payer extends PayerAuthorizationPort {
  readonly state: SettlementState;
  readonly ledger: IncrementLedger;
  /** Reads back a PENDING increment from the payee instead of signing a larger amount. */
  reconcile(): Promise<AuthorizeResult>;
  finalizeE0(finalizedAt: string): EvidenceE0;
}

interface PendingIncrement {
  readonly increment: AuthorizedIncrement;
  readonly url: string;
}

/**
 * Fleet-side SPEC 02 role. Every policy check runs before the SDK's `createCredential` signs (G1 D5): the SDK
 * signs inside that call, so after it only the evidence binding remains to protect, not the payer's funds.
 */
export function createPayer(config: PayerConfig): Payer {
  const { trust, commitmentKey } = config;
  if (commitmentKey.publicKey() !== trust.payerAccountId) throw new Error('commitmentKey does not match trust.payerAccountId');
  const send = config.fetch ?? ((request: Request) => fetch(request));
  const encoding = config.encoding ?? xdrCommitmentEncoding;
  const nextNonce = config.nonce ?? (() => generateAckNonce());
  const emit: SettlementEvent = config.onEvent ?? (() => undefined);
  const machine = createStateMachine();
  const ledger = createIncrementLedger({ sessionId: trust.sessionId, tariff: config.tariff });
  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      stellar.channel({
        commitmentKey,
        allowedChannels: [trust.channelId],
        network: trust.network,
        store: Store.memory(),
        ...(config.rpcUrl === undefined ? {} : { rpcUrl: config.rpcUrl }),
      }),
    ],
  });
  let pending: PendingIncrement | undefined;

  function rejected(reasonCode: PayerRefusalCode, details: string): AuthorizeResult {
    machine.transition('REJECTED');
    machine.transition('READY');
    emit('payer.rejected', { reasonCode, details });
    return { kind: 'REJECTED', reasonCode, details };
  }

  function accepted(increment: AuthorizedIncrement): AuthorizeResult {
    ledger.append(increment);
    machine.transition('ACCEPTED');
    machine.transition('READY');
    emit('payer.accepted', { sequence: increment.sequence, cumulative: increment.commitment.cumulativeAmountBaseUnits });
    return { kind: 'AUTHORIZED', increment };
  }

  async function authorize(input: Parameters<PayerAuthorizationPort['authorize']>[0]): Promise<AuthorizeResult> {
    if (machine.finalized) return { kind: 'REJECTED', reasonCode: 'E0_ALREADY_FINALIZED', details: 'E0 is finalized; no further increments' };
    if (pending !== undefined) {
      return { kind: 'PENDING', reasonCode: 'PAYMENT_OUTCOME_UNKNOWN', details: 'reconcile the pending increment before authorizing another' };
    }
    const decision = evaluateCandidate(trust, ledger.increments(), input, config.channel);
    if (!decision.approved) return rejected(decision.refusal.code, decision.refusal.details);
    const sequence = ledger.increments().length + 1;
    const url = config.payeeUrl + incrementPath(trust.sessionId, sequence);
    emit('payer.policy.approved', { sequence, readingId: input.reading.readingId, cumulative: decision.cumulative, evidenceDigest: input.charge.evidenceDigest });

    let probe: Response;
    try {
      probe = await send(new Request(url, { method: 'POST' }));
    } catch (error) {
      return rejected('RPC_UNAVAILABLE', `payee unreachable before any signature: ${message(error)}`);
    }
    if (probe.status !== 402) return rejected('PAYMENT_NOT_ACCEPTED', `expected a 402 MPP challenge, got HTTP ${probe.status}`);
    let request: { amount: string; channel: string; methodDetails?: { network?: string } };
    try {
      request = Challenge.fromResponse(probe).request as typeof request;
    } catch (error) {
      return rejected('INVALID_NATIVE_CREDENTIAL', `402 carries no valid MPP challenge: ${message(error)}`);
    }
    machine.transition('CHALLENGED');
    if (request.channel !== trust.channelId) return rejected('CHANNEL_NOT_PINNED', `challenge names channel ${request.channel}`);
    if (request.methodDetails?.network !== trust.network) return rejected('NETWORK_MISMATCH', `challenge network ${String(request.methodDetails?.network)}`);
    if (request.amount !== decision.delta.toString()) {
      return rejected('CHARGE_MISMATCH', `challenge amount ${request.amount} is not the approved delta ${decision.delta}`);
    }
    emit('payer.challenge.checked', { sequence, amount: request.amount, channel: request.channel });

    let authorization: string;
    try {
      authorization = await mppx.createCredential(probe, { cumulativeAmount: decision.cumulative.toString() });
    } catch (error) {
      // The SDK simulates and checks the commitment before it signs, so a failure here signed nothing.
      const why = message(error);
      return rejected(/network|timed out|ECONN|fetch failed/i.test(why) ? 'RPC_UNAVAILABLE' : 'INVALID_NATIVE_CREDENTIAL', why);
    }
    let commitment: NativeCommitment;
    try {
      const credential = Credential.fromRequest<{ amount: string; signature: string }>(new Request(url, { headers: { Authorization: authorization } }));
      commitment = nativeCommitmentRecord({
        channelId: trust.channelId,
        amount: BigInt(credential.payload.amount),
        message: encoding(trust.channelId, BigInt(credential.payload.amount)),
        signatureHex: credential.payload.signature,
        commitmentKey: trust.payerAccountId,
      });
    } catch (error) {
      return rejected('SDK_CAPTURE_UNAVAILABLE', `native credential could not be captured: ${message(error)}`);
    }
    machine.transition('NATIVE_SIGNED');
    const nativeRefusal = checkNativeCommitment({
      commitment,
      channelId: trust.channelId,
      commitmentKey: trust.payerAccountId,
      expectedCumulative: decision.cumulative,
      encoding,
    });
    if (nativeRefusal !== null) return rejected(nativeRefusal.code, nativeRefusal.details);
    emit('payer.native.signed', { sequence, cumulative: commitment.cumulativeAmountBaseUnits, commitmentDigest: commitment.commitmentDigest, signatureB64: commitment.signatureB64 });

    const ack: PayerEvidenceAck = signPayerAck({
      sessionId: trust.sessionId,
      charge: input.charge,
      commitment,
      payerAccountId: trust.payerAccountId,
      nonce: nextNonce(),
      sign: (bytes) => commitmentKey.sign(Buffer.from(bytes)),
    });
    const ackRefusal = checkPayerAck({
      ack,
      sessionId: trust.sessionId,
      channelId: trust.channelId,
      payerAccountId: trust.payerAccountId,
      charge: input.charge,
      commitment,
      usedNonces: ledger.usedNonces(),
    });
    if (ackRefusal !== null) return rejected(ackRefusal.code, ackRefusal.details);
    machine.transition('ACK_SIGNED');
    emit('payer.ack.signed', { sequence, nonce: ack.nonce, evidenceDigest: ack.evidenceDigest, commitmentDigest: ack.commitmentDigest });

    const increment = AuthorizedIncrementSchema.parse({ schema: 'usagepay.increment.v1', sequence, reading: input.reading, charge: input.charge, commitment, payerAck: ack });
    let response: Response;
    try {
      response = await send(new Request(url, { method: 'POST', headers: { Authorization: authorization, [ACK_HEADER]: encodeAckHeader(ack) } }));
    } catch (error) {
      return markPending(increment, url, `credential sent, outcome unknown: ${message(error)}`);
    }
    const body = (await response.json().catch(() => null)) as { code?: unknown; details?: unknown; commitmentDigest?: unknown } | null;
    if (response.status === 200 && body?.commitmentDigest === commitment.commitmentDigest) return accepted(increment);
    if (response.status === 409 && isRefusalCode(body?.code)) return rejected(body.code, `payee refused before SDK acceptance: ${String(body.details)}`);
    if (response.status === 402) return rejected('PAYMENT_NOT_ACCEPTED', 'the SDK did not accept the native credential');
    return markPending(increment, url, `unexpected payee answer HTTP ${response.status}`);
  }

  function markPending(increment: AuthorizedIncrement, url: string, details: string): AuthorizeResult {
    machine.transition('PENDING');
    pending = { increment, url };
    emit('payer.pending', { sequence: increment.sequence, details });
    return { kind: 'PENDING', reasonCode: 'PAYMENT_OUTCOME_UNKNOWN', details };
  }

  async function reconcile(): Promise<AuthorizeResult> {
    if (pending === undefined) return { kind: 'REJECTED', reasonCode: 'PAYMENT_NOT_ACCEPTED', details: 'nothing to reconcile' };
    let response: Response;
    try {
      response = await send(new Request(`${pending.url}/receipt`));
    } catch (error) {
      return { kind: 'PENDING', reasonCode: 'PAYMENT_OUTCOME_UNKNOWN', details: `payee still unreachable: ${message(error)}` };
    }
    const body = (await response.json().catch(() => null)) as { commitmentDigest?: unknown } | null;
    const { increment } = pending;
    if (response.status === 200 && body?.commitmentDigest === increment.commitment.commitmentDigest) {
      pending = undefined;
      return accepted(increment);
    }
    if (response.status === 404) {
      pending = undefined;
      return rejected('PAYMENT_NOT_ACCEPTED', 'payee has no receipt for the pending increment');
    }
    return { kind: 'PENDING', reasonCode: 'PAYMENT_OUTCOME_UNKNOWN', details: `payee receipt answer HTTP ${response.status}` };
  }

  return {
    authorize,
    reconcile,
    ledger,
    get state() {
      return machine.state;
    },
    finalizeE0(finalizedAt) {
      if (pending !== undefined) throw new Error('cannot finalize E0 while an increment is PENDING');
      machine.transition('E0_FINALIZED');
      const e0 = ledger.finalizeE0(finalizedAt);
      emit('payer.e0.finalized', { increments: e0.increments.length, highest: ledger.highest()?.commitment.cumulativeAmountBaseUnits });
      return e0;
    },
  };
}

function isRefusalCode(value: unknown): value is PayerRefusalCode {
  return typeof value === 'string' && (PAYER_REFUSAL_CODES as readonly string[]).includes(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
