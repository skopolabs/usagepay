# UsagePay — Claude Code Execution Rules

**Product authority:** `01.1-usagepay-technical-architecture-and-roadmap.md` v1.1.1.  
**Implementation authority:** `specs/00-shared-contracts-and-engineering-rules.md`, followed by the relevant module SPEC (01–04) and, for the judge-facing UI, SPEC 05 (presentation layer only).  
**Language:** All repository artifacts, code comments and completion reports in English.

## Mission
Implement only the HackMeridian P0: signed simulated EV metering → deterministic tariff → fleet authorization and payer-signed evidence acknowledgement → genuine MPP cumulative commitments → Stellar Testnet channel close → independent E0/E1 verification. Never expand the product scope or introduce a custom payment contract.

## Work one gate at a time

1. **G0 — First assignment:** Read product document 01.1 and SPEC 00. Bootstrap the TypeScript/Node.js 22+/pnpm workspace, freeze shared schemas/types, canonicalization, fixtures and contract tests. Pin compatible dependencies and save resolved versions in `implementation-versions.json`. Run offline tests, typecheck and build. **Do not implement business modules or submit transactions in G0.**
2. **G1 — Separate assignment, after G0 passes:** With disposable funded Testnet identities, run the official MPP channel lifecycle, capture authentic native signed credential/preimage, verify signature and actual on-chain close. Record public transaction evidence. A progress callback alone is not proof of captured commitment bytes.
3. **G2–G5 — Later assignments:** Implement SPEC 01–03 in owned modules, then follow SPEC 04 for integration, independent verification and the demo. Parallel work begins only after frozen contracts and the native-credential capture gate.

Never skip a failed gate. Stop and report the smallest actionable blocker. An MPP Charge fallback cannot be described as passing a channel-specific acceptance test.

## Approved stack and references

- TypeScript; Node.js 22+; pnpm; Vitest or an agreed test runner; **Stellar Testnet only**.
- Use the pinned `@stellar/mpp`, compatible `mppx`, `@stellar/stellar-sdk`, and the upstream experimental `one-way-channel` contract. Do not invent APIs or rewrite commitment signing.
- Confirm the *installed* SDK version and source before implementation. Use official Stellar developer skills (`agentic-payments`, `data`, `assets`), Raven MCP, and the SDK's own examples/tests when behavior is uncertain.
- Official examples: `stellar/stellar-mpp-sdk/examples/channel-client.ts`, `channel-server.ts`, `channel-close-mpp.ts`; `stellar-experimental/one-way-channel/examples/demo.sh`.
- Use exact pinned dependency versions and a committed lockfile. No automatic dependency upgrades mid-hackathon.

## Invariants

- Payer and meter signing keys are separate, disposable Testnet identities. The payee, client UI and verifier must never receive payer private keys. Never use mainnet or personal secrets.
- All monetary amounts and energy calculations use integers / `bigint`, never floating-point financial arithmetic.
- A native MPP signature authorizes a cumulative channel amount; it **does not** cryptographically bind meter data on its own. The separate, payer-signed acknowledgement must bind the evidence digest, exact native commitment digest, channel and network.
- Native MPP commitments and Testnet settlement must be real, not fabricated or mock results passed off as real.
- E0 is immutable before settlement. E1 references E0 and the verified post-close chain state; no circular reference to a future transaction.
- The independent verifier recomputes all relevant hashes and signatures. Never trust a stored `verified: true`, a transaction hash alone or a fabricated chain receipt.
- One-process demo storage is permitted but must never be described as production durability; physical meter certification, protocol conformance and hardware disconnection are out of scope.

## Collaboration and testing

- Only modify directories owned by the assigned SPEC. A shared schema change requires coordinator approval, updated fixtures and passing consumer contract tests.
- Tests form a pyramid: deterministic unit tests → component integration tests → real Testnet E2E → repeatable demo, including negative paths and unavailable-RPC status.
- For each gate, run the exact applicable commands and report what **actually ran**. Never infer success from code inspection alone.
- Use fixture/test data for simulated readings; all signed commitments, private keys and Testnet receipts are generated at runtime and never committed as fabricated proofs.

## Completion report (brief)

`Gate | PASS/FAIL/BLOCKED | Files changed | Commands and results | Testnet proof (if applicable) | Remaining blocker`

If the product authority file or any required SPEC is unavailable, report the missing path rather than guessing requirements.
