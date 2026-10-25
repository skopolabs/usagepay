# SPEC 03 — Independent Verifier

**Status:** Ready for Claude implementation after SPEC 00 contract freeze and SPEC 02 native-credential capture gate  
**HackMeridian:** 2026-10-25  
**Product authority:** UsagePay `01.1` v1.1.1  
**Implementation authority:** `specs/00-shared-contracts-and-engineering-rules.md`  
**Input contracts:** SPEC 00 `EvidenceE0`, `EvidenceE1`, `VerificationResult`; SPEC 01 signed meter-source profile; SPEC 02 real MPP credentials, payer acknowledgements and settlement artifacts.

**Mission:** Independently recompute whether recorded consumption, its approved monetary amount, the **actual native MPP commitment**, the separate payer-signed evidence acknowledgement and the **observed Stellar Testnet settlement** agree. The verifier must not trust UsagePay's stored success flags or claim that Stellar validates physical consumption.

## 1. Scope and ownership

| P0 — implement | P1 — only after the full P0 flow | Out of scope |
|---|---|---|
| Read E0/E1 + independently supplied trust/config; strict runtime schemas; verify meter bytes/signatures; replay tariff and cumulative arithmetic; verify real MPP Ed25519 signatures and payer acknowledgements; recompute E0 hash; query Stellar RPC for actual channel/close; separate PASS/FAIL/NOT_AVAILABLE checks; minimal CLI or Verify view; tests | Optional human-friendly visual evidence timeline; diagnostics for provisional readings | Certified OCMF, production key trust/PKI, live real-world meter, automatic refunds, chain indexer, multi-vehicle channels, dispute automation, new smart contract, on-chain evidence anchor, privacy proofs, mainnet |

**Ownership:** `packages/verification/**`, its tests and (only if necessary) the small view in `apps/demo/**`. Read `packages/contracts` from SPEC 00. Do **not** change shared schemas, payer/metering implementations, the native MPP signing method or other modules without coordinator approval.

**Inputs:** A frozen `EvidenceE0`, a post-settlement `EvidenceE1`, **independent trusted meter-key registry**, pinned Testnet channel/asset/recipient expectations, and a **read-only** Stellar RPC connection. A local JSON file or HTTP endpoint may supply E0/E1; no new backend is required. Trusted keys and expected recipient/asset/network must **not** be learned solely from E0/E1.

**Outputs:** A typed set of `VerificationResult` checks (`status`, `reasonCode`, `details`) plus a derived overall verdict and concise CLI/page display. Results must be reproducible from the same artifacts and same observed chain state.

## 2. Data flow and trust boundary

```text
Original E0 + E1 files (untrusted assertions)
             |                  Independent trust inputs
             |                  (meter public key, pinned channel/asset/payee,
             |                   network, on-chain commitment key)
             v                         |
      Strict schemas + JCS              |
             |                         |
    +--------+----------+--------------+
    |                   |              |
    v                   v              v
 Meter proof         Payer proof     Chain proof (RPC)
 Signed raw bytes    Tariff replay  Contract identity/state
 Counter continuity  Native MPP sig Close transaction/effects
 Source consistency  Evidence ack    Recipient/asset/amount
    |                   |              |
    +-------------------+--------------+
                        |
                 Individual verdicts
                        |
              Aggregate PASS / FAIL / NOT_AVAILABLE
                        |
                   CLI / Verify view
```

**Not a circular proof:** E0 was finalized off-chain before the close and **does not contain a transaction hash**; E1 records `SHA256(JCS(E0))` and the observed close transaction afterward. E0 being called *finalized* does not itself prove its creation time to an external observer: no trusted timestamp/on-chain anchor is required in P0.

## 3. Verification algorithm (normative)

Run checks in this order, but report all safely evaluable checks if one fails. Never reinterpret malformed evidence as valid because another check passed.

