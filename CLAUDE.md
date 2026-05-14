# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@examples/playwright` — a runnable **LangGraph StateGraph** that implements the four-agent Playwright QA pipeline specified in `qa-skills/` (SKILL.md + orchestrator.md + _planner.md + _generator.md + _healer.md). Every node performs real side effects (shells out to `git`/`gh`/`docker compose`, spawns Hyperswitch's backend script, runs `npx playwright test --reporter=json`, calls an LLM via any OpenAI-compatible endpoint, applies surgical edits).

This package has two parts:
- **Root package** (`@examples/playwright`) — the graph itself, driven headlessly from `src/index.ts` and `scripts/phase-trace.ts`.
- **`web-ui/` subpackage** (`@examples/playwright-web-ui`) — a dark-themed React + Hono cockpit that imports the compiled graph and exposes it via SSE + REST to a browser UI that visualises node progression, streams logs, and handles the `awaitUserChoice` HITL interrupt.

Both share the same `.env` and write to the same sessionDir layout. **The graph is owned by the root package**; the web-ui is a thin live-view wrapper. When a node's behavior changes, update it in `src/`, not in `web-ui/`.

## Commands

### Root package (from `examples/playwright/`)

| Command | What it does |
| ------- | ------------ |
| `npx tsx src/index.ts full [commit\|new-branch\|clean]` | Full pipeline demo: plan → generate → heal → HITL → cleanup, driven with `"generate tests for module: payments"` |
| `npx tsx src/index.ts heal [commit\|new-branch\|clean]` | Heal-only demo: plan → heal → HITL → cleanup |
| `npx tsx scripts/phase-trace.ts` | **No-LLM** topology/phase-history sanity check for both modes. Run this first when changing routing or node wiring. |
| `pnpm demo:full` / `pnpm demo:heal` | Aliases for the above |

### Web UI (from `examples/playwright/web-ui/`)

| Command | What it does |
| ------- | ------------ |
| `pnpm dev` | `concurrently` runs `dev:server` (tsx watch on :7800) + `dev:client` (Vite on :5173). Vite proxies `/api/*` → Hono. |
| `pnpm dev:server` | Hono backend only (`tsx watch server/index.ts`) |
| `pnpm dev:client` | Vite dev server only |
| `pnpm build` | Bundles client → `dist/` |
| `pnpm start` | Runs Hono server (prod, no watch) |

### Env / tsc

Env comes from `examples/playwright/.env` (template `./.env.example`). **`src/env.ts` resolves `.env` relative to the source file, not `process.cwd()`** — so the graph works identically whether invoked from this dir or from `web-ui/`. Web-ui additionally reads `WEB_UI_PORT` (default 7800), `WEB_UI_HOST` (default 127.0.0.1), and `BACKEND_URL` (Vite proxy target).

Set `OUT_PREFIX=.out` to redirect root-package artifacts to a scratch dir; set `ENABLE_BROWSER_TOOLS=0` to skip Chromium entirely (much faster when iterating on non-browser logic). **No test suite, no linter, no typecheck script** in either package — `tsc` runs implicitly via `tsx` / Vite.

## Architecture — what crosses files

### `qa-skills/` is the source of truth for agent behavior

The five markdown files in `qa-skills/` are the **spec** — `src/` is the implementation. When a planner/generator/healer behaves wrong, the fix is usually in the spec + a prompt-assembly tweak in `src/agents/prompts.ts`, not in the node that invokes the agent. `src/agents/prompts.ts::buildSystemPrompt` concatenates, in priority order: identity line → `AGENT_PLAYBOOK` (condensed cheat-sheet in `src/agents/playbook.ts`) → full `SKILL.md` → role-specific `_{role}.md` → run-specific context. The **playbook wins** when it contradicts SKILL.md — it is the load-bearing summary and exists because agents kept forgetting things buried deep in SKILL.md.

The **module catalogue** (URL + prerequisites + API helpers per module) is encoded in **three** places: as a table in `qa-skills/SKILL.md`, as a cheat-sheet section in `src/agents/playbook.ts`, and as `MODULE_CATALOG` in `src/config.ts`. All three must agree when you add/edit a module.

### Graph topology, routing, and the mid-refactor node

`src/graph.ts` wires 10 nodes: `setupContext` → (parallel `setupBackend` + `setupFrontend`) → `setupJoin` → `planTests` → (mode branch: `generateTests` → `healTests` | direct `healTests`) → self-loop on `healTests` (≤ `maxHealingAttempts`, default 3) → `awaitUserChoice` (interrupt) → `cleanup` → `summary` → END. All conditional routing lives in `src/routing.ts`; any node that sets `status: "failed"` short-circuits straight to `summary`.

**Mid-refactor warning:** `src/nodes/parseInput.ts` is legacy and **not wired into the graph** — `setupContext.ts` is the current entry node (it combines input parsing + repo cloning into one step, and clones into the hard-coded `BASE_CLONE_DIR = /Users/prajwal.nl/hcc-tmp/hcc-<sessionId>`). Edit `setupContext.ts`, not `parseInput.ts`. The README still references `parseInput` — it hasn't been updated to match.

