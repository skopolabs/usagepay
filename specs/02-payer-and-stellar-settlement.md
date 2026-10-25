# SPEC 02 — Payer & Stellar Settlement

**Status:** Ready for implementation **after** SPEC 00 contract freeze and the native-commitment capture gate  
**HackMeridian:** 2026-10-25  
**Product authority:** UsagePay `01.1` v1.1.1  
**Implementation authority:** `specs/00-shared-contracts-and-engineering-rules.md`  
**Input contract:** SPEC 01 `MeteringOutcome` (`ACCEPTED` with `MeterReading` + `MeasurementCharge`)

**Mission:** Turn an accepted measured charge into a **fleet-approved, real Stellar MPP channel commitment**, cryptographically acknowledge the **specific consumption evidence**, and settle the latest approved cumulative commitment on **Stellar Testnet**. Provide authentic artifacts to SPEC 03. Do not assert that the channel contract enforces meter validity.

## 1. Ownership and non-negotiable scope

| P0 — implement | P1 — only after full P0 | Outside this module |
|---|---|---|
| Fleet-side policy gate and signing; actual `@stellar/mpp` challenge/credential exchange; native signature capture; separate payer evidence acknowledgement; per-channel monotonic accounting; persisted E0; one real Testnet close; chain observation recorded as E1; error outcomes and tests | SDK-provided dispute watcher / `close_start` response | Meter signatures and tariff engine (SPEC 01); independent replay verifier and UI (SPEC 03); custom contract, automated refunds, partial settlements, multiple fleet vehicles, channel-as-a-service, production HA, real funds |

**Role separation:** `fleet/payer` holds the channel commitment private key **and** uses it to sign a separately domain-separated `PayerEvidenceAck`. `CPO/payee` issues the MPP challenge, verifies commitments and acknowledges accepted service. **The payee must never receive the payer's signing secret.** Run payer and payee as separate roles/processes even if they share a monorepo.

**Absolute success boundary:** A `NativeCommitment` is a real signed MPP artifact, not a fabricated value with a copied amount. E0 contains immutable pre-settlement approved increments; E1 is created from **observed chain results after the close**. Mock RPC/credential fixtures must never be labeled Testnet success.

## 2. Data flow and trust boundaries

```text
SPEC 01: signed meter evidence + deterministic cumulative charge
                    |
                    v
[PAYER-controlled policy] -> cap, tariff identity, replay/order, channel pinning
                    |
            reject | approve
                    v
Native MPP 402 challenge -> fleet signs SDK-native cumulative commitment
                    |
                    v
Capture REAL credential/signature + reconstruct/verify exact native message bytes
                    |
                    v
Fleet signs SEPARATE payer evidence acknowledgement (reading/charge digest
    + native commitment digest + channel/network + cumulative amount + nonce)
                    |
                    v
PAYEE application preflight: verify both signatures and bindings BEFORE
    forwarding credential to the SDK's normal acceptance/verification path
                    |
                    v
SDK verifies/stores native commitment -> receipt + accepted increment -> E0
                    |
                    v
Recipient closes channel on Testnet -> inspect transaction -> create E1
                    |
                    v
SPEC 03: independent verification (no trust in stored success flags)
```

**Crucial integration gate:** Public `onProgress` events in the inspected SDK report cumulative amounts, **not** native signature bytes. The developer must establish a supported **HTTP/MPP credential boundary** that exposes the actual client-signed credential and permits app-level acknowledgement validation **before the payee treats that payment as accepted**. Do **not** assume an SDK hook exists, patch `node_modules`, copy an amount into a fake signature field, or accept a post-hoc payer acknowledgement as equivalent to pre-acceptance authorization. If the pinned SDK cannot support this design, record a **P0 BLOCKER** and propose the smallest compatible integration seam for human review; do not silently bypass this gate.

### Event ordering for one increment

