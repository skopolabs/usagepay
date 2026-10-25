import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceE1Schema, computeE0Digest, type EvidenceE0 } from '@usagepay/contracts';
import {
  IllegalTransitionError,
  LedgerError,
  createChannelSettlement,
  createIncrementLedger,
  createStateMachine,
  type ChainGateway,
  type CloseSubmission,
} from '../src/index.js';
import { golden, goldenEvidence, harness, randomContractId, type Harness } from './helpers.js';

/** Three genuinely SDK-signed increments (offline fake chain) and their finalized E0. */
async function acceptedSession(): Promise<{ h: Harness; e0: EvidenceE0 }> {
  const h = harness();
  try {
    for (const evidence of goldenEvidence) {
      const result = await h.payer.authorize({ ...evidence, tariff: golden.tariff, channelId: h.channelId });
      if (result.kind !== 'AUTHORIZED') throw new Error(`setup increment refused: ${JSON.stringify(result)}`);
    }
    return { h, e0: h.payer.finalizeE0('2026-10-25T09:05:00.000Z') };
  } finally {
    h.chain.restore();
  }
}

const TX = 'a'.repeat(64);

/** Scripted Stellar boundary: settlement logic runs for real, only the network answers are fixed. */
function gateway(script: {
  close?: () => CloseSubmission;
  status?: () => 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  withdrawn?: bigint;
}) {
  const calls = { close: [] as { amount: bigint; signature: string }[], getTransaction: 0 };
  const chain: ChainGateway = {
    async close({ amount, signature }) {
      calls.close.push({ amount, signature: Buffer.from(signature).toString('base64') });
      return script.close?.() ?? { kind: 'SUBMITTED', txHash: TX };
    },
    async getTransaction() {
      calls.getTransaction += 1;
      return { status: script.status?.() ?? 'SUCCESS', ledger: 42 };
    },
    async readWithdrawn() {
      return script.withdrawn ?? 3000000n;
    },
  };
  return { chain, calls };
}

function settlementFor(h: Harness, chain: ChainGateway) {
  return createChannelSettlement({
    channelId: h.channelId,
    assetSac: golden.tariff.assetSac,
    commitmentKey: h.commitmentKey.publicKey(),
    gateway: chain,
    highestAccepted: () => h.payee.highestAccepted(),
  });
}

describe('SPEC 02 settlement: close with the highest accepted voucher, E1 from observed chain state', () => {
  it('SUCCESS: closes with 3000000 and the captured native signature; E1 references E0 and the observed payout', async () => {
    const { h, e0 } = await acceptedSession();
    const { chain, calls } = gateway({});
    const settlement = settlementFor(h, chain);
    const result = await settlement.closeLatest({ channelId: h.channelId, e0 });
    expect(calls.close).toEqual([{ amount: 3000000n, signature: e0.increments[2]?.commitment.signatureB64 }]);
    expect(result).toEqual({
      kind: 'OBSERVED',
      e1: {
        schema: 'usagepay.e1.v1',
        e0Digest: computeE0Digest(e0),
        network: 'stellar:testnet',
        channelId: h.channelId,
        assetSac: golden.tariff.assetSac,
        closeTxHash: TX,
        txStatus: 'SUCCESS',
        settledCumulativeBaseUnits: '3000000',
        verifierVersion: 'usagepay-verifier.v1',
      },
    });
    expect(settlement.state).toBe('SETTLED');
    // Idempotent: a second call returns the same observation and never submits another close.
    expect(await settlement.closeLatest({ channelId: h.channelId, e0 })).toEqual(result);
    expect(calls.close).toHaveLength(1);
  });

  it('records the payout the chain reports, not the amount it asked for', async () => {
    const { h, e0 } = await acceptedSession();
    const result = await settlementFor(h, gateway({ withdrawn: 2000000n }).chain).closeLatest({ channelId: h.channelId, e0 });
    expect(result.kind === 'OBSERVED' && result.e1.settledCumulativeBaseUnits).toBe('2000000');
  });

  it('FAILED transaction: E1 states FAILED with no settled amount and the state is REJECTED', async () => {
    const { h, e0 } = await acceptedSession();
    const settlement = settlementFor(h, gateway({ close: () => ({ kind: 'UNKNOWN', txHash: TX, error: 'Close transaction failed: FAILED' }), status: () => 'FAILED' }).chain);
    const result = await settlement.closeLatest({ channelId: h.channelId, e0 });
    expect(result).toMatchObject({ kind: 'OBSERVED', e1: { txStatus: 'FAILED', closeTxHash: TX } });
    expect(result.kind === 'OBSERVED' && result.e1.settledCumulativeBaseUnits).toBeUndefined();
    expect(settlement.state).toBe('REJECTED');
  });

  it('unknown close outcome without a hash is PENDING and is never retried with a new close', async () => {
    const { h, e0 } = await acceptedSession();
    const { chain, calls } = gateway({ close: () => ({ kind: 'UNKNOWN', error: 'socket hang up' }) });
    const settlement = settlementFor(h, chain);
    expect(await settlement.closeLatest({ channelId: h.channelId, e0 })).toMatchObject({ kind: 'PENDING', reasonCode: 'SETTLEMENT_PENDING' });
    expect(await settlement.closeLatest({ channelId: h.channelId, e0 })).toMatchObject({ kind: 'PENDING', reasonCode: 'SETTLEMENT_PENDING' });
    expect(calls.close).toHaveLength(1);
    expect(settlement.state).toBe('PENDING');
  });

  it('RPC down after submission is PENDING; a later call re-reads the same hash and then settles', async () => {
    const { h, e0 } = await acceptedSession();
    let rpcUp = false;
    const { chain, calls } = gateway({});
    const flaky: ChainGateway = {
      ...chain,
      getTransaction: async (hash) => {
        if (!rpcUp) throw new Error('fetch failed');
        return chain.getTransaction(hash);
      },
    };
    const settlement = settlementFor(h, flaky);
    expect(await settlement.closeLatest({ channelId: h.channelId, e0 })).toMatchObject({ kind: 'PENDING', reasonCode: 'RPC_UNAVAILABLE' });
    expect(settlement.state).toBe('PENDING');
    expect(settlement.closeTxHash).toBe(TX);
    rpcUp = true;
    expect(await settlement.closeLatest({ channelId: h.channelId, e0 })).toMatchObject({ kind: 'OBSERVED', e1: { txStatus: 'SUCCESS' } });
    expect(calls.close).toHaveLength(1);
    expect(settlement.state).toBe('SETTLED');
  });

  it('NOT_FOUND is observed as such and stays PENDING, never settled', async () => {
    const { h, e0 } = await acceptedSession();
    let status: 'NOT_FOUND' | 'SUCCESS' = 'NOT_FOUND';
    const settlement = settlementFor(h, gateway({ status: () => status }).chain);
    const first = await settlement.closeLatest({ channelId: h.channelId, e0 });
    expect(first).toMatchObject({ kind: 'OBSERVED', e1: { txStatus: 'NOT_FOUND' } });
    expect(first.kind === 'OBSERVED' && EvidenceE1Schema.safeParse(first.e1).success).toBe(true);
    expect(settlement.state).toBe('PENDING');
    status = 'SUCCESS';
    expect(await settlement.closeLatest({ channelId: h.channelId, e0 })).toMatchObject({ e1: { txStatus: 'SUCCESS' } });
    expect(settlement.state).toBe('SETTLED');
  });

  it('refuses an E0 that does not end with the highest accepted commitment', async () => {
    const { h, e0 } = await acceptedSession();
    const { chain, calls } = gateway({});
    const truncated = { ...e0, increments: e0.increments.slice(0, 2) };
    expect(await settlementFor(h, chain).closeLatest({ channelId: h.channelId, e0: truncated })).toMatchObject({
      kind: 'REJECTED',
      reasonCode: 'E0_NOT_LATEST_ACCEPTED',
    });
    expect(calls.close).toEqual([]);
  });

  it('refuses an unpinned channel and a second, different E0', async () => {
    const { h, e0 } = await acceptedSession();
    const settlement = settlementFor(h, gateway({}).chain);
    expect(await settlement.closeLatest({ channelId: randomContractId(), e0 })).toMatchObject({ reasonCode: 'CHANNEL_NOT_PINNED' });
    await settlement.closeLatest({ channelId: h.channelId, e0 });
    const other = { ...e0, finalizedAt: '2026-10-25T09:06:00.000Z' };
    expect(await settlement.closeLatest({ channelId: h.channelId, e0: other })).toMatchObject({ reasonCode: 'E0_ALREADY_FINALIZED' });
  });
});