| ID | Independent check | Required behavior |
|---|---|---|
| `V01_SCHEMA` | Strictly validate E0/E1 and each nested SPEC 00 record | Reject wrong network, incorrect decimal integer, invalid base64/hex, duplicate IDs/nonces, empty or malformed signatures, missing required fields, bad sequence/order |
| `V02_METER` | Decode **exact** `rawPayloadB64` and verify the Ed25519 signature against an **externally pinned** simulated meter key; parse the signed simulator profile from SPEC 01 | Recompute signed `meterStartWh`, `meterEndWh`, `deltaWh`, `sessionId`, `machineId`, `readingId`, timestamps; detect unsigned-envelope/source mismatch; report `certification: simulated` independently of signature validity |
| `V03_TARIFF` | Recompute `TariffSnapshot.versionDigest` with JCS; validate asset SAC, precision, session validity and tariff identity | Derive each `cumulativeWh`, `cumulativeChargeBaseUnits = floor(cumulativeWh * pricePerKwhBaseUnits / 1000)` and `deltaChargeBaseUnits` using `bigint`, strictly ordered readings; reject modified price, rounding drift, mismatched asset or interval |
| `V04_EVIDENCE` | Recompute every `readingDigest` and `evidenceDigest` using the **exact** preimages in SPEC 00/01 | Reject mismatched record identifiers, session, evidence hashes, non-monotonic increments and charge totals; never trust a stored verification flag |
| `V05_MPP` | Verify **real** native MPP credential and signed message bytes with the **independently pinned expected** channel commitment key | Reconstruct the native message from the pinned SDK's exact encoding (channel, network, cumulative amount, domain); compare with `signedMessageB64`; verify signature; recompute `commitmentDigest`; require strictly increasing approved cumulatives equal to replayed charges |
| `V06_PAYER_ACK` | Recompute ack preimage `UTF8('usagepay.payer-evidence-ack.v1\n') + JCS(ackWithoutSignature)` | Verify Ed25519 with the **independently pinned payer commitment key**; require exact digest/amount/session/channel/network correspondence to the same increment and unique `(channelId, sessionId, nonce)` |
| `V07_E0_E1_LINK` | Recompute `SHA256(JCS(E0))` | Require equality with `E1.e0Digest`; `E1` network/channel/asset must match the pinned channel and E0's tariff/commitments |
| `V08_CHAIN` | Independently inspect **real** Stellar Testnet RPC results for the exact E1 close transaction and channel | Require confirmed successful close for expected channel, actual payee, SAC and net amount. Verify channel `from`, `to`, `token`, and that the **on-chain commitment key equals the offline-pinned signer**. Cross-check E1 status and any stated settled amount against real transaction/effect/state data rather than trusting a tx hash alone. If authoritative payout/amount evidence cannot be obtained, return `NOT_AVAILABLE`, **not PASS** <br>**Pinned contract facts (G1 D2, D3, D6):** the one-way-channel has no `commitment_key` getter; read `CommitmentKey` from contract instance storage. A close emits `withdraw {to, amount}`, `close` and `refund {amount}`, and leaves `balance() = 0`; expect that, not a residual balance. A transaction or event outside RPC retention (about 7 days for events) yields `NOT_AVAILABLE`, not FAIL. |

**Important:** `V05_MPP` verification of the signature must be performed over the exact bytes, using the pinned SDK/contract encoding. The signature and signed bytes are captured by SPEC 02 from a real native credential; a locally regenerated *fake* signature, a displayed amount or a progress callback is not acceptable. No new native MPP signing algorithm is to be implemented here.

**Chain amount interpretation:** P0 uses **one channel, three serialized cumulative commitments and one final close**, no preceding partial `settle`. In this constrained path, compare the final approved cumulative amount to the payout **proved** by the close transaction and/or authoritative contract accounting. A successful transaction alone does not prove the expected transfer, and a later channel balance alone may not establish the recipient's receipt. Use actual RPC transaction/contract events or independently provable state effects as supported by the pinned contract. If the installed APIs cannot establish amount/payee, log the precise missing evidence and return `NOT_AVAILABLE`. Do not fabricate fields from SDK progress output.