1. SPEC 01 returns valid `MeterReading` and `MeasurementCharge`; payer independently checks schema, pinned `TariffSnapshot`, `readingDigest` and `evidenceDigest` (the payee's assertion alone is insufficient).
2. Fleet verifies charge continuity: expected new cumulative base units = previous approved cumulative + `deltaChargeBaseUnits`, within channel deposit and fleet cap. **Budget denial happens before any new native commitment or evidence acknowledgement is signed.**
3. Client processes an **authentic** MPP challenge with `channel` pinned by `allowedChannels` and `network` pinned to `stellar:testnet`. Enforce that the amount the SDK will actually sign equals the fleet's exact approved cumulative amount; do not trust a server-proposed amount without checking it.
4. Capture the SDK-native signed credential. Derive `signedMessageB64` using the **pinned SDK's exact commitment encoding** (or the existing contract's read-only `prepare_commitment`), and verify Ed25519 with the channel's on-chain commitment public key. Record the actual signature and `NativeCommitment` from SPEC 00.
5. Fleet signs `PayerEvidenceAck` covering the actual `commitmentDigest` and current `evidenceDigest` using the canonical domain-separated message from SPEC 00. Use a fresh nonce, and verify acks cannot be replayed or moved to another session/channel/network/amount.
6. Send the *unchanged native MPP credential* and the app acknowledgement through the selected supported integration boundary. The payee validates the original evidence binding before normal SDK payment verification/acceptance. **Do not create a competing payment protocol.**
7. Preserve the source evidence, native commitment, ack and acceptance status in a recoverable single-process demo record. Only mark an increment `ACCEPTED` after both the acknowledgement gate **and** the SDK's native verification pass. If payment or persistence is uncertain, report `PENDING` or a typed failure, never `ACCEPTED`.
8. After three approved increments, finalize **immutable** E0 **before** closing. Recipient executes one genuine Testnet channel `close` using the highest accepted native commitment.
9. Query Stellar RPC for the final transaction status and channel payout details. Emit E1 with the observed chain hash/status/amount. `NOT_FOUND`, timeout, unknown recipient/asset or `FAILED` **cannot produce a payment success claim**. SPEC 03 owns independent cross-checks.

**No circular references:** E0 contains no closing transaction hash. E1 references `e0Digest` and the observed closing transaction; anchoring E0/E1 on-chain is **P2**, not part of the close operation.

## 3. Canonical contracts and module ports

**Re-use the EXACT SPEC 00 runtime schemas.** Implement no extra cross-module schema. SPEC 01 owns meter parsing and charge calculation; SPEC 03 owns independent verification results. Local Payer/Settlement interfaces are an implementation convenience:

```ts
interface PayerAuthorizationPort {
  authorize(input: {
    reading: MeterReading;
    charge: MeasurementCharge;
    tariff: TariffSnapshot;
    channelId: string;
  }): Promise<
    | { kind: 'AUTHORIZED'; increment: AuthorizedIncrement }
    | { kind: 'REJECTED'; reasonCode: PayerRefusalCode; details: string }
    | { kind: 'PENDING'; reasonCode: string; details: string }
  >;
}

interface ChannelSettlementPort {
  closeLatest(input: {
    channelId: string;
    e0: EvidenceE0;
  }): Promise<
    | { kind: 'OBSERVED'; e1: EvidenceE1 }
    | { kind: 'PENDING'; reasonCode: string; details: string }
    | { kind: 'REJECTED'; reasonCode: string; details: string }
  >;
}
```

The `AUTHORIZED` result means **both** valid payer evidence approval and successful SDK native acceptance; it must never mean merely “the payer signed something”. `OBSERVED` means RPC was queried and E1 contains its **actual** status; **only a validated `SUCCESS`** may later be reported as settled. Do not expose private keys in interfaces, errors, fixtures, logs or demo bundles.

Use the SPEC 00 fields without renaming:

- `NativeCommitment`: actual `channelId`, `network`, `cumulativeAmountBaseUnits`, `signedMessageB64`, `signatureB64`, `commitmentKey`, `commitmentDigest`.
- `PayerEvidenceAck`: `sessionId`, `network`, `channelId`, `evidenceDigest`, `commitmentDigest`, `approvedCumulativeBaseUnits`, unique `nonce`, `payerKey`, `signatureB64`.
- `AuthorizedIncrement`: `sequence`, `reading`, `charge`, `commitment`, `payerAck`.
- `EvidenceE0`: `sessionId`, pinned `TariffSnapshot`, ordered increments, `finalizedAt`.
- `EvidenceE1`: `e0Digest`, network, channel, asset SAC, **real** `closeTxHash`, observed `txStatus`, optional observed `settledCumulativeBaseUnits`, verifier version.

`PayerEvidenceAck.signatureB64` is Ed25519 over `UTF8('usagepay.payer-evidence-ack.v1\n') + JCS(ackWithoutSignature)`, **not** over the native channel commitment XDR. Compute the ack **after** the native commitment exists. All digest encodings, nonces and amount strings follow SPEC 00.

## 4. Amounts, policy and state transitions

