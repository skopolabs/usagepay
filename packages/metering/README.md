# @usagepay/metering (SPEC 01)

Turns signed simulated meter readings into SPEC 00 `MeterReading` and `MeasurementCharge` records, with the price
taken from a pinned tariff. The data is simulated and OCPP-shaped. It is not certified metering, and this module
can never approve a payment.

## Entrypoints

- **`createSimulatedCharger({sessionId, machineId, startedAt, meterStartWh, signer})`**
  - Emits OCPP-shaped `Started` / `Updated` / `Ended` events.
  - It is the only component that signs: it signs the exact JCS bytes of the SPEC 01 §3.2 payload.
- **`createRandomMeterSigner(keyId)`**
  - Creates a disposable meter key for a demo run.
  - Put its `publicKey` in the verifier's pinned registry.
  - For offline tests, use `TEST_ONLY_METER_KEY` from `@usagepay/fixtures`.
- **`createMeteringSession({machineId, expectedAssetSac, trustedMeterKeys, currentTariff})`**
  - Returns a `MeteringPort`. `apply(event)` returns `SESSION_STARTED`, `ACCEPTED {reading, charge}`, `SESSION_ENDED` or `REJECTED {reasonCode, details}`.
  - It holds public keys only.
  - It pins the tariff at `Started`.

## Guarantees (tested in `test/metering.test.ts`)

- **Signature first.** The signature is verified over the original source bytes before any parsed field is trusted. Only then are the bytes parsed, and they must already be the canonical JCS encoding.
- **Signed data wins.** The unsigned envelope cannot override signed data:
  - `transactionId`, `readingId` and the timestamps must match the signed payload;
  - the transport register value must match the signed `meterEndWh`;
  - the `machineId` must match the configured simulator.
- **Derived delta.** `deltaWh` is computed from the signed absolute counters. Intervals are half-open, adjacent and strictly increasing.
- **Integer pricing.** Prices use `bigint` with `floor` applied once to the cumulative amount. A positive amount of usage that prices to 0 is refused with `ZERO_VALUE_INCREMENT`.
- **No mutation on refusal.** A rejected event never changes the accepted projection.
- **Identical to the golden vectors.** Accepted output is byte-identical to the frozen golden vectors in `fixtures/v1/vectors.json`.

| Scenario | Result |
|---|---|
| S1-A | 250/250/250 Wh → 1000000 / 2000000 / 3000000 base units |
| F1-A | Source byte changed → `INVALID_METER_SIGNATURE` |
| F1-B | Untrusted key → `INVALID_METER_SIGNATURE` or `UNKNOWN_METER_KEY` |
| F3-A | Replayed reading → `DUPLICATE_READING` |
| F3-B | Envelope disagrees with signed data → `SIGNED_PAYLOAD_MISMATCH` |
| F3-C | Counter gap → `COUNTER_GAP`; overlapping times → `INVALID_INTERVAL` |
| F3-D | Problem with Wh values or the tariff → `UNSUPPORTED_EVENT`, `INVALID_SOURCE_BYTES`, `TARIFF_CHANGED`, `TARIFF_NOT_ACTIVE` or `ZERO_VALUE_INCREMENT` |

The state is one in-process session projection. It is not durable storage.
