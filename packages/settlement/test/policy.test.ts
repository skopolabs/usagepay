import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_CRITICAL_CONDITIONS,
  NETWORK,
  canonicalize,
  utf8Bytes,
  type AuthorizedIncrement,
} from '@usagepay/contracts';
import {
  OFFLINE_COMMITMENT_DOMAIN,
  OFFLINE_FIXTURE_CHANNEL_ID,
  TEST_ONLY_PAYER_KEY,
  TRUSTED_METER_KEYS,
  buildAuthorizationConformanceCases,
  buildGoldenSession,
  type ConformanceCase,
} from '@usagepay/fixtures';
import {
  checkChannelFacts,
  checkNativeCommitment,
  checkPayerAck,
  evaluateCandidate,
  type CommitmentEncoding,
  type PayerTrust,
  type Refusal,
} from '../src/index.js';

/** The fixtures' explicitly labelled offline stand-in for the pinned XDR commitment encoding. */
const offlineEncoding: CommitmentEncoding = (channelId, amount) =>
  utf8Bytes(OFFLINE_COMMITMENT_DOMAIN + canonicalize({ channelId, network: NETWORK, cumulativeAmountBaseUnits: amount.toString() }));

const golden = buildGoldenSession();
const [inc1, inc2, inc3] = golden.increments as [AuthorizedIncrement, AuthorizedIncrement, AuthorizedIncrement];

function trust(overrides: Partial<PayerTrust> = {}): PayerTrust {
  return {
    network: NETWORK,
    sessionId: golden.inputs.session.sessionId,
    channelId: OFFLINE_FIXTURE_CHANNEL_ID,
    payerAccountId: TEST_ONLY_PAYER_KEY.accountId,
    assetSac: golden.tariff.assetSac,
    tariffVersionDigest: golden.tariff.versionDigest,
    meterKeys: TRUSTED_METER_KEYS,
    budgetCapBaseUnits: '100000000',
    ...overrides,
  };
}

const candidateOf = (increment: AuthorizedIncrement) => ({
  reading: increment.reading,
  charge: increment.charge,
  tariff: golden.tariff,
  channelId: increment.commitment.channelId,
});

/** The payer's full pre-acceptance gate, stage by stage, as SPEC 02 runs it around the native SDK signature. */
function payerGate(testCase: ConformanceCase): Refusal | null {
  const { trust: pinned, prior, candidate } = testCase;
  const decision = evaluateCandidate(pinned, prior, { ...candidateOf(candidate), tariff: testCase.tariff });
  if (!decision.approved) return decision.refusal;
  const native = checkNativeCommitment({
    commitment: candidate.commitment,
    channelId: pinned.channelId,
    commitmentKey: pinned.payerAccountId,
    expectedCumulative: decision.cumulative,
    encoding: offlineEncoding,
  });
  if (native !== null) return native;
  return checkPayerAck({
    ack: candidate.payerAck,
    sessionId: pinned.sessionId,
    channelId: pinned.channelId,
    payerAccountId: pinned.payerAccountId,
    charge: candidate.charge,
    commitment: candidate.commitment,
    usedNonces: new Set(prior.map((p) => p.payerAck.nonce)),
  });
}

const payerCode = (id: string) => AUTHORIZATION_CRITICAL_CONDITIONS.find((c) => c.id === id)?.payerReasonCode;

