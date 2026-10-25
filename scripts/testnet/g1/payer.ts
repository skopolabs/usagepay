import { Mppx, stellar } from '@stellar/mpp/channel/client';
import { Keypair } from '@stellar/stellar-sdk';
import { Challenge, Credential, Store } from 'mppx';
import {
  NETWORK,
  computeEvidenceDigest,
  computeReadingDigest,
  generateAckNonce,
  payerAckSigningMessage,
  accountIdToPublicKey,
  bytesToBase64,
  hexToBytes,
  verifyEd25519,
  type MeasurementCharge,
  type MeterReading,
  type NativeCommitment,
  type PayerEvidenceAck,
  type PayerEvidenceAckUnsigned,
} from '@usagepay/contracts';
import { buildCommitmentMessage, nativeCommitmentRecord, rpcServer, simulatePrepareCommitment } from './chain.ts';
import { ACK_HEADER } from './payee.ts';
import type { Trace } from './trace.ts';

export interface PayerConfig {
  readonly channel: string;
  /** Commitment secret: never leaves the payer. */
  readonly commitmentSecret: string;
  readonly sessionId: string;
  readonly payeeUrl: string;
  readonly trace: Trace;
}

/** Test-only ways to make the payer send an ack the payee must refuse (negative path of the ack gate). */
export interface AckTamper {
  readonly label: string;
  readonly evidenceDigest?: string;
  readonly signer?: Keypair;
}

export interface IncrementOutcome {
  readonly status: number;
  readonly body: unknown;
  readonly commitment: NativeCommitment;
  readonly ack: PayerEvidenceAck;
  readonly simulationEqualsLocalXdr: boolean;
}

