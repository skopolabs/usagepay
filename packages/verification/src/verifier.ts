import { computeE0Digest, type VerificationResult } from '@usagepay/contracts';
import { checkChain, type ChainReader } from './chain.js';
import { xdrCommitmentEncoding, type CommitmentEncoding } from './encoding.js';
import {
  checkE0E1Link,
  checkEvidence,
  checkMeter,
  checkNativeCommitments,
  checkPayerAcks,
  checkSchemas,
  checkTariff,
  replayCharges,
} from './offline.js';
import { notAvailable, overallVerdict, type CheckId } from './result.js';
import type { VerifierTrust } from './trust.js';

export const DEFAULT_RPC_TIMEOUT_MS = 15_000;

export interface VerifierConfig {
  readonly trust: VerifierTrust;
  /** Read-only RPC. Without it the run is offline and V08 (so the overall verdict) is NOT_AVAILABLE. */
  readonly chain?: ChainReader;
  /** Commitment byte encoding; defaults to the pinned one-way-channel XDR encoding. */
  readonly encoding?: CommitmentEncoding;
  readonly timeoutMs?: number;
}

/** Safe, traceable identification of what was verified (public values only). */
export interface VerificationSubject {
  readonly sessionId?: string;
  readonly e0Digest?: string;
  readonly closeTxHash?: string;
  readonly increments: readonly { readonly readingId: string; readonly cumulativeWh: string; readonly cumulativeChargeBaseUnits: string }[];
}

/** Module-local report: SPEC 00 `VerificationResult` per check, unchanged in shape, plus the derived verdict. */
export interface VerificationReport {
  readonly overall: VerificationResult;
  readonly checks: Readonly<Record<CheckId, VerificationResult>>;
  readonly subject: VerificationSubject;
}

/** SPEC 03 §5. Inputs are untrusted (`unknown`) and validated before any RPC query. */
export interface VerificationPort {
  verify(input: { readonly e0: unknown; readonly e1: unknown }): Promise<VerificationReport>;
}

export function createVerifier(config: VerifierConfig): VerificationPort {
  const { trust } = config;
  const encoding = config.encoding ?? xdrCommitmentEncoding;
  const timeoutMs = config.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  return {
    async verify(input) {
      const schema = checkSchemas(input.e0, input.e1);
      const { e0, e1 } = schema;
      const skipped = (what: string) => notAvailable('PRECONDITION_FAILED', `not evaluated: ${what} failed V01_SCHEMA`);
      let checks: Record<CheckId, VerificationResult>;
      if (e0 === undefined) {
        const none = skipped('E0');
        checks = { V01_SCHEMA: schema.result, V02_METER: none, V03_TARIFF: none, V04_EVIDENCE: none, V05_MPP: none, V06_PAYER_ACK: none, V07_E0_E1_LINK: none, V08_CHAIN: none };
      } else {
        const replay = replayCharges(e0);
        checks = {
          V01_SCHEMA: schema.result,
          V02_METER: checkMeter(e0, trust),
          V03_TARIFF: checkTariff(e0, trust, replay),
          V04_EVIDENCE: checkEvidence(e0, trust),
          V05_MPP: checkNativeCommitments(e0, trust, encoding, replay),
          V06_PAYER_ACK: checkPayerAcks(e0, trust),
          V07_E0_E1_LINK: e1 === undefined ? skipped('E1') : checkE0E1Link(e0, e1, trust),
          V08_CHAIN:
            e1 === undefined
              ? skipped('E1')
              : config.chain === undefined
                ? notAvailable('CHAIN_NOT_QUERIED', 'offline run: Stellar RPC was not queried, so the settlement is not proven')
                : await checkChain({ e0, e1, trust, chain: config.chain, timeoutMs }),
        };
      }
      const subject: VerificationSubject = {
        ...(e0 === undefined ? {} : { sessionId: e0.sessionId, e0Digest: computeE0Digest(e0) }),
        ...(e1 === undefined ? {} : { closeTxHash: e1.closeTxHash }),
        increments: (e0?.increments ?? []).map(({ charge }) => ({
          readingId: charge.readingId,
          cumulativeWh: charge.cumulativeWh,
          cumulativeChargeBaseUnits: charge.cumulativeChargeBaseUnits,
        })),
      };
      return { overall: overallVerdict(checks), checks, subject };
    },
  };
}
