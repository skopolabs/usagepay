# SPEC 01 — Metering & Evidence

**Status:** Ready for Claude implementation after SPEC 00 contract freeze  
**HackMeridian:** 2026-10-25  
**Product authority:** UsagePay `01.1` v1.1.1  
**Implementation authority:** `specs/00-shared-contracts-and-engineering-rules.md`

**Mission:** Produce verifiable, correctly priced consumption records from one **simulated EV charger**. Supply SPEC 02 with trusted-by-policy *metering inputs*, not a claim that physical delivery is proven. Implement only `packages/metering/**` and its test/fixture additions.

## 1. Scope and ownership

| P0 — build | P1 — only after the full P0 demo | Explicitly out |
|---|---|---|
| OCPP 2.x-**shaped** Started / Updated / Ended simulator; signed, raw source-byte capture; pinned meter key; deterministic normalization; tariff snapshot and cumulative calculation; clear refusal codes; tests | End-only signed/provisional interval handling; a genuinely different meter adapter | Real OCPP WebSocket/CSMS conformance, certified OCMF parser, hardware, device attestation network, charge-station control, wallets, MPP, payer signatures, E0/E1 assembly |

**Upstream boundaries:**
- **Input:** simulator event, session/tariff configuration, test-only trusted meter public-key registry.
- **Output:** validated `MeterReading` + `MeasurementCharge` from SPEC 00, or a typed refusal. Optionally report `SESSION_STARTED` / `SESSION_ENDED` without emitting a charge.
- **Consumer:** SPEC 02 performs payer-side budget validation, signs real MPP commitments and evidence acknowledgements. This module **cannot approve a payment**.
- **Verifier:** SPEC 03 replays source signature and tariff calculations using the original records, never this module's `verified` flags.

Do not change SPEC 00 schemas, `packages/contracts/**`, native MPP SDK or other modules without coordinator approval. All generated output must validate using the shared runtime schemas.

## 2. Simple and detailed data flow

```text
Simulated charger
  └─ Started / Updated / Ended OCPP-shaped event
      └─ original signed meter payload bytes + Ed25519 signature
          └─ adapter: decode → pinned key verify → cross-check fields
              └─ validated MeterReading (exact rawPayloadB64 retained)
                  └─ pinned TariffSnapshot + bigint cumulative pricing
                      └─ MeasurementCharge + evidenceDigest
                          └─ SPEC 02 (authorization and payment)
```

```mermaid
sequenceDiagram
    participant Meter as Simulated meter (test key)
    participant Adapter as OCPP-shaped adapter
    participant Core as Metering & tariff core
    participant Next as SPEC 02 payer boundary
    Meter->>Adapter: Started(session ID)
    Adapter-->>Core: SESSION_STARTED (no charge)
    loop each interval (3 in happy-path fixture)
        Meter->>Adapter: Updated/Ended + exact source bytes + signature
        Adapter->>Core: Verify source bytes and normalize counters
        alt signature, identity or continuity invalid
            Core-->>Next: REJECTED(reason); no charge
        else accepted
            Core->>Core: Integer tariff calculation + evidence digest
            Core-->>Next: MeterReading + MeasurementCharge
        end
    end
```

### Why the two source representations exist

The **OCPP-shaped transport event** tells the adapter when a session starts/updates/ends. The **separately signed meter payload** attests to the numbers and identity data *inside the source bytes*. The normalized `MeterReading` must be checked against those bytes, or a payee could substitute a different `deltaWh` while retaining a valid signature over unrelated data.

