import {
  AuthorizedIncrementSchema,
  NETWORK,
  base64ToBytes,
  bytesToBase64,
  computeCommitmentDigest,
  computeEvidenceDigest,
  computeReadingDigest,
  contractIdFromBytes,
  hexToBytes,
  sha256Hex,
  utf8Bytes,
  type AuthorizationConditionId,
  type AuthorizedIncrement,
  type MeasurementCharge,
  type MeterReading,
  type NativeCommitment,
  type PayerEvidenceAckUnsigned,
  type TariffSnapshot,
} from '@usagepay/contracts';
import {
  OFFLINE_FIXTURE_CHANNEL_ID,
  buildGoldenSession,
  buildOfflineCommitment,
  fixtureNonce,
  signPayerAck,
  type GoldenSession,
} from './golden.js';
import type { GoldenInputs } from './inputs.js';
import { tamperedReading } from './negative.js';
import { TEST_ONLY_PAYER_KEY, TEST_ONLY_UNTRUSTED_METER_KEY, TRUSTED_METER_KEYS } from './test-keys.js';

/**
 * Authorization conformance cases (OFFLINE_FIXTURE). Each case presents a payer/verifier with pinned trust inputs,
 * the already-authorized prior increments and one candidate increment. Unless `structurallyRejected` is set, the
 * candidate passes the structural SPEC 00 schema, so only the semantic check named by `conditionId` (plus any
 * listed in `alsoViolates`) can refuse it. SPEC 02 (before signing) and SPEC 03 (re-check) must reject every case
 * and accept every positive control.
 */
export interface ConformanceTrust {
  readonly network: typeof NETWORK;
  readonly sessionId: string;
  readonly channelId: string;
  readonly payerAccountId: string;
  readonly assetSac: string;
  readonly tariffVersionDigest: string;
  readonly meterKeys: ReadonlyMap<string, Uint8Array>;
  readonly budgetCapBaseUnits: string;
}

export interface ConformanceCase {
  readonly caseId: string;
  readonly conditionId: AuthorizationConditionId | null;
  readonly alsoViolates: readonly AuthorizationConditionId[];
  readonly description: string;
  readonly trust: ConformanceTrust;
  readonly tariff: TariffSnapshot;
  readonly prior: readonly AuthorizedIncrement[];
  readonly candidate: AuthorizedIncrement;
  readonly structurallyRejected: boolean;
}

/** Budget used by every case except the AC13 budget case; high enough never to bind accidentally. */
export const CONFORMANCE_DEFAULT_BUDGET_CAP = '100000000';

function trustFor(golden: GoldenSession, overrides: Partial<ConformanceTrust> = {}): ConformanceTrust {
  return {
    network: NETWORK,
    sessionId: golden.inputs.session.sessionId,
    channelId: OFFLINE_FIXTURE_CHANNEL_ID,
    payerAccountId: TEST_ONLY_PAYER_KEY.accountId,
    assetSac: golden.tariff.assetSac,
    tariffVersionDigest: golden.tariff.versionDigest,
    meterKeys: TRUSTED_METER_KEYS,
    budgetCapBaseUnits: CONFORMANCE_DEFAULT_BUDGET_CAP,
    ...overrides,
  };
}

function evidenceDigestOf(charge: Omit<MeasurementCharge, 'evidenceDigest'>): string {
  const { readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits, deltaChargeBaseUnits, sessionId, readingId } = charge;
  return computeEvidenceDigest({ readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits, deltaChargeBaseUnits, sessionId, readingId });
}

/** Charge rebuilt for a (possibly modified) reading with consistent reading and evidence digests. */
function rechargeFor(reading: MeterReading, charge: MeasurementCharge, patch: Partial<MeasurementCharge> = {}): MeasurementCharge {
  const draft = { ...charge, readingDigest: computeReadingDigest(reading), ...patch };
  return { ...draft, evidenceDigest: patch.evidenceDigest ?? evidenceDigestOf(draft) };
}

interface ResealOptions {
  readonly reading?: MeterReading;
  readonly charge?: MeasurementCharge;
  readonly commitment?: NativeCommitment;
  readonly channelId?: string;
  readonly ackPatch?: Partial<PayerEvidenceAckUnsigned>;
}

