import {
  AuthorizedIncrementSchema,
  EvidenceE0Schema,
  type AuthorizedIncrement,
  type EvidenceE0,
  type TariffSnapshot,
} from '@usagepay/contracts';

export class LedgerError extends Error {
  readonly code: 'E0_ALREADY_FINALIZED' | 'CUMULATIVE_NOT_MONOTONIC' | 'INVALID_INCREMENT';

  constructor(code: LedgerError['code'], message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/**
 * Single-process accepted-increment log (SPEC 02 §4 idempotency). It is demo storage, not production durability:
 * it lives in one process and is lost with it. Once E0 is finalized the log is frozen and refuses every addition.
 */
export interface IncrementLedger {
  readonly sessionId: string;
  increments(): readonly AuthorizedIncrement[];
  usedNonces(): ReadonlySet<string>;
  highest(): AuthorizedIncrement | undefined;
  append(increment: AuthorizedIncrement): void;
  /** Freezes the log into an immutable E0. E0 carries no closing transaction hash (no circular reference). */
  finalizeE0(finalizedAt: string): EvidenceE0;
  e0(): EvidenceE0 | undefined;
}

export function createIncrementLedger(config: { readonly sessionId: string; readonly tariff: TariffSnapshot }): IncrementLedger {
  const increments: AuthorizedIncrement[] = [];
  const nonces = new Set<string>();
  let frozen: EvidenceE0 | undefined;

  return {
    sessionId: config.sessionId,
    increments: () => [...increments],
    usedNonces: () => new Set(nonces),
    highest: () => increments.at(-1),
    append(increment) {
      if (frozen !== undefined) throw new LedgerError('E0_ALREADY_FINALIZED', 'E0 is finalized; no increment may be added');
      const parsed = AuthorizedIncrementSchema.safeParse(increment);
      if (!parsed.success) throw new LedgerError('INVALID_INCREMENT', parsed.error.message);
      if (parsed.data.sequence !== increments.length + 1) {
        throw new LedgerError('INVALID_INCREMENT', `expected sequence ${increments.length + 1}, got ${parsed.data.sequence}`);
      }
      const previous = increments.at(-1);
      if (previous !== undefined && BigInt(parsed.data.commitment.cumulativeAmountBaseUnits) <= BigInt(previous.commitment.cumulativeAmountBaseUnits)) {
        throw new LedgerError('CUMULATIVE_NOT_MONOTONIC', 'native cumulative commitments must strictly advance');
      }
      increments.push(structuredClone(parsed.data));
      nonces.add(parsed.data.payerAck.nonce);
    },
    finalizeE0(finalizedAt) {
      if (frozen !== undefined) throw new LedgerError('E0_ALREADY_FINALIZED', 'E0 was already finalized');
      frozen = deepFreeze(
        EvidenceE0Schema.parse({
          schema: 'usagepay.e0.v1',
          sessionId: config.sessionId,
          tariff: structuredClone(config.tariff),
          increments: structuredClone(increments),
          finalizedAt,
        }),
      );
      return frozen;
    },
    e0: () => frozen,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