For P0, this is a purpose-built **simulator profile**, not a claim that a real OCMF-certified charger emits the exact fields below. OCPP supports transport of signed meter values, but intermediate signatures depend on equipment/configuration. See the [OCA signed meter values guidance](https://openchargealliance.org/wp-content/uploads/2025/05/signed_meter_values-v10-1.pdf), sections 2 and 4.

## 3. Simulator and normalization contract

### 3.1 Minimal OCPP-shaped transport (internal fixture only)

```json
{
  "eventType": "Updated",
  "timestamp": "2026-10-25T09:01:00.000Z",
  "transactionInfo": { "transactionId": "ev-session-001" },
  "meterValue": [{ "timestamp": "2026-10-25T09:01:00.000Z", "sampledValue": [{ "measurand": "Energy.Active.Import.Register", "unitOfMeasure": { "unit": "Wh" }, "value": 10250 }] }],
  "usagepaySimulator": {
    "readingId": "r-001",
    "rawPayloadB64": "<generated-base64>",
    "signatureB64": "<generated-ed25519-signature>",
    "signerKeyId": "test-meter-01"
  }
}
```

`usagepaySimulator` is **not an OCPP standard field**. Do not label these fixtures OCPP-compliant or produce invented OCMF records. For P0, feed these objects directly to the adapter; WebSockets and actual CSMS integration are out of scope. `Started` initializes the session and baseline; `Updated` and `Ended` carry charging intervals; `Ended` terminates further acceptance.

### 3.2 Exactly what the simulated meter signs

The simulator signs the **original UTF-8 bytes** of JCS-serialized payload below with a **meter-only Ed25519 test key**. Store those exact bytes in `MeterReading.rawPayloadB64`. Verify with a separately pinned public key addressed by `signerKeyId`.

```json
{
  "schema": "usagepay.sim-meter-payload.v1",
  "domain": "ev.ocpp2x",
  "sessionId": "ev-session-001",
  "machineId": "sim-charger-01",
  "readingId": "r-001",
  "observedAt": "2026-10-25T09:01:00.000Z",
  "intervalStart": "2026-10-25T09:00:00.000Z",
  "intervalEnd": "2026-10-25T09:01:00.000Z",
  "meterStartWh": "10000",
  "meterEndWh": "10250",
  "unit": "Wh"
}
```

The source payload is **synthetic, OCMF-inspired meter evidence**, not a certified OCMF wire format. It signs absolute beginning/end register values; the adapter **derives** `deltaWh = BigInt(meterEndWh) - BigInt(meterStartWh)` rather than accepting an operator-provided chargeable delta.

**Mandatory consistency checks:**
1. Decode base64 strictly; verify Ed25519 over the exact original decoded bytes **before trusting parsed fields**. The key must be in the fixture's explicit trusted-key registry; do not trust a public key supplied only by the event itself.
2. Parse the decoded data with a strict runtime schema; require its canonical encoding to match the original bytes for this simulator profile. Any change to the payload bytes after signing must fail cryptographic verification.
3. Compare signed `sessionId`, `readingId`, `observedAt`, `machineId` (from known simulator configuration), and ending Wh counter with the transport envelope. Reject discrepancies; unsigned envelope data cannot override signed fields.
4. Require `meterEndWh > meterStartWh` for a chargeable interval; reject invalid, negative, non-integer or decreasing counters. Starting counter of the next accepted interval must equal the prior accepted ending counter for this one-session simulator profile.
5. Intervals must be strictly increasing, adjacent and non-overlapping; use UTC ISO8601 and `[intervalStart, intervalEnd)`; reject `observedAt` outside the supported session timeline or an `Updated` event after `Ended`.
6. Deduplicate by `(domain, sessionId, readingId)` **before** adding usage; repeat delivery must never emit a second accepted increment.
7. A simulator signature can support `assurance: 'L2'`, **only in the sense of a verified signature against the pinned simulated key**; always set `certification: 'simulated'`. The last interval is `coverage: 'terminal_signed'`; earlier signed intervals use `coverage: 'intermediate_signed'`. Neither means legal calibration.

On success emit **exact** SPEC 00 `MeterReading` fields, including original `rawPayloadB64`, original signature, key ID, `deltaWh` as decimal string, domain `ev.ocpp2x`, and accurate coverage/assurance metadata. Never persist a Boolean `verified` in place of source bytes and signature.

## 4. Versioned tariff and charge calculation

- The session pins one `TariffSnapshot` before the first charge. A tariff change mid-session is **rejected for P0**; tariff changes and reconciliations are a roadmap item.
- Validate tariff asset, currency, integer price, positive decimal scale, effective time and `versionDigest` using SPEC 00. The simulator must not invent an asset address; consume the Testnet SAC fixed by the integration coordinator.
- Use `bigint` only. No floating-point monetary calculations. For the demonstration tariff **0.40 USDC/kWh** and verified 7-decimal scale, `pricePerKwhBaseUnits = '4000000'`.
- For each accepted interval:

```text
cumulativeWh              = priorCumulativeWh + deltaWh
cumulativeChargeBaseUnits = floor(cumulativeWh * pricePerKwhBaseUnits / 1000)
deltaChargeBaseUnits      = cumulativeChargeBaseUnits - priorCumulativeChargeBaseUnits
```

- Reject negative deltas, stale order and a zero-value replay. Positive usage priced to zero because of rounding must be reported as an explicit unsupported P0 micro-interval rather than silently treated as a paid increment. Never round individual interval amounts and then sum: **round the cumulative amount once**.
- `versionDigest = SHA256(JCS(tariff without versionDigest))` and `readingDigest = SHA256(JCS(validated MeterReading))`, hex lowercase without `0x`.
- Compute `MeasurementCharge.evidenceDigest` as `SHA256(JCS({readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits, deltaChargeBaseUnits, sessionId, readingId}))`, using precisely this key set (SPEC 00 §5). Do not include `evidenceDigest` in its own preimage.
- The accepted per-session projection stores seen IDs, previous counter, previous interval end, cumulative Wh, cumulative amount, pinned tariff and finality state. It is **local single-process state**; no managed database or concurrency framework for P0.

### Expected happy-path values

| Event | Signed register interval | `deltaWh` | Cumulative Wh | Cumulative USDC base units |
|---|---|---:|---:|---:|
| Started | initial 10000 Wh | — | 0 | 0 |
| Updated `r-001` | 10000 → 10250 Wh | 250 | 250 | 1,000,000 |
| Updated `r-002` | 10250 → 10500 Wh | 250 | 500 | 2,000,000 |
| Ended `r-003` | 10500 → 10750 Wh | 250 | 750 | 3,000,000 |

These are deterministic **test fixtures**, not real-world energy readings or on-chain proof. Each accepted charge is handed to SPEC 02 for independent fleet policy checks and the native channel commitment. This module never signs the payer acknowledgement.

## 5. Implementation interface (owned by this module)

Use SPEC 00's exported runtime-validated `MeterReading`, `TariffSnapshot`, and `MeasurementCharge`; do not copy their schemas locally. The exact TS filenames are an implementation choice, but this behavioral boundary is fixed:

```ts
export type MeteringOutcome =
  | { kind: 'SESSION_STARTED'; sessionId: string }
  | { kind: 'ACCEPTED'; reading: MeterReading; charge: MeasurementCharge }
  | { kind: 'SESSION_ENDED'; sessionId: string } // no increment, if final reading already accepted
  | { kind: 'REJECTED'; reasonCode: MeteringRefusalCode; details: string };

export interface MeteringPort {
  apply(event: SimulatedOcppEvent): Promise<MeteringOutcome>;
}
```

`SimulatedOcppEvent` and `MeteringRefusalCode` are local implementation types. The `Ended` event **may** emit an `ACCEPTED` final charge; in that case it must also mark the session ended internally and refuse subsequent meter events. Use `SESSION_ENDED` only when no charge is emitted. Do not create a duplicate final charge to signal completion.

**Refusal codes:** `INVALID_SOURCE_BYTES`, `UNKNOWN_METER_KEY`, `INVALID_METER_SIGNATURE`, `SIGNED_PAYLOAD_MISMATCH`, `INVALID_INTERVAL`, `NON_MONOTONIC_COUNTER`, `COUNTER_GAP`, `DUPLICATE_READING`, `OUT_OF_ORDER`, `SESSION_CLOSED`, `TARIFF_NOT_ACTIVE`, `TARIFF_CHANGED`, `ZERO_VALUE_INCREMENT`, `UNSUPPORTED_EVENT`.

Rejected events must not mutate accepted usage, charge totals, last accepted counter or finalized status. A rejected event cannot cause a new payment to be signed downstream. Return errors in a stable `{kind:'REJECTED', reasonCode, details}` shape; log sanitized IDs, not private keys.

## 6. Testing pyramid — data-flow evidence, not coverage theater

```text
       Demo smoke: visibly signed reading and one rejected tampered reading
      Integration: SPEC 01 output validates against SPEC 00; SPEC 02 consumes it
     Unit tests: source-byte signatures, identity, counter continuity, JCS, bigint
```

| Level | Required test | Input → expected result |
|---|---|---|
| Unit `S1-A` | Three valid signed intervals | Started + 250/250/250 Wh → three accepted charges; exact cumulative units `1000000`, `2000000`, `3000000` |
| Unit `F1-A` **P0** | Tampered bytes | Change one source byte after signing → `INVALID_METER_SIGNATURE`, no accepted charge |
| Unit `F1-B` **P0** | Invalid key | Valid signature from untrusted key → `UNKNOWN_METER_KEY` or `INVALID_METER_SIGNATURE` |
| Unit `F3-A` | Duplicate/replay | Re-submit `r-002` → `DUPLICATE_READING`, cumulative unchanged |
| Unit `F3-B` | Signed-vs-envelope mismatch | Keep valid signed bytes but alter transport reported meter total/session → `SIGNED_PAYLOAD_MISMATCH` |
| Unit `F3-C` | Counter / interval discontinuity | Start next interval from 10400 instead of 10250 → `COUNTER_GAP`; overlapping times → `INVALID_INTERVAL` |
| Unit `F3-D` | Tariff / integer handling | Non-integer Wh, changed tariff version or expired tariff → stable refusal; no float/rounded drift |
| Contract | Type compatibility | Every accepted output parses as SPEC 00 runtime schemas; recomputed digest matches exact fixture vector |
| Integration (SPEC 04) | Downstream refusal remains safe | Tampered reading → no SPEC 02 payer approval, no new MPP commitment; valid reading → approved flow |
| Testnet E2E (SPEC 04) | Full happy path | Real Stellar payment is tested by SPEC 02/04, **not claimed as a metering unit test** |

**Test output convention:** include scenario ID, fixture ID, accepted/rejected status, reason code, `deltaWh`, cumulative Wh and cumulative charge (no secrets). Prefer parameterized pure tests and fixed deterministic test-only keys. Execute module tests offline; avoid Testnet/network calls in this package.

## 7. Work order for Claude (no extra infrastructure)

1. Read SPEC 00 and the current canonical types. If the schemas are not available, stop at the contract dependency; **do not introduce competing types**.
2. Implement deterministic simulator fixtures and a **separate, pinned, test-only** Ed25519 meter keypair generator/loader. Signing happens only inside the simulator; the verification path holds public keys only.
3. Implement exact source-byte verification, strict parsing and normalization; test `F1` before any financial calculation.
4. Implement pinned tariff computation and idempotent per-session projection; test `S1` and `F3`.
5. Validate `MeterReading` and `MeasurementCharge` against SPEC 00 schemas; emit an accepted or rejected typed result, never a fabricated approval.
6. Run the module tests and typecheck. Supply the integrator with documented fixture entrypoints and reproducible sample output.

**Done only when:** all P0 module tests pass; 3 signed intervals generate precisely the expected integer amounts and digests; signature tampering and unknown keys refuse with no mutation; duplicates cannot double-charge; normalized values reproduce from **signed source bytes**; outputs validate against SPEC 00; no payer signing, SDK MPP or network dependency leaked into this package.

## 8. References

- **Normative internal:** `specs/00-shared-contracts-and-engineering-rules.md`; UsagePay `01.1` v1.1.1, §§5–9.
- **Protocol context (not compliance claim):** [Open Charge Alliance — Signed Meter Values in OCPP, v1.0](https://openchargealliance.org/wp-content/uploads/2025/05/signed_meter_values-v10-1.pdf), especially §§2 and 4.
- **Later real-format integration only:** [SAFE-eV OCMF specification](https://github.com/SAFE-eV/OCMF-Open-Charge-Metering-Format/blob/master/OCMF-en.md).
- **Next consumer:** SPEC 02 — Payer & Stellar Settlement (not yet authored).

**Stop rule:** Do not implement real OCPP networking, legally certified OCMF, a second meter domain or financial settlement inside SPEC 01. Deliver the signed-data boundary correctly first.
