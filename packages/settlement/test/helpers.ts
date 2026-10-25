import { randomBytes } from 'node:crypto';
import { Mppx, stellar } from '@stellar/mpp/channel/client';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { Challenge, Credential, Store } from 'mppx';
import {
  NETWORK,
  bytesToBase64,
  payerAckSigningMessage,
  type AuthorizedIncrement,
  type MeasurementCharge,
  type MeterReading,
  type PayerEvidenceAck,
  type PayerEvidenceAckUnsigned,
} from '@usagepay/contracts';
import { TRUSTED_METER_KEYS, buildGoldenSession } from '@usagepay/fixtures';
import {
  ACK_HEADER,
  createPayee,
  createPayer,
  encodeAckHeader,
  incrementPath,
  nativeCommitmentRecord,
  xdrCommitmentEncoding,
  type Payee,
  type PayeeConfig,
  type Payer,
  type PayerConfig,
  type PayerTrust,
} from '../src/index.js';
import { installFakeChain, type FakeChain } from './fake-chain.js';

export const golden = buildGoldenSession();
export const sessionId = golden.inputs.session.sessionId;
export const goldenEvidence = golden.readings.map((reading, index) => ({ reading, charge: golden.charges[index]! }));
export const PAYEE_URL = 'http://payee.offline';

export function randomContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

export interface Harness {
  readonly chain: FakeChain;
  readonly commitmentKey: Keypair;
  readonly recipient: string;
  readonly channelId: string;
  readonly trust: PayerTrust;
  readonly payee: Payee;
  readonly payer: Payer;
  readonly events: { event: string; data: Record<string, unknown> }[];
  /** Calls the payee directly with a hand-built request, as a hostile or faulty client would. */
  rawIncrement(input: RawIncrementInput): Promise<Response>;
}

export interface HarnessOptions {
  readonly trust?: Partial<PayerTrust>;
  readonly payer?: Partial<PayerConfig>;
  readonly payee?: Partial<PayeeConfig>;
  /** Payer's own commitment key; defaults to the key pinned in the channel. */
  readonly payerKey?: Keypair;
  readonly evidence?: readonly { reading: MeterReading; charge: MeasurementCharge }[];
  /** Wraps the in-memory payee fetch the payer uses (hostile or lossy transport). */
  readonly wrapFetch?: (handle: Payee['handle']) => (request: Request) => Promise<Response>;
}

/** Real SDK client and server roles, wired through an in-memory fetch and the offline fake chain. */
export function harness(options: HarnessOptions = {}): Harness {
  const commitmentKey = Keypair.random();
  const recipient = Keypair.random().publicKey();
  const channelId = randomContractId();
  const chain = installFakeChain({
    channelId,
    token: golden.tariff.assetSac,
    from: Keypair.random().publicKey(),
    to: recipient,
    commitmentKey: commitmentKey.publicKey(),
    balance: 10_000_000n,
    closeEffectiveAtLedger: null,
  });
  const evidence = options.evidence ?? goldenEvidence;
  const events: Harness['events'] = [];
  const onEvent = (event: string, data: Record<string, unknown>) => events.push({ event, data });
  const payee = createPayee({
    channelId,
    sessionId,
    commitmentKey: commitmentKey.publicKey(),
    recipient,
    assetSac: golden.tariff.assetSac,
    evidence: (sequence) => evidence[sequence - 1],
    onEvent,
    ...options.payee,
  });
  const payerKey = options.payerKey ?? commitmentKey;
  const trust: PayerTrust = {
    network: NETWORK,
    sessionId,
    channelId,
    payerAccountId: payerKey.publicKey(),
    assetSac: golden.tariff.assetSac,
    tariffVersionDigest: golden.tariff.versionDigest,
    meterKeys: TRUSTED_METER_KEYS,
    budgetCapBaseUnits: '100000000',
    ...options.trust,
  };
  const payer = createPayer({
    trust,
    tariff: golden.tariff,
    commitmentKey: payerKey,
    payeeUrl: PAYEE_URL,
    fetch: options.wrapFetch?.(payee.handle) ?? payee.handle,
    onEvent,
    ...options.payer,
  });
  return { chain, commitmentKey, recipient, channelId, trust, payee, payer, events, rawIncrement: (input) => rawIncrement(payee, channelId, commitmentKey, input) };
}

export interface RawIncrementInput {
  readonly sequence: number;
  /** Cumulative amount the real SDK client signs. */
  readonly cumulative: bigint;
  readonly charge: MeasurementCharge;
  readonly ackPatch?: Partial<PayerEvidenceAckUnsigned>;
  /** Mutates the ack after signing (no re-signature). */
  readonly ackAfterSigning?: (ack: PayerEvidenceAck) => PayerEvidenceAck;
  readonly ackSigner?: Keypair;
  readonly omitAck?: boolean;
}

async function rawIncrement(payee: Payee, channelId: string, commitmentKey: Keypair, input: RawIncrementInput): Promise<Response> {
  const url = PAYEE_URL + incrementPath(sessionId, input.sequence);
  const probe = await payee.handle(new Request(url, { method: 'POST' }));
  const client = Mppx.create({
    polyfill: false,
    methods: [stellar.channel({ commitmentKey, allowedChannels: [channelId], network: 'stellar:testnet', store: Store.memory() })],
  });
  const authorization = await client.createCredential(probe, { cumulativeAmount: input.cumulative.toString() });
  const { payload } = Credential.fromRequest<{ amount: string; signature: string }>(new Request(url, { headers: { Authorization: authorization } }));
  const commitment = nativeCommitmentRecord({
    channelId,
    amount: input.cumulative,
    message: xdrCommitmentEncoding(channelId, input.cumulative),
    signatureHex: payload.signature,
    commitmentKey: commitmentKey.publicKey(),
  });
  const signer = input.ackSigner ?? commitmentKey;
  const unsigned: PayerEvidenceAckUnsigned = {
    schema: 'usagepay.payer-ack.v1',
    sessionId,
    network: NETWORK,
    channelId,
    evidenceDigest: input.charge.evidenceDigest,
    commitmentDigest: commitment.commitmentDigest,
    approvedCumulativeBaseUnits: commitment.cumulativeAmountBaseUnits,
    nonce: randomBytes(16).toString('hex'),
    payerKey: signer.publicKey(),
    ...input.ackPatch,
  };
  const signed: PayerEvidenceAck = { ...unsigned, signatureB64: bytesToBase64(signer.sign(Buffer.from(payerAckSigningMessage(unsigned)))) };
  const ack = input.ackAfterSigning ? input.ackAfterSigning(signed) : signed;
  const headers: Record<string, string> = { Authorization: authorization };
  if (input.omitAck !== true) headers[ACK_HEADER] = encodeAckHeader(ack);
  return payee.handle(new Request(url, { method: 'POST', headers }));
}

/** Wraps a fetch so 402 challenges are rewritten in flight, as a hostile payee would. */
export function rewriteChallenge(
  inner: (request: Request) => Promise<Response>,
  rewrite: (request: Record<string, unknown>) => Record<string, unknown>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await inner(request);
    if (response.status !== 402) return response;
    const challenge = Challenge.fromResponse(response);
    const forged = { ...challenge, request: rewrite(challenge.request as Record<string, unknown>) } as typeof challenge;
    return new Response(null, { status: 402, headers: { 'WWW-Authenticate': Challenge.serialize(forged) } });
  };
}

export function cumulativeOf(increment: AuthorizedIncrement | undefined): string | undefined {
  return increment?.commitment.cumulativeAmountBaseUnits;
}