describe('SPEC 02 local states and the increment ledger', () => {
  it('walks the increment loop, finalizes E0 and settles', () => {
    const machine = createStateMachine();
    for (const state of ['CHALLENGED', 'NATIVE_SIGNED', 'ACK_SIGNED', 'ACCEPTED', 'READY', 'E0_FINALIZED', 'SETTLING', 'SETTLED'] as const) {
      machine.transition(state);
    }
    expect(machine.history).toEqual(['READY', 'CHALLENGED', 'NATIVE_SIGNED', 'ACK_SIGNED', 'ACCEPTED', 'READY', 'E0_FINALIZED', 'SETTLING', 'SETTLED']);
  });

  it.each([
    ['READY', 'ACCEPTED'],
    ['CHALLENGED', 'ACK_SIGNED'],
    ['SETTLED', 'SETTLING'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(() => createStateMachine(from).transition(to)).toThrow(IllegalTransitionError);
  });

  it('PENDING leaves only through reconciliation, never into a new challenge', () => {
    const machine = createStateMachine('CHALLENGED');
    machine.transition('PENDING');
    expect(() => machine.transition('CHALLENGED')).toThrow(IllegalTransitionError);
    expect(() => machine.transition('SETTLING')).toThrow(IllegalTransitionError);
    machine.transition('REJECTED');
    machine.transition('READY');
  });

  it('a failed settlement never reopens the increment loop', () => {
    const machine = createStateMachine('E0_FINALIZED');
    machine.transition('SETTLING');
    machine.transition('REJECTED');
    expect(() => machine.transition('READY')).toThrow(IllegalTransitionError);
  });

  it('E0 is frozen and the ledger refuses additions after finalization', () => {
    const ledger = createIncrementLedger({ sessionId: golden.inputs.session.sessionId, tariff: golden.tariff });
    ledger.append(golden.increments[0]!);
    const e0 = ledger.finalizeE0('2026-10-25T09:05:00.000Z');
    expect(Object.isFrozen(e0)).toBe(true);
    expect(() => ledger.append(golden.increments[1]!)).toThrow(LedgerError);
    expect(() => ledger.finalizeE0('2026-10-25T09:06:00.000Z')).toThrow(/already finalized/);
    expect(ledger.e0()).toBe(e0);
  });

  it('the ledger refuses out-of-order and non-advancing increments', () => {
    const ledger = createIncrementLedger({ sessionId: golden.inputs.session.sessionId, tariff: golden.tariff });
    expect(() => ledger.append(golden.increments[1]!)).toThrow(/expected sequence 1/);
    ledger.append(golden.increments[0]!);
    expect(() => ledger.append({ ...golden.increments[0]!, sequence: 2 })).toThrow(/strictly advance/);
  });
});
