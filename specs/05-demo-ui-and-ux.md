# SPEC 05 — Demo UI & UX (judge-facing presentation layer)

**Status:** approved. Decisions D1–D10 were agreed with the team lead; the open questions were resolved as D11–D14 (§9). §10 specifies the implementation requirements beyond §3–§7.
**HackMeridian:** 2026-10-25.
**Product authority:** `01.1-usagepay-technical-architecture-and-roadmap.md` v1.1.1: P0 Must 4 "independent Verify page/CLI", and the truth labels of `docs/HACKATHON-PITCH-AND-DEMO.md`. The pitch itself may still change, and the UI does not depend on its exact script.
**Implementation authority:** SPEC 00 (shared types and rules) and SPEC 04 (scenarios, evidence classes, demo bundle, demo-day evidence procedure). This SPEC adds **only a presentation layer**: no protocol, payment, verification or schema behavior.
**Owner:** integration coordinator (`apps/web/**`, root UI scripts).

**Mission:** make the complete P0 flow understandable to a non-technical judge in about three minutes, and inspectable in depth by a technical judge, without any hardware. The flow runs from simulated charging and signed readings through fleet approval and off-chain vouchers to one real Stellar Testnet settlement and independent verification, with visible failure paths.

## 1. Decisions

| ID | Decision |
|---|---|
| **D1** | The UI is **required**, not optional. Since the demo has no hardware, it is UsagePay's main differentiator. |
| **D2** | **Backend first.** The UI is built only on SPEC 04 outputs that have already been validated (success path and failure paths). It holds no business logic: it never computes amounts, digests, signatures or verdicts itself, and only displays what the modules produced. |
| **D3** | **One data source.** The UI renders `upay.demo-bundle.v1`, written by `pnpm demo`. It uses the same plain-language strings as the terminal walkthrough (`apps/demo/src/narrative.ts`), so the terminal, the UI and the pitch say the same thing. |
| **D4** | **Show the whole flow:** <ul><li>the simulated charging and meter readings;</li><li>the fleet approvals with their off-chain vouchers and receipts;</li><li>the real Testnet payment and its transaction confirmation;</li><li>the independent verification;</li><li>every failure scenario (F1–F7).</li></ul> |
| **D5** | **On-chain versus off-chain is always visible.** Every step carries its layer: off-chain for signed messages between the parties, on-chain for reads from or writes to Stellar Testnet. |
| **D6** | **Readable blockchain CLI.** Every on-chain fact comes with three things: <ul><li>the `stellar` CLI command that reproduces it;</li><li>the output the demo observed;</li><li>a stellar.expert link.</li></ul> Each can be copied. A judge can check every claim outside our software. |
| **D7** | **Two audiences on one screen.** Plain language comes first. Technical detail (hashes, keys, base units, reason codes, raw events) is one click away and never shown instead of the explanation. |
| **D8** | **Honesty is part of the UX.** <ul><li>A captured run is always labelled `REPLAY` with its recording time.</li><li>Every scenario shows its evidence class (`REAL_TESTNET`, `SDK_INTEGRATION`, `OFFLINE_FIXTURE`).</li><li>`NOT_AVAILABLE` is never shown as success.</li><li>The limits section from the bundle is always reachable.</li><li>Nothing is fabricated or animated as "live" when it is not.</li><li>The UI is Testnet only.</li></ul> |
| **D9** | **Demo-day evidence.** All Testnet evidence shown to judges is regenerated during the hackathon (SPEC 04 §9.4). Earlier runs are rehearsals. |
| **D10** | **Same rigor as the backend.** Everything is TypeScript, pinned exact dependency versions and the committed lockfile. It carries tests, a reproducible build and English repository artifacts. No secret ever reaches the browser. |

## 2. Audience goals