**P0 demo:** one fleet, one channel, one EV session; serialize payment requests for a single channel. Use integer `bigint` base units; only convert to a decimal string at the SDK interface with explicit asset precision. No floating-point pricing or independent SDK-side tariff logic.

| Increment | Accepted total usage | Tariff (example only) | Expected channel cumulative (7-decimal asset) |
|---|---:|---|---:|
| `r-001` | 250 Wh | 0.40 USDC/kWh | `1000000` |
| `r-002` | 500 Wh | 0.40 USDC/kWh | `2000000` |
| `r-003` | 750 Wh | 0.40 USDC/kWh | `3000000` |

**Budget test:** cap = `2500000` base units; first two intervals approved, third refused with `BUDGET_EXCEEDED`. The highest signed commitment remains `2000000`. Channel deposit and contract token/recipient must also be validated; a cap does **not** replace the channel's funded balance.

**Local P0 states:** `READY → CHALLENGED → NATIVE_SIGNED → ACK_SIGNED → ACCEPTED → E0_FINALIZED → SETTLING → SETTLED`; failures enter `REJECTED` (safe, no accepted value change) or `PENDING` (unknown outcome; do not retry with an incremented amount until reconciled). `E0_FINALIZED` forbids further additions. `SETTLED` requires a successful chain outcome; do not transition based on `sendTransaction` returning a hash alone.

**Idempotency:** unique `(domain, sessionId, readingId)` from SPEC 01, unique `(channelId, sessionId, nonce)` per ack, strictly advancing native cumulative signatures. Rejected/duplicate readings and rejected policy checks must not create a new payer signature. An uncertain SDK/close result must be read back, not handled by immediately creating a larger voucher. In a single-process demo, keep a coherent accepted increment log and highest signed commitment; SDK `Store.memory()` is acceptable **only for this isolated process**, not multi-instance production.

**Refusal codes** (module-local; stable and testable): `BUDGET_EXCEEDED`, `CHANNEL_NOT_PINNED`, `NETWORK_MISMATCH`, `ASSET_MISMATCH`, `RECIPIENT_MISMATCH`, `DEPOSIT_INSUFFICIENT`, `TARIFF_DIGEST_MISMATCH`, `EVIDENCE_DIGEST_MISMATCH`, `CHARGE_MISMATCH`, `CUMULATIVE_NOT_MONOTONIC`, `INVALID_NATIVE_CREDENTIAL`, `INVALID_NATIVE_SIGNATURE`, `INVALID_PAYER_ACK`, `REPLAY_NONCE`, `PAYMENT_NOT_ACCEPTED`, `E0_ALREADY_FINALIZED`, `SETTLEMENT_PENDING`, `SETTLEMENT_FAILED`, `RPC_UNAVAILABLE`, `SDK_CAPTURE_UNAVAILABLE`.

For AC05, AC06 and AC10 the payer returns the SPEC 01 codes that the frozen authorization catalogue assigns: `INVALID_METER_SIGNATURE`, `SIGNED_PAYLOAD_MISMATCH` and `DUPLICATE_READING` (G2).

## 5. Stellar implementation — use upstream primitives

### 5.1 Pre-event runtime feasibility gate (mandatory)

1. Lock compatible Node 22+, pnpm, `@stellar/mpp`, `mppx`, `@stellar/stellar-sdk`, `viem` and Stellar CLI versions in the SPEC 00 version manifest + project lockfile. **Do not mix versions from old docs.**
2. Use disposable payer and recipient **Testnet-only** identities. Establish the correct **Circle Testnet USDC trustlines/faucet**; `USDC_SAC_TESTNET` is a **C-address** for the token contract, not the classic asset issuer (`G-address`). Never use mainnet identities or expose secrets in a git repository.
3. Deploy/fund the experimental one-way-channel with the intended **actual asset SAC**, signer key and recipient. Inspect the channel contract's `token`, `to`, `from`, deposit/balance, `commitment_key` and network. Reject any mismatch.
4. Run the official `channel-client.ts` / `channel-server.ts` examples to produce **three native cumulative commitments**. Capture real signed credential bytes and verify the native message produced by the pinned SDK (using a read-only contract parity check if necessary). The SDK progress callback **does not contain the signature**; intercept at a supported HTTP/credential boundary.
5. Exercise the official close path and inspect the resulting Testnet transaction. Keep real addresses/transaction hashes **only in run outputs**, not hardcoded into static fixture JSON.
6. Verify the application acknowledgement can reach the payee and be checked **before SDK payment acceptance**. This is the only new authorization bridge built by UsagePay. If impossible with the pinned SDK public integration surfaces, mark the gate **BLOCKED** and report the exact constraint; do not implement a fake NativeCommitment or bypass the ack.

