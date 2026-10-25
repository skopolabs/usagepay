# HackMeridian — UsagePay Pitch and Demo Sheet

**HackMeridian begins:** Sunday, 25 October 2026 · **Audience:** judges and demo presenter · **Length target:** approximately 2–3 minutes · **Technical authority:** [01.1 §§8–11](01-usagepay/01.1-usagepay-technical-architecture-and-roadmap.md)

## The problem, in one sentence

External meters can record what a machine consumed, and Stellar MPP can authorize/settle cumulative amounts, but the **independently checkable association between source evidence, payer approval and actual settlement** is an application integration problem.

## What the demo actually shows

```text
Simulated EV charging event -> check meter evidence -> replay tariff
          -> fleet approves exact cumulative amount -> MPP commitment
          -> real Stellar Testnet close -> verifier explains matches / gaps
```

**Opening line:** "UsagePay enables verifiable machine-to-machine payments for metered services on Stellar." Kicker: *Infrastructure for the machine economy.* Then: "We show it with EV charging because everyone understands a charger; the same flow fits any service a machine can measure." Messaging and guardrails: [01.2 §0.1](usagepay/01.2-usagepay-product-foundation.md#01-positioning-and-messaging-single-source-for-the-ui-readme-and-pitch).

**Pitch line:** "UsagePay links externally measured services to payer-approved Stellar channel commitments and replayable settlement evidence. It does not claim that the Stellar contract certifies a physical meter."

**Why not only MPP:** "MPP tells you how much was authorized and that it settled. It cannot tell you for what. UsagePay makes every payment carry its proof."

## Presentation beats

1. **20s — The gap:** metering, financial approval and settlement are different authoritative systems; today's protocol components are acknowledged.
2. **30s — Meter:** simulated OCPP/OCMF-shaped record, visibly labeled simulated, with signature and tariff replay.
3. **25s — Fleet policy:** show a valid approval and a tampered reading / spending cap refusal.
4. **40s — Real Stellar settlement:** show multiple increasing commitments and a genuine testnet transaction hash.
5. **35s — Verify:** separate PASS/FAIL/NOT AVAILABLE statuses; E0 before closing and E1 after; no claim of on-chain meter enforcement.
6. **Optional 20s — Only if functional:** independent second meter adapter **or** SDK-based watcher.
7. **15s — Continuation:** open-source evidence core and separately validated managed channel operations; privacy and finance are later independent hypotheses.

**Truth labels to keep visible:** Testnet-only experimental unaudited one-way-channel; synthetic meter and key, not legal certification; no confidential settlement; watcher is an SDK primitive; no validated B2B buyer. If the session channel demo fails, describe the Charge fallback as narrower and omit channel claims.

**For engineers:** read [01.1](01-usagepay/01.1-usagepay-technical-architecture-and-roadmap.md). **For product/commercial questions:** consult [01.2](01-usagepay/01.2-usagepay-product-foundation.md) and [01.4](01-usagepay/01.4-usagepay-economics.md). This pitch sheet never overrides their scope or guarantees.
