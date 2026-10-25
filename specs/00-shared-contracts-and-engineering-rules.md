# SPEC 00 — Shared Contracts and Engineering Rules

**Status:** Ready for implementation · **HackMeridian:** 2026-10-25  
**Product authority:** `01.1-usagepay-technical-architecture-and-roadmap.md` v1.1.1  
**Purpose:** Freeze the interfaces that make SPECs 01–03 independently implementable. This document governs implementation contracts only; it does not replace product scope or the roadmap.

## 1. Non-negotiable scope

Implement one honest, reproducible **Stellar Testnet** flow: simulated EV meter evidence → pinned tariff → fleet-side approval → **actual MPP cumulative channel commitments** → contract settlement → an independently repeatable verification report.

**P0:** one EV-shaped adapter, multiple actual cumulative commitments, budget rejection and tampered-signed-reading rejection, off-chain payer-signed evidence acknowledgement, immutable E0 followed by E1, verified chain outcome, tests, runnable demo.  
**P1 only after P0:** second non-EV adapter, provisional/end-only reading behavior, SDK watcher.  
**P2/out:** multi-vehicle shared channel, on-chain E0 anchor, OCPI CDR export, production-grade durability, certified OCPP/OCMF integration, custom smart contracts, mainnet, VeilPay, FlowCredit.

**Explicit limitations:** simulated device signatures are not evidence of legal calibration; native channel signatures do not enforce metering; app-level linkage is not atomic on-chain payment validation; standard USDC transactions disclose financial metadata. An approval refusal does **not** physically pause charging.

## 2. Approved implementation choices

| Decision | Rule |
|---|---|
| Language/runtime | TypeScript, Node.js **22+**, pnpm version compatible with the resolved MPP SDK (its current README requires pnpm 10.33+) |
| Network | `stellar:testnet` only, explicitly pinned in clients and verification |
| Payment implementation | `@stellar/mpp` + compatible `mppx`, `@stellar/stellar-sdk`, experimental `one-way-channel` contract; no reimplementation of MPP signing |
| Asset | Circle testnet USDC SAC as exported by the **installed SDK** (`USDC_SAC_TESTNET`); check actual contract asset and decimals on-chain; never mistake the classic `G...` issuer for the `C...` SAC |
| Wallet/key model | Distinct test-only meter signing identity and fleet-controlled channel commitment key; operator/payee has no access to fleet signing secrets |
| Store | One-process reference store is allowed for hackathon; keep highest accepted commitment, meter payloads and E0/E1 recoverable for demo; **no HA/SLA claim** |
| UI | Small Verify view or CLI; no new wallet UX, consumer payment app, authentication SaaS or frontend framework requirement |
| Code organization | Monorepo with `packages/contracts`, `packages/metering`, `packages/settlement`, `packages/verification`, `apps/demo`, `fixtures`, `scripts/testnet` |
| Dependencies | Resolve and **pin exact versions and repository SHAs before implementation**; commit one pnpm lockfile; never copy examples whose dependency versions differ from installed packages |

The currently published SDK exposes `@stellar/mpp/channel/client`, `@stellar/mpp/channel/server`, channel `close`, `getChannelState` and `watchChannel`, but exact behavior must be verified against the pinned version. **Do not fabricate an SDK API, signature format, or settlement proof.**

## 3. Execution gates: G0 offline contract freeze, then G1 Testnet feasibility

**G0 — offline only (first Claude Code assignment):**

1. Scaffold the workspace and `packages/contracts`; implement runtime schemas/types, canonicalization, deterministic test fixtures and contract tests. Do not implement business modules.
2. Resolve and pin compatible Node/pnpm/dependency versions, CLI version, official skill revision and actual MPP SDK source commit in `implementation-versions.json`; commit the lockfile.
3. Run offline unit/contract tests, typecheck and build. Report actual command results and **stop after G0**. Do not create/fund channels, sign live credentials, call Testnet or claim a demonstrated MPP integration in G0.

**G1 — separate assignment after G0 passes:**

