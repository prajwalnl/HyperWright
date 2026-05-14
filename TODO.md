# TODO — make a fresh clone runnable

This repo was extracted from a langgraphjs fork into a standalone pnpm
workspace. Packaging is done (`pnpm install` + `pnpm dev` boot the web
server + embedded graph). The items below are what still stands between
a fresh `git clone` and an actual end-to-end run.

## 1. Hard-coded clone path (blocks "clone and go") — HIGH

`BASE_CLONE_DIR = "/Users/prajwal.nl/hcc-tmp"` is hard-coded in **two**
files:

- `src/nodes/cloneRepo.ts:10`
- `src/nodes/setupContext.ts:14`

On any other machine/user this path is wrong, so a run breaks at the
clone / setup node.

**Plan:** make it env-configurable — read `CLONE_BASE_DIR` from env,
default to `os.tmpdir()` (or a repo-relative `.clones/` dir). Apply to
both files, add `CLONE_BASE_DIR` to `.env.example`, and gitignore
`.clones/` if that's the chosen default.

## 2. Playwright browsers not installed — MEDIUM

`ENABLE_BROWSER_TOOLS=1` by default, but `pnpm install` does not fetch
browser binaries (no `postinstall`).

**Plan:** add a `postinstall` script running `playwright install chromium`,
OR document `npx playwright install chromium` as a setup step. Note the
escape hatch: `ENABLE_BROWSER_TOOLS=0` skips Chromium entirely.

## 3. No `.env` in repo — MEDIUM (inherent, document it)

`.env` is gitignored (correct — it holds secrets). `env.ts` has
fallbacks so the server still boots, but `LITELLM_API_KEY` falls back to
the literal `sk-must-override-via-.env`, so every LLM call fails until a
real `.env` exists.

**Plan:** add a README "Setup" section: `cp .env.example .env` and fill
in a real OpenAI-compatible endpoint + key.

## 4. External infra & tooling — LOW (inherent, document it)

The pipeline shells out to `git` and `gh` (must be authenticated) and
targets a Hyperswitch environment (backend :8080, frontend :9000) —
`setupBackend` / `setupFrontend` expect that infra to exist or be
pointed elsewhere via `.env`.

**Plan:** document prerequisites in the README — `gh auth login`, the
Hyperswitch dashboard repo, and which `.env` vars repoint the targets.

## 5. Misc polish — LOW

- No `engines` field / `.nvmrc` — pin a Node version (tsx + vite want
  Node 18+/20+).
- `README.md` still references the legacy `parseInput` node; the current
  entry node is `setupContext` (see `CLAUDE.md`).
- `.claude/settings.local.json` is tracked — decide whether to gitignore
  it in this repo.

---

## Done (packaging extraction)

- Pinned `@langchain/langgraph` from `workspace:*` to `^1.2.9` (npm).
- Added `@tsconfig/recommended` + `typescript` to devDependencies.
- Added `pnpm-workspace.yaml` (root graph + `web-ui` sub-package).
- Added `.gitignore` (node_modules, dist, `.env`, runtime artifacts).
- Flattened `examples/playwright/*` to the repo root, dropped the rest
  of the langgraphjs monorepo.
- Added root `dev` / `build` / `start` passthrough scripts → `web-ui`.