export function createPayer(config: PayerConfig) {
  const { channel, trace } = config;
  const server = rpcServer();
  const commitmentKey = Keypair.fromSecret(config.commitmentSecret);
  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      stellar.channel({
        commitmentKey,
        allowedChannels: [channel],
        network: 'stellar:testnet',
        store: Store.memory(),
      }),
    ],
  });
  /** The payer's own record of the highest cumulative amount the payee accepted. */
  let approvedCumulative = 0n;
  const incrementUrl = (sequence: number) => `${config.payeeUrl}/sessions/${config.sessionId}/increments/${sequence}`;

  async function fetchEvidence(sequence: number): Promise<{ reading: MeterReading; charge: MeasurementCharge }> {
    const response = await mppx.rawFetch(`${incrementUrl(sequence)}/evidence`);
    if (!response.ok) throw new Error(`evidence ${sequence}: HTTP ${response.status}`);
    return (await response.json()) as { reading: MeterReading; charge: MeasurementCharge };
  }

  /**
   * Pre-sign checks for G1 (the full AC01-AC17 set lands in G2): the served evidence recomputes, belongs to this
   * session, and the cumulative charge equals the payer's own approved cumulative plus the delta.
   */
  function checkEvidence(sequence: number, reading: MeterReading, charge: MeasurementCharge): bigint {
    const fail = (why: string) => {
      throw new Error(`payer refuses to sign increment ${sequence}: ${why}`);
    };
    if (charge.sessionId !== config.sessionId || reading.sessionId !== config.sessionId) fail('session mismatch');
    if (charge.readingDigest !== computeReadingDigest(reading)) fail('readingDigest does not recompute');
    const { schema: _schema, evidenceDigest, ...preimage } = charge;
    if (computeEvidenceDigest(preimage) !== evidenceDigest) fail('evidenceDigest does not recompute');
    const cumulative = BigInt(charge.cumulativeChargeBaseUnits);
    if (cumulative !== approvedCumulative + BigInt(charge.deltaChargeBaseUnits)) fail('cumulative != approved + delta');
    return cumulative;
  }

  async function payIncrement(sequence: number, tamper?: AckTamper): Promise<IncrementOutcome> {
    const { reading, charge } = await fetchEvidence(sequence);
    const cumulative = checkEvidence(sequence, reading, charge);
    trace.emit('payer', 'evidence.checked', { sequence, evidenceDigest: charge.evidenceDigest, cumulative });

    const probe = await mppx.rawFetch(incrementUrl(sequence), { method: 'POST' });
    if (probe.status !== 402) throw new Error(`increment ${sequence}: expected 402 challenge, got ${probe.status}`);
    const challenge = Challenge.fromResponse(probe);
    const request = challenge.request as { amount: string; channel: string };
    if (request.channel !== channel || request.amount !== charge.deltaChargeBaseUnits) {
      throw new Error(`increment ${sequence}: challenge does not match the evidence (channel or amount)`);
    }
    trace.emit('payer', 'challenge.received', { sequence, challengeId: challenge.id, amountBaseUnits: request.amount });

    const authorization = await mppx.createCredential(probe, { cumulativeAmount: cumulative.toString() });
    const credential = Credential.fromRequest<{ amount: string; signature: string }>(
      new Request(incrementUrl(sequence), { headers: { Authorization: authorization } }),
    );
    if (credential.payload.amount !== cumulative.toString()) throw new Error('SDK signed a different cumulative amount');

    const local = buildCommitmentMessage(channel, cumulative);
    const simulated = await simulatePrepareCommitment(server, channel, cumulative);
    const simulationEqualsLocalXdr = Buffer.from(local).equals(Buffer.from(simulated));
    const signatureValid = verifyEd25519(
      accountIdToPublicKey(commitmentKey.publicKey()),
      local,
      hexToBytes(credential.payload.signature),
    );
    if (!simulationEqualsLocalXdr || !signatureValid) {
      throw new Error(`increment ${sequence}: captured credential failed local checks (xdr=${simulationEqualsLocalXdr}, sig=${signatureValid})`);
    }
    const commitment = nativeCommitmentRecord({
      channel,
      amount: cumulative,
      message: local,
      signatureHex: credential.payload.signature,
      commitmentKey: commitmentKey.publicKey(),
    });
    trace.emit('payer', 'commitment.signed', {
      sequence,
      cumulative,
      signature: credential.payload.signature,
      signedMessageB64: commitment.signedMessageB64,
      commitmentDigest: commitment.commitmentDigest,
      simulationEqualsLocalXdr,
      signatureValid,
    });

    const signer = tamper?.signer ?? commitmentKey;
    const unsigned: PayerEvidenceAckUnsigned = {
      schema: 'usagepay.payer-ack.v1',
      sessionId: config.sessionId,
      network: NETWORK,
      channelId: channel,
      evidenceDigest: tamper?.evidenceDigest ?? charge.evidenceDigest,
      commitmentDigest: commitment.commitmentDigest,
      approvedCumulativeBaseUnits: cumulative.toString(),
      nonce: generateAckNonce(),
      payerKey: signer.publicKey(),
    };
    const ack: PayerEvidenceAck = { ...unsigned, signatureB64: bytesToBase64(signer.sign(Buffer.from(payerAckSigningMessage(unsigned)))) };
    trace.emit('payer', tamper ? 'ack.signed.tampered' : 'ack.signed', {
      sequence,
      ...(tamper ? { tamper: tamper.label } : {}),
      nonce: ack.nonce,
      evidenceDigest: ack.evidenceDigest,
      commitmentDigest: ack.commitmentDigest,
    });

    const response = await mppx.rawFetch(incrementUrl(sequence), {
      method: 'POST',
      headers: {
        Authorization: authorization,
        [ACK_HEADER]: Buffer.from(JSON.stringify(ack)).toString('base64url'),
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) approvedCumulative = cumulative;
    trace.emit('payer', response.ok ? 'increment.paid' : 'increment.refused', { sequence, status: response.status, body });
    return { status: response.status, body, commitment, ack, simulationEqualsLocalXdr };
  }

  return { payIncrement, publicKey: commitmentKey.publicKey() };
}
