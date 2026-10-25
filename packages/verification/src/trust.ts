import { z } from 'zod';
import {
  IdentifierSchema,
  NetworkSchema,
  PositiveDecimalStringSchema,
  Sha256HexSchema,
  StellarAccountIdSchema,
  StellarContractIdSchema,
  accountIdToPublicKey,
  type NETWORK,
} from '@usagepay/contracts';

/**
 * Trust inputs pinned outside the evidence (SPEC 03 §5). None of these may be learned from E0/E1: the verifier
 * compares the evidence against them. `commitmentKey` is the channel commitment key, which also signs payer acks;
 * V08 confirms it against on-chain storage.
 */
export interface VerifierTrust {
  readonly network: typeof NETWORK;
  readonly sessionId: string;
  readonly channelId: string;
  readonly recipient: string;
  readonly funder: string;
  readonly assetSac: string;
  readonly commitmentKey: string;
  readonly tariffVersionDigest: string;
  /** Fleet budget cap (AC13), re-checked by V03. */
  readonly budgetCapBaseUnits: string;
  /** Pinned meter keys: signerKeyId -> raw Ed25519 public key. */
  readonly meterKeys: ReadonlyMap<string, Uint8Array>;
}

/** JSON form of the trust inputs for the CLI; meter keys are given as G-addresses. */
export const TrustFileSchema = z.strictObject({
  schema: z.literal('usagepay.verifier-trust.v1'),
  network: NetworkSchema,
  sessionId: IdentifierSchema,
  channelId: StellarContractIdSchema,
  recipient: StellarAccountIdSchema,
  funder: StellarAccountIdSchema,
  assetSac: StellarContractIdSchema,
  commitmentKey: StellarAccountIdSchema,
  tariffVersionDigest: Sha256HexSchema,
  budgetCapBaseUnits: PositiveDecimalStringSchema,
  meterKeys: z.record(IdentifierSchema, StellarAccountIdSchema).refine((keys) => Object.keys(keys).length > 0, 'at least one pinned meter key'),
});

export function trustFromFile(json: unknown): VerifierTrust {
  const { schema: _schema, meterKeys, ...pinned } = TrustFileSchema.parse(json);
  return { ...pinned, meterKeys: new Map(Object.entries(meterKeys).map(([keyId, accountId]) => [keyId, accountIdToPublicKey(accountId)])) };
}