1. With disposable funded Testnet identities, run the upstream *channel end-to-end* example (deploy/fund, sign at least three cumulative commitments, close, independently inspect the transaction). Prepare Circle testnet faucet/trustlines manually if CAPTCHA blocks automation. Keep real transaction hashes and account IDs as **runtime outputs**, never static fabricated fixtures.
2. **Native credential capture:** demonstrate access to the actual native signed commitment bytes (or exact SDK-defined signed preimage plus signature), channel ID, cumulative amount, verification key and native verification routine. Capture at the SDK/HTTP application boundary if necessary; do not modify MPP signing semantics. A progress callback is not sufficient proof.
3. **Pre-acceptance acknowledgement gate:** demonstrate a supported application/HTTP boundary that permits the payer to sign a separate acknowledgement of the *actual* native commitment and evidence digest, and permits the payee to verify this binding **before treating the credential as accepted** by the SDK. Test rejection for a mismatched acknowledgement and show that no new commitment is accepted. Do not assume a hook exists or claim that post-hoc linkage is equivalent.
4. Record `PASS/FAIL/BLOCKED` with redacted commands, versions and real public chain evidence in `scripts/testnet/` run output. If either capture or pre-acceptance checking cannot be implemented without unsupported SDK modification, report a **P0 BLOCKER** and stop for human review. If channel operation fails, the documented **MPP Charge fallback** has reduced claims and must not count as passing channel-specific P0 acceptance.

Parallel business-module implementation begins only after G0 contracts are frozen **and** the G1 native-credential capture/pre-acceptance gate passes. If G1 is blocked, identify the smallest integration seam rather than inventing signatures or changing the product scope.

## 4. Canonical cross-module data contract (version 1)

All fields below are required unless marked `?`. Types are implementation contracts; names of upstream SDK structures are **not** asserted. Every byte/string conversion must be deterministic and round-trip testable.

```ts
type Hex = string;                 // lowercase, 0x-free hex; schema validates lengths
type DecimalString = string;       // nonnegative base-10 integer, no exponent or decimal point
type Base64 = string;
type IsoTime = string;             // UTC ISO8601; normalized and validated
type Assurance = 'L0'|'L1'|'L2';
type ReadingCoverage = 'intermediate_unsigned'|'intermediate_signed'|'terminal_signed';

type MeterReading = {
  schema: 'usagepay.reading.v1';
  readingId: string; sessionId: string; machineId: string;
  domain: 'ev.ocpp2x';
  observedAt: IsoTime; intervalStart: IsoTime; intervalEnd: IsoTime; // [start,end)
  deltaWh: DecimalString; // integer Wh, NOT a floating-point kWh
  rawPayloadB64: Base64;  // exact signed/source bytes, NOT reserialized JSON
  signatureB64?: Base64; signerKeyId?: string;
  assurance: Assurance; coverage: ReadingCoverage;
  certification: 'simulated'|'unknown'|'vendor_attested'|'independently_checked';
};

type TariffSnapshot = {
  schema: 'usagepay.tariff.v1'; tariffId: string;
  assetSac: string; assetDecimals: number; currencyCode: 'USDC';
  unit: 'kWh'; pricePerKwhBaseUnits: DecimalString;
  rounding: 'floor_cumulative'; validFrom: IsoTime; validUntil?: IsoTime;
  versionDigest: Hex; // SHA256 of canonical tariff fields excluding versionDigest
};

type MeasurementCharge = {
  schema: 'usagepay.charge.v1'; readingId: string; sessionId: string;
  readingDigest: Hex; tariffVersionDigest: Hex;
  cumulativeWh: DecimalString; cumulativeChargeBaseUnits: DecimalString;
  deltaChargeBaseUnits: DecimalString; // current cumulative charge - prior cumulative charge
  evidenceDigest: Hex; // digest of canonical reading + tariff + calculated values
};

type NativeCommitment = {
  schema: 'usagepay.native-commitment.v1';
  channelId: string; network: 'stellar:testnet';
  cumulativeAmountBaseUnits: DecimalString;
  signedMessageB64: Base64; signatureB64: Base64;
  commitmentKey: string; // G... public ed25519 key pinned to channel
  commitmentDigest: Hex; // SHA256 of canonical {signedMessageB64, signatureB64}
};

type PayerEvidenceAck = {
  schema: 'usagepay.payer-ack.v1'; sessionId: string;
  network: 'stellar:testnet'; channelId: string;
  evidenceDigest: Hex; commitmentDigest: Hex;
  approvedCumulativeBaseUnits: DecimalString;
  nonce: string; payerKey: string; // pinned channel commitment key in demo
  signatureB64: Base64;
};

type AuthorizedIncrement = {
  schema: 'usagepay.increment.v1'; sequence: number;
  reading: MeterReading; charge: MeasurementCharge;
  commitment: NativeCommitment; payerAck: PayerEvidenceAck;
};

type EvidenceE0 = {
  schema: 'usagepay.e0.v1'; sessionId: string;
  tariff: TariffSnapshot; increments: AuthorizedIncrement[];
  finalizedAt: IsoTime; // E0 content is immutable before settlement
};

type EvidenceE1 = {
  schema: 'usagepay.e1.v1'; e0Digest: Hex;
  network: 'stellar:testnet'; channelId: string; assetSac: string;
  closeTxHash: Hex; txStatus: 'SUCCESS'|'FAILED'|'NOT_FOUND';
  settledCumulativeBaseUnits?: DecimalString;
  verifierVersion: 'usagepay-verifier.v1';
};

type VerificationResult = {
  status: 'PASS'|'FAIL'|'NOT_AVAILABLE';
  reasonCode: string; details: string;
};
```