| Audience | Must understand after the demo |
|---|---|
| Non-technical judge | <ol><li>A charger measured energy and signed it.</li><li>The fleet approved and paid step by step without touching the blockchain each time.</li><li>One real Stellar transaction settled the exact amount.</li><li>An independent auditor confirmed everything.</li><li>Tampering and over-budget charging were refused.</li></ol> |
| Technical judge | <ul><li>Which signatures exist and who signed what.</li><li>Why the MPP voucher alone does not bind meter data, and what the separate receipt adds.</li><li>Where E0 is sealed and where E1 is observed.</li><li>How V01–V08 are recomputed.</li><li>How to reproduce every on-chain fact with the Stellar CLI.</li></ul> |
| Presenter | A keyboard-driven sequence through the sections, configurable as the pitch evolves (§5) |

## 3. Information architecture

The UI is one page of story sections, plus a scenario explorer. The section order follows the flow of the product, not a fixed pitch script.

| # | Section | Content (all from the bundle) | Layer |
|---|---|---|---|
| 0 | **Header and status bar** | <ul><li>The positioning from 01.2 §0.1: the kicker *Infrastructure for the machine economy.*, the H1 *UsagePay enables verifiable machine-to-machine payments for metered services on Stellar.*, the promise line and a box labelling EV charging as the **demo use case** (§10.4).</li><li>`REPLAY of real Stellar Testnet run <id>, recorded <time>`.</li><li>`Verified live at <time>: PASS / NOT_AVAILABLE / FAIL`.</li><li>Testnet badge and links to the evidence files.</li></ul> | — |
| 1 | **The gap** | Three separate systems: meter, payer, ledger. Why nobody can prove which payment matched which measurement, and why Stellar MPP alone is not enough (§10.4) | — |
| 2 | **Who is involved** | Five actor cards from `bundle.actors`, each with a role sentence and an icon | — |
| 3 | **Metered usage (demo: EV charging)** | A simulated charger panel: <ul><li>register in Wh;</li><li>kWh delivered;</li><li>price per kWh;</li><li>running total in USDC;</li><li>"signed by meter key …";</li><li>a `SIMULATED meter` badge.</li></ul> One row per signed reading (`realRun.meter`) | OFF-CHAIN |
| 4 | **Approval and vouchers** | The main visual: a **swimlane timeline**. <ul><li>Lanes: meter / fleet / station (off-chain) and Stellar (on-chain).</li><li>Events from `realRun.story` play step by step: reading → approval → voucher #n → receipt #n → station accepts.</li><li>A counter shows **3 off-chain vouchers and 0 transactions so far**.</li><li>The sealed E0 fingerprint appears as a stamp.</li></ul> | OFF-CHAIN |
| 5 | **One payment on Stellar** | <ul><li>The single close transaction, with hash, ledger and explorer link.</li><li>A **money-flow diagram**: deposit 1.00 → station 0.30 + fleet refund 0.70, from the observed events.</li><li>Wallet balances before and after.</li><li>The headline **3 vouchers → 1 transaction**.</li></ul> | ON-CHAIN |
| 6 | **Check it yourself** | A terminal panel with each command from `realRun.cli` and its observed output, plus a copy button | ON-CHAIN |
| 7 | **Independent auditor (Verify page)** | <ul><li>V01–V08 as a checklist: title, plain question, status icon and text, layer badge.</li><li>The technical `details` can be expanded.</li><li>A large overall verdict.</li></ul> This section fulfils 01.1 P0 Must 4 | OFF + ON |
| 8 | **What if something goes wrong?** | A card per scenario (S1, F1–F7) with its question, answer, expected versus actual, evidence class and checkpoints. Opening a card replays that scenario's story on the same swimlane, with the refusal highlighted. F1 shows the edited value (10500 → 19500 Wh) | OFF + ON |
| 9 | **What we do not claim** | `bundle.limits`, always visible in the footer and expanded here | — |

## 4. UX principles

