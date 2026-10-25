# HackMeridian — UsagePay Pitch and Demo Sheet

**Audience:** judges (async review of the demo video, pitch deck and repository) and the finalist live pitch · **Length target:** about 3 minutes · **Technical authority:** [01.1 §§8–11](../01.1-usagepay-technical-architecture-and-roadmap.md)

**Links:** [live demo](https://usagepay.vercel.app) · [pitch deck](https://docs.google.com/presentation/d/157kTzIG6SZ9LdqSRKgJaeVdF4ENpdYWz/edit?slide=id.p1#slide=id.p1) · [demo video channel](https://www.youtube.com/channel/UCVkziV3cu8SnGI5tDzu37oQ) · [repository](https://github.com/skopolabs/usagepay)

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

Each beat follows one section of the [live demo](https://usagepay.vercel.app); the presenter keys `→` / `←` move between them.

1. **15s — Category and gap** (Overview, 1 · The gap): the meter, the payer and the ledger each keep their own record; nobody can prove which payment matched which measurement.
2. **20s — Why MPP alone is not enough** (1 · The gap): MPP proves how much was authorized and that it settled, not *for what*. UsagePay adds the link on top of MPP, without a new contract.
3. **25s — Meter** (3 · Usage): simulated OCPP-shaped readings, visibly labelled simulated, each signed; the tariff replays to the base unit.
4. **30s — Approval and vouchers** (4 · Vouchers): the fleet approves three increments within its budget; each voucher comes with a payer-signed receipt bound to its evidence; E0 is sealed before settlement.
5. **25s — One payment on Stellar** (5 · Payment): one real Testnet close settles the three vouchers; open the transaction on stellar.expert.
6. **30s — Independent auditor** (6 · Auditor): V01–V08 PASS with no keys; separate PASS / FAIL / NOT_AVAILABLE statuses; no claim of on-chain meter enforcement.
7. **20s — What if** (7 · What if): a tampered reading and an over-budget payment are refused before anyone pays.
8. **15s — Continuation:** open-source evidence core and separately validated managed channel operations; a second meter adapter is on the roadmap; privacy and finance are later, independent hypotheses.

**Truth labels to keep visible:** Testnet only, experimental unaudited one-way-channel; one adapter today (energy in Wh); synthetic meter and key, not legal certification; no confidential settlement; the channel watcher is an SDK primitive; no validated B2B buyer.

**For engineers:** read [01.1](../01.1-usagepay-technical-architecture-and-roadmap.md). **For product/commercial questions:** consult [01.2](usagepay/01.2-usagepay-product-foundation.md) and [01.4](usagepay/01.4-usagepay-economics.md). This pitch sheet never overrides their scope or guarantees.
