# UsagePay — Developer Environment & AI Tooling

**Audience:** HackMeridian developers (1–3 people).  
**Goal:** Set up a consistent Claude Code + Stellar environment and understand when to use each tool.  
**Authority:** `CLAUDE.md`, `specs/00-shared-contracts-and-engineering-rules.md`, and `01.1-usagepay-technical-architecture-and-roadmap.md`. This guide does not change the MVP scope.

## 1. What each tool is for

| Tool | Why we use it | When to use it |
|---|---|---|
| **Claude Code** | Implements a single assigned SPEC and runs tests | Every implementation gate |
| **Stellar Dev Skill (official)** | Gives Claude Stellar-specific development patterns | MPP, assets/SAC, RPC, signing, SDK questions |
| **Raven MCP** | Searches current Stellar docs and ecosystem information | When a Stellar API, protocol or version detail needs verification |
| **Stellar CLI + `stellar skill`** | Provides agent-oriented CLI conventions and Testnet operations | Inspect local configuration; perform G1 Testnet operations |
| **`@stellar/mpp` SDK & upstream examples** | Actual implementation of cumulative channel credentials and settlement | G1 feasibility and SPEC 02; do not rewrite its signing protocol |
| **Git + pnpm lockfile** | Keeps the team on the same source and dependency versions | All gates |

**Do not install `kaankacar/stellar-build` for this MVP.** Its extra skills, personas and prompt-rewriting hooks are unnecessary for our already-specified workflow. It remains a reference, not a dependency.

## 2. Required setup (each developer's machine)

Supported working environments: macOS or Ubuntu/Linux; Windows developers may use WSL. **Installations and authentication are per developer; do not share tokens, keys or local Claude settings.**

### A. Core prerequisites

Install Git, **Node.js 22 or later**, and a compatible pnpm version. The current MPP SDK README requires **pnpm 10.33+**. Once G0 creates `package.json` with a `packageManager` version and commits `pnpm-lock.yaml`, use the **repository-pinned** version instead of upgrading independently.

```bash
git --version
node --version
corepack --version
corepack enable
pnpm --version
```

If Node.js or Corepack is missing, install an appropriate Node.js 22+ release using your existing version manager (e.g. mise or nvm), then re-run the checks. If Corepack is unavailable in your Node distribution, follow its official installation instructions. **Do not run `pnpm install` before the G0 workspace exists.**

### B. Claude Code

