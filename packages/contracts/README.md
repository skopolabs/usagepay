# @usagepay/contracts — frozen SPEC 00 v1 contracts

Single source of runtime schemas (zod) and inferred TypeScript types for every cross-module record, plus the
canonical byte rules. Modules import from here; they never copy or redefine these shapes. Changes require
coordinator approval, regenerated fixtures (`pnpm fixtures:generate`) and passing consumer contract tests.

| Concern | Rule |
|---|---|
| Canonicalization | RFC 8785 JCS (`canonicalize`). Only null, booleans, well-formed strings, safe integers, arrays and plain objects; anything else throws `CanonicalizationError`. |
| Digests | Lowercase hex `SHA-256(JCS(value))` (`jcsDigest`). Source payloads hash the original decoded bytes (`computeRawPayloadDigest`). |
| Tariff | `versionDigest` = digest of the snapshot without `versionDigest` (`computeTariffVersionDigest`). |
| Reading / evidence | `readingDigest` = digest of the whole `MeterReading`; `evidenceDigest` = digest of exactly `{readingDigest, tariffVersionDigest, cumulativeWh, cumulativeChargeBaseUnits, deltaChargeBaseUnits, sessionId, readingId}`. |
| Native commitment | `commitmentDigest` = digest of `{signedMessageB64, signatureB64}`; `signedMessageB64` must hold the real bytes the pinned SDK signs (captured in G1+). |
| Payer ack | Signs `UTF8("usagepay.payer-evidence-ack.v1\n") ‖ UTF8(JCS(ack without signatureB64))` (`payerAckSigningMessage`), Ed25519 strict RFC 8032. |
| Ack nonce | Lowercase hex of 16..64 bytes produced by `generateAckNonce()` (CSPRNG); unique per `(channelId, sessionId)`. Fixture nonces are deterministic and test-only. |
| E0 | `E0Digest` = digest of E0; E0 never contains a settlement transaction hash. |
| Amounts | `DecimalString` only (no float, sign, exponent or leading zero; ≤ i128 max); arithmetic in `bigint` (`cumulativeChargeBaseUnits`). |
| Identifiers | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` for session, reading, machine, tariff and key IDs. |
| Times | One spelling: `YYYY-MM-DDTHH:mm:ss.sssZ`; intervals are half-open `[start, end)`. |
| Network | `stellar:testnet` only. Channel and asset are `C...` contract IDs; commitment/payer keys are `G...` accounts. |

**Schema vs. module responsibility.** (approved by the coordinator for v1) Schemas reject malformed shapes and intra-record contradictions
(integer formats, network, L2 without signature, invalid intervals, hex/base64, repeated reading IDs or ack
nonces in E0, reordered sequences, settled amount on a non-`SUCCESS` E1). Cross-record *binding* checks
(recomputing digests, amount/channel/session equality, signature validity, budget, chain state) belong to the
owning module or the independent verifier so they report precise reason codes.

`SimMeterPayloadSchema` (`usagepay.sim-meter-payload.v1`, SPEC 01 §3.2) lives here because both the metering
adapter and the verifier must parse the same signed bytes without importing each other.

## Authorization-critical conditions

`AUTHORIZATION_CRITICAL_CONDITIONS` (AC01–AC17) is the frozen list of semantic conditions the **payer must
evaluate before signing** (the native commitment, then the evidence ack) and the **independent verifier must
re-evaluate** from E0/E1 with its own pinned trust inputs. Schemas never stand in for these checks.
`@usagepay/fixtures` exports `buildAuthorizationConformanceCases()`: one or more schema-valid violating cases per
condition plus positive controls. SPEC 02 and SPEC 03 tests must reject every case and accept every control.
Known gap: AC13 (budget cap) needs the fleet cap as a pinned verifier trust input, to be added in G2.