The upstream SDK internally signs **XDR `ScVal::Map` bytes** containing `amount`, `channel`, `domain` (`chancmmt`) and `network`. It does **not** sign UsagePay's evidence digest. When capturing the credential, decode the actual signature from its wire format (currently hex), convert to canonical `signatureB64` and validate against the message's original bytes. **Verify this against the pinned source and contract.** Do not implement a competing native signer.

### 5.2 API boundary checks

- **Client:** pin `allowedChannels`, `network: 'stellar:testnet'` and `commitmentKey`. Validate source data, exact approved cumulative and policy **before** creating/accepting a new credential. The native SDK may use a server-provided cumulative baseline; compare what it **actually signs** to SPEC 01's approved amount before the transaction is accepted.
- **Server:** configure `channel`, `commitmentKey`, expected `recipient`, `currency`, `network`, `checkOnChainState: true` and a store with atomic `update()` semantics. Preserve the SDK's own challenge replay and settling-state controls. The demo does not disable protections to simplify tests. The pinned `@stellar/mpp` 0.7.1 server enforces `recipient` and `currency` against `getChannelState`, so no app-side duplicate is needed (G1 D1).
- **Settlement:** use the official close operation (or direct existing contract close if the SDK-supported path is unsuitable), **with the highest actually accepted native voucher**. Confirm finalized chain result and channel payout; timeout/unknown state means `PENDING`.
  - With the pinned SDK, the MPP credential `action: 'close'` requires a commitment **strictly above** the stored cumulative. Closing at the highest accepted voucher therefore uses the standalone `close()` helper from `@stellar/mpp/channel/server`, with the recipient as envelope signer (the contract calls `to.require_auth()`) (G1 D4).
  - The contract `close` withdraws the payout to `to` **and refunds the remaining balance to `from` in the same transaction**; it emits `withdraw`, `close` and `refund`, and `balance()` becomes `0` (G1 D3).
- **Ack scope (G1 D5, D7):** the client signs inside `createCredential`, with no hook between known bytes and signature. Every payer pre-sign check (evidence, policy, budget, challenge channel/amount) therefore runs **before** `createCredential`. Ed25519 is deterministic: re-signing the same cumulative after an ack rejection yields the identical native signature the payee already holds. The ack protects the **evidence binding**; only the payer's pre-sign checks protect the payer's funds.
- **Watchers and refunds:** no hosted watcher, unattended refund recovery or auto-close guarantee in P0. P1 may use the official `watchChannel`/dispute callbacks without redesigning state.

**Important P0 restriction:** For this demo, one close after three serialized signed increments. Partial settlement, shared channels across vehicles, key rotation, multi-instance CAS durability and production dispute service belong to the post-hackathon UsagePay roadmap, **not** this SPEC.

## 6. Testing pyramid — explicit success and error paths

```text
      Demo smoke     one genuine Testnet channel, E0 then E1, visible tx link
       Testnet E2E   three real cumulative signatures → one confirmed close
  Integration tests native credential + payer ack gate + SPEC 00/01 fixtures
   Unit tests       policy, amounts, JCS/Ed25519, replay, state transitions
```

| Level / ID | Scenario | Input → required outcome |
|---|---|---|
| Unit `S1-B` | Fleet authorization | Valid `r-001` + pinned tariff/channel → expected `1000000` base units; sign real domain-separated ack **only after** native artifact is available |
| Unit `F2-B` **P0** | Over budget | Cap `2500000`, third interval → `BUDGET_EXCEEDED`; no new native signature/ack, highest approved stays `2000000` |
| Unit `F3-B` | Duplicate | Replay `r-002` or ack nonce → no additional accepted payment (`REPLAY_NONCE` or duplicate rejection) |
| Unit `F4-B` **P0** | Alter evidence authorization | Change `evidenceDigest`, tariff, channel, amount or native commitment after signing ack → `INVALID_PAYER_ACK` / `EVIDENCE_DIGEST_MISMATCH`; server refuses before native acceptance |
| Unit `F4-C` | Wrong credentials | Wrong network, unpinned channel, incorrect signer or stale cumulative → typed rejection, no accepted increment |
| Integration | SPEC 01 → SPEC 02 | Golden signed reading → independently reproduced charge → native credential captured → separate payer ack verified → accepted increment passes SPEC 00 schema |
| Integration | Failure propagation | Tampered source reading or incorrect tariff → no native SDK credential signing; malformed ack → no SDK payment acceptance |
| **Testnet E2E `S1` P0** | Full channel | Fund real channel → three real signed cumulative amounts `1000000`, `2000000`, `3000000` → E0 frozen → on-chain close `SUCCESS` → E1 with observed details; verifier integration deferred to SPEC 03/04 |
| Testnet negative | RPC delay or missing tx | Preserve unresolved state; no fabricated settled status or unbounded retry |
| Demo smoke | Human-readable trace | `readingId` → `evidenceDigest` → native commitment digest → ack verification → cumulative → real `closeTxHash`, without private secrets |