## 4. Verification result semantics and presentation

Use SPEC 00 `VerificationResult` **without changing its shape**. Implement a *module-local* report structure holding these typed results; the shape below is only a presentation projection, not a competing shared contract:

```text
UsagePay Verify — Stellar Testnet (illustrative layout)
E0 digest / session: <computed> / ev-session-001

V01  SCHEMAS & ORDER                PASS
V02  SIGNED METER BYTES             PASS  (simulated key; NOT certified hardware)
V03  PINNED TARIFF / BIGINT         PASS
V04  USAGE EVIDENCE DIGEST          PASS
V05  REAL MPP FINANCIAL SIGNATURE  PASS
V06  PAYER EVIDENCE ACK            PASS
V07  E0 ↔ E1 DIGEST                 PASS
V08  TESTNET CLOSE & PAYOUT         PASS  (observed tx: <real hash>)

CRYPTO/SETTLEMENT RESULT: PASS
PHYSICAL METER CERTIFICATION: NOT PROVIDED
METER VALIDITY ENFORCED ON-CHAIN: NOT PROVIDED
CONFIDENTIAL PAYMENT AMOUNTS: NOT PROVIDED
```

**Verdict precedence (P0):**
- `FAIL` if any mandatory verification check fails conclusively (invalid data/signature, wrong network, amount or recipient, confirmed failed/unrelated transaction).
- Otherwise `NOT_AVAILABLE` if an essential check cannot be performed because data/RPC/contract proof is missing or pending. Offline fixtures can pass `V01`–`V07` but **cannot** earn an end-to-end PASS without real chain verification.
- `PASS` only when **all `V01`–`V08` pass** for the supported one-close Testnet scope.

Return stable reason codes, e.g. `INVALID_SCHEMA`, `UNKNOWN_METER_KEY`, `INVALID_METER_SIGNATURE`, `SIGNED_PAYLOAD_MISMATCH`, `TARIFF_DIGEST_MISMATCH`, `CHARGE_REPLAY_MISMATCH`, `NATIVE_COMMITMENT_INVALID`, `PAYER_ACK_INVALID`, `EVIDENCE_DIGEST_MISMATCH`, `NON_MONOTONIC_CUMULATIVE`, `E0_DIGEST_MISMATCH`, `CHAIN_MISMATCH`, `SETTLEMENT_FAILED`, `RPC_UNAVAILABLE`, `SETTLEMENT_NOT_PROVABLE`. Never return `PASS` for an unverified condition; never hide failures behind a generic “verified” badge.

Module-local codes added in G3: `COUNTER_DISCONTINUITY` (V02), `TARIFF_NOT_ACTIVE`, `ASSET_MISMATCH`, `BUDGET_EXCEEDED` (V03), `SESSION_MISMATCH` (V04), `CHAIN_NOT_QUERIED` (V08 in an offline run) and `PRECONDITION_FAILED`. A check reports `PRECONDITION_FAILED` as NOT_AVAILABLE when the E0 or E1 it reads failed `V01_SCHEMA`. No RPC query is made for an E0 that fails V01.

**Separate claims:** the signature may be valid for a **simulated key** even though physical calibration is not provided. Cryptographic association is **application-level**; the contract checks the financial amount, not the meter. Ordinary public Stellar USDC channels **do not provide confidential amounts**. Report these as explicit limitations, not as failed P0 requirements.

## 5. Implementation interface

Do not add new shared schemas or hidden trust fields. One simple verifier entrypoint is sufficient:

```ts
export interface VerificationPort {
  verify(input: {
    e0: EvidenceE0;
    e1: EvidenceE1;
    // Trust and RPC clients are injected at construction/configuration time,
    // not read from untrusted E0/E1 values.
  }): Promise<{
    overall: VerificationResult;
    checks: Record<string, VerificationResult>;
  }>;
}
```

