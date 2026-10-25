# SPEC 04 — Integration & Acceptance

**Status:** Ready for implementation after SPEC 00 contract freeze and the native MPP capture feasibility gate  
**HackMeridian:** 2026-10-25  
**Product authority:** `01.1-usagepay-technical-architecture-and-roadmap.md` v1.1.1  
**Implementation authority:** SPEC 00; module behavior is defined by SPECs 01–03.  
**Owner:** Integration coordinator (one developer or the nominated integrator in a three-person team).

**Mission:** Turn the independently implemented metering, payer/settlement and verification modules into **one reproducible Stellar Testnet demonstration**. Define executable acceptance gates, success and error traces, and a minimal judge-friendly walkthrough. Do not expand product scope, duplicate module logic or substitute mock transactions for real settlement.

## 1. P0 integration boundary

```text
TEST-ONLY SIMULATED CHARGER                 EXTERNAL, PINNED TRUST CONFIG
  Started / Updated / Ended                 meter key, tariff, channel,
  + original signed meter bytes             fleet budget, asset, recipient
             |                                        |
             v                                        |
      SPEC 01 — Metering & Evidence <-----------------+
      verify → normalize → cumulative charge
             |
             v
      SPEC 02 — Payer & Stellar Settlement
      fleet policy → real native MPP 402 credential
      → separate fleet evidence acknowledgement
      → payee pre-acceptance checks → SDK acceptance
      → immutable E0 (three approved increments)
             |
             v
      REAL STELLAR TESTNET
      existing one-way-channel → one close → RPC outcome
             |
             v
      E1 (references E0 digest + actual close tx)
             |
             v
      SPEC 03 — Independent Verifier
      original source bytes + tariff replay + native signature
      + payer acknowledgement + independent chain inspection
             |
             v
      CLI / minimal Verify display: PASS | FAIL | NOT_AVAILABLE
```

**P0 completion requires:** one signed EV-shaped simulated charging session, three strictly increasing **real** native MPP commitments, separate signed payer acknowledgements, real Testnet channel close, immutable pre-close E0, observed post-close E1, and an independently reproducible overall `PASS` across `V01`–`V08`. One bad signed reading and one budget refusal must be visibly rejected **without signing or accepting an additional payment**.

**Never imply:** physical measurement has been certified; OCPP/OCMF conformance; the Stellar contract enforces metering; a valid transaction hash proves the correct payee/asset/amount; ordinary USDC channels are confidential; Testnet software is production-audited.

## 2. Ownership, parallelization and integration rules

| Workstream | Owner and editable area | Required handoff to integrator |
|---|---|---|
| Shared contracts / setup — SPEC 00 | Coordinator: `packages/contracts/**`, common `fixtures/**`, root toolchain and lockfile | Runtime schemas, canonicalization test vectors, example E0/E1, pinned versions, proof of native-credential capture feasibility |
| A — SPEC 01 | Metering developer: `packages/metering/**`, relevant fixtures/tests | `MeteringPort`, valid signed `MeterReading` + `MeasurementCharge`, refusal codes and offline tests |
| B — SPEC 02 | Settlement developer: `packages/settlement/**`, `scripts/testnet/**`, relevant tests | `PayerAuthorizationPort`, real signed native credential and ack, `AuthorizedIncrement`, E0/E1, real close logs |
| C — SPEC 03 | Verification developer: `packages/verification/**`, minimal `apps/demo/**`, relevant tests | `VerificationPort`, per-check verdicts, read-only Testnet lookup, CLI output |
| Integration — SPEC 04 | Coordinator: root scripts, wiring, cross-package tests, README/demo/run outputs | One command sequence and complete, independently repeatable evidence |

**One person:** execute contract freeze and Testnet spike, then A → B → C → integration. **Two or three people:** build A/B/C in separate branches/worktrees only **after** schemas, SDK versions and native capture boundary are frozen. No agent may redefine a shared type, switch the asset/network, upgrade the lockfile independently, or edit another owner's implementation to hide a failed contract test. Escalate a proposed contract change to the coordinator; rerun contract tests for all consumers before merging.

