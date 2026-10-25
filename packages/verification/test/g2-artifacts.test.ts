import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, computeE0Digest } from '@usagepay/contracts';
import { CHECK_IDS, createVerifier, formatReport, xdrCommitmentEncoding } from '../src/index.js';
import { fakeChain, g2Artifacts } from './helpers.js';

/**
 * Contract test on the genuine SPEC 02 Testnet artifacts (real SDK-signed native commitments, runtime meter key).
 * The chain answers are a double here; the live read-only RPC proof is the opt-in `g3:verify` run.
 */
describe('genuine G2 E0/E1 with the pinned XDR commitment encoding', () => {
  const { e0, e1, trust } = g2Artifacts();

  it('the trust file pins independently of E0/E1 and matches the run', () => {
    expect(trust.channelId).toBe(e1.channelId);
    expect(computeE0Digest(e0)).toBe(e1.e0Digest);
  });

  it('every native signed message is byte-equal to the locally rebuilt XDR commitment', () => {
    for (const { commitment } of e0.increments) {
      expect(bytesToBase64(xdrCommitmentEncoding(commitment.channelId, BigInt(commitment.cumulativeAmountBaseUnits)))).toBe(commitment.signedMessageB64);
    }
  });

  it('passes V01-V08 against a chain double that reports the observed close', async () => {
    const report = await createVerifier({ trust, chain: fakeChain(e0, trust).reader }).verify({ e0, e1 });
    for (const id of CHECK_IDS) expect(report.checks[id], id).toMatchObject({ status: 'PASS' });
    expect(report.overall.status).toBe('PASS');
    expect(report.subject.increments.map((i) => i.cumulativeChargeBaseUnits)).toEqual(['1000000', '2000000', '3000000']);
  });

  it('a copied E0 with one flipped meter byte fails immediately', async () => {
    const tampered = structuredClone(e0);
    const raw = base64ToBytes(tampered.increments[1]!.reading.rawPayloadB64);
    raw[raw.length - 3] = (raw[raw.length - 3] ?? 0) ^ 0x01;
    tampered.increments[1]!.reading.rawPayloadB64 = bytesToBase64(raw);
    const report = await createVerifier({ trust, chain: fakeChain(e0, trust).reader }).verify({ e0: tampered, e1 });
    expect(report.checks.V02_METER.status).toBe('FAIL');
    expect(report.checks.V07_E0_E1_LINK).toMatchObject({ status: 'FAIL', reasonCode: 'E0_DIGEST_MISMATCH' });
    expect(report.overall.status).toBe('FAIL');
  });

  it('the text report states the verdict, the real tx and the P0 limitations without secrets or raw payloads', async () => {
    const report = await createVerifier({ trust, chain: fakeChain(e0, trust).reader }).verify({ e0, e1 });
    const text = formatReport(report);
    expect(text).toContain('V05_MPP');
    expect(text).toContain(e1.closeTxHash);
    expect(text).toMatch(/OVERALL: PASS/);
    expect(text).toMatch(/PHYSICAL METER CERTIFICATION: NOT PROVIDED/);
    expect(text).not.toContain(e0.increments[0]!.reading.rawPayloadB64);
    expect(text).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  });
});
