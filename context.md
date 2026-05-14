# HyperWright — Project Context

> **Tool Name**: HyperWright  
> **Repository**: AI-powered E2E test automation pipeline for Hyperswitch Control Center  
> **Tech Stack**: Playwright + TypeScript + LangGraph + Playwright MCP  

---

## 1. Executive Summary

HyperWright is a **LangGraph StateGraph** that automatically plans, generates, and heals Playwright E2E tests. It transforms PRs into tested PRs by:

1. **Parsing input** (PR #, module, or scenario)
2. **Bootstrapping** (cloning repo, starting FE/BE servers)
3. **Planning** (browser exploration via Playwright MCP → test-plan.json)
4. **Generating** (typed .spec.ts files + Page Objects)
5. **Healing** (auto-fix failing tests up to 3 attempts)
6. **Opening PR** (with tests, traces, and bug reports)

The name is a play on **Hyperswitch + Playwright**; "wright" also means "one who makes things right" (the healer).

---

## 2. Background: Why We Migrated from Cypress

### Before (Cypress)
- **60 tests** taking **~14 minutes** per run
- JavaScript only — no type safety
- Manual selector sourcing (slow, not scalable for AI)
- Limited parallelism (paid grid required)
- No path to AI-driven generation

### Migration to Playwright
- **60 tests** now run in **~8 minutes** (~43% faster per test)
- **TypeScript** — catches AI hallucinations at compile time
- **Native parallelism** — free, multi-worker
- **Visual regression** — pixel-level snapshots
- **Playwright MCP** — browser as a callable tool for AI agents

**Result**: Migration was a prerequisite for HyperWright. The tool couldn't exist on Cypress.

---

## 3. Architecture Overview

### Core Philosophy
HyperWright is a **stateful graph**, not a prompt chain:
- **Nodes** = discrete units (LLM calls, tool calls, deterministic TS functions)
- **Edges** = conditional routing (heal loop, re-plan, failure short-circuit)
- **Checkpointing** = state saved after every node, supports resume
- **Split responsibility** = model decides *what* to test; graph decides *flow*

### Graph Topology (10 Nodes)

```
START → setupContext ─┬─► setupBackend ─┐
                      └─► setupFrontend ─┴─► setupJoin ─► planTests
                                                             │
                          (mode === "full")                    │ (heal-only)
                   ┌────────────────┴───────────────┐          │
                   ▼                                │          │
            generateTests ──► healTests ◄───────────┴──────────┘
                                  │
                        (self-loop ≤ 3 attempts)
                                  │
                                  ▼
                        awaitUserChoice [interrupt()]
                                  │
                                  ▼
                              cleanup ──► summary ──► END
```

**Key Design**: Any node setting `status: "failed"` short-circuits straight to `summary`.

### Node Responsibilities

| Node | Type | What It Does |
|------|------|--------------|
| `setupContext` | Deterministic | Parses input (PR/module/scenario), clones repo, generates sessionId |
| `setupBackend` | Deterministic | Health-checks BE (:8080), spawns Hyperswitch if down, polls until ready |
| `setupFrontend` | Deterministic | Kills existing FE (:9000), builds, starts dev server, polls until ready |
| `setupJoin` | Deterministic | Waits for both services, fail-fast if either down |
| `planTests` | **LLM** | Uses Playwright MCP to explore live UI, outputs test-plan.json |
| `generateTests` | **LLM** | Generates typed .spec.ts + Page Objects from test plan |
| `healTests` | Mixed | Runs `playwright test`, parses failures, LLM suggests fixes, retry loop |
| `awaitUserChoice` | HITL | Interrupts graph, waits for human choice (commit/new-branch/clean) |
| `cleanup` | Deterministic | Git operations, docker compose down, kills servers, deletes artifacts |
| `summary` | Deterministic | Writes summary.json, prints final report |

### Sub-Agent Pattern

Three LLM agents (`planTests`, `generateTests`, `healTests`) use `createReactAgent` with:

**System Prompt Hierarchy** (priority order):
1. Identity line
2. `AGENT_PLAYBOOK` (condensed cheat-sheet in `src/agents/playbook.ts`)
3. Full `qa-skills/SKILL.md`
4. Role-specific `_{role}.md` (`_planner.md`, `_generator.md`, `_healer.md`)
5. Run-specific context (sessionId, target, PR diff, etc.)

**The playbook wins** when it contradicts SKILL.md — it's the load-bearing summary.

**Tools Provided**:
- **Browser tools**: Full Playwright MCP surface (`browser_navigate`, `browser_click`, `browser_snapshot`, `browser_generate_locator`, etc.)
- **Planner tools**: `planner_setup_page` (deterministic auth flow), `planner_save_plan`
- **FS tools**: `read_file`, `list_dir`

---

## 4. Technology Stack

### Core Dependencies
- **LangGraph.js** — stateful agent orchestration with checkpointing
- **Playwright** — browser automation, test runner, visual regression
- **Playwright MCP** — exposes browser as LLM-callable tools
- **TypeScript** — type-safe Page Objects, compile-time validation
- **ChatOpenAI** (via litellm proxy) — any OpenAI-compatible endpoint

### Infrastructure
- **Hono** — lightweight backend for Web UI (SSE + REST)
- **React + @xyflow/react** — Web UI frontend with live graph visualization
- **Vite** — frontend bundling with HMR
- **tsx** — TypeScript execution (no build step for CLI)

### External Integrations
- **git/gh CLI** — cloning, branching, committing, pushing, PR creation
- **docker compose** — Hyperswitch backend lifecycle
- **GitHub Actions** — CI integration (future: auto-trigger on PR)

---

## 5. Module Coverage (Current State)

**Total**: 388 specs across 25 modules  
**Passing**: 388  
**Skipped**: 68 (known flaky tests, ticketed for stabilization)

### By Category

| Category | Modules | Tests | Notes |
|----------|---------|-------|-------|
| **Auth · Homepage** | 2 | 52 | Auth (37), Homepage (15). Both 100/100 coverage. |
| **Operations** | 5 | 69 | Payments (37), Refunds (17), Customers (7). Payouts & Disputes: Q2. |
| **Processors** | 8 | 184 | Deepest coverage. 122/137 connectors exercised. |
| **Workflow · Settings** | 9 | 62 | Routing (33), Payment Settings (18), API Keys (11). |
| **Analytics** | 1 | 0 | Planned (Q2). |

### Key Metrics
- **Execution Time**: ~50 min linear, ~17 min sharded (GitHub Actions matrix)
- **Coverage Method**: Scenario-based, not line-based
- **P0 Coverage**: 53% overall (per scenario matrix)
- **Overall Coverage**: 34% (per scenario matrix)

**Important**: Coverage is measured against a **scenario matrix** (scenarios per module defined in Excel), not line coverage. This is intentional — line coverage is misleading for UI E2E when the repo bundles multiple sub-products.

---

## 6. File Structure

```
examples/playwright/                    # Root: @examples/playwright
├── README.md                           # Main documentation
├── .env.example                        # Template for all env vars
├── package.json
├── tsconfig.json
│
├── qa-skills/                          # SOURCE OF TRUTH for agents
│   ├── SKILL.md                        # Main spec
│   ├── orchestrator.md                 # Graph flow spec
│   ├── _planner.md                     # Planner agent spec
│   ├── _generator.md                   # Generator agent spec
│   └── _healer.md                      # Healer agent spec
│
├── src/
│   ├── env.ts                          # .env loader (resolves relative to file)
│   ├── llm.ts                          # ChatOpenAI factory
│   ├── state.ts                        # QAState + reducers (Annotation.Root)
│   ├── types.ts                        # TestPlan, RunResults, Phase, etc.
│   ├── config.ts                       # MODULE_CATALOG, URL constants
│   ├── routing.ts                      # Conditional edge routers
│   ├── graph.ts                        # StateGraph wiring + MemorySaver
│   └── index.ts                        # CLI entry point
│
│   ├── nodes/                          # One file per graph node
│   │   ├── setupContext.ts             # Entry: parse + clone (NOT parseInput.ts — legacy)
│   │   ├── setupBackend.ts
│   │   ├── setupFrontend.ts
│   │   ├── setupJoin.ts
│   │   ├── planTests.ts                # Calls src/agents/planner.ts
│   │   ├── generateTests.ts            # Calls src/agents/generator.ts
│   │   ├── healTests.ts                # Calls src/agents/healer.ts
│   │   ├── awaitUserChoice.ts          # Interrupt for HITL
│   │   ├── cleanup.ts
│   │   └── summary.ts
│   │
│   ├── agents/                         # LLM sub-agents
│   │   ├── playbook.ts                 # Condensed cheat-sheet (wins over SKILL.md)
│   │   ├── prompts.ts                  # System prompt assembly
│   │   ├── react.ts                    # createReactAgent wrapper
│   │   ├── planner.ts                  # Plan agent
│   │   ├── generator.ts                # Generate agent
│   │   ├── healer.ts                   # Heal agent
│   │   └── extract.ts                  # JSON/code extraction from LLM output
│   │
│   ├── tools/                          # Tools for LLM + utils
│   │   ├── browser.ts                  # 26 Playwright MCP browser_* tools
│   │   ├── browser/
│   │   │   ├── singleton.ts            # Lazy Chromium singleton
│   │   │   └── snapshot.ts             # captureSnapshot + generateLocator
│   │   ├── planner.ts                  # planner_setup_page, planner_save_plan
│   │   └── fs.ts                       # read_file, list_dir
│   │
│   ├── runtime/                        # Infrastructure utilities
│   │   ├── exec.ts                     # spawn, killByPort, killPid
│   │   ├── http.ts                     # isReachable, waitUntilReachable
│   │   ├── gh.ts                       # GitHub CLI wrappers
│   │   └── playwright.ts               # Test runner + JSON parsing
│   │
│   └── session/                        # Persistence
│       ├── paths.ts                    # Artifact path resolution
│       ├── files.ts                    # FS helpers
│       ├── sessionFile.ts              # Surgical merge-write for session.json
│       ├── respond.ts                  # respond(state, patch) pattern
│       └── log.ts                      # loggerFor (3-audit logging)
│
├── scripts/
│   └── phase-trace.ts                  # Offline graph topology test (no LLM)
│
└── web-ui/                             # @examples/playwright-web-ui
    ├── package.json
    ├── vite.config.ts                  # Proxies /api/* → Hono
    ├── index.html
    ├── server/
    │   ├── index.ts                    # Hono app (SSE + REST)
    │   ├── runner.ts                   # Singleton graph runner
    │   └── types.ts                    # WorkflowEvent, WorkflowSnapshot
    └── src/
        ├── main.tsx
        ├── App.tsx                     # Three-column layout
        ├── types.ts
        ├── hooks/
        │   └── useWorkflow.ts          # EventSource + reducer
        ├── components/
        │   ├── InputPanel.tsx          # Input + start button
        │   ├── StatusPanel.tsx         # Metrics + phase trail
        │   ├── GraphCanvas.tsx         # @xyflow/react live graph
        │   ├── QANode.tsx              # Custom node component
        │   ├── LogPanel.tsx            # Streaming logs
        │   └── HITLBar.tsx             # Commit/New-branch/Clean
        ├── state/
        │   └── graphLayout.ts          # GRAPH_NODES + GRAPH_EDGES (mirror of src/graph.ts)
        └── styles/
            └── globals.css             # Dark theme CSS variables
```

---

## 7. Critical Conventions (Must Follow)

### Import Syntax
- **ESM with `.js` extensions** — `from "./graph.js"` even for `.ts` files
- Both `tsconfig.json` use `moduleResolution: "nodenext"`
- Cross-package imports: `from "../../src/graph.js"`

### Error Handling
- **Fail fast with `status: "failed"`** — catch errors in nodes, log them, return `respond(state, { status: "failed", ... })`
- **Don't throw** — thrown errors crash the graph; `summary` won't run
- Router short-circuits `status: "failed"` straight to `summary`

### Logging (3 Audiences)
Always use `const l = loggerFor(nodeName, logs)`:
1. Pushes to local `logs` array → `state.logs` via append reducer
2. Writes to `logs/<node>.log` under session dir
3. Emits `"log"` event → SSE → Web UI

Never use `console.log` directly in nodes.

### Browser Lifecycle
- **Lazy singleton** in `src/tools/browser/singleton.ts`
- Shared across all tool calls in a run
- `browser_console_messages` and `browser_network_requests` accumulate
- `runSubAgent` calls `closeBrowser()` in `finally` block
- **Don't teach agents to call `browser_close`**

### State Updates
Always end nodes with:
```typescript
return respond(state, {
  phase: "planning-complete",
  // ... other patches
});
```

This merges patch, writes `session.json`, returns for LangGraph reducers.

### Graph/Web-UI Sync (Critical!)
When editing graph topology, update THREE mirrors:

1. **`web-ui/src/state/graphLayout.ts`** — `GRAPH_NODES` + `GRAPH_EDGES`
2. **`web-ui/src/hooks/useWorkflow.ts`** — `PHASE_TO_NODES` mapping
3. Any new `Phase` in `src/types.ts` must appear in #2

Failure to sync causes canvas to show wrong node states.

---

## 8. Environment Variables

Copy `.env.example` → `.env` and configure:

### Required (LLM Provider)
```ini
LITELLM_BASE_URL=http://localhost:4000/v1
LITELLM_MODEL=anthropic/claude-sonnet-4-5
LITELLM_API_KEY=sk-litellm-master-key
LITELLM_TEMPERATURE=0
LITELLM_MAX_TOKENS=4096
```

### Required (Hyperswitch Stack)
```ini
HYPERSWITCH_HEALTH_URL=http://localhost:8080/health
HYPERSWITCH_START_SCRIPT=playwright-tests/start_hyperswitch.sh
HYPERSWITCH_STOP_CWD=hyperswitch
BACKEND_START_TIMEOUT_MS=240000
BACKEND_POLL_STEP_MS=5000
```

### Required (Frontend)
```ini
FRONTEND_URL=http://localhost:9000
FRONTEND_PORT=9000
FRONTEND_BUILD_CMD=npm run re:start
FRONTEND_START_CMD=npm run start
FRONTEND_START_TIMEOUT_MS=240000
FRONTEND_POLL_STEP_MS=5000
```

### Required (Paths)
```ini
GENERATED_TESTS_DIR=playwright-tests/ai-generated
EXISTING_TESTS_DIR=playwright-tests/e2e
PAGE_OBJECTS_DIR=playwright-tests/support/pages
PLAYWRIGHT_PASSWORD=Test@123456
```

### Optional
```ini
ENABLE_BROWSER_TOOLS=1          # Set 0 to skip Chromium (faster dev)
OUT_PREFIX=.out                 # Redirect artifacts to .out/ subdirectory
WEB_UI_PORT=7800                # Hono backend port
BACKEND_URL=http://localhost:7800  # Vite proxy target
```

---

## 9. Commands

### Root Package (`examples/playwright/`)

```bash
# Full pipeline demo (plan → generate → heal → HITL → cleanup)
npx tsx src/index.ts full [commit|new-branch|clean]

# Heal-only demo (plan → heal → HITL → cleanup)
npx tsx src/index.ts heal [commit|new-branch|clean]

# Offline topology check (no LLM required)
npx tsx scripts/phase-trace.ts

# Aliases
pnpm demo:full
pnpm demo:heal
```

### Web UI (`examples/playwright/web-ui/`)

```bash
# Dev mode (Hono + Vite concurrently)
pnpm dev

# Individual servers
pnpm dev:server     # Hono on :7800
pnpm dev:client     # Vite on :5173

# Production
pnpm build          # Bundle to dist/
BACKEND_URL=http://localhost:7800 pnpm start
```

---

## 10. HITL (Human-in-the-Loop) Protocol

When `awaitUserChoice` triggers:
1. Graph calls `interrupt(...)` with summary
2. **CLI**: User sees prompt, types choice
3. **Web UI**: UI shows HITLBar with 3 buttons
4. Resume with: `new Command({ resume: "commit" | "new-branch" | "clean" })`

**Cleanup Logic**:
- `commit` → `git add / commit / push` (only honored for PR targets)
- `new-branch` → `git checkout -b pw/{target}-{ts} / add / commit / push`
- `clean` → `rm -rf` artifacts, kill servers, docker compose down

Note: `commit` is rewritten to `new-branch` unless `targetType` is `pr` or `branch`.

---

## 11. Use Cases

1. **Generate-before-merge** — Dev opens PR, HyperWright adds tests before review
2. **Backfill merged PRs** — Walk history, generate tests in batches
3. **Module-level drives** — Target entire module (e.g., Payouts), get full matrix
4. **Regression triage** — Suite fails in CI, healer diagnoses real bugs vs selector drift
5. **Connector onboarding** — New processor → auto-generate connector-shaped E2E pack
6. **Visual baseline refresh** — One command to regenerate baselines after intentional UI changes

---

## 12. Roadmap

- [ ] Close zero-coverage modules (Payouts, Disputes, Surcharge, 3DS Exemption, Payout Routing, Webhooks, Analytics)
- [ ] Increase visual testing coverage with auto-mask suggestions
- [ ] Auto-trigger on PR open (GitHub bot)
- [ ] Connector pack auto-generation on processor onboard
- [ ] Session resumption (continue failed runs from checkpoint)
- [ ] Restart from any node (iterate on Plan/Generate/Heal without full re-run)

---

## 13. Troubleshooting Guide

| Issue | Solution |
|-------|----------|
| Planning failed 404 | Check `LITELLM_BASE_URL` responds to POST /chat/completions |
| Planning failed 401 | Verify API key matches litellm proxy master key |
| Backend didn't come up | Verify Hyperswitch running or set `HYPERSWITCH_START_SCRIPT=true` (no-op) |
| Frontend build failed | Override `FRONTEND_BUILD_CMD` / `FRONTEND_START_CMD` for your setup |
| Run hangs 2+ min | Lower `*_TIMEOUT_MS` for quick iteration |
| "Executable doesn't exist" | `npx playwright install chromium` or set `ENABLE_BROWSER_TOOLS=0` |
| Graph ends `status=failed` | Check `session.json.error` and per-node logs |
| Git push exit=128 | Use `clean` instead, or configure git upstream |

---

## 14. Key Files for AI Assistants

When modifying behavior, check these in order:

1. **`qa-skills/*.md`** — Spec source of truth
2. **`src/agents/playbook.ts`** — Condensed cheat-sheet (overrides spec)
3. **`src/agents/prompts.ts`** — Prompt assembly logic
4. **`src/agents/{planner,generator,healer}.ts`** — Agent implementations
5. **`src/nodes/*.ts`** — Node implementations
6. **`src/config.ts`** — Module catalogue (must sync with playbook.ts + SKILL.md)

**Cross-cutting checklist**: When editing graph, update web-ui mirrors in `graphLayout.ts` and `useWorkflow.ts`.

---

## 15. References

- **Presentation**: `presentation.html` (slides with metrics)
- **Speaker Script**: `script.md` (detailed narration for each slide)
- **Requirements**: `ppt.txt` (original requirements that drove the build)
- **Claude Guidance**: `CLAUDE.md` (this file — engineering conventions)

---

*Last updated*: Based on repo state at merge of web-ui/README.md into main README.md  
*Maintainer*: Engineering team, Hyperswitch Control Center  
*Status*: Active development, 388 tests in production
