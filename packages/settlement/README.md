# @usagepay/settlement (SPEC 02)

Payer and Stellar settlement. It turns an accepted SPEC 01 charge into a fleet-approved, genuinely SDK-signed MPP
channel commitment and binds that commitment to the evidence with a payer evidence ack. It then settles the highest
accepted commitment on Stellar Testnet and records E1 from observed chain results.

## Entry points

| Export | Role | Holds |
|---|---|---|
| `createPayer` | `PayerAuthorizationPort`, fleet side | commitment secret (signs inside the SDK and signs acks) |
| `createPayee` | CPO side: MPP challenge, ack preflight, SDK verification | public commitment key only |
| `createChannelSettlement` | `ChannelSettlementPort`, recipient side | nothing; uses a `ChainGateway` |
| `createStellarChainGateway` | the only Stellar boundary of settlement: SDK `close()`, `getTransaction`, `withdrawn()` | recipient secret (envelope signer) |
| `evaluateCandidate`, `checkNativeCommitment`, `checkPayerAck`, `checkChannelFacts` | pure checks for AC01–AC17 plus deposit, recipient and token | nothing |
| `createIncrementLedger`, `createStateMachine` | accepted-increment log, immutable E0, SPEC 02 §4 states | nothing |

## Guarantees

- **Pre-sign checks.** Every payer check runs before `createCredential`, because the SDK signs inside that call (G1 D5). These cover evidence, tariff, meter signature, charge replay, contiguity, budget, deposit, and the challenge's channel, network and amount. A refused increment makes no prepare_commitment call, no native signature and no ack.
- **Native capture.** The native signature is the SDK's own. The payer rebuilds the pinned XDR commitment bytes and verifies the signature under the pinned key before it signs the ack.
- **Ack preflight.** The payee checks the native commitment and the ack (AC14–AC17) before the unchanged credential reaches SDK verification. A refused request never reaches the SDK store.
- **AUTHORIZED.** This result requires both the ack gate and SDK acceptance.
- **PENDING.** An unknown outcome blocks further increments until `reconcile()` reads the payee receipt.
- **E0.** E0 is deep-frozen and refuses additions once finalized.
- **Close and E1.**
  - The close uses the standalone SDK `close()` with the highest accepted voucher (G1 D4).
  - E1 records the observed `txStatus` and the observed `withdrawn()` payout.
  - A close with an unknown outcome is `PENDING` and is re-read, never resubmitted.
  - Only `SUCCESS` reaches `SETTLED`.
- **Demo storage.** The ledger and SDK `Store.memory()` are single-process demo storage, not production durability.

Module-local `ChannelSettlementPort` reason codes beyond §4: `INVALID_E0` and `E0_NOT_LATEST_ACCEPTED`. The payer's `PENDING` reason is `PAYMENT_OUTCOME_UNKNOWN`. The payer also returns the catalogue's SPEC 01 codes for AC05, AC06 and AC10: `INVALID_METER_SIGNATURE`, `SIGNED_PAYLOAD_MISMATCH` and `DUPLICATE_READING`.

## Tests

`corepack pnpm vitest run --project settlement` runs offline. The integration tests use the **real** pinned `@stellar/mpp` client and server against a fake one-way-channel contract.

The fake is installed on `rpc.Server.prototype` in `test/fake-chain.ts`, the RPC boundary. A local HTTP RPC is not possible: the SDK constructs `rpc.Server` without `allowHttp`. The fake is OFFLINE evidence only.

| ID | Where | Outcome |
|---|---|---|
| S1-B | `policy.test.ts`, `payer-payee.test.ts` | SPEC 01 events → 1,000,000 / 2,000,000 / 3,000,000 accepted; native signature before ack; E0 frozen |
| F2-B | both | cap 2,500,000 → `BUDGET_EXCEEDED`, no simulation, signature or ack; highest stays 2,000,000 |
| F3-B | both | replayed r-002 → `DUPLICATE_READING`; reused nonce → `REPLAY_NONCE` (payer and payee) |
| F4-B | `payer-payee.test.ts` | 10 tampered acks and credentials → 409 before the SDK; store unchanged |
| F4-C | `payer-payee.test.ts` | unpinned channel, wrong network, wrong amount, wrong signer, SDK balance and recipient refusals |
| Failure propagation | `payer-payee.test.ts` | tampered reading or tariff → never signed; RPC down before signing; native bytes not capturable → `SDK_CAPTURE_UNAVAILABLE`; lost answer → `PENDING` until reconciled |
| AC01–AC17 | `policy.test.ts` | every frozen conformance case is refused with its catalogue code, and every control is accepted |
| Settlement | `settlement.test.ts` | SUCCESS, FAILED, NOT_FOUND, unknown outcome, RPC down → PENDING → re-read; the E0 binding |

The Testnet E2E is opt-in, sends transactions and needs a freshly deployed channel:

```sh
CHANNEL_ALIAS=upay-g2-channel scripts/testnet/deploy-channel.sh
corepack pnpm g2:settlement
```