1. **Plain first, proof second.** Each element shows a title and one sentence; "Show technical detail" reveals the public fields.
2. **Status semantics never rely on color alone.** Each status has its own icon and text:

   | Status | Color | Icon |
   |---|---|---|
   | OK / PASS | green | ✔ |
   | REJECTED / FAIL | red | ✘ |
   | PENDING / NOT_AVAILABLE | amber | … |
   | INFO | neutral | none |

   `NOT_AVAILABLE` is never green.
3. **The layer is always marked.** On-chain items carry a Stellar badge and a distinct lane; off-chain items carry a "signed message" badge.
4. **Every claim is backed.** Any hash, amount or verdict links to its evidence: an explorer link, a CLI command, an E0/E1 field or a check.
5. **Replay is honest.** Playback animates only recorded events, at a presenter-controlled pace. The `REPLAY` label never disappears.
6. **Projector-ready.** Large type, high contrast (WCAG AA), no horizontal scroll from 1280 px to 1920 px, and usable on a laptop at 1366 × 768. A phone layout is supported if the UI is hosted (Q2).
7. **Failures are first-class.** The scenario explorer gets the same visual weight as the happy path. Refusals are celebrated as protection, not hidden as errors.

## 5. Presenter mode

Keyboard navigation steps through the sections of §3 in order. The pitch will keep evolving, so the UI does not hard-code its script or timing. The order of the steps and their optional time targets live in one small configuration, which can change without touching any component.

Keys:
- `→` / `←` move to the next or previous step.
- `Space` plays or pauses the swimlane timeline.
- `T` toggles technical detail.
- `S` opens the scenario explorer.

An optional elapsed-time indicator shows the time spent so far.

## 6. Architecture

| Topic | Proposal |
|---|---|
| Package | `apps/web` (`@usagepay/web`). A browser-only package, separate from the Node code in `apps/demo`. It imports **types only** from `@usagepay/demo`, plus the pure display formatter `@usagepay/demo/format` (integer `formatAmount`/`formatEnergy`/`short`), so no Node or SDK code is bundled |
| Stack | React + Vite + TypeScript, with exact pinned versions recorded in `implementation-versions.json`. Plain CSS with design tokens, without a UI framework, to keep the dependency surface small |
| Data | `pnpm demo` writes `apps/demo/out/demo-bundle.json`, and the UI build copies it into the static assets. The UI validates `schema === 'upay.demo-bundle.v1'` and handles each of these with explicit, honest states: <ul><li>`realRun.status === 'MISSING'`;</li><li>`ledger.status === 'UNAVAILABLE'`;</li><li>a NOT_AVAILABLE verification.</li></ul> |
| Network | None, beyond explorer links opened by the user (unless Q4 is approved). No wallet connection, no keys, no transaction building |
| Output | A static build in `apps/web/dist`, viewable offline from local files and hostable as a static site (Q2) |
| Root scripts | <ul><li>`pnpm ui:dev`: dev server on the latest bundle.</li><li>`pnpm ui:build`: runs `pnpm demo` to refresh the bundle, then builds.</li><li>`pnpm ui:preview`: serves the build locally.</li></ul> |

## 7. Testing and acceptance

Tests run with Vitest. Component tests use jsdom and render a **real** bundle built from `runScenarios()` and the newest committed run, never fabricated values. A manual visual check at 1366 px and 1920 px happens before each commit.

| ID | Acceptance criterion |
|---|---|
| UI-AC01 | Every `StoryEvent` renders its actor, its layer badge, a status icon with text, its title and its detail |
| UI-AC02 | Every on-chain fact shows an explorer link or a CLI equivalent with its observed output |
| UI-AC03 | The `REPLAY` label and the recording time are visible whenever a captured run is shown |
| UI-AC04 | V01–V08 render with the plain question and the status. `NOT_AVAILABLE` and `FAIL` are never shown as success |
| UI-AC05 | S1 and F1–F7 are all reachable, each with expected versus actual, its evidence class and its checkpoints |
| UI-AC06 | `MISSING`, `UNAVAILABLE` and `NOT_AVAILABLE` bundles render explicit states and never crash |
| UI-AC07 | The limits are reachable from every section |
| UI-AC08 | Presenter mode reaches every section by keyboard alone |
| UI-AC09 | There is no secret pattern in the built assets, and no network request other than user-opened links |
| UI-AC10 | Usability check: after a three-minute run-through, a person without blockchain knowledge can answer the five questions in §2 |

