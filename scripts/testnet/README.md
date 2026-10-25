# Testnet scripts (G1)

Stellar Testnet only. Identities are disposable and live in the Stellar CLI keystore, outside the repository.
Testnet names use the `upay` prefix.

| Step | Command | Sends transactions |
|---|---|---|
| 1. Build the pinned `one-way-channel` wasm | `scripts/testnet/build-channel.sh` | no |
| 2–3. Identities, Friendbot XLM, USDC trustlines | `scripts/testnet/setup-identities.sh` | yes |
| — Fund `upay-g1-payer` with Testnet USDC | Circle faucet (manual) | yes |
| 4. Upload wasm, deploy and fund `upay-g1-channel` (1 USDC) | `scripts/testnet/deploy-channel.sh` | yes |
| 5–7. Commitments, ack gate, close, independent verification | `corepack pnpm g1:lifecycle` | yes (close) |

All scripts are idempotent except `g1:lifecycle`. It closes the channel, so a rerun needs a freshly deployed channel
(remove the `upay-g1-channel` alias, then run `deploy-channel.sh` again).

## G1 lifecycle (`g1/`)

- `payer.ts` fetches the evidence and recomputes it, then checks the 402 challenge.
  - It signs the native commitment with the pinned `@stellar/mpp` client, through `rawFetch` and `createCredential` with `cumulativeAmount`.
  - It captures the credential and rebuilds the signed XDR locally, comparing it with a `prepare_commitment` simulation.
  - It verifies the signature, then signs the payer evidence ack.
- `payee.ts` runs an mppx channel server with `recipient` and `currency` pinned.
  - An ack preflight runs before mppx verifies the credential.
  - A rejected ack never reaches the SDK store, so the stored cumulative does not advance.
  - The payee closes the channel with the highest accepted commitment.
- `verifier.ts` holds no secrets and starts from public data only. It reads the commitment key from contract instance storage. It then recomputes every message, digest and signature, and checks:
  - the close transaction call;
  - the `withdraw`/`close`/`refund` events;
  - the getters.
- Each run writes `runs/<runId>/trace.jsonl`, which the demo UI replays, plus `capture.json` and `summary.json`. These files contain only public data and are committed as evidence. Raw CLI logs (`runs/*.log`) stay local.
