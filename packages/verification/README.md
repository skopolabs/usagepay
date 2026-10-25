# @usagepay/verification (SPEC 03)

The independent verifier. It recomputes four things from E0/E1:
- the signed meter bytes;
- the tariff replay;
- the evidence digests;
- the genuine native MPP commitments and the payer acks.

It then checks the Stellar Testnet close through read-only RPC. Every comparison is against trust inputs pinned outside the evidence. It holds no keys, and it never signs or submits anything.

## Entry points

| Export | Role |
|---|---|
| `createVerifier({ trust, chain?, encoding?, timeoutMs? })` | `VerificationPort.verify({ e0, e1 })` returns the report: one SPEC 00 `VerificationResult` per check, plus the overall verdict and a public `subject` |
| `createStellarChainReader({ rpcUrl? })` | Read-only `ChainReader`: `getTransaction` (decoded envelope), `getEvents` for the close ledger, the instance-storage `CommitmentKey`, and the channel getters through simulation |
| `trustFromFile(json)` | Parses a `usagepay.verifier-trust.v1` file into `VerifierTrust` |
| `formatReport(report)` | SPEC 03 §4 text view with the explicit P0 limitations. Prints public values only and never a raw meter payload |
| `runCli(argv, deps)` / `dist/bin.js` | `verify <e0.json> <e1.json> --trust <trust.json> [--offline] [--json] [--rpc <url>] [--timeout <ms>]` |

CLI exit codes:

| Code | Meaning |
|---|---|
| `0` | PASS |
| `1` | FAIL |
| `2` | NOT_AVAILABLE |
| `3` | Usage or trust-input error; no verdict was produced |

## Checks

| ID | Recomputes |
|---|---|
| V01 | SPEC 00 E0/E1 schemas: network, formats, sequence order, unique readings and ack nonces, no extra fields such as a stored `verified` flag |
| V02 | Pinned meter key over the exact `rawPayloadB64` bytes; canonical signed payload equals the reading envelope; signed counter and interval continuity; nothing after `terminal_signed`; `certification` reported |
| V03 | Tariff digest equals the pinned digest; asset is the pinned SAC; validity window; bigint `floor_cumulative` replay; fleet budget cap (AC13) |
| V04 | Pinned session; `readingDigest` and `evidenceDigest` from the exact preimages; strictly increasing cumulatives |
| V05 | Signed message is byte-equal to the pinned XDR commitment for (pinned channel, replayed amount); Ed25519 signature under the pinned commitment key; `commitmentDigest` |
| V06 | Ack signature over the domain-separated JCS message; payer key pinned; binds the increment's recomputed evidence and commitment digests, amount, session, channel and network; nonce unique |
| V07 | `SHA256(JCS(E0)) = E1.e0Digest`; E1 network, channel and asset are the pinned ones |
| V08 | See below |

V08 checks the following against the chain:
1. RPC observes a successful `close(amount, signature)` of the pinned channel with E0's highest commitment.
2. A `withdraw {to, amount}` event pays that amount to the pinned recipient.
3. The on-chain `CommitmentKey`, `from`, `to` and `token` are the pinned ones.
4. `withdrawn()` equals the amount and `balance()` is 0.
5. The E1 status and the settled amount match what was observed.

Verdict precedence is FAIL > NOT_AVAILABLE > PASS, and PASS requires all of V01–V08. An offline run, an RPC outage, a timeout, a transaction outside RPC retention, or a missing `withdraw` event all give NOT_AVAILABLE, never PASS. Contradicting chain data gives FAIL.

## Independence

The package depends only on `@usagepay/contracts` and `@stellar/stellar-sdk`. It never imports the metering or settlement modules. The XDR commitment encoding is rebuilt here; the contract test proves it byte-equal to the SDK-signed messages captured on Testnet in G2.

## Tests

`corepack pnpm vitest run --project verification` runs offline. Chain answers are doubles at the `ChainReader` port, and the RPC adapter test fakes only `rpc.Server.prototype`.

| ID | Where | Outcome |
|---|---|---|
| S1-C | `offline.test.ts` | Golden session passes V01–V07 with 1,000,000 / 2,000,000 / 3,000,000; overall is NOT_AVAILABLE without chain proof |
| F1-C | `offline.test.ts` | One flipped source byte, an unpinned or unknown meter key, or an envelope mismatch → V02 FAIL; a stored `verified: true` → V01 FAIL |
| F3-C | `offline.test.ts` | Duplicate reading, reused nonce or reordered increments → V01 FAIL; a counter, interval or terminal gap → V02 `COUNTER_DISCONTINUITY` |
| F4-C | `offline.test.ts` | Mutated evidence, tariff, price, rounding, budget, asset, session or channel → V03–V07 FAIL while the native signature stays genuine |
| F4-D | `offline.test.ts` | Different amount or channel, replaced signature, wrong signer or wrong key → V05 `NATIVE_COMMITMENT_INVALID` |
| F5-C | `chain.test.ts` | Unrelated SUCCESS tx, wrong close amount or signature, payout recipient or amount, channel parties, token or key, `withdrawn()`, residual balance, overstated E1 → V08 FAIL |
| F5-D | `chain.test.ts` | RPC down, timeout, NOT_FOUND, events outside retention, missing `withdraw` event, unreadable key → V08 NOT_AVAILABLE |
| AC01–AC17 | `conformance.test.ts` | Every frozen case fails one of its catalogue checks (AC13 in V03); every control passes V01–V07 |
| Contract | `g2-artifacts.test.ts` | The newest committed genuine G2 E0/E1 (with its `trust.json`) passes V01–V08 against a chain double; a flipped byte fails |
| Adapter | `stellar-reader.test.ts` | Close envelope, events and contract state decoded from Soroban RPC XDR shapes |
| CLI | `cli.test.ts` | Exit codes, `--offline`, `--json`, `--rpc`; trust file required |

The live Testnet E2E is opt-in and read-only:

```sh
corepack pnpm g3:verify   # newest g2-* run: S1 PASS, F1-C FAIL, F5-C FAIL (real unrelated close), F5-D NOT_AVAILABLE
corepack pnpm verify scripts/testnet/runs/<g2-run>/e0.json scripts/testnet/runs/<g2-run>/e1.json --trust scripts/testnet/runs/<g2-run>/trust.json
```