/** Re-signs the commitment (unless supplied) and the payer ack so that every signature is valid again. */
function reseal(base: AuthorizedIncrement, options: ResealOptions = {}): AuthorizedIncrement {
  const reading = options.reading ?? base.reading;
  const charge = options.charge ?? base.charge;
  const commitment =
    options.commitment ??
    buildOfflineCommitment(options.channelId ?? base.commitment.channelId, charge.cumulativeChargeBaseUnits, TEST_ONLY_PAYER_KEY);
  const payerAck = signPayerAck(
    {
      schema: 'usagepay.payer-ack.v1',
      sessionId: charge.sessionId,
      network: commitment.network,
      channelId: commitment.channelId,
      evidenceDigest: charge.evidenceDigest,
      commitmentDigest: commitment.commitmentDigest,
      approvedCumulativeBaseUnits: commitment.cumulativeAmountBaseUnits,
      nonce: base.payerAck.nonce,
      payerKey: TEST_ONLY_PAYER_KEY.accountId,
      ...options.ackPatch,
    },
    TEST_ONLY_PAYER_KEY,
  );
  return { ...base, reading, charge, commitment, payerAck };
}

function variantInputs(golden: GoldenSession, patch: (inputs: GoldenInputs) => GoldenInputs): GoldenInputs {
  return patch(structuredClone(golden.inputs));
}

const OTHER_CHANNEL_ID = contractIdFromBytes(hexToBytes(sha256Hex(utf8Bytes('usagepay.offline-fixture.other-channel.v1'))));
const XLM_SAC_TESTNET = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

