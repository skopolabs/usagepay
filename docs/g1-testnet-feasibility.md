# G1 — Testnet feasibility report

**Result: PASS. All 35 checks passed.** Run `g1-2026-10-25T11-49-48-724Z` on `stellar:testnet` (protocol 29, stellar-rpc 30.0.0).
Evidence: `scripts/testnet/runs/g1-2026-10-25T11-49-48-724Z/` (`summary.json`, `trace.jsonl`, `capture.json`).

Evidence class: TESTNET_LIVE for the commitments, acks and settlement. The meter readings and charges are the
OFFLINE_FIXTURE golden S1 session. Real metering starts in G2.

## Public proof

| Item | Value |
|---|---|
| Channel (`upay-g1-channel`) | `CBDYDMFWEZXPLEZVIWGOPK6W3FNSBNEZNFHUZ4GQKS3DA4OZHJKOGXN4` |
| Wasm (one-way-channel `25dea1b`) | sha256 `d662c1217f2452115d1a3392f21f097acc458fa6ff77dafd84c0d637b9745d90` (reproducible build, 12385 bytes) |
| Wasm upload tx | none in this deployment: the content-addressed wasm was already installed on Testnet, so the CLI skipped the install |
| Deploy + 1 USDC deposit tx | `56f298ba7890d73cc11c5fd35c46f792076dd34bdaf74c6ff59d3ee3733097f7` |
| Close tx (ledger 5381082) | `ee5598ca5f5ea5fda213282bd7f2fc23a0ab53bf947ae28b2c0393ff4ff74543` |
| Events in close tx | `withdraw {to: recipient, amount: 3000000}`, `close`, `refund {amount: 7000000}` |
| Balances (USDC) | recipient 1.5 → 1.8; funder 17.5 → 18.2 |

## What was demonstrated

1. **Native commitments.** There were three real MPP channel commitments (1,000,000 → 2,000,000 → 3,000,000 base units). They were signed by the pinned `@stellar/mpp` 0.7.1 client and accepted by its server with `checkOnChainState`, `recipient` and `currency`.
2. **Credential capture at the HTTP boundary.** On the payer side the credential comes from `createCredential`. On the payee side it comes from `Credential.fromRequest`. No SDK code was patched.
3. **Signed bytes are known.** The `prepare_commitment` simulation output is byte-identical to a locally built XDR `ScVal::Map {amount, channel, domain: "chancmmt", network: SHA-256(passphrase)}`.
4. **Signature verification.** Every captured signature verifies (strict Ed25519) under the `CommitmentKey` read from contract instance storage.
5. **Pre-acceptance ack gate.** Each credential travels with a payer-signed `usagepay.payer-ack.v1`. That ack binds the evidence digest, the exact commitment digest, the amount, the channel and the network. The payee checks it before mppx sees the credential.
   - Negative 1 (stale evidence digest) was rejected with `409 ACK_EVIDENCE_MISMATCH`, and the stored cumulative stayed at 2,000,000.
   - Negative 2 (foreign signer) was rejected with `409 ACK_PAYER_KEY_MISMATCH`, and the stored cumulative stayed at 2,000,000.
6. **On-chain close and independent verification.** The payee closed the channel with the highest accepted commitment. A secret-free verifier then checked:
   - the call arguments of the close transaction;
   - the events;
   - the getters (`withdrawn = 3000000`, `balance = 0`, parties and token);
   - the balance deltas from Horizon.

## Deltas versus the specs and the plan

| # | Finding | Impact / action |
|---|---|---|
| D1 | `@stellar/mpp` 0.7.1 channel server **does** accept `recipient` and `currency` and enforces them against `getChannelState`. | The planned app-side check (T5) is not needed. Pin both in the payee config. |
| D2 | One-way-channel has no `commitment_key` getter. The key is in instance storage (`CommitmentKey`) and in the `Open` event. | V08 must read instance storage (implemented in `verifier.ts`). Fixes T6. |
| D3 | `close` withdraws the payout **and auto-refunds the remaining balance to the funder in the same transaction**, so `balance()` becomes 0. | E1 and the verifier must expect a `refund` event and `balance = 0`, not a residual balance. |
| D4 | The `close` action of the MPP credential path requires a commitment strictly above the stored cumulative. Closing at the last accepted voucher therefore needs the standalone `close()` helper, or a new higher commitment. | G1 uses `close()` with the highest accepted commitment. SPEC 02 should name this path. |
| D5 | Ed25519 is deterministic: a payer that re-signs the same cumulative after an ack rejection produces the identical native signature. In both negative cases, the payee already held a valid native signature for 3,000,000 (`7e365121…`). | Confirms caveat T4. The ack protects the evidence binding, not the payer's funds. The payer's pre-sign checks are the only protection for the payer. The pitch must say so. |
| D6 | Getters and transactions are visible through RPC only within its retention window (about 7 days for events). Contract instance TTL after deploy was about 120k ledgers. | The verifier reports `NOT_AVAILABLE` outside retention (implemented for `getTransaction`). Fixes T7. The demo channel must be redeployed within about a week of the event. The next Testnet reset is 2026-12-16. |
| D7 | The SDK client signs inside `createCredential`, so the payer's pre-sign checks must run before that call. The SDK has no hook between "bytes known" and "signature produced". | The payer checks evidence and the challenge first. The credential bytes are re-checked after signing (the SDK also runs `assertCommitmentBinds`). |
| D8 | Root workspace now depends on `@usagepay/contracts` and `@usagepay/fixtures` (`workspace:*`). The scripts run as TypeScript directly on Node 22.22 (type stripping). | No new external dependencies. The lockfile changed only by these links. |

## Known gaps (not G1 scope)

- AC13 (budget cap) is still not enforced by the verifier. Planned for G2.
- The payer's pre-sign checks are a G1 subset. The full set of authorization-critical conditions AC01–AC17 lands in G2.
- Payer, payee and verifier share one process. They share no secrets, and storage is `Store.memory()`, which is not durable.