**Dependency direction:** modules import types/validators from `packages/contracts`, not each other's internals. The integrator composes their public ports. Keep payer secrets exclusively in the payer execution context; a verifier must never receive a private key. Payer and payee remain distinct roles even when a local demo launcher starts both processes.

## 3. Mandatory integration gates — execute in order

| Gate | Action | Pass condition / stop condition |
|---|---|---|
| **G0 — Contracts** | Pin Node 22+, compatible pnpm/MPP/SDK/CLI versions, package lockfile, Testnet identifiers; run shared schema/JCS/fixtures tests | `pnpm install --frozen-lockfile`, typecheck and offline contract tests pass; otherwise **BLOCKED** |
| **G1 — Authentic native channel** | Use the pinned upstream channel examples to fund a Testnet channel, capture **actual signed MPP credentials**, reconstruct/verify exact native preimage and obtain one verified close | Real key/channel/network/asset/payee and valid signature/close proven. `onProgress` alone is insufficient. If unavailable: **BLOCKED**, not a made-up signature |
| **G2 — Module handoffs** | Feed SPEC 01 output to SPEC 02, preserve real credential and signed payer ack, then pass E0/E1 to SPEC 03 | All imported data validates against SPEC 00 with no duplicate schemas; no acceptance before the payer-ack gate and native SDK verification |
| **G3 — Complete Testnet flow** | Start one session, accept three 250 Wh intervals, finalize E0, close once on Testnet, inspect chain independently, create E1 | Genuine cumulative `1000000 → 2000000 → 3000000` base units for a verified 7-decimal asset; actual successful payout to pinned recipient/token for expected amount |
| **G4 — Independent verification** | Run CLI against generated E0/E1 and independent trust inputs; execute negative and unavailable-data scenarios | All `V01`–`V08` pass for genuine S1; bad data **FAIL**, RPC/insufficient proof **NOT_AVAILABLE**; no trusted success flags |
| **G5 — Repeatable judge walkthrough** | Run the one-command demo and README instructions on a clean local checkout, then capture screen/video | Explain source → signatures → approval → channel → settlement → Verify, with visible real Testnet reference and limits; no fabricated step |

**Gate progression is evidence-based.** A `Charge`-mode fallback may demonstrate an alternate Stellar payment, but **never** satisfies G1/G3/G4 channel-specific acceptance. If the existing channel contract/SDK is incompatible, preserve working code and record the failure; do not add a custom Soroban contract or redefine P0 without an explicit team decision.

## 4. Golden data path and repeatability

Use the exact shared types from SPEC 00 and the simulated source profile from SPEC 01; **do not introduce an integration-only evidence schema**.

| Step | Actual artifact / data | Expected relationship |
|---|---|---|
| `Started` | `ev-session-001`, start register `10000` Wh | Establish session; no charge, no MPP credential |
| `Updated r-001` | Signed source `10000 → 10250` Wh | `deltaWh=250`, cumulative Wh `250`, amount `1000000` |
| `Updated r-002` | Signed source `10250 → 10500` Wh | cumulative Wh `500`, amount `2000000` |
| `Ended r-003` | Signed source `10500 → 10750` Wh | cumulative Wh `750`, amount `3000000`, session closed |
| For each approved increment | SDK-native `NativeCommitment` + distinct payer-signed `PayerEvidenceAck` | Signatures verify; commitment binds channel/network/cumulative; ack binds exact evidence digest to exact native commitment |
| **Before close** | Frozen E0 + `SHA256(JCS(E0))` | Ordered increments; no close tx hash anywhere in E0 |
| **After close** | Observed E1 + read-only RPC verification | `E1.e0Digest` matches E0; actual channel, signer key, payee, token and payout match trusted configuration |
| Verify | One overall report and eight mandatory checks | Overall `PASS` only if `V01_SCHEMA` through `V08_CHAIN` each pass |

The illustrative tariff is `0.40 USDC/kWh`, represented as `4000000` token base units per kWh **only when the actual configured token uses seven decimals**. The budget is chosen by the fleet policy; the negative test fixture uses a `2500000`-unit cap. All amounts use decimal strings/`bigint`, not floating point. Derive hashes/signatures from the actual fixture inputs; **do not paste fabricated signatures, transaction hashes, or on-chain success responses** into checked-in outputs.