describe('SPEC 02 payer policy (pure, offline)', () => {
  it('S1-B: valid r-001 with the pinned tariff and channel is approved at 1000000 base units', () => {
    expect(evaluateCandidate(trust(), [], candidateOf(inc1))).toEqual({ approved: true, cumulative: 1000000n, delta: 1000000n });
  });

  it('S1-B: r-002 and r-003 replay the golden cumulative charges after their true history', () => {
    expect(evaluateCandidate(trust(), [inc1], candidateOf(inc2))).toMatchObject({ approved: true, cumulative: 2000000n });
    expect(evaluateCandidate(trust(), [inc1, inc2], candidateOf(inc3))).toMatchObject({ approved: true, cumulative: 3000000n });
  });

  it('F2-B: cap 2500000 approves r-001 and r-002 and refuses r-003 with BUDGET_EXCEEDED', () => {
    const { budgetCase } = golden.inputs;
    const capped = trust({ budgetCapBaseUnits: budgetCase.capBaseUnits });
    expect(evaluateCandidate(capped, [], candidateOf(inc1))).toMatchObject({ approved: true });
    expect(evaluateCandidate(capped, [inc1], candidateOf(inc2))).toMatchObject({ approved: true, cumulative: 2000000n });
    expect(evaluateCandidate(capped, [inc1, inc2], candidateOf(inc3))).toMatchObject({
      approved: false,
      refusal: { code: 'BUDGET_EXCEEDED' },
    });
  });

  it('F3-B: a replayed r-002 is refused as a duplicate reading', () => {
    expect(evaluateCandidate(trust(), [inc1, inc2], candidateOf(inc2))).toMatchObject({
      approved: false,
      refusal: { code: 'DUPLICATE_READING' },
    });
  });

  it('F3-B: a reused ack nonce is refused with REPLAY_NONCE', () => {
    const refused = checkPayerAck({
      ack: inc2.payerAck,
      sessionId: trust().sessionId,
      channelId: trust().channelId,
      payerAccountId: trust().payerAccountId,
      charge: inc2.charge,
      commitment: inc2.commitment,
      usedNonces: new Set([inc2.payerAck.nonce]),
    });
    expect(refused?.code).toBe('REPLAY_NONCE');
  });

  it('refuses a signed counter gap even when the interval is contiguous and the charge replays', () => {
    const gapped = buildGoldenSession({
      ...golden.inputs,
      intervals: golden.inputs.intervals.map((interval) =>
        interval.readingId === 'r-002' ? { ...interval, meterStartWh: '10260', meterEndWh: '10510' } : interval,
      ),
    });
    expect(evaluateCandidate(trust(), [inc1], candidateOf(gapped.increments[1]!))).toMatchObject({
      approved: false,
      refusal: { code: 'DUPLICATE_READING' },
    });
  });

  it('refuses a cumulative above the channel balance even below the fleet cap', () => {
    const facts = { token: golden.tariff.assetSac, to: 'GRECIPIENT', balance: 1500000n, closeEffectiveAtLedger: null };
    expect(evaluateCandidate(trust(), [inc1], candidateOf(inc2), facts)).toMatchObject({
      approved: false,
      refusal: { code: 'DEPOSIT_INSUFFICIENT' },
    });
  });

  describe('channel facts pinning', () => {
    const recipient = TEST_ONLY_PAYER_KEY.accountId;
    const pinned = { ...trust(), recipient };
    const facts = { token: golden.tariff.assetSac, to: recipient, balance: 10000000n, closeEffectiveAtLedger: null };

    it('accepts the pinned token, recipient and an open channel', () => {
      expect(checkChannelFacts(pinned, facts)).toBeNull();
    });
    it.each([
      ['ASSET_MISMATCH', { token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' }],
      ['RECIPIENT_MISMATCH', { to: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7' }],
      ['DEPOSIT_INSUFFICIENT', { closeEffectiveAtLedger: 123 }],
    ])('refuses %s', (code, patch) => {
      expect(checkChannelFacts(pinned, { ...facts, ...patch })?.code).toBe(code);
    });
  });
});

describe('SPEC 02 payer gate against the frozen authorization conformance cases', () => {
  const cases = buildAuthorizationConformanceCases(golden);

  it.each(cases.filter((c) => c.conditionId === null).map((c) => [c.caseId, c] as const))('%s is accepted', (_id, testCase) => {
    expect(payerGate(testCase)).toBeNull();
  });

  it.each(cases.filter((c) => c.conditionId !== null).map((c) => [c.caseId, c] as const))('%s is refused with its catalogue code', (_id, testCase) => {
    const expected = [testCase.conditionId, ...testCase.alsoViolates].map((id) => payerCode(id ?? ''));
    const refused = payerGate(testCase);
    expect(refused).not.toBeNull();
    // AC02 cannot be expressed structurally in contract v1; the payer still names the network.
    expect(testCase.structurallyRejected ? ['NETWORK_MISMATCH'] : expected).toContain(refused?.code);
  });
});
