import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fromBaseUnits } from '@stellar/mpp';
import { Mppx, Store, close, stellar } from '@stellar/mpp/channel/server';
import { Keypair } from '@stellar/stellar-sdk';
import { Credential } from 'mppx';
import {
  NETWORK,
  PayerEvidenceAckSchema,
  verifyPayerAckSignature,
  type MeasurementCharge,
  type MeterReading,
  type NativeCommitment,
  type PayerEvidenceAck,
} from '@usagepay/contracts';
import { nativeCommitmentRecord, rpcServer, simulatePrepareCommitment } from './chain.ts';
import type { Trace } from './trace.ts';

export const ACK_HEADER = 'x-upay-payer-ack';
const DECIMALS = 7;

export interface PayeeConfig {
  readonly channel: string;
  readonly token: string;
  readonly recipient: string;
  /** Recipient secret: signs only the close transaction envelope (`to.require_auth()`). */
  readonly recipientSecret: string;
  /** Commitment public key pinned for this channel; the payee never holds its secret. */
  readonly commitmentKey: string;
  readonly sessionId: string;
  readonly increments: readonly { readonly reading: MeterReading; readonly charge: MeasurementCharge }[];
  readonly trace: Trace;
}

export interface AcceptedIncrement {
  readonly sequence: number;
  readonly commitment: NativeCommitment;
  readonly ack: PayerEvidenceAck;
  readonly credentialAuthorization: string;
}

type ChannelPayload = { action?: 'voucher' | 'close'; amount: string; signature: string };
type AckRejection = { code: string; detail: string };

export interface Payee {
  readonly url: string;
  readonly accepted: readonly AcceptedIncrement[];
  storedCumulative(): Promise<string>;
  closeWithHighestCommitment(): Promise<{ txHash: string; amount: string }>;
  stop(): Promise<void>;
}

