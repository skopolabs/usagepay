/**
 * SPEC 02 §4 local P0 states. One machine per payer session: each increment walks READY -> CHALLENGED ->
 * NATIVE_SIGNED -> ACK_SIGNED -> ACCEPTED and returns to READY; E0_FINALIZED closes the increment loop for good.
 * REJECTED is safe (no accepted value change) and returns to READY. PENDING is an unknown outcome: it only leaves
 * through reconciliation (or, after E0, by re-reading the same close transaction), never by signing a larger amount.
 */
export const SETTLEMENT_STATES = [
  'READY',
  'CHALLENGED',
  'NATIVE_SIGNED',
  'ACK_SIGNED',
  'ACCEPTED',
  'E0_FINALIZED',
  'SETTLING',
  'SETTLED',
  'REJECTED',
  'PENDING',
] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

const TRANSITIONS: Readonly<Record<SettlementState, readonly SettlementState[]>> = {
  READY: ['CHALLENGED', 'REJECTED', 'E0_FINALIZED'],
  CHALLENGED: ['NATIVE_SIGNED', 'REJECTED', 'PENDING'],
  NATIVE_SIGNED: ['ACK_SIGNED', 'REJECTED', 'PENDING'],
  ACK_SIGNED: ['ACCEPTED', 'REJECTED', 'PENDING'],
  ACCEPTED: ['READY'],
  REJECTED: ['READY'],
  PENDING: ['ACCEPTED', 'REJECTED', 'SETTLING'],
  E0_FINALIZED: ['SETTLING'],
  SETTLING: ['SETTLED', 'PENDING', 'REJECTED'],
  SETTLED: [],
};

/** States that may only be reached before E0 is finalized. */
const INCREMENT_STATES: ReadonlySet<SettlementState> = new Set(['READY', 'CHALLENGED', 'NATIVE_SIGNED', 'ACK_SIGNED', 'ACCEPTED']);

export class IllegalTransitionError extends Error {
  readonly from: SettlementState;
  readonly to: SettlementState;

  constructor(from: SettlementState, to: SettlementState) {
    super(`illegal settlement state transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export interface StateMachine {
  readonly state: SettlementState;
  readonly history: readonly SettlementState[];
  readonly finalized: boolean;
  transition(to: SettlementState): void;
}

export function createStateMachine(initial: SettlementState = 'READY'): StateMachine {
  const history: SettlementState[] = [initial];
  let finalized = initial === 'E0_FINALIZED';
  return {
    get state() {
      return history.at(-1) ?? initial;
    },
    get history() {
      return [...history];
    },
    get finalized() {
      return finalized;
    },
    transition(to) {
      const from = history.at(-1) ?? initial;
      // After E0 is finalized, REJECTED/PENDING belong to settlement and never reopen the increment loop.
      const allowed = TRANSITIONS[from].includes(to) && (finalized ? !INCREMENT_STATES.has(to) : to !== 'SETTLING');
      if (!allowed) throw new IllegalTransitionError(from, to);
      if (to === 'E0_FINALIZED') finalized = true;
      history.push(to);
    },
  };
}