### Graph topology is mirrored in the web-ui — keep them in sync

`web-ui/src/state/graphLayout.ts` is a **hand-maintained mirror** of `src/graph.ts`: a `GRAPH_NODES` array with positions + a `GRAPH_EDGES` array. When you add/remove/rename a node in `src/graph.ts`, update this file too or the canvas will silently diverge from reality (nodes won't light up, or will light up in the wrong order).

There's a second mirror in the same direction: **`PHASE_TO_NODES`** in `web-ui/src/hooks/useWorkflow.ts` maps every `Phase` from `src/types.ts` to the node(s) it implies. When you add a new `Phase`, add it here too — otherwise the `visitedNodes` set stays stale and the canvas shows that node as never-visited even after the graph has walked past it.

### State shape, reducers, and persistence

`src/state.ts` defines `QAState` via `Annotation.Root` with explicit reducers: `lastWriteWins` for scalars, `appendArray` for `logs`/`phaseHistory`/`generatedFiles`, custom shallow merge for `servers`/`repo`/`metrics`. `phaseHistory` is append-only and is the primary observable trace of the state machine — `scripts/phase-trace.ts` asserts against it, and the web-ui derives "visited nodes" from it. `phase` (the current phase) is last-write-wins.

Every node ends with `return respond(state, patch)` (from `src/session/respond.ts`), which merges the patch into state, writes `session.json` via `writeSession`, and returns the update so LangGraph's reducers apply it. **Keep that pattern** — if you skip `respond` and return a bare patch, `session.json` stops updating mid-run, the web-ui's restored snapshot goes stale, and phase-trace still passes (so you won't catch it in CI). Write a log line via `loggerFor`, not `console.log` — see next section.

### Logging has three audiences — use `loggerFor`

Every node creates `const l = loggerFor(nodeName, logs)` (from `src/session/log.ts`). Each call **does three things simultaneously**:
1. Pushes the line to the local `logs` array (flows into `state.logs` via the append reducer — this is what the headless CLI prints).
2. Writes the line to `logs/<node>.log` under the session dir (crash-recovery + post-mortem).
3. Emits a `"log"` event on the `logger` `EventEmitter` singleton, which the web-ui's `Runner` subscribes to and forwards as SSE.

If you add a new node, use `loggerFor` — don't `console.log` and don't push to `logs` directly, or the web-ui will lose realtime output and per-node log files won't exist.

### Sub-agent pattern

`planTests` / `generateTests` / `healTests` each call a function in `src/agents/` that builds a `createReactAgent` via `src/agents/react.ts::runSubAgent`. Each sub-agent receives the **full** browser tool surface from `src/tools/browser.ts` (Playwright-MCP-compatible naming: `browser_navigate`, `browser_snapshot`, `browser_generate_locator`, …), the `fs` tools, and — critically — `planner_setup_page` from `src/tools/planner.ts`. The planner additionally gets `planner_save_plan`. **Do not** make agents stitch login manually; the playbook tells them to call `planner_setup_page` once at the start, and that tool deterministically does signup → login → skip 2FA → navigate.

Chromium is a **lazy singleton** in `src/tools/browser/singleton.ts`, shared across every tool call in a run, so `browser_console_messages` and `browser_network_requests` accumulate across tool invocations. `runSubAgent` calls `closeBrowser()` in its `finally` block — do not teach agents to call `browser_close` mid-flow.

### HITL resume protocol (same on both sides)

`src/nodes/awaitUserChoice.ts` calls `interrupt(...)` which pauses the graph. The caller resumes with `new Command({ resume: "commit" | "new-branch" | "clean" })`. Checkpointer is `MemorySaver` (in-process only), so resuming requires **the same graph object** that started the run — surviving a process restart mid-interrupt is **not supported**. `cleanup` rewrites a `commit` choice to `new-branch` unless `targetType` is `pr` or `branch` (no point committing to `main`).

In the web-ui: after `graph.stream()` returns, `Runner` inspects `graph.getState()` — if `state.next` includes `awaitUserChoice` **or** any task has interrupts, it flips `awaitingChoice=true` and publishes an `awaiting_choice` event. The client shows `HITLBar`; user picks a choice; `POST /api/workflow/resume` calls `graph.stream(new Command({ resume: choice }), ...)`. Valid choices are re-validated in `server/index.ts`.

### Web-ui runner: singleton, two event sources, one event union

`web-ui/server/runner.ts` is a singleton (`export const runner = new Runner()`) — the server executes **one graph run at a time**; a second `/api/workflow/start` while running returns 409. The runner has two distinct event paths both feeding the same `WorkflowEvent` union (`web-ui/server/types.ts`):

1. **Graph state updates** — `graph.stream(..., streamMode: "updates")` yields `{ [nodeName]: partialUpdate }` chunks. `consume()` calls `graph.getState()` after each chunk to get the full snapshot + `next` array, then broadcasts a `state` SSE event with `currentNodes` (just-completed) and `nextNodes` (upcoming).
2. **Real-time logs** — the parent `logger` singleton emits `"log"` events as nodes write lines; runner subscribes and forwards each as a `log` SSE event.

The client reducer in `web-ui/src/hooks/useWorkflow.ts::reduce()` is the **single** place SSE events turn into UI state. Events: `started`, `state`, `log`, `awaiting_choice`, `finished`, `stopped`, `error`. The canvas highlights `nextNodes` as "running" (they're what's about to execute) and renders `visitedNodes` (derived from `currentNodes` + `phaseHistory` via `PHASE_TO_NODES`) as "done". Heartbeat pings every 15s keep proxies from dropping the SSE connection.

### Session persistence and why `running` / `awaitingChoice` are NEVER restored

Web-ui runs are keyed by `threadId` (UUID). Artifacts live under `.web-ui-run/<SESSION_DIR>/<threadId>/` (`session.json`, `web-ui-logs.json`) and `.web-ui-run/<GENERATED_TESTS_DIR>/<threadId>/`. The `.web-ui-run/` prefix is deliberately added onto `SESSION_DIR`/`GENERATED_TESTS_DIR` so the web-ui writes **outside** the CLI's normal output dirs — CLI demos and web-ui runs can coexist without clobbering each other.

On startup, `Runner.loadLatestRun()` restores the latest session's logs and snapshot for display — but **deliberately does NOT restore `running` or `awaitingChoice`**. Those flags describe a live in-process workflow; after a server restart the graph object and `AbortController` no longer exist, so restoring `running=true` would make `/start` return 409 forever and `/stop` be a no-op. Same invariant on the client: `useWorkflow.deserializeState()` never restores `running` / `awaitingChoice` from `localStorage` — a reload would lock the UI. **If you touch session restore on either side, preserve this.**

### Abort / stop is a distinct terminal state

`runner.stop()` aborts via an `AbortController` passed into `graph.stream`. Errors whose message matches `/abort/i` are classified as `stopped` (not `error`) and emit a `stopped` event. The client treats `stopped` as a terminal state distinct from `error` and `finished`. Don't collapse the three — `StatusPanel` and persistence depend on them being distinct.

## Conventions specific to this package

- **ESM with `.js` import specifiers** — both `tsconfig.json` files use `moduleResolution: "nodenext"`, so every relative import must end in `.js` even for `.ts`/`.tsx` sources (`from "./graph.js"`, `from "./runner.js"`). This applies to cross-package imports too: `web-ui/server/runner.ts` does `from "../../src/graph.js"`, etc.
- **Fail fast, don't throw — return `status: "failed"`** — nodes catch their own errors, log them, and return `respond(state, { phase: "failed", status: "failed", error, ... })`. The router short-circuits to `summary`. Don't let a thrown error escape `graph.stream(...)` — the web-ui's `Runner` will classify it as a crash and emit `error` instead of letting `summary` run.
- **Artifact paths via `sessionPaths(sessionDir)`** — don't hard-code filenames under `sessionDir`; use the helper in `src/session/paths.ts` so `input-context.json` / `session.json` / `test-plan.json` / `run-results.json` / `bug-report.md` / `summary.json` stay in one place. The web-ui's log path (`web-ui-logs.json`) is a separate sidecar for crash/reconnect recovery.
- **Web-ui styling is plain CSS** — no CSS-in-JS, no utility framework. Styles live in `web-ui/src/styles/globals.css` with CSS variables. Keep new styles there.
- **Graph canvas node status is computed in one place** — `QANode` expects `status: "idle" | "running" | "done" | "failed"`. The mapping from `nextNodes` / `visitedNodes` / `failed` happens inside `web-ui/src/components/GraphCanvas.tsx` — don't push status into the store or compute it in two places.

## Cross-cutting change checklists

When editing the graph, update the web-ui too:

- **Add/remove a node in `src/graph.ts`** → update `web-ui/src/state/graphLayout.ts` (`GRAPH_NODES` + `GRAPH_EDGES`).
- **Add a new `Phase` in `src/types.ts`** → add it to `PHASE_TO_NODES` in `web-ui/src/hooks/useWorkflow.ts`, or the canvas won't mark the corresponding node visited.
- **Add a new field to `QAState`** → decide whether it should live in `WorkflowSnapshot` (`web-ui/server/types.ts`) and, if so, mirror it in `toSnapshot()` in `web-ui/server/runner.ts` and `loadSession()`.
- **Add a new `WorkflowEvent` variant** → handle it in both `reduce()` (`web-ui/src/hooks/useWorkflow.ts`) and the SSE event-type list it subscribes to, and publish it from `web-ui/server/runner.ts`.
- **Change a node's logger output shape** → the per-line SSE contract is `{ node, line }`; don't emit objects. The reducer assumes `line` is a string.
- **Add a new module to `MODULE_CATALOG`** → update `qa-skills/SKILL.md` and `src/agents/playbook.ts` in the same commit.
