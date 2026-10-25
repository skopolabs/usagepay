# UsagePay — HackMeridian Lisbon 2026 MVP

*Infrastructure for the machine economy.*

**UsagePay enables verifiable machine-to-machine payments for metered services on Stellar.**

Every payment carries its proof: the signed measurement, the price applied, the payer's approval and the Stellar settlement, checkable by anyone.

**Demo use case: EV charging**, because everyone understands a charger and a kilowatt-hour. UsagePay is not an EV charging product. The same flow fits any service a machine can measure: energy, compute time, connectivity, equipment hours, water. This MVP implements one adapter, energy in Wh; a second adapter is on the roadmap. Messaging and claim guardrails: [01.2 §0.1](docs/usagepay/01.2-usagepay-product-foundation.md#01-positioning-and-messaging-single-source-for-the-ui-readme-and-pitch).

## For judges

| | |
|---|---|
| **Live demo** | [usagepay.vercel.app](https://usagepay.vercel.app): the judge-facing page over the real Testnet run. Static, no keys, no wallet, no network request |
| **Demo video** | [YouTube channel](https://www.youtube.com/channel/UCVkziV3cu8SnGI5tDzu37oQ) |
| **Pitch deck** | [Google Slides](https://docs.google.com/presentation/d/157kTzIG6SZ9LdqSRKgJaeVdF4ENpdYWz/edit?slide=id.p1#slide=id.p1) |
| **Track** | Genesis · Stellar Composed |
| **Testnet proof** | Close transaction [`0626430c…ca1da`](https://stellar.expert/explorer/testnet/tx/0626430c4b707bf3273ee9b454a73e014de5a3df0d5f24449ece9abb075ca1da) settling three vouchers in one channel close, verified V01–V08 PASS ([details](#testnet-evidence-demo-day)) |

Test it in three steps:
1. Open the [live demo](https://usagepay.vercel.app): replay the session, then open the independent auditor and the attack scenarios.
2. Run it yourself: `corepack pnpm install --frozen-lockfile && corepack pnpm demo` replays the captured run and re-checks it read-only against Stellar Testnet ([Run it](#run-it)).
3. Verify with no keys and no funds: [Verify without keys](#verify-without-keys-reviewers).

Where to find the evidence for each judging criterion:

| Criterion | Where to look |
|---|---|
| Track alignment | [HackMeridian positioning](#hackmeridian-positioning--genesis--stellar-composed): Stellar MPP SDK, the one-way channel and Stellar RPC composed into an evidence layer |
| User value and problem | [The problem](#the-problem) and [Product Foundation](docs/usagepay/01.2-usagepay-product-foundation.md) |
| Technical execution | [Specs](#specs), [build results](#build-results) and a real [Testnet settlement](#testnet-evidence-demo-day) |
| Innovation | [Why Stellar MPP alone is not enough](#the-problem) |
| Hackathon progress | [Build results](#build-results), gate by gate |
| Market and ecosystem potential | [Viability Gates](docs/usagepay/01.3-usagepay-viability-gates.md) and [Economics](docs/usagepay/01.4-usagepay-economics.md) |
| Product design and UX | The [live demo](https://usagepay.vercel.app) and [SPEC 05](specs/05-demo-ui-and-ux.md) |

## HackMeridian positioning — Genesis / Stellar Composed

**Target track:** [Genesis → Stellar Composed](https://www.hackmeridian.com/). The event describes this track as combining **two or more Stellar ecosystem tools or projects into something new**.

| Building block | Role in UsagePay |
|---|---|
| [Stellar MPP SDK](https://github.com/stellar/stellar-mpp-sdk) + [experimental one-way-channel](https://github.com/stellar-experimental/one-way-channel) | Existing off-chain cumulative payment commitments and on-chain settlement; **already integrated upstream** |
| [Stellar RPC / JavaScript SDK](https://developers.stellar.org/docs/data/apis/rpc) | Independently query and verify the Testnet channel and settlement |
| **UsagePay's metering/evidence integration** | Bind signed usage evidence, an accepted tariff and payer authorization to the payment, then replay verification independently |

**What is new:** the evidence-to-authorization and independent-verification layer for metered machine services — **not** MPP itself, the payment channel, or the existing MPP-to-channel integration. The MVP demonstrates the independent use of Stellar RPC and the application-layer composition with a real Testnet run, not only in the pitch.

**Why Stellar:** reuse its existing off-chain payment channel infrastructure and settle aggregated consumption on Testnet instead of putting every meter reading on-chain. This does **not** make physical metering trustworthy by itself; the demo uses simulated signed readings, and the channel contract does not enforce metering evidence.

## The problem

A machine can report how much of a service it consumed. Stellar MPP can authorize cumulative payments and settle them through a payment channel. **Neither component alone proves that a specific payment was approved for a specific measurement and tariff.** Connecting the meter, the payer and the settlement record leaves an evidence and reconciliation gap.

**Why Stellar MPP alone is not enough.** MPP answers two questions: how much did the payer authorize, and did it settle? It cannot answer the third: *for what?* An MPP voucher signs a channel and a running total, with no reading, unit or price. The channel contract pays any amount the payer signed and never sees the meter. So any usage log can be shown next to a valid payment, and nobody can prove they belong together. UsagePay adds that link on top of MPP, without a new contract.

**Fits what is already deployed.** No new hardware: UsagePay is built to read the meter data existing standards already carry (in EV charging, OCPP with OCMF signed readings), with no new device or firmware change. No new payment protocol: it uses Stellar MPP and the existing one-way channel contract, unchanged. Charger management, billing and roaming systems keep their role. In this MVP the meter is simulated and OCPP-shaped, not certified and not conformant.

## Our solution

UsagePay provides the **application-level bridge** between those existing systems:

```text
Simulated meter, demo: EV charger (signed reading)
    -> Verify reading + apply fixed tariff
    -> Payer (demo: EV fleet) approves usage and spending
    -> Native Stellar MPP signed cumulative commitment
    -> Payer signs a separate evidence-to-payment acknowledgement
    -> Real channel close on Stellar Testnet
    -> Independent verifier checks evidence, signatures and payout
```

The hackathon result is one reproducible flow: **three approved consumption increments, one genuine Testnet settlement, and an independently verifiable E0/E1 evidence bundle.** The demo also rejects a tampered reading, an over-budget payment and five other attack and failure scenarios.

### Key trade-offs — what we do *not* claim

| Choice | Why | Limitation |
|---|---|---|
| Simulated, signed EV readings | Demonstrate the complete evidence chain without hardware | Not certified metrology or full OCPP/OCMF compliance |
| Existing Stellar MPP + experimental one-way-channel | Reuse payment primitives instead of building another contract | **Testnet only**; experimental contract, not audited production infrastructure |
| Separate payer-signed evidence acknowledgement | Prove the payer approved a particular evidence/amount association | The channel contract **does not** validate meter data on-chain |
| Off-chain E0/E1 and simple local execution | Keep the prototype small and independently replayable | No privacy guarantee, production-grade persistence, or 24/7 operations |

## Run it

Requirements: Node.js 22.12+ and pnpm 10.33.0 through Corepack (`corepack enable`). Every command below runs from the repository root.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck          # all packages and tests
corepack pnpm test               # every offline test (unit + module + integration)
corepack pnpm test:contracts     # SPEC 00 contracts, fixtures and the SPEC 04 cross-package scenarios S1/F1-F7
corepack pnpm build              # all packages and the demo entry point
corepack pnpm demo               # judge walkthrough: replay of the latest real Testnet run + live read-only verification
corepack pnpm ui:build           # demo UI: refreshes the bundle, builds apps/web/dist/index.html (one self-contained file)
corepack pnpm ui:preview         # serves the demo UI locally; presenter keys → ← Space T S
corepack pnpm test:e2e:testnet   # EXPLICIT OPT-IN, live Testnet: needs UPAY_TESTNET_E2E=1 and funded disposable identities
```

`pnpm demo` prints five labelled steps:
1. The simulated meter signs its readings.
2. The fleet approves each step and signs a voucher plus a receipt.
3. One real Testnet close settles the session.
4. An independent verifier checks V01–V08 live and read-only.
5. Offline scenarios show a tampered reading, the budget cap, replay, evidence detachment, false settlement, edited records and a lost connection.

It replays a captured run and labels it `REPLAY`; it never presents that run as a new payment. It also writes `apps/demo/out/demo-bundle.json`, which the demo UI renders. Its exit codes:

| Code | Meaning |
|---|---|
| `0` | PASS |
| `1` | FAIL |
| `2` | NOT_AVAILABLE (offline, or the ledger cannot be reached) |
| `3` | Usage error |

`pnpm test:e2e:testnet` refuses to run without the opt-in or with any non-Testnet configuration. It then runs the whole real flow with fresh evidence:
1. It deploys a fresh `upay-e2e-*` channel with a 1 USDC Testnet deposit.
2. It authorizes three real SDK-signed cumulative commitments, freezes E0, closes the channel once and writes E1 (G2).
3. It verifies the result independently (G3).

Identity and funding setup is described in [scripts/testnet/README.md](scripts/testnet/README.md).

### Verify without keys (reviewers)

Reviewers need no keys and no Testnet funds. Each committed `scripts/testnet/runs/g2-*` directory holds a real captured public bundle:

| File | Contents |
|---|---|
| `e0.json` | Sealed evidence, written before the close |
| `e1.json` | Observed settlement |
| `trust.json` | Public trust inputs, pinned before the first increment |
| `trace.jsonl` | Event trace of the run |

```bash
RUN=scripts/testnet/runs/<g2-run>
corepack pnpm verify $RUN/e0.json $RUN/e1.json --trust $RUN/trust.json            # live, read-only RPC
corepack pnpm verify $RUN/e0.json $RUN/e1.json --trust $RUN/trust.json --offline  # V08 becomes NOT_AVAILABLE, never PASS
```

### What is real and what is simulated

| Component | Status |
|---|---|
| Stellar MPP channel commitments | **Real.** Signed by the pinned `@stellar/mpp` SDK at runtime |
| Payer evidence receipts | **Real.** Runtime Ed25519 signatures |
| Channel deploy, deposit and close | **Real** Stellar Testnet transactions |
| Independent verification | **Real.** Read-only Stellar RPC: transaction, contract events, instance storage and getters |
| Meter | **Simulated.** A software charger signs OCPP-shaped readings with a disposable key. Not certified and not OCPP/OCMF conformant |
| Asset | Testnet USDC only. It has no real value |
| Offline scenarios S1/F1–F7 (`SDK_INTEGRATION`) | Run the real modules and SDK signatures against a **simulated** ledger. They prove refusal logic, not settlement |

### Testnet evidence (demo day)

The official Testnet evidence for HackMeridian was generated on **2026-10-25** with `UPAY_TESTNET_E2E=1 corepack pnpm test:e2e:testnet` (run [`e2e-2026-10-25T18-42-23-653Z`](scripts/testnet/runs/e2e-2026-10-25T18-42-23-653Z/summary.json)):
- channel `upay-e2e-20261025t1842`: [`CBFRK646MGAOQK5M7ZALES7ATVNNTTF4ULBJ3WQ6Z5FEH4IDBGW7XHKM`](https://stellar.expert/explorer/testnet/contract/CBFRK646MGAOQK5M7ZALES7ATVNNTTF4ULBJ3WQ6Z5FEH4IDBGW7XHKM);
- close transaction, ledger 5386036: [`0626430c4b707bf3273ee9b454a73e014de5a3df0d5f24449ece9abb075ca1da`](https://stellar.expert/explorer/testnet/tx/0626430c4b707bf3273ee9b454a73e014de5a3df0d5f24449ece9abb075ca1da);
- settlement run (E0, E1, `trust.json`): [`g2-2026-10-25T18-42-37-596Z`](scripts/testnet/runs/g2-2026-10-25T18-42-37-596Z/);
- independent verification, V01–V08 PASS: [`g3-2026-10-25T18-42-49-636Z/s1-report.txt`](scripts/testnet/runs/g3-2026-10-25T18-42-49-636Z/s1-report.txt).

The G1 channel feasibility run of the same day is reported in [docs/g1-testnet-feasibility.md](docs/g1-testnet-feasibility.md). Soroban RPC keeps transactions and events for about 7 days; after that, V08 reports `NOT_AVAILABLE` until a fresh run exists. The full procedure is in SPEC 04 §9.

### Provenance

Resolved versions are recorded in [implementation-versions.json](implementation-versions.json) and checked by `pnpm versions:check`.

| Source | Pinned version |
|---|---|
| `@stellar/mpp` | 0.7.1 ([stellar-mpp-sdk](https://github.com/stellar/stellar-mpp-sdk) `9f2f825`) |
| `mppx` | 0.6.31 |
| `@stellar/stellar-sdk` | 15.1.0 |
| [one-way-channel](https://github.com/stellar-experimental/one-way-channel) | `25dea1b`, wasm sha256 `d662c121…5d90`, reproducible build |

## Start reading here

| File | Purpose | Who reads it |
|---|---|---|
| **[01.1 — Technical Architecture & Roadmap](01.1-usagepay-technical-architecture-and-roadmap.md)** | **Authoritative MVP scope**, invariants, architecture and P0/P1 priorities | Everyone — first |
| **[Hackathon Pitch & Demo](docs/HACKATHON-PITCH-AND-DEMO.md)** | Three-minute pitch, demo sequence and honest claims | Everyone; presenters |
| **[SETUP.md](SETUP.md)** | Configure Claude Code, Stellar Skills, Raven MCP, CLI and local prerequisites | Every developer |
| **[CLAUDE.md](CLAUDE.md)** | Mandatory execution rules and completion-report format for Claude | Every Claude session |
| [Product Foundation](docs/usagepay/01.2-usagepay-product-foundation.md) | Personas, positioning and product hypothesis | Product/pitch questions |
| [Viability Gates](docs/usagepay/01.3-usagepay-viability-gates.md) | How the idea can be validated or falsified | Mentors/product discussion |
| [Economics](docs/usagepay/01.4-usagepay-economics.md) | Commercial assumptions and potential business models | Business questions |

**Document priority:** 01.1 defines *what* to build; SPEC 00 and the assigned module SPEC define *how* to implement it. Product research is background, not an instruction to add features.

## Specs

Each module has its own SPEC; [01.1](01.1-usagepay-technical-architecture-and-roadmap.md) is the product authority above them.

| SPEC | Defines | Code |
|---|---|---|
| [00 — Shared Contracts](specs/00-shared-contracts-and-engineering-rules.md) | Shared types, runtime schemas, canonical JSON, digests, signing formats, fixtures and dependency pins | `packages/contracts`, `fixtures` |
| [01 — Metering & Evidence](specs/01-metering-and-evidence.md) | Simulated charger, signed raw readings, normalization, deterministic tariff and evidence digests | `packages/metering` |
| [02 — Payer & Settlement](specs/02-payer-and-stellar-settlement.md) | Fleet approval and budget, native MPP commitments, payer evidence receipt, Testnet channel close, E0/E1 | `packages/settlement` |
| [03 — Independent Verifier](specs/03-independent-verifier.md) | Checks V01–V08 over signatures, tariff, binding and the ledger, with PASS / FAIL / NOT_AVAILABLE | `packages/verification` |
| [04 — Integration & Acceptance](specs/04-integration-and-acceptance.md) | End-to-end flow, scenarios S1/F1–F7, the `demo` walkthrough and the demo bundle | `apps/demo`, `scripts/testnet` |
| [05 — Demo UI & UX](specs/05-demo-ui-and-ux.md) | Judge-facing page over the demo bundle: off-chain vs on-chain flow, Testnet settlement, auditor, failure scenarios | `apps/web` |

## Build results

| Gate | Deliverable | Result and evidence |
|---|---|---|
| **G0 — Offline foundation** | TypeScript workspace, frozen SPEC 00 schemas, fixtures and contract tests | PASS: `corepack pnpm test:contracts` |
| **G1 — Stellar feasibility** | Real MPP channel lifecycle on Testnet, captured native commitment signature, actual close | PASS, 35 of 35 checks: [G1 report](docs/g1-testnet-feasibility.md) |
| **G2 — Modules** | SPEC 01–03: metering, payer and settlement, independent verifier | PASS: settlement run [`g2-2026-10-25T18-42-37-596Z`](scripts/testnet/runs/g2-2026-10-25T18-42-37-596Z/) |
| **G3–G5 — Integration and demo** | Real end-to-end flow, independent verification, repeatable demo and UI | PASS: [E2E run](scripts/testnet/runs/e2e-2026-10-25T18-42-23-653Z/summary.json), V01–V08 [report](scripts/testnet/runs/g3-2026-10-25T18-42-49-636Z/s1-report.txt), `corepack pnpm demo` prints `DEMO PASS` |

`corepack pnpm test` runs 461 offline tests in 25 files. **Testing pyramid:** deterministic unit tests → module and contract integration tests → real Stellar Testnet E2E → demo smoke test, including tampering, budget refusal, replay and missing-chain-data paths. Mocks never count as real Testnet evidence.

## Repository layout

```text
usagepay/
├── 01.1-usagepay-technical-architecture-and-roadmap.md   # product authority
├── specs/                      # SPEC 00-04 implementation contracts, SPEC 05 demo UI & UX
├── packages/
│   ├── contracts/              # SPEC 00 shared schemas, JCS, digests, signatures
│   ├── metering/               # SPEC 01 simulated charger, signed readings, tariff
│   ├── settlement/             # SPEC 02 payer gate, payee ack gate, MPP commitments, close, E0/E1
│   └── verification/           # SPEC 03 independent verifier V01-V08 and `verify` CLI
├── fixtures/                   # SPEC 00 deterministic OFFLINE_FIXTURE data and conformance cases
├── apps/demo/                  # SPEC 04 scenarios S1/F1-F7, plain-language narrative, `demo` CLI and bundle
├── apps/web/                   # SPEC 05 judge-facing demo UI (static, renders the demo bundle, no keys, no network)
├── scripts/testnet/            # G1/G2/G3 and E2E Testnet runners; runs/ holds public evidence
└── docs/                       # pitch, G1 feasibility notes, product research
```

## Security

The repository holds no private key, `.env` file, credential or fabricated transaction evidence. Every Testnet identity is disposable, and the page, the payee and the verifier never receive the payer's private key. Testnet only: no mainnet account or real money is used.

## How it was built

Built with [Claude Code](https://claude.com/claude-code) under the execution rules in [CLAUDE.md](CLAUDE.md): one gate at a time, each closed only after its tests and Testnet checks actually ran, never on code inspection alone. Setup is in [SETUP.md](SETUP.md).

**Definition of success:** an engineer or judge can replay the documented flow, inspect a real Stellar Testnet settlement and independently understand why a particular charge passed — or failed — verification.

## Team

**Skopo Team**
- Wesley Santos: [LinkedIn](https://www.linkedin.com/in/wesleymassine/)
- Mario León: [LinkedIn](https://www.linkedin.com/in/mario-garc%C3%ADa-le%C3%B3n-0a76ab420)

## License

[MIT](LICENSE) © Skopo Labs
