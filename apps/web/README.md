# @usagepay/web — judge-facing demo UI (SPEC 05)

A static, browser-only page that renders the `upay.demo-bundle.v1` written by `pnpm demo`. It is the presentation layer only. It computes no amount, digest, signature or verdict, holds no keys, connects to no wallet and makes no network request. The only exception is an explorer link that the viewer opens.

## Commands (from the repository root)

```bash
corepack pnpm ui:build     # tsc -b, pnpm demo (refreshes apps/demo/out/demo-bundle.json), typecheck, vite build
corepack pnpm ui:preview   # serves apps/web/dist locally (offline once built)
corepack pnpm ui:dev       # dev server with hot reload on the current bundle
corepack pnpm typecheck:web
corepack pnpm test         # includes the `web` Vitest project (UI-AC01..09)
```

`ui:build` continues when the demo verdict is FAIL (exit 1) or NOT_AVAILABLE (exit 2), because the page then shows that state honestly. It stops on a usage error (exit 3) or when no bundle exists. `UPAY_BUNDLE=<file>` builds from another bundle file.

The output is **one self-contained file**, `apps/web/dist/index.html`:
- the script, the styles and the bundle are inlined;
- it opens from disk or from any static host (D12: Vercel, during the hackathon only);
- its Content-Security-Policy forbids every connection (`connect-src 'none'`) and every external resource.

## Sections and presenter keys

| # | Section (`src/presenter.ts`) | Source in the bundle |
|---|---|---|
| 0 | Overview: positioning (01.2 §0.1), demo use case, `REPLAY` banner, captured verdict, headline figures | `realRun.recordedAt`, `verification`, `meter`, `settlement` |
| 1 | The gap, and why Stellar MPP alone is not enough | static copy |
| 2 | Who is involved | `actors` |
| 3 | Metered usage (demo: EV charging): simulated charger display and signed readings | `realRun.meter`, `tariff`, `parties.meterKey` |
| 4 | Approval and vouchers: swimlane replay, where a repeated round plays as one step in short; counters; E0 stamp | `realRun.story` |
| 5 | One payment on Stellar: close transaction, money flow, balances | `realRun.ledger`, `settlement`, `links` |
| 6 | Check it yourself: `stellar` CLI commands, observed output, explorer links | `realRun.cli`, `links` |
| 7 | Independent auditor (Verify page) V01–V08 | `realRun.verification` |
| 8 | What if: S1, F1–F7 with expected vs actual, checkpoints and story | `scenarios`, `evidenceClasses` |
| 9 | What we do not claim | `limits` |

Presenter keys:

| Key | Action |
|---|---|
| `→` / `←` | Next or previous section. Moves the focus and shows `Step n / N · label · elapsed` |
| `Space` | Play or pause the swimlane replay. On a focused button or link, `Space` keeps its native meaning |
| `T` | Technical detail on or off |
| `S` | Scenarios |

The order and the optional `targetSeconds` live in `PRESENTER_STEPS`, so the pitch can change without touching the components. A link such as `index.html#verify` opens on that section.

## Honesty rules enforced by the UI

- A captured run is labelled `REPLAY` with its recording time in three places: the top bar, the overview banner and the timeline.
- Status icons and words never depend on colour alone. `NOT_AVAILABLE`, `PENDING`, `FAIL`, `REJECTED` and unknown statuses are never green.
- `MISSING`, `UNAVAILABLE` and `NOT_AVAILABLE` bundles render explicit states. A malformed bundle renders an explanation, never a crash.
- The build refuses a bundle containing anything shaped like a Stellar secret seed.

## Tests

`test/global-setup.ts` builds five real bundles with the SPEC 04 code: `live`, `offline`, `unavailable`, `fail` and `missing`.
- They use the newest committed `g2-*` run.
- `live` and `fail` use the read-only ledger double from `apps/demo/test/ledger-double.ts`.

`test/ui.test.tsx` covers UI-AC01 to UI-AC09 and the replay steps in jsdom. `test/build.test.ts` runs a production build and checks:
- a single file;
- the CSP;
- no secret;
- no external resource or network API.