## 8. Out of scope

- Wallet connection, payments from the browser, Mainnet, user accounts.
- Real hardware.
- A backend service that holds keys.
- Editing evidence from the UI.
- New protocol, payment or verification behavior.
- Any claim beyond the SPEC 04 limits.

## 9. Resolved questions

| ID | Decision |
|---|---|
| **D11 — Language** | **English only.** This follows the repository default and the pitch sheet, and the UI reuses the tested narrative strings unchanged. |
| **D12 — Hosting** | **Local and public.** <ul><li>The presenter runs it locally with `pnpm ui:preview`.</li><li>The **Vercel deploy is done during the hackathon**, after the demo-day evidence exists, from that day's build.</li><li>It contains public data only.</li><li>It is a separate, confirmed step: nothing is deployed before the hackathon.</li></ul> |
| **D13 — Live run** | **Replay for P0, live mode as an optional extra.** <ul><li>P0 replays the run captured that morning, labelled `REPLAY`.</li><li>The optional extra, built only after P0 is complete, is a local process that holds the Testnet keys, runs `test:e2e:testnet` and streams its public trace to the UI.</li><li>The browser never receives keys.</li></ul> |
| **D14 — Verification** | **Captured for P0, browser re-verify as an optional extra.** <ul><li>P0 shows the verification `pnpm demo` captured, with its timestamp.</li><li>The extra, attempted only after a successful browser and CORS feasibility spike, is a "Re-verify now" action: the browser runs the unchanged SPEC 03 verifier against Soroban RPC. If the spike fails, the captured result stays the only view.</li></ul> |

## 10. Implementation requirements

This section specifies what the P0 page shall provide beyond §3–§7, so that a team can rebuild the same page. None of it changes protocol, payment, verification or schema behavior.

### 10.1 Required components

| Component | Location | Requirement |
|---|---|---|
| **Package `@usagepay/web`** | `apps/web/` (React 19, Vite 8, plain CSS tokens in `src/styles.css`) | §6 |
| **Bundle inlined at build time** | `vite.config.ts` plugin `upay-demo-bundle` (virtual module `virtual:upay-bundle`) | <ul><li>The page makes no data request.</li><li>The default source is `apps/demo/out/demo-bundle.json`; `UPAY_BUNDLE` overrides it.</li><li>The build fails with a clear message when the bundle is missing.</li><li>It **refuses** any bundle containing a Stellar-secret-seed-shaped string (`S` followed by 55 base32 characters).</li></ul> |
| **Single-file build with CSP** | `vite.config.ts` plugin `upay-single-file` | <ul><li>`dist/index.html` inlines the script and the styles.</li><li>It opens from disk, from `ui:preview` or from a static host.</li><li>A build-time Content-Security-Policy forbids connections and external resources (`default-src 'none'; connect-src 'none'`).</li></ul> |
| **Runtime bundle check** | `src/bundle.ts` `parseBundle` | Checks the schema, the required fields and the list types, and shows an explanation instead of a crash (UI-AC06) |
| **Evidence class explanations** | `apps/demo/src/narrative.ts` `EVIDENCE_CLASSES`, bundle field `evidenceClasses` | <ul><li>Plain words for `REAL_TESTNET`, `SDK_INTEGRATION` and `OFFLINE_FIXTURE`.</li><li>An additive field of `upay.demo-bundle.v1`; the UI tolerates its absence.</li></ul> |
| **Pure formatter subpath** | `apps/demo/package.json` export `./format` | Display formatting shared with the terminal, without bundling Node code |
| **Shared workspace aliases** | `vitest.aliases.ts` (exact-match patterns) | Used by the root Vitest projects and by the web project and build. `@usagepay/demo/format` must not be caught by `@usagepay/demo` |
| **Presenter configuration** | `src/presenter.ts` `SECTIONS`, `PRESENTER_STEPS`, `PLAYBACK_INTERVAL_MS` | §5: the order, labels and optional time targets change without touching components |
| **Shared section links** | `index.html#<section>` | Opens on that section, for judges and for the hosted page |
| **Ledger test double, shared** | `apps/demo/test/ledger-double.ts` | Used by the demo tests and the web test setup |
| **Root scripts** | `package.json` | <ul><li>`ui:dev`, `ui:build`, `ui:preview` and `typecheck:web`.</li><li>`ui:build` keeps building on a demo verdict of FAIL (1) or NOT_AVAILABLE (2), which the page then shows honestly.</li><li>It stops on a usage error (3).</li></ul> |
| **Pinned UI dependencies** | `apps/web/package.json`, `implementation-versions.json` `uiDependencies`, `versions:check` | D10. `vite` is the instance vitest already resolves. `jsdom` stays on a release that supports Node 22.12 |