**Schemas:** implement `zod` or an equivalent single runtime validator in `packages/contracts` and infer TS types from it; the code above describes the required public shape, not a second duplicated runtime type system. Tests must reject incorrect integer formats, unknown network, empty signature on L2, invalid intervals, invalid hex/base64, repeated IDs and reordered sequences.

## 5. Signing/canonicalization contract

- Use **RFC 8785 JSON Canonicalization Scheme (JCS)** or a deterministic implementation conforming to it. Reject unsupported numeric values; monetary and energy units are decimal **strings**, so JSON number precision never affects signatures.
- Digest: lowercase `SHA-256(JCS(value))`. Source payload digests hash the **original decoded bytes**; never the parsed and reserialized version.
- Domain-separated payer acknowledgement: sign UTF-8 bytes of `usagepay.payer-evidence-ack.v1\n` followed by the JCS encoding of the ack object **excluding** `signatureB64`. Use Ed25519 with the demo's payer-controlled commitment signing key; verifier independently checks the public key against the on-chain channel `commitment_key`.
- Native MPP commitment remains unchanged. `commitmentDigest = SHA-256(JCS({signedMessageB64, signatureB64}))`; `signedMessageB64` must contain the actual message bytes constructed/verified by the pinned SDK. A second signature **does not alter** the payment contract.
- Compute `readingDigest` over the entire canonical, frozen `MeterReading`; independently verify the source signature against the exact decoded `rawPayloadB64` bytes. The declared assurance/certification fields are metadata to be evaluated, not self-authenticating proof. Compute `evidenceDigest` over `{readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits, deltaChargeBaseUnits, sessionId, readingId}` with fixed JCS encoding.
- Each `(channelId, sessionId, nonce)` is unique across authorized increments. Do not accept a reused nonce, an older cumulative amount, or a payer ack whose amount/channel/digests differ. Pin key ownership and network before accepting payment.
- `E0Digest = SHA-256(JCS(E0))`. **E0 contains no settlement transaction hash**. E1 is created only after obtaining/inspecting the chain result. E0 anchoring is optional P2 and cannot be conflated with E1.

Acknowledge evidence **after** capturing the actual native commitment and **before** accepting/finalizing E0. Persist native signed commitment + ack + source evidence together before reporting acceptance. Where an SDK abstraction does not expose a required value, report a blocker rather than inventing it.

## 6. Monetary and identity rules

- Demo tariff is an explicitly hypothetical **0.40 USDC/kWh**, represented by `4_000_000` base units per kWh **when the verified asset scale is 7 decimals**. Given cumulative Wh, compute `cumulativeAmount = floor(cumulativeWh * pricePerKwhBaseUnits / 1000)` using `bigint`.
- New delta = current cumulative charge minus previously approved cumulative charge; reject negative, stale, zero-cost replay or exceeding the chosen fleet budget. Compare against **actual signed channel cumulative amount**, not against a reconstructed guess.
- Each source reading has unique `(domain, sessionId, readingId)`; duplicate delivery cannot increase authorized value.
- Meter public key is pinned separately. Both meter key and payer key are test-only; CPO **never holds** payer signing secret. On P0 demo use one session/one channel, serialized increments; shared multi-vehicle accounting is P2.
- On-chain: verify network, contract channel ID, asset SAC, recipient and actual settled amount using real contract/RPC data. A transaction hash alone is insufficient.

