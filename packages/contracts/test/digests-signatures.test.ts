import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  PAYER_ACK_DOMAIN,
  SourcePayloadError,
  bytesToBase64,
  canonicalize,
  computeCommitmentDigest,
  computeEvidenceDigest,
  computeTariffVersionDigest,
  decodeSimMeterPayload,
  encodeSimMeterPayload,
  generateAckNonce,
  jcsDigest,
  payerAckSigningMessage,
  publicKeyToAccountId,
  utf8Bytes,
  verifyEd25519,
  verifyPayerAckSignature,
  type PayerEvidenceAckUnsigned,
  type SimMeterPayload,
} from '../src/index.js';

const seed = new Uint8Array(32).fill(7); // unit-test-only key material
const publicKey = ed25519.getPublicKey(seed);
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

const payload: SimMeterPayload = {
  schema: 'usagepay.sim-meter-payload.v1',
  domain: 'ev.ocpp2x',
  sessionId: 'ev-session-001',
  machineId: 'sim-charger-01',
  readingId: 'r-001',
  observedAt: '2026-10-25T09:01:00.000Z',
  intervalStart: '2026-10-25T09:00:00.000Z',
  intervalEnd: '2026-10-25T09:01:00.000Z',
  meterStartWh: '10000',
  meterEndWh: '10250',
  unit: 'Wh',
};

describe('digest preimages (SPEC 00 §5)', () => {
  it('tariff versionDigest excludes the versionDigest field itself', () => {
    const fields = { tariffId: 't', pricePerKwhBaseUnits: '4000000' };
    // Cast: only the exclusion rule is under test here, not tariff validity.
    const withDigest = { ...fields, versionDigest: 'ignored' } as unknown as Parameters<typeof computeTariffVersionDigest>[0];
    expect(computeTariffVersionDigest(withDigest)).toBe(jcsDigest(fields));
  });

  it('evidenceDigest uses exactly the seven SPEC 00 keys and refuses extra keys', () => {
    const preimage = {
      readingDigest: digestA,
      tariffVersionDigest: digestB,
      cumulativeWh: '250',
      cumulativeChargeBaseUnits: '1000000',
      deltaChargeBaseUnits: '1000000',
      sessionId: 'ev-session-001',
      readingId: 'r-001',
    };
    expect(computeEvidenceDigest(preimage)).toBe(jcsDigest(preimage));
    expect(() => computeEvidenceDigest({ ...preimage, evidenceDigest: digestA } as typeof preimage)).toThrow();
  });

  it('commitmentDigest covers only {signedMessageB64, signatureB64}', () => {
    const parts = { signedMessageB64: 'AAEC', signatureB64: bytesToBase64(new Uint8Array(64)) };
    expect(computeCommitmentDigest({ ...parts, extra: 'x' } as typeof parts)).toBe(jcsDigest(parts));
  });

  it('payer ack message is the domain separator followed by JCS of the ack without signatureB64', () => {
    const unsigned: PayerEvidenceAckUnsigned = {
      schema: 'usagepay.payer-ack.v1',
      sessionId: 'ev-session-001',
      network: 'stellar:testnet',
      channelId: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      evidenceDigest: digestA,
      commitmentDigest: digestB,
      approvedCumulativeBaseUnits: '1000000',
      nonce: generateAckNonce(),
      payerKey: publicKeyToAccountId(publicKey),
    };
    const message = payerAckSigningMessage(unsigned);
    expect(new TextDecoder().decode(message)).toBe(`usagepay.payer-evidence-ack.v1\n${canonicalize(unsigned)}`);
    expect(PAYER_ACK_DOMAIN.endsWith('\n')).toBe(true);
    const signed = { ...unsigned, signatureB64: bytesToBase64(ed25519.sign(message, seed)) };
    expect(payerAckSigningMessage(signed)).toEqual(message);
    expect(verifyPayerAckSignature(signed)).toBe(true);
    expect(verifyPayerAckSignature({ ...signed, approvedCumulativeBaseUnits: '2000000' })).toBe(false);
  });
});

describe('Ed25519 verification over exact bytes', () => {
  it('verifies a signature and rejects one flipped message byte', () => {
    const message = utf8Bytes('exact source bytes');
    const signature = ed25519.sign(message, seed);
    expect(verifyEd25519(publicKey, message, signature)).toBe(true);
    const tampered = Uint8Array.from(message);
    tampered[0]! ^= 1;
    expect(verifyEd25519(publicKey, tampered, signature)).toBe(false);
  });

  it('returns false (never throws) for malformed key or signature lengths', () => {
    expect(verifyEd25519(new Uint8Array(31), new Uint8Array(1), new Uint8Array(64))).toBe(false);
    expect(verifyEd25519(publicKey, new Uint8Array(1), new Uint8Array(63))).toBe(false);
  });
});

describe('SPEC 01 simulator payload bytes', () => {
  it('encodes as UTF-8 JCS and decodes back to the same payload', () => {
    const bytes = encodeSimMeterPayload(payload);
    expect(new TextDecoder().decode(bytes)).toBe(canonicalize(payload));
    expect(decodeSimMeterPayload(bytes)).toEqual(payload);
  });

  it('rejects semantically equal but non-canonical bytes (pretty-printed JSON)', () => {
    expect(() => decodeSimMeterPayload(utf8Bytes(JSON.stringify(payload, null, 2)))).toThrow(SourcePayloadError);
  });

  it('rejects invalid UTF-8, non-JSON and profile violations', () => {
    expect(() => decodeSimMeterPayload(Uint8Array.from([0xff, 0xfe]))).toThrow(SourcePayloadError);
    expect(() => decodeSimMeterPayload(utf8Bytes('not json'))).toThrow(SourcePayloadError);
    expect(() => decodeSimMeterPayload(utf8Bytes(canonicalize({ ...payload, meterEndWh: 10250 })))).toThrow(SourcePayloadError);
  });
});