export function buildAuthorizationConformanceCases(golden: GoldenSession = buildGoldenSession()): ConformanceCase[] {
  const [inc1, inc2, inc3] = golden.increments as [AuthorizedIncrement, AuthorizedIncrement, AuthorizedIncrement];
  const trust = trustFor(golden);
  const base = { trust, tariff: golden.tariff, prior: [inc1], alsoViolates: [], structurallyRejected: false } as const;
  const cases: ConformanceCase[] = [];

  // Positive controls: every golden increment, given its true history, violates nothing.
  golden.increments.forEach((candidate, index) => {
    cases.push({
      ...base,
      caseId: `CONTROL-${candidate.reading.readingId}`,
      conditionId: null,
      description: `Golden ${candidate.reading.readingId} after its true prior increments must be accepted`,
      prior: golden.increments.slice(0, index),
      candidate,
    });
  });

  cases.push({
    ...base,
    caseId: 'AC01-other-channel',
    conditionId: 'AC01_CHANNEL_PINNED',
    description: 'r-002 committed and acknowledged for a channel other than the pinned one',
    candidate: reseal(inc2, { channelId: OTHER_CHANNEL_ID }),
  });

  cases.push({
    ...base,
    caseId: 'AC02-pubnet-commitment',
    conditionId: 'AC02_NETWORK_PINNED',
    description: 'r-002 commitment claims stellar:pubnet (structurally impossible in contract v1)',
    candidate: { ...inc2, commitment: { ...inc2.commitment, network: 'stellar:pubnet' as typeof NETWORK } },
    structurallyRejected: true,
  });

  {
    const alt = buildGoldenSession(variantInputs(golden, (i) => ({ ...i, tariff: { ...i.tariff, assetSac: XLM_SAC_TESTNET } })));
    cases.push({
      ...base,
      caseId: 'AC03-xlm-asset',
      conditionId: 'AC03_ASSET_PINNED',
      description: 'Internally consistent session priced in the XLM SAC instead of the pinned USDC SAC',
      trust: trustFor(golden, { tariffVersionDigest: alt.tariff.versionDigest }),
      tariff: alt.tariff,
      prior: [alt.increments[0]!],
      candidate: alt.increments[1]!,
    });
  }

  {
    const alt = buildGoldenSession(variantInputs(golden, (i) => ({ ...i, tariff: { ...i.tariff, pricePerKwhBaseUnits: '5000000' } })));
    cases.push({
      ...base,
      caseId: 'AC04-unpinned-price',
      conditionId: 'AC04_TARIFF_PINNED_AND_ACTIVE',
      description: 'Internally consistent session under a 0.50 USDC/kWh tariff that is not the pinned tariff',
      tariff: alt.tariff,
      prior: [alt.increments[0]!],
      candidate: alt.increments[1]!,
    });
  }

  {
    const alt = buildGoldenSession(
      variantInputs(golden, (i) => ({ ...i, tariff: { ...i.tariff, validUntil: '2026-10-25T09:01:00.000Z' } })),
    );
    cases.push({
      ...base,
      caseId: 'AC04-tariff-expired',
      conditionId: 'AC04_TARIFF_PINNED_AND_ACTIVE',
      description: 'Pinned tariff expires at 09:01; r-002 covers [09:01, 09:02)',
      trust: trustFor(golden, { tariffVersionDigest: alt.tariff.versionDigest }),
      tariff: alt.tariff,
      prior: [alt.increments[0]!],
      candidate: alt.increments[1]!,
    });
  }

  {
    const alt = buildGoldenSession(golden.inputs, { meterSigner: TEST_ONLY_UNTRUSTED_METER_KEY });
    cases.push({
      ...base,
      caseId: 'AC05-untrusted-meter-key',
      conditionId: 'AC05_METER_SIGNATURE',
      description: 'Session signed by a meter key outside the pinned registry (claims key ID test-meter-01)',
      prior: [inc1],
      candidate: alt.increments[1]!,
    });
  }

  {
    const reading = tamperedReading(golden);
    cases.push({
      ...base,
      caseId: 'AC05-tampered-source-byte',
      conditionId: 'AC05_METER_SIGNATURE',
      alsoViolates: ['AC06_SIGNED_SOURCE_MATCHES_READING'],
      description: 'One signed source byte of r-002 changed (meterEndWh 10500 -> 19500); digests recomputed and re-signed downstream',
      candidate: reseal(inc2, { reading, charge: rechargeFor(reading, inc2.charge) }),
    });
  }

  {
    const reading = { ...inc2.reading, machineId: 'sim-charger-02' };
    cases.push({
      ...base,
      caseId: 'AC06-envelope-machine-mismatch',
      conditionId: 'AC06_SIGNED_SOURCE_MATCHES_READING',
      description: 'Reading claims machine sim-charger-02 while the signed bytes say sim-charger-01',
      candidate: reseal(inc2, { reading, charge: rechargeFor(reading, inc2.charge) }),
    });
  }

  {
    const draft = { ...inc2.charge, readingDigest: sha256Hex(utf8Bytes('usagepay.offline-fixture.other-reading')) };
    cases.push({
      ...base,
      caseId: 'AC07-wrong-reading-digest',
      conditionId: 'AC07_READING_DIGEST',
      description: 'Charge cites a readingDigest that is not SHA-256(JCS(reading)); evidence digest consistent with it',
      candidate: reseal(inc2, { charge: { ...draft, evidenceDigest: evidenceDigestOf(draft) } }),
    });
  }

  {
    const draft = { ...inc2.charge, cumulativeChargeBaseUnits: '2000001', deltaChargeBaseUnits: '1000001' };
    cases.push({
      ...base,
      caseId: 'AC08-overcharge-by-one',
      conditionId: 'AC08_CHARGE_REPLAY',
      description: 'r-002 charged 2000001 instead of floor(500 * 4000000 / 1000) = 2000000; all digests/signatures consistent',
      candidate: reseal(inc2, { charge: { ...draft, evidenceDigest: evidenceDigestOf(draft) } }),
    });
  }

  cases.push({
    ...base,
    caseId: 'AC09-wrong-evidence-digest',
    conditionId: 'AC09_EVIDENCE_DIGEST',
    description: 'Charge evidenceDigest does not match its preimage; the ack faithfully binds the wrong value',
    candidate: reseal(inc2, {
      charge: { ...inc2.charge, evidenceDigest: sha256Hex(utf8Bytes('usagepay.offline-fixture.other-evidence')) },
    }),
  });

  cases.push({
    ...base,
    caseId: 'AC10-duplicate-reading',
    conditionId: 'AC10_READING_NEW_AND_CONTIGUOUS',
    alsoViolates: ['AC08_CHARGE_REPLAY', 'AC12_CUMULATIVE_STRICTLY_INCREASING'],
    description: 'r-002 delivered again (fresh nonce) after r-001 and r-002 were authorized',
    prior: [inc1, inc2],
    candidate: reseal(inc2, { ackPatch: { nonce: fixtureNonce(inc2.reading.sessionId, 'r-002-redelivery') } }),
  });

  {
    const alt = buildGoldenSession(
      variantInputs(golden, (i) => ({
        ...i,
        intervals: [
          ...i.intervals,
          {
            readingId: 'r-004',
            observedAt: '2026-10-25T09:04:00.000Z',
            intervalStart: '2026-10-25T09:03:00.000Z',
            intervalEnd: '2026-10-25T09:04:00.000Z',
            meterStartWh: '10750',
            meterEndWh: '11000',
            coverage: 'terminal_signed',
            expected: { deltaWh: '250', cumulativeWh: '1000', cumulativeChargeBaseUnits: '4000000', deltaChargeBaseUnits: '1000000' },
          },
        ],
      })),
    );
    cases.push({
      ...base,
      caseId: 'AC10-after-terminal-reading',
      conditionId: 'AC10_READING_NEW_AND_CONTIGUOUS',
      description: 'r-004 arrives after the terminal_signed r-003 ended the session',
      prior: alt.increments.slice(0, 3),
      candidate: alt.increments[3]!,
    });
  }

  {
    const alt = buildGoldenSession(
      variantInputs(golden, (i) => ({ ...i, session: { ...i.session, sessionId: 'ev-session-002' } })),
    );
    cases.push({
      ...base,
      caseId: 'AC11-foreign-session',
      conditionId: 'AC11_SESSION_CONSISTENT',
      description: 'Consistent r-002 from session ev-session-002 offered to the pinned ev-session-001',
      candidate: alt.increments[1]!,
    });
  }

  {
    const alt = buildGoldenSession(
      variantInputs(golden, (i) => ({
        ...i,
        intervals: i.intervals.map((interval) => (interval.readingId === 'r-002' ? { ...interval, meterEndWh: interval.meterStartWh } : interval)),
      })),
    );
    cases.push({
      ...base,
      caseId: 'AC12-zero-value-increment',
      conditionId: 'AC12_CUMULATIVE_STRICTLY_INCREASING',
      description: 'r-002 signs 0 Wh, so the cumulative amount stays at 1000000',
      prior: [alt.increments[0]!],
      candidate: alt.increments[1]!,
    });
  }

  cases.push({
    ...base,
    caseId: 'AC13-budget-cap-2500000',
    conditionId: 'AC13_BUDGET_CAP',
    description: 'Cap 2500000: r-003 would raise the cumulative amount to 3000000 (F2)',
    trust: trustFor(golden, { budgetCapBaseUnits: golden.inputs.budgetCase.capBaseUnits }),
    prior: [inc1, inc2],
    candidate: inc3,
  });

  cases.push({
    ...base,
    caseId: 'AC14-unpinned-commitment-key',
    conditionId: 'AC14_NATIVE_COMMITMENT_BINDS',
    description: 'Commitment signed by a key other than the pinned payer commitment key; ack by the pinned payer',
    candidate: reseal(inc2, {
      commitment: buildOfflineCommitment(OFFLINE_FIXTURE_CHANNEL_ID, inc2.charge.cumulativeChargeBaseUnits, TEST_ONLY_UNTRUSTED_METER_KEY),
    }),
  });

  {
    const message = base64ToBytes(inc2.commitment.signedMessageB64);
    const marker = '"cumulativeAmountBaseUnits":"2';
    message[new TextDecoder().decode(message).indexOf(marker) + marker.length] = '9'.charCodeAt(0); // 2000000 -> 2900000
    const signedMessageB64 = bytesToBase64(message);
    const commitment = {
      ...inc2.commitment,
      signedMessageB64,
      commitmentDigest: computeCommitmentDigest({ signedMessageB64, signatureB64: inc2.commitment.signatureB64 }),
    };
    cases.push({
      ...base,
      caseId: 'AC14-message-altered-after-signing',
      conditionId: 'AC14_NATIVE_COMMITMENT_BINDS',
      description: 'Signed commitment message altered after signing (amount 2000000 -> 2900000); digest recomputed and acknowledged',
      candidate: reseal(inc2, { commitment }),
    });
  }

  cases.push({
    ...base,
    caseId: 'AC15-stale-commitment-digest',
    conditionId: 'AC15_COMMITMENT_DIGEST',
    description: 'Stored commitmentDigest does not recompute from the credential; the ack binds the stored value',
    candidate: reseal(inc2, {
      commitment: { ...inc2.commitment, commitmentDigest: sha256Hex(utf8Bytes('usagepay.offline-fixture.other-commitment')) },
    }),
  });

  cases.push({
    ...base,
    caseId: 'AC16-ack-previous-evidence',
    conditionId: 'AC16_ACK_BINDING',
    description: 'Ack validly signed but binding r-001 evidence to the r-002 commitment (F4-B)',
    candidate: reseal(inc2, { ackPatch: { evidenceDigest: inc1.charge.evidenceDigest } }),
  });

  cases.push({
    ...base,
    caseId: 'AC16-ack-amount-mismatch',
    conditionId: 'AC16_ACK_BINDING',
    description: 'Ack approves 2500000 while the commitment and charge are 2000000',
    candidate: reseal(inc2, { ackPatch: { approvedCumulativeBaseUnits: '2500000' } }),
  });

  cases.push({
    ...base,
    caseId: 'AC17-reused-nonce',
    conditionId: 'AC17_NONCE_FRESH',
    description: 'r-003 ack reuses the r-002 ack nonce in the same channel and session (F3-B)',
    prior: [inc1, inc2],
    candidate: reseal(inc3, { ackPatch: { nonce: inc2.payerAck.nonce } }),
  });

  for (const testCase of cases) {
    const parsed = AuthorizedIncrementSchema.safeParse(testCase.candidate);
    if (parsed.success === testCase.structurallyRejected) {
      throw new Error(`conformance case ${testCase.caseId}: structural validity does not match its declaration`);
    }
  }
  return cases;
}