Use [Anthropic's installation instructions](https://code.claude.com/docs/en/setup) for your OS. On macOS with Homebrew:

```bash
brew install --cask claude-code
claude --version
```

On Ubuntu/Linux, follow the official [Claude Code setup](https://code.claude.com/docs/en/setup) rather than an unofficial installer. Start Claude Code inside the repository and complete the first-run sign-in:

```bash
cd /path/to/usagepay
claude
```

### C. Official Stellar Dev Skill

**Run the next two commands inside the interactive Claude Code session**, not in the system shell:

```text
/plugin marketplace add stellar/stellar-dev-skill
/plugin install stellar-dev@stellar-dev
```

Use the relevant skills on demand: `agentic-payments` (MPP), `assets` (USDC and SAC), `data` (RPC), and `smart-contracts` only when inspecting the existing one-way-channel contract. Verify actual library versions against installed code; skill examples can become stale.

### D. Raven MCP

**Run this in the system terminal:**

```bash
claude mcp add --transport http stellar-raven \
  "https://raven.stellar.buzz/mcp"
claude mcp list
```

Then **inside Claude Code**, run `/mcp`, select `stellar-raven`, choose **Authenticate**, and complete browser sign-in. This URL is the endpoint published by the official [Stellar Building with AI](https://developers.stellar.org/docs/build/building-with-ai) guide and the [Raven site](https://raven.stellar.buzz/). No Raven service API key is required; authentication is still required.

**Useful request to Claude:**

> Use Stellar Raven to locate the current MPP Session/channel documentation and source references. Cite the actual documentation or source URL. Do not implement anything yet.

Raven is a **reference tool**, not an implementation dependency. If it is temporarily unavailable, consult the official docs and pinned SDK source; do not invent APIs.

### E. Stellar CLI

Install [Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli) **28.1.0 or later** (required for the documented `stellar skill` command). On macOS:

```bash
brew install stellar-cli
```

On Ubuntu/Linux, use the installation method maintained in the official guide (including its published Linux install script, if appropriate for your machine). Verify:

```bash
stellar --version
stellar doctor
stellar skill
```

At the **beginning of a Claude session involving Stellar CLI**, tell Claude:

> Run `stellar skill` and follow its conventions for Stellar CLI commands. Use Testnet only. For reads, use `--send=no` when supported. Never submit a transaction during G0.

**Do not install Rust or compile a new contract for G0.** During G1, install Rust + `wasm32v1-none` only if building the upstream experimental channel contract is actually required.

## 3. Repository onboarding

Clone the **team repository URL supplied by the coordinator** (no particular GitHub repository is assumed here). Verify the checkout contains:

```text
usagepay/
├── CLAUDE.md
├── SETUP.md
├── 01.1-usagepay-technical-architecture-and-roadmap.md
└── specs/
    ├── 00-shared-contracts-and-engineering-rules.md
    ├── 01-metering-and-evidence.md
    ├── 02-payer-and-stellar-settlement.md
    ├── 03-independent-verifier.md
    └── 04-integration-and-acceptance.md
```

After G0, the repository will also contain `package.json`, `pnpm-lock.yaml`, `implementation-versions.json`, the shared contracts package and tests. Team members should then use:

```bash
# In the repository root; only after G0 has produced the workspace:
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

These are **target workspace commands**; G0 must create corresponding scripts. Do not report them as passed before execution.

**Shared in Git:** project instructions, SPECs, code, non-secret fixtures, lockfile, safe `.env.example`, Testnet public addresses and public transaction hashes.  
**Local only:** Claude/Raven OAuth session, `.env`, private Testnet keys, machine-specific configuration, personal mainnet accounts. Confirm `.env` and key files are Git-ignored before generating secrets.

## 4. How to work with Claude — one gate at a time

### G0 — first session, offline only

Paste this prompt into Claude Code:

```text
Read CLAUDE.md, UsagePay 01.1, SETUP.md and SPEC 00.
Execute G0 only: initialize the workspace, freeze shared schemas/types,
canonicalization, deterministic fixtures, and offline contract tests.
Resolve and pin compatible dependencies. Run tests, typecheck and build.
Report actual results using the format in CLAUDE.md. STOP before G1.
Do not create accounts, fund channels or submit Testnet transactions.
```

**G0 success:** the frozen schemas/fixtures compile, offline tests pass and Claude supplies an actual execution report. A tool installation alone is **not** G0 completion.

### G1 — only after G0 passes

The coordinator assigns G1 separately: fund **disposable Testnet-only** identities, verify a real native MPP channel lifecycle, capture the actual signed credential and prove the payer-signed evidence acknowledgement can be checked before acceptance. Use SPEC 00 and SPEC 02. **No simulated signature or transaction may count as proof.**

Testnet USDC can require a Circle faucet CAPTCHA and trustline setup. Coordinate it before G1; never share signing secrets. MPP Charge is only a documented reduced-scope fallback, not evidence that Session/channel P0 succeeded.

### G2–G5 — only after G1 passes

Assign `metering`, `settlement` and `verification` independently using their SPECs; integrate through SPEC 04. Use one branch or worktree per owner. Only the coordinator may approve changes to the frozen shared contracts. Every owner reports: **gate, PASS/FAIL/BLOCKED, changed files, tests run, evidence, blocker**.

## 5. Environment readiness checklist

- [ ] Git, Node.js 22+, Corepack/pnpm available; versions recorded.
- [ ] Claude Code runs and is authenticated.
- [ ] Official Stellar Dev Skill installed in Claude Code.
- [ ] Raven MCP connected and browser-authenticated; a Stellar docs query works.
- [ ] Stellar CLI version is at least 28.1.0; `stellar doctor` and `stellar skill` work.
- [ ] Project files and correct SPEC versions are present.
- [ ] No mainnet credentials or personal wallet secrets are accessible to the build.
- [ ] Team understands **G0 is offline** and **G1 is the first real Testnet gate**.

If a required setup item fails, share only the command, version and **redacted** error with the coordinator. Do not share OAuth tokens, `.env` contents or private keys.

## 6. Primary references

- [Stellar: Building with AI](https://developers.stellar.org/docs/build/building-with-ai)
- [Raven MCP: official connection instructions](https://raven.stellar.buzz/)
- [Stellar Dev Skill (official)](https://github.com/stellar/stellar-dev-skill)
- [Stellar CLI for agents / Quickstart](https://developers.stellar.org/docs/tools/cli/agent-cli/quickstart)
- [Stellar CLI installation](https://developers.stellar.org/docs/tools/cli/install-cli)
- [Stellar MPP SDK](https://github.com/stellar/stellar-mpp-sdk)
- [MPP channel client](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-client.ts) · [server](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-server.ts) · [close](https://github.com/stellar/stellar-mpp-sdk/blob/main/examples/channel-close-mpp.ts)
- [One-way-channel upstream demo](https://github.com/stellar-experimental/one-way-channel/blob/main/examples/demo.sh)
- [Claude Code setup](https://code.claude.com/docs/en/setup)
