/**
 * SPEC 04 §5 opt-in rule for the live Testnet E2E: it spends disposable Testnet funds, so it must refuse to run
 * unless explicitly enabled, and refuse any configuration that is not Stellar Testnet.
 */
export const E2E_OPT_IN = 'UPAY_TESTNET_E2E';
export const TESTNET_ID = 'stellar:testnet';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export interface TestnetGuardInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `network` block of implementation-versions.json. */
  readonly network: { readonly id?: unknown; readonly networkPassphrase?: unknown } | undefined;
  readonly rpcUrl: string;
  /** Passphrase the RPC endpoint reports (`getNetwork`), when already queried. */
  readonly rpcPassphrase?: string;
}

/** `null` when the run may proceed; otherwise the refusal reason. */
export function testnetGuard(input: TestnetGuardInput): string | null {
  if (input.env[E2E_OPT_IN] !== '1') return `refusing: live Testnet E2E is opt-in; set ${E2E_OPT_IN}=1 (it spends disposable Testnet funds)`;
  if (input.network === undefined) return 'refusing: no network configuration in implementation-versions.json';
  if (input.network.id !== TESTNET_ID) return `refusing: configured network ${String(input.network.id)} is not ${TESTNET_ID}`;
  if (input.network.networkPassphrase !== TESTNET_PASSPHRASE) return 'refusing: configured passphrase is not the Stellar Testnet passphrase';
  if (/mainnet|pubnet|public/i.test(input.rpcUrl) || !/testnet/i.test(input.rpcUrl)) return `refusing: RPC ${input.rpcUrl} is not a Testnet endpoint`;
  if (input.rpcPassphrase !== undefined && input.rpcPassphrase !== TESTNET_PASSPHRASE) return `refusing: RPC ${input.rpcUrl} reports a non-Testnet passphrase`;
  return null;
}