**Dependencies to inject:** pinned meter public-key registry; explicit expected network=`stellar:testnet`, channel ID, recipient `G...`, asset SAC `C...`, expected payer/channel commitment public key pinned outside the evidence (then confirmed **against chain** by V08); read-only Stellar RPC client; pinned SDK version/config. On RPC outage, cryptographic offline checks should still run and show their statuses, while chain-dependent checks yield `NOT_AVAILABLE`.

**G3 trust inputs.** The injected trust also carries:
- the expected funder (`from`);
- the fleet budget cap, so V03 re-checks AC13 and closes the catalogue's `verifierGap`;
- the commitment byte encoding. It defaults to the pinned one-way-channel XDR. Offline fixtures inject their labelled stand-in.

The CLI reads the trust inputs from a separate `usagepay.verifier-trust.v1` file, never from E0/E1.

**V08 payout proof.** V08 requires both of these:
- the close transaction's `withdraw {to, amount}` event, which ties the payout to that transaction;
- the channel state: `withdrawn()` and `balance() = 0`.

`withdrawn()` alone is not accepted as proof of this close.

**Implementation rules:**
1. Read and validate full E0/E1 records before querying RPC. No signing key or wallet access is required by the verifier.
2. Decode and verify **original meter-signed bytes**, not a reserialized approximation. Recompute all integer charges and digests locally.
3. Verify native commitment preimages with the same **canonical contract byte encoding** as the pinned SDK but **do not sign** anything. Verify the signature offline against the independently pinned expected channel key; the **on-chain match** is a separate mandatory `V08` check. If the on-chain key cannot be read, `V08` is `NOT_AVAILABLE`, even when the offline `V05` signature passes.
4. Verify each payer acknowledgement over the exact domain-separated message; compare all fields directly with the corresponding native commitment, reading/charge, pinned channel and tariff.
5. Obtain chain evidence independently with Stellar RPC `getTransaction`, `getEvents` and/or read-only contract state queries where applicable. Poll only within an explicit bounded timeout; an unknown response remains pending/unavailable. Do not treat the local E1 `txStatus` as authority.
6. Return safe, traceable output with session ID, reading IDs, cumulative Wh/amount and shortened public addresses. Never print private keys, raw secrets or full raw payloads by default.
7. Prefer a **CLI-first** verifier (`verify path/to/e0.json path/to/e1.json`) and a simple optional HTML/React view consuming the same module; do not create a new UI framework or server just to display statuses.

## 6. Test pyramid — explicit data flows and failures

```text
       Demo smoke   verify real Testnet E0/E1; visibly reject tampered evidence
       Testnet E2E one confirmed channel close + actual payout verification
   Module/contract  SPEC 00 E0/E1 and SPEC 01/02 fixtures; mocked RPC only
    Unit (most)    Ed25519, JCS, integer replay, hashes, binding, reason codes
```

| Level / scenario | Input → expected result |
|---|---|
| Unit `S1-C` | Three signed simulator readings 250/250/250 Wh, valid pinned tariff and signed native/ack fixtures → `V01`–`V07` PASS; exact cumulative amounts `1000000`, `2000000`, `3000000` (7-decimal USDC example) |
| Unit `F1-C` **P0** | Modify one raw meter source byte while retaining the original signature → `V02_METER: FAIL`, overall FAIL; a stored `verified: true` must not change this result |
| Unit `F3-C` | Duplicate reading ID or ack nonce, reorder increments, or alter the counter continuity → appropriate check FAIL; no acceptance based on last reported balance |
| Unit `F4-C` **P0** | Mutate evidence digest, tariff, native commitment, approved cumulative amount, session, network or channel after payer signing → `V03`–`V06` FAIL as applicable, even when an independent native MPP signature is valid |
| Unit `F4-D` | Replace native MPP signature or signed message with a different channel/amount → `NATIVE_COMMITMENT_INVALID`, overall FAIL |
| Unit `F5-C` **P0** | E1 points to unrelated real `SUCCESS` transaction or mismatched recipient/asset/amount → `V08_CHAIN: FAIL`, no false settlement PASS |
| Unit `F5-D` | RPC unavailable, transaction pending/`NOT_FOUND`, or no authoritative payout data → `V08_CHAIN: NOT_AVAILABLE`, overall NOT_AVAILABLE unless another conclusive FAIL exists |
| Contract | Feed actual SPEC 01/02 fixture output into SPEC 03; all schema and digest checks pass; no copies of shared types and no dependency on provider success flags |
| **Testnet E2E `S1` P0** | Read **actual** E0/E1 from SPEC 02; query independent Testnet RPC; verify the deployed channel's expected recipient/asset/key and successful close payout, then overall PASS |
| Demo smoke | Run Verify on genuine artifacts, then mutate a copied record and rerun to show immediate FAIL; show simulation/legal limitations and a genuine Testnet tx reference |

