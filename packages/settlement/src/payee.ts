import { randomBytes } from 'node:crypto';
import { fromBaseUnits } from '@stellar/mpp';
import { Mppx, Store, stellar } from '@stellar/mpp/channel/server';
import { Credential } from 'mppx';
import {
  AuthorizedIncrementSchema,
  type AuthorizedIncrement,
  type MeasurementCharge,
  type MeterReading,
  type NativeCommitment,
} from '@usagepay/contracts';
import { checkPayerAck } from './ack.js';
import { refusal, type Refusal } from './codes.js';
import { checkNativeCommitment, nativeCommitmentRecord, xdrCommitmentEncoding, type CommitmentEncoding } from './commitment.js';
import type { SettlementEvent } from './payer.js';
import { ACK_HEADER, decodeAckHeader, type RequestHandler } from './transport.js';

export interface PayeeEvidence {
  readonly reading: MeterReading;
  readonly charge: MeasurementCharge;
}

export interface PayeeConfig {
  readonly channelId: string;
  readonly sessionId: string;
  /** Commitment public key pinned for this channel. The payee never holds the payer's secret. */
  readonly commitmentKey: string;
  readonly recipient: string;
  readonly assetSac: string;
  /** Accepted SPEC 01 evidence for an increment sequence (1-based), if the CPO has it. */
  readonly evidence: (sequence: number) => PayeeEvidence | undefined;
  readonly decimals?: number;
  readonly rpcUrl?: string;
  readonly realm?: string;
  readonly encoding?: CommitmentEncoding;
  readonly onEvent?: SettlementEvent;
}

export interface Payee {
  readonly handle: RequestHandler;
  accepted(): readonly AuthorizedIncrement[];
  highestAccepted(): AuthorizedIncrement | undefined;
  /** Cumulative amount the SDK's own store holds for the channel. */
  storedCumulative(): Promise<string>;
}

type ChannelPayload = { action?: 'voucher' | 'close'; amount: string; signature: string };

/**
 * CPO-side SPEC 02 role. The application preflight verifies the native commitment and the payer evidence ack
 * before the unchanged credential reaches the SDK's normal verification (signature, replay, monotonicity,
 * on-chain state, recipient and currency). Only when both pass is the increment recorded as accepted.
 */