**Artifact lifecycle:** source signed bytes and validated readings → native commitment and ack → payee SDK acceptance → recoverable increment → immutable E0 → real close → observed E1 → read-only independent report. Persistence uncertainty or an SDK denial means `PENDING`/`REJECTED`, **never** accepted. A real but pending `getTransaction` status is not final settlement.

## 5. Acceptance testing pyramid

```text
                 /\
                /  \       Demo smoke: one complete human-readable walkthrough
               /E2E \      Testnet: genuine deposit, commitments, close and payout proof
              /------\
             / Module \    Ports + shared fixtures + controlled SDK/RPC boundaries
            /----------\
           /Unit & data \  Ed25519, original bytes, JCS, tariffs, state, policy
          /______________\
```

Run **offline tests by default**. A separate, explicitly enabled Testnet E2E command may consume disposable funded keys; it must refuse to run when Testnet configuration is absent or points to Mainnet. Only external SDK/network boundaries may be mocked in module tests. A mocked transaction **cannot** fulfill a Testnet success gate.

| Scenario | Data-flow stimulus | Expected, inspectable outcome |
|---|---|---|
| **S1 — Happy path (P0)** | Started, three valid signed 250 Wh intervals → fleet approvals → three real native commitments and acks → frozen E0 → Testnet close → E1 | Values `1000000/2000000/3000000`; `V01`–`V08: PASS`; real payout confirmed; overall `PASS` |
| **F1 — Tampered meter (P0)** | Change one byte of signed `r-002` source after signature | `INVALID_METER_SIGNATURE` / `V02_METER: FAIL`; no new SDK commitment/ack or accepted amount |
| **F2 — Fleet budget (P0)** | Use budget cap `2500000`; send the third valid 250 Wh increment | `BUDGET_EXCEEDED`; highest approved stays `2000000`; no third signature/ack, no extra accepted charge |
| **F3 — Replay/idempotency** | Deliver `r-002` twice, or reuse an ack nonce | `DUPLICATE_READING` or `REPLAY_NONCE`; unchanged accepted amount and evidence history |
| **F4 — Evidence-binding mismatch (P0)** | Keep a real native MPP signature valid, then alter evidence digest, tariff, channel or approved amount | Native signature may still pass its own check; payer ack/binding **FAIL**, overall `FAIL`; app refuses acceptance when detected preflight |
| **F5 — False/missing settlement (P0)** | Refer to another `SUCCESS` tx, wrong payee/asset/amount, or disconnect RPC | Confirmed mismatch ⇒ `V08_CHAIN: FAIL`; unavailable proof ⇒ `NOT_AVAILABLE`; **never** overall `PASS` |
| **F6 — E0/E1 integrity** | Mutate frozen E0 without recomputing E1; or forge E1 status | `E0_DIGEST_MISMATCH` / `V07: FAIL`; fabricated `SUCCESS` does not override RPC result |
| **F7 — Restart/persistence boundary** | Simulate a failed local write after signed credential but before application acceptance | Fail closed with `PENDING`/typed failure; do not claim accepted or settled. Production recovery/reconciliation remains out of scope |

**Test isolation:** S1 Testnet uses disposable keys and one funded channel; F1–F7 should primarily run with deterministic offline fixtures. The budget test must run in a **separate fresh scenario**; it intentionally rejects `r-003` and must not corrupt S1's completed three-increment record. A mock E1 can prove parser/verifier branches, not on-chain settlement.

**Every result must identify:** scenario ID, fixture/session ID, expected status, actual status, failure reason when present, and evidence class (`OFFLINE_FIXTURE`, `SDK_INTEGRATION`, or `REAL_TESTNET`). Use stable `reasonCode` values and exit nonzero when a required test fails. Logs may expose public Testnet addresses and hashes, **never** key material, raw secrets, or payer signing credentials.

## 6. Root commands and evidence handoff

The coordinator must wire these scripts in the root `package.json` and document the real commands in `README.md` (the script bodies are implemented during integration, not assumed to exist already):