**Test isolation:** Pure unit tests run offline, using deterministic test-only keys/fixtures. Module integration uses SDK/RPC mocks **only at external boundaries**. The pinned SDK builds `rpc.Server` without `allowHttp`, so a local HTTP RPC cannot be injected. The offline boundary is therefore the `rpc.Server` client methods, and the real SDK client and server still run (G2). Keep real Testnet tests in a separate opt-in command and require an explicit test-only funding configuration. Record actual vs expected results and refusal reason codes; a mocked close may never satisfy the `S1` Testnet gate.

**Acceptance trace format (illustrative, not forged Testnet output):**

```text
S1-B / ev-session-001 / r-001
METER=ACCEPTED | CHARGE=1000000 | POLICY=APPROVED
NATIVE_COMMITMENT=VERIFIED (actual signature captured)
PAYER_EVIDENCE_ACK=VERIFIED (digest-bound, unique nonce)
SDK_ACCEPTED=true | CHANNEL_CUMULATIVE=1000000
...
S1 / SETTLEMENT=SUCCESS | E0_DIGEST=<computed> | TX=<observed Testnet hash>
```

## 7. Claude implementation order (no hidden tasks)

1. Read SPEC 00, SPEC 01 and the installed SDK source + official examples. **If native credential capture was not proven in the feasibility spike, stop and report BLOCKED.**
2. Implement payer-side policy/checks with pure tests first (`S1-B`, `F2-B`, `F3-B`), using SPEC 00/01 schemas. Do not sign until the policy approves.
3. Integrate the native SDK challenge/credential client-server flow. Capture original native signature and verify exact SDK/contract commitment preimage (`F4-C`). No handwritten native MPP signing.
4. Implement the separately domain-separated payer evidence acknowledgement and the **payee pre-acceptance verification boundary**; test mismatches (`F4-B`).
5. Preserve accepted `AuthorizedIncrement` records and finalize immutable E0 before close. Never persist success for an SDK-denied credential.
6. Implement one channel close using existing SDK/contract operations and inspect actual Testnet chain state; build E1 from real observations only. Run opt-in E2E test.
7. Run package tests, typecheck, build and a short reproducible integration run; provide evidence, actual addresses/tx hashes (test-only), error codes and the exact source/dependency revision to the SPEC 04 integrator.

**Definition of Done:** all P0 tests pass; fleet controls the commitment and ack keys; channel/network/recipient/token are pinned; native signatures and payer acks are independently verifiable; budget and invalid evidence never yield a payment; at least three native commitments strictly advance; one real Testnet close is observed and linked to immutable E0 via E1; any unknown network result stays **PENDING**; no mainnet, custom contract or hosted watcher was added.

## 8. Official implementation references

- [Stellar MPP SDK README](https://github.com/stellar/stellar-mpp-sdk) — dependency setup and actual channel APIs.
- [Channel client](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-client.ts) and [channel server](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-server.ts) — official 402 / credential examples.
- [MPP close through credential flow](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-close-mpp.ts) and [direct close](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-close.ts).
- [Native commitment XDR source](https://github.com/stellar/stellar-mpp-sdk/blob/main/sdk/src/channel/commitment.ts) — actual format of `buildCommitmentMessage`; **read-only reference, not a new UsagePay signing algorithm**.
- [One-way-channel Testnet demonstration](https://github.com/stellar-experimental/one-way-channel/blob/main/examples/demo.sh) — native-asset example; verify **USDC SAC** separately.
- [Official Stellar Agentic Payments skill](https://github.com/stellar/stellar-dev-skill/tree/main/skills/agentic-payments) — conceptual reference; prefer pinned code for API details.

**Stop rule:** Do not implement MPP itself, bypass real signature capture, add an unaudited custom contract, add a second adapter, claim an audited or legally certified payment service, or expand P0 into production operations. Build exactly this payer-to-settlement boundary.