export async function startPayee(config: PayeeConfig): Promise<Payee> {
  const { channel, trace } = config;
  const server = rpcServer();
  const store = Store.memory();
  const accepted: AcceptedIncrement[] = [];
  const usedNonces = new Set<string>();
  const mppx = Mppx.create({
    secretKey: randomBytes(32).toString('hex'),
    realm: 'upay-g1',
    methods: [
      stellar.channel({
        channel,
        commitmentKey: config.commitmentKey,
        store,
        network: 'stellar:testnet',
        recipient: config.recipient,
        currency: config.token,
        checkOnChainState: true,
      }),
    ],
  });

  async function preflightAck(request: Request, sequence: number, payload: ChannelPayload): Promise<
    { ok: true; ack: PayerEvidenceAck; commitment: NativeCommitment } | { ok: false; rejection: AckRejection }
  > {
    const reject = (code: string, detail: string) => ({ ok: false as const, rejection: { code, detail } });
    const increment = config.increments[sequence - 1];
    if (increment === undefined) return reject('UNKNOWN_INCREMENT', `no evidence for increment ${sequence}`);
    const header = request.headers.get(ACK_HEADER);
    if (header === null) return reject('ACK_MISSING', `${ACK_HEADER} header is required with every channel credential`);
    let parsed: ReturnType<typeof PayerEvidenceAckSchema.safeParse>;
    try {
      parsed = PayerEvidenceAckSchema.safeParse(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')));
    } catch {
      return reject('ACK_MALFORMED', 'ack header is not base64url JSON');
    }
    if (!parsed.success) return reject('ACK_MALFORMED', parsed.error.message);
    const ack = parsed.data;
    if (ack.payerKey !== config.commitmentKey) return reject('ACK_PAYER_KEY_MISMATCH', 'payerKey is not the pinned commitment key');
    if (!verifyPayerAckSignature(ack)) return reject('ACK_SIGNATURE_INVALID', 'ack signature does not verify under payerKey');
    if (ack.network !== NETWORK || ack.channelId !== channel || ack.sessionId !== config.sessionId) {
      return reject('ACK_BINDING_MISMATCH', 'ack network, channel or session differs from this payee');
    }
    if (ack.evidenceDigest !== increment.charge.evidenceDigest) {
      return reject('ACK_EVIDENCE_MISMATCH', 'ack evidenceDigest is not the evidence served for this increment');
    }
    if (payload.amount !== increment.charge.cumulativeChargeBaseUnits || ack.approvedCumulativeBaseUnits !== payload.amount) {
      return reject('ACK_AMOUNT_MISMATCH', 'credential amount, ack amount and evidence cumulative charge differ');
    }
    if (usedNonces.has(ack.nonce)) return reject('ACK_NONCE_REUSED', 'ack nonce was already accepted');
    const message = await simulatePrepareCommitment(server, channel, BigInt(payload.amount));
    const commitment = nativeCommitmentRecord({
      channel,
      amount: BigInt(payload.amount),
      message,
      signatureHex: payload.signature,
      commitmentKey: config.commitmentKey,
    });
    if (ack.commitmentDigest !== commitment.commitmentDigest) {
      return reject('ACK_COMMITMENT_MISMATCH', 'ack commitmentDigest does not bind this native credential');
    }
    return { ok: true, ack, commitment };
  }

  async function handlePaid(request: Request, sequence: number): Promise<Response> {
    const increment = config.increments[sequence - 1];
    if (increment === undefined) return Response.json({ code: 'UNKNOWN_INCREMENT' }, { status: 404 });
    const charge = mppx.channel({
      amount: fromBaseUnits(increment.charge.deltaChargeBaseUnits, DECIMALS),
      description: `upay increment ${sequence}`,
    });
    let prepared: { ack: PayerEvidenceAck; commitment: NativeCommitment } | undefined;
    if (request.headers.has('authorization')) {
      const credential = Credential.fromRequest<ChannelPayload>(request);
      trace.emit('payee', 'credential.received', {
        sequence,
        action: credential.payload.action ?? 'voucher',
        amount: credential.payload.amount,
        signature: credential.payload.signature,
        challengeId: credential.challenge.id,
      });
      const preflight = await preflightAck(request, sequence, credential.payload);
      if (!preflight.ok) {
        trace.emit('payee', 'ack.rejected', { sequence, ...preflight.rejection, storedCumulative: await storedCumulative() });
        return Response.json(preflight.rejection, { status: 409 });
      }
      trace.emit('payee', 'ack.verified', { sequence, commitmentDigest: preflight.commitment.commitmentDigest });
      prepared = preflight;
    }
    const result = await charge(request);
    if (result.status === 402) {
      trace.emit('payee', prepared ? 'credential.rejected' : 'challenge.issued', {
        sequence,
        amountBaseUnits: increment.charge.deltaChargeBaseUnits,
      });
      return result.challenge;
    }
    if (prepared === undefined) throw new Error('mppx accepted a request without a preflighted credential');
    usedNonces.add(prepared.ack.nonce);
    accepted.push({
      sequence,
      commitment: prepared.commitment,
      ack: prepared.ack,
      credentialAuthorization: request.headers.get('authorization') ?? '',
    });
    trace.emit('payee', 'increment.accepted', {
      sequence,
      cumulative: prepared.commitment.cumulativeAmountBaseUnits,
      storedCumulative: await storedCumulative(),
    });
    return result.withReceipt(Response.json({ sequence, accepted: prepared.commitment.cumulativeAmountBaseUnits }));
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/sessions\/([^/]+)\/increments\/(\d+)(\/evidence)?$/.exec(url.pathname);
    if (match === null || match[1] !== config.sessionId) return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    const sequence = Number(match[2]);
    if (match[3] !== undefined && request.method === 'GET') {
      const increment = config.increments[sequence - 1];
      if (increment === undefined) return Response.json({ code: 'UNKNOWN_INCREMENT' }, { status: 404 });
      trace.emit('payee', 'evidence.served', { sequence, evidenceDigest: increment.charge.evidenceDigest });
      return Response.json(increment);
    }
    if (match[3] === undefined && request.method === 'POST') return handlePaid(request, sequence);
    return Response.json({ code: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }

  async function storedCumulative(): Promise<string> {
    const record = (await store.get(`stellar:channel:cumulative:${channel}`)) as { amount?: string } | null;
    return record?.amount ?? '0';
  }

  const http = createServer((req, res) => {
    route(toWebRequest(req)).then(
      (response) => writeResponse(res, response),
      (error: unknown) => {
        trace.emit('payee', 'error', { message: error instanceof Error ? error.message : String(error) });
        res.writeHead(500).end();
      },
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    accepted,
    storedCumulative,
    async closeWithHighestCommitment() {
      const highest = accepted.at(-1);
      if (highest === undefined) throw new Error('no accepted commitment to close with');
      const amount = BigInt(highest.commitment.cumulativeAmountBaseUnits);
      trace.emit('payee', 'close.requested', { amount, commitmentDigest: highest.commitment.commitmentDigest });
      const txHash = await close({
        channel,
        amount,
        signature: Buffer.from(highest.commitment.signatureB64, 'base64'),
        feePayer: { envelopeSigner: Keypair.fromSecret(config.recipientSecret) },
        network: 'stellar:testnet',
      });
      trace.emit('network', 'tx.close.confirmed', { txHash, amount });
      return { txHash, amount: amount.toString() };
    },
    stop: () => new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve()))),
  };
}

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}