```bash
pnpm install --frozen-lockfile
pnpm typecheck           # all packages
pnpm test                # offline unit tests
pnpm test:contracts      # cross-package contract/integration, offline
pnpm build               # all packages / demo entrypoint
pnpm test:e2e:testnet    # EXPLICIT OPT-IN; live Testnet only
pnpm demo                # single local walkthrough / CLI or minimal UI
```

The **demo** should make only a few clearly labeled steps visible: (1) simulated meter consumption, (2) fleet authorization and cumulative MPP commitments, (3) confirmed real Testnet close, (4) independent verification results, (5) tampering/budget rejection. Offline F1/F2 demonstrations may reuse deterministic fixtures rather than spend a second Testnet channel. For reviewers who run without funded Testnet keys, supply a read-only `verify` entrypoint accepting a **real captured** public E0/E1 bundle and pinned public trust config; do not mislabel a replay as a fresh payment.

Minimal, reviewable evidence: one reproducible run command, actual Testnet contract address and transaction link, SDK versions/source SHA, public E0/E1 artifacts and per-check verification output, plus README, brief demo video and pitch. Produce a static screenshot only as a supplement, not instead of executable or on-chain evidence. Do not commit private `.env`, mnemonic, signing keys, faucet credentials or full credential secrets.

## 7. Definition of Done and handoff to hackathon presentation

- [ ] **Contract freeze respected:** all module outputs validate against SPEC 00; version manifest/lockfile reproducible; no overlapping schema implementations or unapproved cross-module edits.
- [ ] **Metering correct:** signed raw bytes and normalized delta/tariff replay pass; tampered reading cannot trigger financial authorization.
- [ ] **Payer controls authorization:** correct budget, unique IDs/nonces, pinned channel/network/asset/payee, native MPP signature captured and separately signed evidence acknowledgement verified **before** payee SDK acceptance.
- [ ] **Real Testnet settlement:** three genuine cumulative commitments, one real close, independently confirmed correct network, signer, payee, asset and settled amount.
- [ ] **Evidence lifecycle correct:** E0 finalized before close and unchanged; E1 references its exact hash and observed transaction only.
- [ ] **Independent verification:** `V01`–`V08` pass on authentic run; F1/F2/F4/F5 errors are demonstrated and never reported as payment success; missing chain data yields `NOT_AVAILABLE`.
- [ ] **Test pyramid executed:** unit, contract, opt-in real Testnet E2E and one demo smoke; each gate has actual `PASS`/`FAIL`/`BLOCKED` evidence, not a narrative claim.
- [ ] **Readable submission:** README covers architecture, setup, run/verify steps, real vs simulated components, limits, source provenance, Testnet explorer link; demo recording and short pitch prepared.

**Release decision:** `GO` only when the complete native-channel Testnet proof and verifier pass. Otherwise `BLOCKED` with a working offline demo and an explicit list of missing gates. A fallback Charge transaction can be shown honestly as a reduced-scope prototype, **not** described as complete UsagePay P0.

## 8. Implementation references (read the pinned revisions)

