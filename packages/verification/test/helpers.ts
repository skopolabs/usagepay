import {
  NETWORK,
  accountIdToPublicKey,
  bytesToHex,
  canonicalize,
  computeE0Digest,
  utf8Bytes,
  type AuthorizedIncrement,
  type EvidenceE0,
  type EvidenceE1,
  type PayerEvidenceAckUnsigned,
} from '@usagepay/contracts';
import {
  OFFLINE_COMMITMENT_DOMAIN,
  OFFLINE_FIXTURE_CHANNEL_ID,
  TEST_ONLY_METER_KEY,
  TEST_ONLY_PAYER_KEY,
  TRUSTED_METER_KEYS,
  buildGoldenSession,
  buildOfflineCommitment,
  offlineE1,
  signPayerAck,
} from '@usagepay/fixtures';
import {
  type ChainReader,
  type CommitmentEncoding,
  type ObservedChannel,
  type ObservedEvent,
  type ObservedTransaction,
  type VerifierTrust,
} from '../src/index.js';

/** The fixtures' explicitly labelled offline stand-in for the pinned XDR commitment encoding. */
export const offlineEncoding: CommitmentEncoding = (channelId, amount) =>
  utf8Bytes(OFFLINE_COMMITMENT_DOMAIN + canonicalize({ channelId, network: NETWORK, cumulativeAmountBaseUnits: amount.toString() }));

export const golden = buildGoldenSession();
export const RECIPIENT = TEST_ONLY_METER_KEY.accountId;
export const FUNDER = 'GB6XZYHIGRQPG7L7CHZYFM3HFHKSJNBDXQZ5W5ZCDG5QEM32EEBAPOJC';

export function goldenTrust(overrides: Partial<VerifierTrust> = {}): VerifierTrust {
  return {
    network: NETWORK,
    sessionId: golden.inputs.session.sessionId,
    channelId: OFFLINE_FIXTURE_CHANNEL_ID,
    recipient: RECIPIENT,
    funder: FUNDER,
    assetSac: golden.tariff.assetSac,
    commitmentKey: TEST_ONLY_PAYER_KEY.accountId,
    tariffVersionDigest: golden.tariff.versionDigest,
    budgetCapBaseUnits: '100000000',
    meterKeys: TRUSTED_METER_KEYS,
    ...overrides,
  };
}

/** An E1 that honestly references `e0` (offline: its close hash is synthetic, never settlement evidence). */
export function e1For(e0: EvidenceE0, overrides: Partial<EvidenceE1> = {}): EvidenceE1 {
  return { ...offlineE1(golden, 'SUCCESS', e0.increments.at(-1)?.commitment.cumulativeAmountBaseUnits), e0Digest: computeE0Digest(e0), ...overrides };
}

export function e0With(increments: AuthorizedIncrement[], base: EvidenceE0 = golden.e0): EvidenceE0 {
  return { ...base, increments };
}

/** Replaces increment `index` and re-signs its payer ack, so only the targeted binding can fail. */
export function mutateIncrement(index: number, patch: (increment: AuthorizedIncrement) => AuthorizedIncrement, ackPatch: Partial<PayerEvidenceAckUnsigned> = {}): EvidenceE0 {
  const increments = golden.increments.map((increment, i) => {
    if (i !== index) return increment;
    const next = patch(structuredClone(increment));
    const { signatureB64: _drop, ...unsigned } = next.payerAck;
    return { ...next, payerAck: signPayerAck({ ...unsigned, ...ackPatch }, TEST_ONLY_PAYER_KEY) };
  });
  return e0With(increments);
}

/** Re-signs a native commitment for (channel, amount) with the pinned test payer key. */
export function resignedCommitment(channelId: string, amount: string) {
  return buildOfflineCommitment(channelId, amount, TEST_ONLY_PAYER_KEY);
}

export interface FakeChainState {
  transaction: ObservedTransaction | Error;
  events: readonly ObservedEvent[] | Error;
  channel: ObservedChannel | Error;
}

/** Read-only chain double at the RPC port. Defaults describe an honest close of `e0`'s highest commitment. */
export function fakeChain(e0: EvidenceE0, trust: VerifierTrust, patch: Partial<FakeChainState> = {}) {
  const highest = e0.increments.at(-1)!.commitment;
  const amount = BigInt(highest.cumulativeAmountBaseUnits);
  const state: FakeChainState = {
    transaction: {
      status: 'SUCCESS',
      ledger: 1234,
      invocation: { contractId: trust.channelId, functionName: 'close', amount, signatureB64: highest.signatureB64 },
    },
    events: [
      { name: 'withdraw', to: trust.recipient, amount },
      { name: 'close' },
      { name: 'refund', from: trust.funder, amount: 10_000_000n - amount },
    ],
    channel: {
      commitmentKeyHex: bytesToHex(accountIdToPublicKey(trust.commitmentKey)),
      from: trust.funder,
      to: trust.recipient,
      token: trust.assetSac,
      balance: 0n,
      withdrawn: amount,
    },
    ...patch,
  };
  const calls: string[] = [];
  const answer = <T>(value: T | Error): Promise<T> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const reader: ChainReader = {
    getTransaction: (hash) => (calls.push(`getTransaction(${hash})`), answer(state.transaction)),
    getTransactionEvents: (channelId, ledger, hash) => (calls.push(`getTransactionEvents(${channelId},${ledger},${hash})`), answer(state.events)),
    readChannel: (channelId) => (calls.push(`readChannel(${channelId})`), answer(state.channel)),
  };
  return { reader, calls, state };
}