## 7. Ownership and allowed edits

| Owner | Changes allowed | Must not change |
|---|---|---|
| Contracts coordinator (SPEC 00) | `packages/contracts/**`, `fixtures/**`, top-level tooling | Product roadmap, native MPP protocol |
| Metering (SPEC 01) | `packages/metering/**`, its tests and meter fixture additions | Shared schema without explicit approval; payer keys |
| Settlement (SPEC 02) | `packages/settlement/**`, `scripts/testnet/**`, its tests | Meter source ownership; verifier logic |
| Verification (SPEC 03) | `packages/verification/**`, `apps/demo/**`, its tests | Payer signing secret; fabricated tx status |
| Integrator (SPEC 04) | Wiring, shared test scripts, README/demo | Silently expanding P0 or rewriting architecture |

Integration uses a single repo/lockfile; no branch may independently upgrade SDK versions or redefine schemas. For three people, use three branches/worktrees **after** the contract gate. For one person, implement 01 → 02 → 03 sequentially (the Testnet spike is earlier).

## 8. Testing pyramid and developer-readable execution traces

Use **many pure unit tests, fewer module/contract tests, and a minimal number of real Testnet end-to-end tests**. All test names and failure messages must explain *what input entered the system, which rule was exercised, and why the result is correct*. **Mocks never count as proof of an on-chain payment.**

```text
                     /\
                    /  \     Demo smoke: one recorded, repeatable walkthrough
                   / E2E\    Real Testnet: channel -> settlement -> independent verification
                  /------\
                 / Module \  Integration/contract: A -> B -> C with deterministic fixtures
                /----------\
               / Unit + data\ Pure schemas, exact bytes, JCS, signatures, bigint, limits
              /______________\
```

| Layer | Primary coverage | Expected evidence |
|---|---|---|
| **Unit (most tests)** | JCS/hash test vectors, exact raw-byte signature verification, tariff `bigint` math, ID/replay validation, budget boundary, schema parse/reject | Deterministic fixture → exact expected value or typed refusal; no network |
| **Module / contract** | SPEC 01 output validates against shared schemas; SPEC 02 accepts approved evidence and emits real SDK-shaped commitments; SPEC 03 recomputes from E0/E1 and pinned trust inputs | Cross-package contract tests with fixtures, fake RPC/SDK *only at external boundaries*; prove no internal module imports |
| **Testnet E2E (few)** | Real channel deposit → at least three cumulative signed commitments → real `close` → RPC `SUCCESS`, channel/recipient/asset/amount confirmation → independent Verify result | Actual Testnet addresses, transaction hash, contract state and reproducible command output; never hardcode fabricated chain results |
| **Demo smoke (one)** | Run the happy path, demonstrate tampered-reading rejection and budget refusal, open Verify page/CLI | Short live or recorded walkthrough with visible PASS/FAIL and links to the real settlement |

### Required data-flow scenarios

**S1 — Happy path (P0):** simulated meter produces exact source bytes → verify meter signature → normalize reading → pin tariff → compute cumulative amount → fleet signs *native MPP commitment* → fleet signs *separate evidence acknowledgement* → persist increment/E0 → close channel on Testnet → inspect RPC result → create E1 → independent verifier recomputes every check → **PASS**. For illustration, at a 0.40 USDC/kWh tariff with **verified 7-decimal asset precision**, consecutive 250 Wh intervals yield cumulative **1,000,000 → 2,000,000 → 3,000,000 base units**. Values are examples, never hardcoded SDK outputs.

**F1 — Tampered reading (P0):** mutate one byte of the signed meter payload after signing → source signature **FAIL** → no payer acknowledgement, no new native commitment, no accepted charge.

