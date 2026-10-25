# 03 — Integrated Architecture: UsagePay, FlowCredit and VeilPay

**Document version:** 1.1.0 · **Strategy reviewed:** 2026-10-25 · **HackMeridian begins:** Sunday, 2026-10-25 · **Status:** Independent future coexistence vision, NOT a hackathon scope or shared release promise · **Authority:** 03 only for inter-service contracts; each product owns its roadmap

## 1. A more precise common thesis

**Proof of use → proof of settlement → evidence of revenue → selective proof without disclosure.** This is a **potential composition**, not a guarantee that all steps are automatically cryptographically atomic, legally binding, or financeable.

Three independent hypotheses:

1. **UsagePay — Evidence infrastructure:** connect externally metered consumption, provenance, tariff and authorized MPP commitments to settlement records. Current hackathon candidate. Testnet only for experimental one-way-channel.
2. **VeilPay — Confidential payments / disclosure:** investigate what counterparties and values must remain confidential in B2B contexts. Not part of the current channel MVP; privacy primitives and composition have separate maturity gates.
3. **FlowCredit — Underwriting evidence:** transform genuine receipts into a candidate data source for existing financing/risk institutions. No lending contract in the hackathon.

Each must create value alone. Shared branding is not evidence of interoperability or a market.

## 2. Boundary conditions

- Domain standards own device/session identity, calibrated metering and physical control; UsagePay verifies what it can and labels the remainder.
- Stellar MPP owns payment challenges, channel commitments, signature validation and chain settlement; UsagePay does not claim to invent them.
- The **payer** owns its spending authority. A payee cannot use a metering feed to authorize debits from a payer's signing key.
- VeilPay confidentiality may conceal amounts but not physical truth or legal/commercial exposure; standard public channels leak metadata.
- FlowCredit is the only module that can produce `qualified_amount`, under an explicit separate risk policy. Settlement does not imply borrower creditworthiness.

## 3. Optional event contracts

```text
MeterEvidence {
  evidence_id, domain, domain_session_id, machine_ref, interval,
  quantity, unit, raw_payload_digest, meter_signature,
  meter_key_reference, provenance_level, certification_status,
  verification_result
}
TariffAssessment {
  evidence_id, tariff_version_digest, applied_rate,
  rounding_rule, computed_increment, payer_policy_decision
}
PaymentEvidence {
  channel_id, network, asset, payer_authority_ref,
  challenge_ref?, cumulative_amount, commitment_signature,
  commitment_digest, allocation_refs[]
}
SettlementEvidence {
  channel_id, pre_settlement_digest, settlement_tx_hash,
  chain_finality_status, settled_amount, verified_at
}
MachineRevenueEvent {
  settlement_ref, service_ref, observed_amount, settled_amount,
  evidence_quality, customer_ref, dispute_status
}
QualifiedRevenueAssessment {
  revenue_event_ref, qualified_amount, risk_policy_version,
  counterparty_checks, reviewer_ref, reasons[]
}
```

`challenge_ref` is conditional on actual MPP SDK flow; do not assume it is an on-chain data field. `payer_authority_ref` is metadata/authorization policy, not the private key. PII and private device data are excluded from public hashes unless linkage/privacy impact is reviewed.

## 4. Composition graph and privacy boundary

```text
 OCPP / signed meters / other domain systems
                     |
               UsagePay adapters
                     |
     provenance + tariff + payer policy
                     |
      payer-signed cumulative MPP amounts
                     |
   Stellar experimental channel + settlement
                     |
         off-chain E0/E1 verification
                    / \
         optional /   \ optional
    VeilPay privacy     FlowCredit risk evidence
    & disclosure         to existing capital
```

**No claim of atomic binding:** the current one-way-channel contract can settle an authorized cumulative amount independently of a physical reading. Application-level evidence checks and chained hashes do not alter its enforcement rules. `E0` is a stable pre-settlement digest; `E1` appends settlement references after finality. Anchoring E0 and E1 requires a separate transaction or a supported mechanism and a feasibility test, without circular references.

### Integration boundaries — implementation-grade conceptual architecture

```text
                    [External machines, meters, digital services]
                                    |
                        [DOMAIN EVIDENCE SOURCES]
                           signatures / identity
                                    |
                        [UsagePay Evidence Core]  <--- OPTIONAL SOURCE
                      MeterEvidence + TariffAssessment
                                    |
                  [Fleet payer approval] + [MPP settlement]
                                    |
                  PaymentEvidence + SettlementEvidence
                                    |
               +--------------------+--------------------+
               |                                         |
               v                                         v
        [FlowCredit adapter]                       [VeilPay adapter]
         ^                 ^                       ^              ^
         |                 |                       |              |
   UsagePay evidence  External rails          UsagePay data   Other clients
       identity / receivables                     access / disclosure
       anti-wash / risk rules                     encryption / proofs
               |                                         |
   QualifiedRevenueAssessment                 Authorized audit view
               |                                         |
               v                                         v
      [External capital partner]                 [Approved recipients]
        compliance, lending                  privacy is NOT assumed atomic

 No shared private keys, mandatory central database, or cross-product
 signing/custody authority. Each boundary has an explicit contract.
```