### 10.2 UX requirements

- **Swimlane layout.** Each event is one full-width card. Five lane rails on its left mark the actor: meter, fleet, station and auditor off-chain, Stellar on-chain. Long plain-language sentences must stay readable at 1366 px, so there is no column per actor.
- **Replay.** The timeline starts fully shown, so nothing is hidden from a reader. `Play` or `Space` replays the recorded events from the start at `PLAYBACK_INTERVAL_MS`, and the step controls move one event at a time. The counters are:
  - signed readings;
  - off-chain vouchers;
  - fleet receipts;
  - Stellar transactions;
  - E0 open or sealed.

  They count only the recorded events played so far, so they show *3 vouchers and 0 transactions* until the close.
- **Layer colours.** Off-chain is blue and on-chain is violet. Green and red are reserved for status, so a layer is never mistaken for a verdict.
- **Scenario cards.** Each card shows two things side by side: the system's outcome (for example `✘ Refused`) and whether that matched the expectation (`✔ As expected`). In the scenario story, the first refusal is marked "Refused here: this is the protection working."
- **Light theme only.** It gives the best projector contrast. Status text never relies on colour alone.

### 10.3 Testing requirements

- `test/global-setup.ts` builds five real bundles with `buildBundle` from the newest committed `g2-*` run, sequentially, because the offline scenario ledger allows one install at a time:

  | Bundle | How it is built | What it shows |
  |---|---|---|
  | `live` | Ledger double answering like Testnet | Verdict PASS |
  | `offline` | No ledger | NOT_AVAILABLE |
  | `unavailable` | Ledger rejects every call | UNAVAILABLE, V08 NOT_AVAILABLE |
  | `fail` | Ledger shows a wrong withdrawn amount | V08 FAIL |
  | `missing` | No run | The MISSING state |

  Each bundle is round-tripped through JSON like the real file.
- `test/ui.test.tsx` covers UI-AC01–AC09 in jsdom. Network primitives are stubbed and asserted unused.
- `test/build.test.ts` (Node environment) checks the production build:
  - it is one file with the CSP;
  - it contains no secret, no `src`/`href` outside the inline code and no network API;
  - it refuses a seed-shaped bundle and a missing one.
- **Visual check.** Before each commit that changes the page, headless Chrome captures every section at 1366 × 768, at 1920 × 1080 and at 390 px (phone), in plain and technical mode. `document.documentElement.scrollWidth` must equal the viewport width at all three sizes, so there is no horizontal scroll.
- `corepack pnpm test` includes the `web` project, and every test must pass.

### 10.4 Positioning requirements