- [MPP client example](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-client.ts) and [MPP server example](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-server.ts) — native client/server 402 flow.
- [MPP close example](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-close-mpp.ts) and [native commitment encoding](https://github.com/stellar/stellar-mpp-sdk/blob/main/sdk/src/channel/commitment.ts) — closing and the exact signed message.
- [Experimental one-way-channel demo](https://github.com/stellar-experimental/one-way-channel/blob/main/examples/demo.sh) — contract lifecycle; script defaults to the **native asset**, not Circle USDC.
- [Stellar data/RPC skill](https://github.com/stellar/stellar-dev-skill/tree/main/skills/data) and [agentic payments skill](https://github.com/stellar/stellar-dev-skill/tree/main/skills/agentic-payments) — chain evidence and payment integration guidance.
- Internal governing documents: SPEC 00 (schemas and policy), SPEC 01 (source meter profile), SPEC 02 (payer/native capture), SPEC 03 (independent checks), UsagePay `01.1` v1.1.1 (product/roadmap).

**Stop rule:** This is the last MVP SPEC for **protocol, payment and verification behavior**. Do not invent a new protocol, a backend service or an expansion of P0.

**Team decision.** The judge-facing UI is required. It is the project's main differentiator, because the demo has no hardware. Its decisions are recorded in [SPEC 05 — Demo UI & UX](05-demo-ui-and-ux.md). SPEC 05 is a presentation layer over the outputs of this SPEC: it adds no protocol, payment or verification behavior.

## 9. Integration requirements and team reproduction guide (G3–G5)

This section specifies **what the integration shall provide beyond §1–§8**, so that every team member can rebuild and reproduce the same results. It changes no P0 scope.

### 9.1 Required integration components

| Component | Location | Requirement |
|---|---|---|
| **Package `@usagepay/demo`** | `apps/demo/` | The integrator's area: scenarios, narrative, walkthrough, bundle. It shall add no schema and duplicate no module logic |
| **Cross-package scenarios S1, F1–F7** | `apps/demo/src/scenarios.ts` | The §5 table, run through the real SPEC 01/02/03 ports, the pinned `@stellar/mpp` client and server and runtime keys. Evidence class `SDK_INTEGRATION` |
| **Offline ledger stand-in** | `apps/demo/src/offline-chain.ts` | Answers only the `rpc.Server.prototype` network methods while a scenario runs. Its `close` shall verify the commitment signature as the contract does. It is never presented as Testnet evidence |
| **Plain-language narrative** | `apps/demo/src/narrative.ts` | Each event shall carry an actor (meter, fleet, station, Stellar, auditor), a layer `ON_CHAIN`/`OFF_CHAIN`, a status `OK`/`REJECTED`/`PENDING`/`INFO`, a title, one sentence and its public technical fields. Explorer links appear only for the real Testnet ledger. It also explains reason codes and V01–V08 |
| **Real-run loader** | `apps/demo/src/real-run.ts` | Loads the newest `g2-*` run and its `trust.json`, decodes meter rows from the exact signed bytes, reads the ledger through the verifier's read-only port and builds `stellar` CLI equivalents with the observed values |
| **Demo bundle `upay.demo-bundle.v1`** | `apps/demo/src/bundle.ts` | The single data source of the terminal walkthrough and the UI (SPEC 05). Public values only |
| **Terminal walkthrough** | `apps/demo/src/walkthrough.ts`, `cli.ts`, `bin.ts` | The five §6 steps, each tagged `ON-CHAIN`/`OFF-CHAIN` |
| **Testnet E2E guard** | `apps/demo/src/testnet-guard.ts` | Opt-in and Testnet-only refusal rules, unit tested |
| **One-command Testnet E2E** | `scripts/testnet/e2e/run.ts` | Fresh channel → G2 → G3 |
| **Per-run trust file** | `scripts/testnet/g2/run.ts` → `runs/g2-*/trust.json` | Public `usagepay.verifier-trust.v1`. Written **before the first increment** from configuration and the pinned on-chain channel facts. Never derived from E0/E1; V08 confirms its chain-facing values |
| **Newest-run resolution** | G3 runner, `pnpm demo`, the verification contract test | They shall always use the newest committed `g2-*` run, so regenerating evidence needs no code change |
| **Vitest project `integration`** | `vitest.config.ts` (root `apps/demo`) | Included in `pnpm test` and `pnpm test:contracts` |
| **Demo UI (SPEC 05)** | `apps/web/`, Vitest project `web` | Renders the demo bundle; see SPEC 05 §10. Included in `pnpm test` |

### 9.2 Commands, environment and exit codes

| Command | Sends transactions | Exit codes |
|---|---|---|
| `corepack pnpm demo [--run <g2-run>] [--trust <file>] [--offline] [--json] [--out <file>] [--rpc <url>] [--timeout <ms>]` | no (read-only RPC) | 0 PASS · 1 FAIL · 2 NOT_AVAILABLE · 3 usage |
| `corepack pnpm verify <e0> <e1> --trust <run>/trust.json [--offline]` | no | 0 · 1 · 2 · 3 |
| `corepack pnpm g3:verify [g2RunDir] [trustFile]` | no | 0 PASS, 1 otherwise |
| `UPAY_TESTNET_E2E=1 corepack pnpm test:e2e:testnet` | yes: deploy, 1 USDC deposit, close | 0 PASS · 1 FAIL · 3 refused |

`pnpm demo` shall exit 0 only when two things hold: every scenario met its expectations, and the real run verified V01–V08 **live**. An offline run or an unreachable ledger gives 2. It is never PASS.

The E2E shall refuse with exit 3 in five cases:
- the opt-in is absent;
- `implementation-versions.json` is not `stellar:testnet`;
- the passphrase is not Testnet;
- the RPC URL, or the passphrase the RPC reports, is not Testnet;
- the funder holds less than 1 USDC.

| Variable | Used by | Meaning |
|---|---|---|
| `UPAY_TESTNET_E2E=1` | E2E | Explicit opt-in to spend disposable Testnet funds |
| `UPAY_CHANNEL_ALIAS` | G2 runner | Channel alias to use. The E2E sets a fresh `upay-e2e-<yyyymmddThhmm>`; default `upay-g2-channel` |
| `UPAY_UNRELATED_TX` | G3 runner | The real but unrelated SUCCESS close used by F5-C. Default: the current G1 close (`implementation-versions.json` → `testnetDeployments.upay-g1-channel.closeTx`) |
| `NO_COLOR` | `pnpm demo` | Disables terminal colors |

### 9.3 Reproducing the results (every team member)

Prerequisites: Node.js 22.12+, Corepack with pnpm 10.33.0 and, for Testnet, the Stellar CLI 28.1.0 with the identities from `scripts/testnet/README.md`.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck && corepack pnpm build
corepack pnpm test             # expected: every file and test passes (includes the SPEC 05 `web` project)
corepack pnpm test:contracts   # expected: every file and test passes (includes S1/F1-F7)
corepack pnpm versions:check   # expected: versions:check PASSED
corepack pnpm fixtures:check   # expected: vectors byte-identical
corepack pnpm demo             # expected: DEMO PASS, exit 0 (needs Testnet RPC reachable)
corepack pnpm demo --offline   # expected: AUDITOR VERDICT NOT_AVAILABLE, exit 2
corepack pnpm typecheck:web    # SPEC 05 UI typecheck
corepack pnpm ui:build         # expected: DEMO PASS, then apps/web/dist/index.html (one file)
```

Expected scenario table (identical on every machine; only runtime signatures and hashes differ):

| ID | Expected → actual |
|---|---|
| S1 | PASS `ALL_CHECKS_PASSED` |
| F1 | REJECTED `INVALID_METER_SIGNATURE` |
| F2 | REJECTED `BUDGET_EXCEEDED` (station paid exactly 2000000) |
| F3 | REJECTED `DUPLICATE_READING` (+ `REPLAY_NONCE`) |
| F4 | REJECTED `INVALID_PAYER_ACK` (V05 PASS, V06 FAIL) |
| F5 | FAIL `CHAIN_MISMATCH` (+ NOT_AVAILABLE `RPC_UNAVAILABLE`) |
| F6 | FAIL `E0_DIGEST_MISMATCH` (+ `SETTLEMENT_FAILED`) |
| F7 | PENDING `PAYMENT_OUTCOME_UNKNOWN` |

The G5 check runs the same commands on a fresh copy of the tracked files, outside the working directory.

### 9.4 Demo-day evidence procedure (during the hackathon)

The submission evidence shall be regenerated during the hackathon. Earlier runs are rehearsals only.

1. Check the funder holds at least 1 USDC and some XLM; the E2E preflight prints both.
2. `UPAY_TESTNET_E2E=1 corepack pnpm test:e2e:testnet` must end with `PASS` and write `runs/e2e-*`, `runs/g2-*` and `runs/g3-*`.
3. `corepack pnpm demo` must show `REPLAY of real Stellar Testnet run g2-<that day>` and end with `DEMO PASS`. Then `corepack pnpm ui:build` and check the page with `corepack pnpm ui:preview`.
4. Remove the rehearsal run directories, then rerun `corepack pnpm test`. The verification contract test and the demo tests use the newest run.
5. Update the README section "Testnet evidence (demo day)" with the channel, close transaction, ledger and verification links.
6. Commit after review.
7. Deploy `apps/web/dist` to Vercel as a separate, confirmed step (SPEC 05 D12).