The independent arrows are intentional: FlowCredit may accept revenue records from non-UsagePay platforms, and VeilPay may serve unrelated institutional or agent payments. Neither is an obligatory plugin in UsagePay's execution path.

**Example 1 — no integration required:** an operator uses UsagePay to verify a measured EV session and reconcile a Testnet payment; neither credit nor private tokens are involved.

**Example 2 — optional future finance:** an independent financier reads a consented UsagePay `SettlementEvidence`, correlates it with customer identity and contractual receivable, and issues a separate `QualifiedRevenueAssessment`. It may reject or discount the revenue despite valid MPP settlement.

**Example 3 — optional future disclosure:** a B2B party releases a selective financial report to an auditor using VeilPay without disclosing raw metering records publicly. This **does not** prove that a private transfer can atomically settle an MPP one-way-channel.

## 5. What the hackathon proves

One real Stellar testnet channel and one externally metered simulated domain, with documented evidence verification, policy refusal and settlement. Second **different** meter adapter only after main path. The demo must not claim production metrology, mainnet safety, confidential settlement, lending, hardware certification or broad interoperability.

**Positioning:** narrow, evidence-grade settlement bridge; do not pitch three simultaneous products. Future direction gets one short sentence, and judges receive candid boundaries.

## 6. Future coexistence roadmap — integration milestones ONLY

**Each product retains its own roadmap:** UsagePay milestones and Track A/B separation are authoritative in [01.1 §10](01-usagepay/01.1-usagepay-technical-architecture-and-roadmap.md); FlowCredit stages are in [02 §7](02-flowcredit.md); VeilPay stages are in [04 §6](04-veilpay.md). No duplicate per-product timeline is maintained here.

**Integration sequence, only if independent products demonstrate value:**

1. **Evidence export contract:** agree on stable, versioned, minimal `MeterEvidence`, `PaymentEvidence` and `SettlementEvidence` with explicit provenance and signed payload digests. UsagePay may be one producer, not the required producer.
2. **Risk consumer contract:** FlowCredit ingests records from UsagePay _and at least one external source_; identity/receivables review produces `QualifiedRevenueAssessment` in a separate trust domain.
3. **Disclosure contract:** VeilPay designs what a recipient, financier or auditor may learn; field-level authorized disclosure must not be confused with confidential settlement on-chain.
4. **Independent composition feasibility:** evaluate privacy wrappers and channel settlement atomically only if the audited primitives permit it. Until tested, settle and privacy remain separate capabilities.
5. **Optional platform operations:** if two or three services each find demand, combine shared onboarding/observability deliberately while retaining independent storage, liability, compliance and failure boundaries.

**Strategic constraint:** Product A (_Evidence Infrastructure_) and Product B (_Managed Settlement Operations_) belong to UsagePay but are **two distinct commercial hypotheses**, not a single SaaS validation event. Product A may thrive as OSS; B needs demonstrated channel adoption, uptime/incident risk and customer willingness to pay. See 01.1 for the **only** UsagePay operational roadmap.

## 7. Outcome taxonomy and investment discipline

- **A** — direct domain-to-MPP integration is sufficient: reference sample or stop standalone project.
- **B** — reusable evidence interface/tooling makes a public good: grants or maintainer sponsorship may be rational, without SaaS assumptions.
- **C** — managed infrastructure has real buyers and operations pain: pilot, pricing and SLA experiment. Keep privacy and operator financial constraints visible.

No grant, hackathon placement, GitHub stars, simulator demo or competitor funding substitutes for a buyer interview or settled production volume.

## 8. Known mismatches that must remain explicit

- Non-EV domain signatures might authenticate transport rather than certified metrology.
- Public channel balances and counterparties still leak B2B patterns: off-chain evidence does **not** hide on-chain amounts.
- Confidential Tokens may protect amounts but not addresses, and seamless confidential-channel composition is not established by public prototypes.
- Repayment contracts cannot force merchants to route all **future** revenue to a fixed channel/recipient.
- FlowCredit cannot mark `qualified_amount` equal to receipts automatically.
- The original AI API second adapter was crowded prior art; a distinct metering domain is a stronger falsification test. A generic simulated meter demonstrates only adapter reuse.

## 9. Primary evidence and further analysis

- OCA signed readings: https://openchargealliance.org/wp-content/uploads/2025/05/signed_meter_values-v10-1.pdf
- Stellar MPP SDK: https://github.com/stellar/stellar-mpp-sdk
- Stellar privacy design (Aug 2026 snapshot): https://developers.stellar.org/meetings/2026/08/06
- OCPI current tags/readme: https://github.com/ocpi/ocpi/releases