**F2 — Budget refusal (P0):** with a 2,500,000-base-unit cap in an independent test fixture, the first two 250 Wh intervals are approved; the third would reach 3,000,000 → **BUDGET_EXCEEDED**, cumulative amount remains 2,000,000, no signature for the third interval.

**F3 — Duplicate/replay:** deliver the same `(domain, sessionId, readingId)` again, or reuse a payer acknowledgement nonce → **DUPLICATE_READING / REPLAY_NONCE**; no extra charge. Include as a small unit/contract test, not a new subsystem.

**F4 — Incorrect evidence binding:** change the tariff version, channel, network, evidence digest, authorized amount or native commitment after payer acknowledgement → independent verifier **FAIL**; a valid Stellar financial signature alone cannot repair the missing evidence authorization.

**F5 — Misleading chain reference:** use a real but unrelated `closeTxHash`, wrong recipient/asset, failed or unavailable transaction → verifier **FAIL** or **NOT_AVAILABLE**, never PASS. RPC unavailable must not be silently treated as success.

**Test reporting:** name automated tests `S1`, `F1`–`F5` (or include those IDs in descriptions). Produce an execution summary containing input fixture ID, expected outcome, actual outcome, and a reason code. Keep real Testnet integration tests in a separate opt-in command so routine unit tests stay fast and deterministic. Treat F3–F5 as targeted acceptance coverage within existing modules; do **not** expand hackathon product scope to production-grade dispute handling.

### Upstream implementation references (inspect, do not reimplement)

- [Stellar MPP channel client](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-client.ts) — 402 → signed cumulative commitments, channel pinning and progress callbacks.
- [Stellar MPP channel server](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-server.ts) — signature verification, server state store and payment gating.
- [MPP close through the credential flow](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-close-mpp.ts) — real closing flow and settlement-state protections; compare against [direct close](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-close.ts).
- [Experimental one-way-channel demo](https://github.com/stellar-experimental/one-way-channel/blob/main/examples/demo.sh) — deployment, commitment preparation, signature and settlement at contract level. **That script uses the native asset; it is not evidence of USDC configuration.** Verify the configured Testnet SAC separately.
- [Stellar official agentic-payments skill](https://github.com/stellar/stellar-dev-skill/tree/main/skills/agentic-payments) — conceptual guidance; resolve API and dependency-version discrepancies against the **pinned SDK source**.

These examples demonstrate native payment behavior; **the UsagePay evidence acknowledgement and independent verification are application additions**. Reuse upstream primitives without copying examples as if they already implement UsagePay's evidence guarantee.

## 9. Completion gates for SPEC 00

**G0 — required before the first stop:**

- [ ] Schema validators and real TS types exist in `packages/contracts`.
- [ ] Golden fixtures (valid increments and tampered/duplicate/budget cases) pass runtime validation tests where appropriate; negative **business** cases are rejected by their respective domain modules, not necessarily by JSON schemas.
- [ ] Canonical hashes/signature preimages are deterministic across two independent invocations.
- [ ] Compatible dependency versions, source revisions and network are pinned; `pnpm install --frozen-lockfile`, typecheck, offline tests and build pass.
- [ ] Cross-module fields are unambiguous, independently testable and frozen for the next gate.
- [ ] G0 completion report lists actual commands/results; **no Testnet requirement or business-module implementation** is counted toward G0.

**G1 — separate required feasibility gate, not a condition for G0 PASS:**

- [ ] Real Testnet channel lifecycle, three native cumulative signatures, on-chain close and independent chain inspection demonstrated with genuine outputs.
- [ ] Actual signed MPP preimage/credential and signature captured and independently verified against the pinned SDK/on-chain key.
- [ ] Separate payer-signed evidence acknowledgement can be validated by the payee **before acceptance**; a deliberately mismatched acknowledgement is refused.
- [ ] Any unsupported SDK boundary is reported as `BLOCKED`, not quietly bypassed. No fabricated results or false channel PASS.

**Primary sources:** [Stellar MPP SDK](https://github.com/stellar/stellar-mpp-sdk), [experimental channel](https://github.com/stellar-experimental/one-way-channel), [Stellar Agentic Payments skill](https://github.com/stellar/stellar-dev-skill/tree/main/skills/agentic-payments), [Raven](https://raven.stellar.org/).
