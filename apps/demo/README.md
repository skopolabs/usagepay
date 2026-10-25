# @usagepay/demo (SPEC 04)

This package is the integration coordinator's area. It does four things:
- composes the public ports of SPEC 01 metering, SPEC 02 settlement and SPEC 03 verification into the S1/F1–F7 acceptance scenarios;
- explains every step in plain language;
- renders the judge walkthrough;
- writes the bundle the demo UI renders.

It adds no schema and duplicates no module logic. It holds no key material beyond in-memory disposable keys for the offline scenarios.

## Entry points

| Export | Role |
|---|---|
| `runScenarios()` | Runs S1 and F1–F7 in order. Each result has the scenario ID, session, expected and actual outcome, reason code, evidence class, checkpoints and a plain-language story |
| `installOfflineChain(channel)` | OFFLINE stand-in for one one-way-channel contract behind Soroban RPC (see below) |
| `explainEvent`, `explainTrace`, `CHECK_EXPLANATIONS`, `EVIDENCE_CLASSES`, `explainReason` | The plain-language layer. Each event gets an actor (meter, fleet, station, Stellar, auditor), an `ON_CHAIN`/`OFF_CHAIN` layer, a status, a title and one sentence. Each evidence class gets a label and one sentence |
| `loadRealRun`, `findLatestRun`, `observeLedger`, `cliEquivalents` | Load a captured `g2-*` Testnet run and its `trust.json`. Read the ledger now, read-only. Show the `stellar` CLI command that reproduces each on-chain fact |
| `buildBundle` → `DemoBundle` (`upay.demo-bundle.v1`) | The single data source of the walkthrough and the UI (`apps/web`, SPEC 05). Public values only |
| `@usagepay/demo/format` | Pure integer display helpers (`formatAmount`, `formatEnergy`, `short`), the only runtime code the browser UI imports |
| `runDemo` / `dist/bin.js` | `pnpm demo [--run <g2-run>] [--trust <file>] [--offline] [--json] [--out <file>] [--rpc <url>] [--timeout <ms>]` |
| `testnetGuard` | Opt-in and Testnet-only refusal rules of `pnpm test:e2e:testnet` |

`pnpm demo` exit codes:

| Code | Meaning |
|---|---|
| `0` | PASS: every scenario met its expectations and the real run verified V01–V08 live |
| `1` | FAIL |
| `2` | NOT_AVAILABLE: offline, or the ledger cannot be reached. This is never PASS |
| `3` | Usage error |

## Scenarios (offline, `SDK_INTEGRATION`)

The modules and the pinned `@stellar/mpp` client and server run unmodified, with real challenges, real `prepare_commitment` round trips, real Ed25519 signatures and real SDK verification. Only the network methods of `rpc.Server.prototype` are answered locally while a scenario runs. The offline close checks the commitment signature as the contract does. **None of this is Testnet evidence.**

| ID | Stimulus | Expected outcome |
|---|---|---|
| S1 | Three signed 250 Wh readings | 1,000,000 → 2,000,000 → 3,000,000. One close pays 3,000,000 and refunds 7,000,000. Verifier V01–V08 PASS |
| F1 | One byte of r-002 changed after signing (10500 → 19500 Wh) | Metering, payer and verifier each give `INVALID_METER_SIGNATURE`. No voucher is signed |
| F2 | Fresh session with a 2,500,000 budget cap | r-003 gives `BUDGET_EXCEEDED` before any signature. The station is paid exactly 2,000,000, and the verifier passes the capped session |
| F3 | r-002 delivered twice; an ack nonce reused | `DUPLICATE_READING`, `REPLAY_NONCE`. No double payment |
| F4 | Receipt re-pointed in transit; receipt re-pointed after sealing | The station refuses with `INVALID_PAYER_ACK`. The verifier gives V05 PASS (the voucher is genuine) and V06 FAIL |
| F5 | Unrelated SUCCESS tx; overstated E1; ledger unreachable | V08 `CHAIN_MISMATCH` twice, then `NOT_AVAILABLE`. Never PASS |
| F6 | E0 edited after sealing; E1 claims SUCCESS for a FAILED tx | `E0_DIGEST_MISMATCH`, `SETTLEMENT_FAILED` |
| F7 | Answer lost after the voucher was sent; close lost in transit | `PENDING` until reconciled. Sealing is refused while pending. The close is not reported as settled and is not retried blindly |

`corepack pnpm vitest run --project integration` runs these scenarios, the narrative tests, the demo CLI tests (against the committed real run with a ledger double) and the Testnet guard tests. `pnpm test:contracts` includes this project.