UsagePay is positioned as the proof layer for machine payments on any metered service; EV charging is the demo use case only. The copy comes from **01.2 §0.1**, the single source for the UI, the README and the pitch.

| Where | Requirement |
|---|---|
| Overview kicker and H1 | Kicker *Infrastructure for the machine economy.* (exported as `KICKER`) above the H1 **"UsagePay enables verifiable machine-to-machine payments for metered services on Stellar."** (exported as `POSITIONING` from `Overview.tsx`) |
| Overview lead | "Every payment carries its proof: …", then an `aside` labelled "Demo use case" with the EV story and chips for the services the same flow fits (Energy, shown here; Compute time; Connectivity; Equipment hours; Water). The chips are illustrative categories, not adapters. The Energy chip is filled with the accent colour, like a selected chip |
| Demo use-case box | Full page width, aligned with the other blocks |
| Section 1 | "A valid payment does not say what it paid for"; meter / payer / ledger, followed by the block **Why Stellar MPP alone is not enough**: what MPP proves, what it cannot prove ("for what?") and the five links UsagePay adds |
| "UsagePay adds the missing link" | Inside a grey box (`--surface-2`), like the MPP columns above it |
| Section 1, after the MPP block | **Fits what is already deployed**: no new hardware (reads what OCPP/OCMF already carry), no new payment protocol (Stellar MPP and the one-way channel unchanged), beside existing systems. Followed by the qualifier that the demo meter is simulated and not conformant, and that end-only signed meters need reconciliation (roadmap). Neutral surface with an accent top border, because blue is reserved for the off-chain layer |
| Actor cards (section 2) | Layer badges must not overflow into the next card at 1366 px: compact badges (`LayerBadge compact`: "OFF-CHAIN" / "ON-CHAIN", full wording kept in the title) and `min-width: 0` on the card |
| Explorer links (section 6) | One row of five compact link buttons (two per row below 900 px) under a single "Open on stellar.expert, the public Testnet explorer" line; each whole button opens the page and keeps the accessible name "… on stellar.expert" |
| Top bar brand | "UsagePay" with a small raised "on Stellar" (`<sup>`). Never "by Stellar", and no official Stellar logo (01.2 §0.1) |
| H1 size | `clamp(1.7rem, 2.75vw, 2.45rem)` at full page width: at most two lines at 1280, 1366 and 1920 px. Phone width wraps further |
| Section 3 | "3 · Metered usage · demo: EV charging"; nav label `Usage` |
| Actor names (`apps/demo` `ACTORS`, also in the terminal walkthrough) | **Meter · EV charger**; **Payer · EV fleet wallet**; **Provider · charging station**. The role comes first, the demo instance second |
| Limits (`apps/demo` `LIMITS`) | First line: "One adapter today: energy in Wh, shown as EV charging. UsagePay is built for any metered service, but this code accepts energy readings only; a second adapter is on the roadmap." This keeps the horizontal claim honest (01.3 §5: "EV-only hard-coded accounting masquerades as horizontal") |
| Terminal walkthrough header (`apps/demo` `walkthrough.ts`) | The kicker, the positioning sentence, then "Demo use case: EV charging. …" |
| `index.html` | Title "UsagePay · verifiable machine payments"; the description starts with the positioning sentence |
| Phone layout | Sections must not scroll under the three-row top bar: `scroll-margin-top: 180px` below 600 px |

**Test.** `ui.test.tsx` "Positioning" (live and missing bundles) shall assert:
- the H1 equals `POSITIONING`;
- the kicker precedes it;
- the demo use case is labelled;
- the H1 never mentions kWh or charging;
- the gap section explains why MPP alone is not enough;
- the one-adapter limit is shown;
- the "Fits what is already deployed" block and its non-conformance qualifier are shown;
- the brand reads "UsagePay" with a raised "on Stellar".

**Visual check.** Headless Chrome at 1366 × 768 and 390 px shows no horizontal scroll. Presenter navigation at 390 px keeps the section title visible.