export function createPayee(config: PayeeConfig): Payee {
  const encoding = config.encoding ?? xdrCommitmentEncoding;
  const emit: SettlementEvent = config.onEvent ?? (() => undefined);
  const decimals = config.decimals ?? 7;
  const store = Store.memory();
  const accepted: AuthorizedIncrement[] = [];
  const mppx = Mppx.create({
    secretKey: randomBytes(32).toString('hex'),
    realm: config.realm ?? 'upay-payee',
    methods: [
      stellar.channel({
        channel: config.channelId,
        commitmentKey: config.commitmentKey,
        store,
        network: 'stellar:testnet',
        recipient: config.recipient,
        currency: config.assetSac,
        checkOnChainState: true,
        ...(config.rpcUrl === undefined ? {} : { rpcUrl: config.rpcUrl }),
      }),
    ],
  });

  function preflight(request: Request, sequence: number, evidence: PayeeEvidence): { commitment: NativeCommitment; ack: AuthorizedIncrement['payerAck'] } | Refusal {
    if (sequence !== accepted.length + 1) return refusal('CUMULATIVE_NOT_MONOTONIC', `next increment is ${accepted.length + 1}, not ${sequence}`);
    let payload: ChannelPayload;
    let commitment: NativeCommitment;
    try {
      payload = Credential.fromRequest<ChannelPayload>(request).payload;
      commitment = nativeCommitmentRecord({
        channelId: config.channelId,
        amount: BigInt(payload.amount),
        message: encoding(config.channelId, BigInt(payload.amount)),
        signatureHex: payload.signature,
        commitmentKey: config.commitmentKey,
      });
    } catch (error) {
      return refusal('INVALID_NATIVE_CREDENTIAL', `credential is not a channel voucher: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (payload.action === 'close') return refusal('INVALID_NATIVE_CREDENTIAL', 'increments accept vouchers only');
    const native = checkNativeCommitment({
      commitment,
      channelId: config.channelId,
      commitmentKey: config.commitmentKey,
      expectedCumulative: BigInt(evidence.charge.cumulativeChargeBaseUnits),
      encoding,
    });
    if (native !== null) return native;
    const header = request.headers.get(ACK_HEADER);
    if (header === null) return refusal('INVALID_PAYER_ACK', `${ACK_HEADER} is required with every channel credential`);
    let ack: unknown;
    try {
      ack = decodeAckHeader(header);
    } catch {
      return refusal('INVALID_PAYER_ACK', 'ack header is not base64url JSON');
    }
    const ackRefusal = checkPayerAck({
      ack,
      sessionId: config.sessionId,
      channelId: config.channelId,
      payerAccountId: config.commitmentKey,
      charge: evidence.charge,
      commitment,
      usedNonces: new Set(accepted.map((a) => a.payerAck.nonce)),
    });
    if (ackRefusal !== null) return ackRefusal;
    return { commitment, ack: ack as AuthorizedIncrement['payerAck'] };
  }

  async function paid(request: Request, sequence: number): Promise<Response> {
    const evidence = config.evidence(sequence);
    if (evidence === undefined) return Response.json({ code: 'UNKNOWN_INCREMENT' }, { status: 404 });
    const charge = mppx.channel({
      amount: fromBaseUnits(evidence.charge.deltaChargeBaseUnits, decimals),
      description: `upay increment ${sequence}`,
    });
    let prepared: { commitment: NativeCommitment; ack: AuthorizedIncrement['payerAck'] } | undefined;
    if (request.headers.has('authorization')) {
      const checked = preflight(request, sequence, evidence);
      if ('code' in checked) {
        emit('payee.preflight.refused', { sequence, code: checked.code, details: checked.details, storedCumulative: await storedCumulative() });
        return Response.json(checked, { status: 409 });
      }
      emit('payee.preflight.verified', { sequence, commitmentDigest: checked.commitment.commitmentDigest, nonce: checked.ack.nonce });
      prepared = checked;
    }
    const result = await charge(request);
    if (result.status === 402) {
      emit(prepared ? 'payee.sdk.refused' : 'payee.challenge.issued', { sequence, amount: evidence.charge.deltaChargeBaseUnits });
      return result.challenge;
    }
    if (prepared === undefined) throw new Error('the SDK accepted a request that skipped the payer ack preflight');
    const increment = AuthorizedIncrementSchema.parse({
      schema: 'usagepay.increment.v1',
      sequence,
      reading: evidence.reading,
      charge: evidence.charge,
      commitment: prepared.commitment,
      payerAck: prepared.ack,
    });
    accepted.push(increment);
    emit('payee.accepted', { sequence, cumulative: increment.commitment.cumulativeAmountBaseUnits, storedCumulative: await storedCumulative() });
    return result.withReceipt(Response.json({ sequence, accepted: increment.commitment.cumulativeAmountBaseUnits, commitmentDigest: increment.commitment.commitmentDigest }));
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/sessions\/([^/]+)\/increments\/(\d+)(\/evidence|\/receipt)?$/.exec(url.pathname);
    if (match === null || decodeURIComponent(match[1] ?? '') !== config.sessionId) return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    const sequence = Number(match[2]);
    if (match[3] === '/evidence' && request.method === 'GET') {
      const evidence = config.evidence(sequence);
      return evidence === undefined ? Response.json({ code: 'UNKNOWN_INCREMENT' }, { status: 404 }) : Response.json(evidence);
    }
    if (match[3] === '/receipt' && request.method === 'GET') {
      const increment = accepted.find((a) => a.sequence === sequence);
      return increment === undefined
        ? Response.json({ code: 'NO_RECEIPT' }, { status: 404 })
        : Response.json({ sequence, commitmentDigest: increment.commitment.commitmentDigest });
    }
    if (match[3] === undefined && request.method === 'POST') return paid(request, sequence);
    return Response.json({ code: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }

  async function storedCumulative(): Promise<string> {
    const record = (await store.get(`stellar:channel:cumulative:${config.channelId}`)) as { amount?: string } | null;
    return record?.amount ?? '0';
  }

  return {
    handle,
    accepted: () => [...accepted],
    highestAccepted: () => accepted.at(-1),
    storedCumulative,
  };
}
