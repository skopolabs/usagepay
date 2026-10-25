# UsagePay — HackMeridian MVP

*Infrastructure for the machine economy.*

**UsagePay enables verifiable machine-to-machine payments for metered services on Stellar.**

Every payment carries its proof: the signed measurement, the price applied, the payer's approval and the Stellar settlement, checkable by anyone.

**Demo use case: EV charging**, because everyone understands a charger and a kilowatt-hour. UsagePay is not an EV charging product. The same flow fits any service a machine can measure: energy, compute time, connectivity, equipment hours, water. This MVP implements one adapter, energy in Wh; a second adapter is on the roadmap. Messaging and claim guardrails: [01.2 §0.1](docs/usagepay/01.2-usagepay-product-foundation.md#01-positioning-and-messaging-single-source-for-the-ui-readme-and-pitch).

## HackMeridian positioning — Genesis / Stellar Composed

**Target track:** [Genesis → Stellar Composed](https://www.hackmeridian.com/). The event describes this track as combining **two or more Stellar ecosystem tools or projects into something new**. This is our intended positioning, subject to mentor/judge confirmation.

| Building block | Role in UsagePay |
|---|---|
| [Stellar MPP SDK](https://github.com/stellar/stellar-mpp-sdk) + [experimental one-way-channel](https://github.com/stellar-experimental/one-way-channel) | Existing off-chain cumulative payment commitments and on-chain settlement; **already integrated upstream** |
| [Stellar RPC / JavaScript SDK](https://developers.stellar.org/docs/data/apis/rpc) | Independently query and verify the Testnet channel and settlement |
| **UsagePay's metering/evidence integration** | Bind signed usage evidence, an accepted tariff and payer authorization to the payment, then replay verification independently |

**What is new:** the evidence-to-authorization and independent-verification layer for metered machine services — **not** MPP itself, the payment channel, or the existing MPP-to-channel integration. The independent use of Stellar RPC and the application-layer composition must be demonstrated in the MVP, rather than asserted only in the pitch.

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

The hackathon result is one reproducible flow: **three approved consumption increments, one genuine Testnet settlement, and an independently verifiable E0/E1 evidence bundle.** The demo must also reject a tampered reading and an over-budget payment.

### Key trade-offs — what we do *not* claim

| Choice | Why | Limitation |
|---|---|---|
| Simulated, signed EV readings | Demonstrate the complete evidence chain without hardware | Not certified metrology or full OCPP/OCMF compliance |
| Existing Stellar MPP + experimental one-way-channel | Reuse payment primitives instead of building another contract | **Testnet only**; experimental contract, not audited production infrastructure |
| Separate payer-signed evidence acknowledgement | Prove the payer approved a particular evidence/amount association | The channel contract **does not** validate meter data on-chain |
| Off-chain E0/E1 and simple local execution | Keep the prototype small and independently replayable | No privacy guarantee, production-grade persistence, or 24/7 operations |

## Start reading here

| File | Purpose | Who reads it |
|---|---|---|
| **[01.1 — Technical Architecture & Roadmap](01.1-usagepay-technical-architecture-and-roadmap.md)** | **Authoritative MVP scope**, invariants, architecture and P0/P1 priorities | Everyone — first |
| **[Hackathon Pitch & Demo](docs/HACKATHON-PITCH-AND-DEMO.md)** | Two-minute explanation, demo sequence and honest claims | Everyone; presenters |
| **[SETUP.md](SETUP.md)** | Configure Claude Code, Stellar Skills, Raven MCP, CLI and local prerequisites | Every developer |
| **[CLAUDE.md](CLAUDE.md)** | Mandatory execution rules and completion-report format for Claude | Every Claude session |
| [Product Foundation](docs/usagepay/01.2-usagepay-product-foundation.md) | Personas, positioning and product hypothesis | Product/pitch questions |
| [Viability Gates](docs/usagepay/01.3-usagepay-viability-gates.md) | How the idea can be validated or falsified | Mentors/product discussion |
| [Economics](docs/usagepay/01.4-usagepay-economics.md) | Commercial assumptions and potential business models | Business questions |

**Document priority:** 01.1 defines *what* to build; SPEC 00 and the assigned module SPEC define *how* to implement it. Product research is background, not an instruction to add features.

## Team responsibilities (1–3 developers)

| Owner | SPEC | Implementation responsibility |
|---|---|---|
| **All / coordinator** | [00 — Shared Contracts](specs/00-shared-contracts-and-engineering-rules.md) | Shared types, runtime schemas, fixtures, signing formats, contract tests and dependency versions |
| **Dev 1 — Backend** | [01 — Metering & Evidence](specs/01-metering-and-evidence.md) | EV simulator, signed raw readings, normalization, deterministic tariff and evidence digests |
| **Dev 2 — Stellar** | [02 — Payer & Settlement](specs/02-payer-and-stellar-settlement.md) | Fleet approval, native MPP commitments, evidence acknowledgement, Testnet channel and close |
| **Dev 3 — Verification + Frontend** | [03 — Independent Verifier](specs/03-independent-verifier.md) | Independent signature/tariff/chain checks, readable results and minimal demo UI |
| **All / coordinator** | [04 — Integration & Acceptance](specs/04-integration-and-acceptance.md) | Wire modules together, execute success/error tests and prepare a repeatable demo |
| **All / coordinator** | [05 — Demo UI & UX](specs/05-demo-ui-and-ux.md) | Judge-facing UI over the demo bundle: off-chain vs on-chain flow, Testnet confirmation, Verify page, failure scenarios |

With one developer, execute the same workstreams sequentially. With two or three, split modules **only after shared contracts and the Stellar technical gate pass**. Each owner modifies their assigned module; shared contract changes require coordinator approval.

## Execution order

| Gate | Deliverable | Stop condition |
|---|---|---|
| **G0 — Offline foundation** | TypeScript workspace, frozen SPEC 00 schemas, fixtures and passing tests | No blockchain transactions; stop after reporting results |
| **G1 — Stellar feasibility** | Real Testnet MPP credentials, captured native signature, payer acknowledgement verification boundary and actual channel close | If native proof cannot be captured/verified, report **BLOCKED**; do not simulate success |
| **G2 — Parallel modules** | SPEC 01, 02 and 03 implementations passing their respective tests | Do not modify another module's interfaces unilaterally |
| **G3–G5 — Integration and demo** | Real end-to-end flow, independent PASS/FAIL/NOT_AVAILABLE results, repeatable presentation | Demo only after mandatory P0 checks pass |

**Testing pyramid:** deterministic unit tests → module/contract integration tests → real Stellar Testnet E2E → demo smoke test. Include positive paths, tampering, budget refusal, replay and missing-chain-data behavior. Mocks never count as real Testnet evidence.

## First Claude Code session

Follow [SETUP.md](SETUP.md), open a terminal at the repository root, and run `claude`. Then give Claude this assignment:

```text
Read CLAUDE.md, UsagePay 01.1 and SPEC 00. Execute G0 only:
initialize the workspace, implement frozen shared schemas, canonicalization,
fixtures and offline contract tests. Run tests, typecheck and build.
Report actual results and STOP before G1. Do not submit transactions.
```

**Security:** use disposable Testnet-only identities for G1. Never commit private keys, `.env`, credentials, or fabricated transaction evidence. All project deliverables and code are written in English.

**Definition of success:** an engineer or judge can replay the documented flow, inspect a real Stellar Testnet settlement and independently understand why a particular charge passed — or failed — verification.