**Negative-test expected output example (illustrative):**

```text
F4-C / ev-session-001 / r-002
V05_MPP: PASS   (native payment signature is genuine)
V06_PAYER_ACK: FAIL (evidenceDigest changed after payer signature)
OVERALL: FAIL
```

**Isolation:** unit/contract tests run with deterministic test-only keys and fixed fixture bytes; mock RPC only at external boundary. Real Testnet E2E remains a separate **opt-in** command and must use actual on-chain data. Keep reporting scenario ID, fixture ID, expected versus actual verdict and reason code.

## 7. Claude implementation order and completion gate

1. Read SPEC 00/01/02, especially the **exact** E0/E1 and commitment schemas, signatures and hash preimages. Require SPEC 02's signed-native-artifact capture gate to be resolved; if not, implement only offline parser/tests and report the blocked real-payment assertions.
2. Implement CLI-first, strict schemas, JCS hashing and meter source replay; test `S1-C` and `F1-C`.
3. Implement deterministic tariff arithmetic, reading continuity, evidence digests and E0↔E1 hash verification; test `F3-C`, `F4-C`.
4. Implement native MPP message/signature and payer ack checks **without introducing a new signer**; test `F4-D` and authentic cross-module fixtures.
5. Implement a read-only Stellar RPC adapter and prove channel/recipient/asset/commitment key/close payout independently. Test unrelated tx and unavailable RPC cases (`F5-C`, `F5-D`).
6. Implement concise CLI output and optional small Verify view only if the P0 functionality is complete; produce machine-readable results for SPEC 04 integration.
7. Run package tests, typecheck and build; then run opt-in full Testnet E2E with SPEC 02 generated E0/E1. Record genuine hashes, source/dependency revisions, timeouts and any unavailable proof.

**Done only when:** all offline P0 tests pass; exact original meter bytes and native MPP signatures are verified, E0/E1 digests recomputed, fraud/tampering/wrong-chain outcomes fail deterministically, unprovable settlement is `NOT_AVAILABLE`, and a successful **real Testnet** flow produces an independently reproducible overall PASS. If Testnet channel evidence cannot be obtained, report **BLOCKED**, not DONE.

## 8. Official references

- [Stellar MPP SDK source — native commitment encoding](https://github.com/stellar/stellar-mpp-sdk/blob/main/sdk/src/channel/commitment.ts)
- [Stellar MPP SDK — channel state queries](https://github.com/stellar/stellar-mpp-sdk/blob/main/sdk/src/channel/server/State.ts)
- [Stellar MPP server SDK](https://github.com/stellar/stellar-mpp-sdk/blob/main/sdk/src/channel/server/Channel.ts)
- [Experimental one-way-channel contract](https://github.com/stellar-experimental/one-way-channel/tree/main/contracts/channel)
- [Official Stellar Skill — RPC, events and transaction querying](https://github.com/stellar/stellar-dev-skill/tree/main/skills/data)
- [Official Stellar MPP channel examples](https://github.com/stellar/stellar-mpp-sdk/tree/main/examples)

**Stop rule:** Verify, do not authorize or settle. Do not treat local flags, SDK callbacks or a transaction hash as proof without independent checks. Preserve the deliberate P0 focus: simulated signed consumption → native authorized channel commitment → separate evidence acknowledgement → real Testnet close → independent verification.
