# Playwright QA Pipeline — as a LangGraph

A runnable **LangGraph StateGraph** that implements the four-agent Playwright
QA automation pipeline specified in `qa-skills/` (SKILL.md, orchestrator.md,
\_planner.md, \_generator.md, \_healer.md).

Every node performs its real side-effect from the spec — no stubs:

- **setupBackend** actually health-checks `:8080` and spawns the Hyperswitch
  start script if down.
- **setupFrontend** actually kills `:9000`, runs the build, spawns the dev
  server, and polls until reachable.
- **planTests / generateTests / healTests** actually call an LLM (via any
  OpenAI-compatible endpoint — litellm proxy, OpenAI, Anthropic via litellm,
  OpenRouter, local Ollama, etc.).
- **healer** actually runs `npx playwright test --reporter=json`, parses the
  output, and applies surgical edits the LLM proposes.
- **cleanup** actually runs `git checkout -b / add / commit / push`, `rm -f`,
  `kill`, and `docker compose down -v`.
- **awaitUserChoice** pauses via LangGraph `interrupt()` and resumes when the
  caller passes `new Command({ resume: "commit" | "new-branch" | "clean" })`.

**Two ways to drive it:**

- CLI: `npx tsx src/index.ts full|heal [commit|new-branch|clean]`
- Web UI: a dark-themed React cockpit at `web-ui/` — live graph of all 10
  nodes, pulsing current node, per-node logs on click, service/phase/metrics
  sidebar, HITL buttons. See [`web-ui/README.md`](./web-ui/README.md).

---

## Prerequisites

- **Node.js ≥ 20** (native `fetch`, `AbortSignal.timeout`, crypto.randomUUID).
- **pnpm** (workspace manager used by the LangGraph.js monorepo).
- **git** (used by cleanup).
- **`gh` CLI** *(optional, only needed for PR-number targets)* — `parseInput` shells out to `gh pr view` + `gh pr diff` to enrich the planner's context with the real PR title / body / diff. Without it, PR targets still work but the LLM only sees the number.
- **Playwright browsers** — installed on demand by Playwright when the browser
  tools first boot a Chromium session. The package dep pulls the driver in; if
  Chromium is missing run `npx playwright install chromium` once.
- **An OpenAI-compatible LLM endpoint** for the three AI agents. Recommended:
  a local [litellm](https://github.com/BerriAI/litellm) proxy, but any
  OpenAI-compatible provider works.
- *(Optional, only if you actually want to run a real Playwright suite against
  the real dashboard)* — a checked-out Hyperswitch + dashboard repo with
  `playwright-tests/start_hyperswitch.sh`, `npm run re:start`, and
  `npm run start` available from the cwd you run the graph from.

---

## Quick start

```bash
# From the repo root:
pnpm install                          # installs @examples/playwright + deps
cd examples/playwright

# 1. Provider config
cp .env.example .env
#    edit .env → set LITELLM_BASE_URL / LITELLM_MODEL / LITELLM_API_KEY

# 2. (first time only) install a Chromium for the browser tools
npx playwright install chromium

# 3. Run the pipeline
npx tsx src/index.ts full clean       # plan → generate → heal → HITL → cleanup
npx tsx src/index.ts heal clean       # heal-only: plan → heal → HITL → cleanup

# 4. Verify the state machine transitions (no LLM needed)
npx tsx scripts/phase-trace.ts

# …or drive it from the web UI (live graph, per-node logs, HITL buttons):
cd web-ui && pnpm install && pnpm dev  # http://localhost:5173
```

After a run, every spec-required artifact is on disk:

```
.opencode/sessions/playwright-run/
  input-context.json
  session.json
  test-plan.json
  run-results.json
  bug-report.md          # only if failures remain after healing
  summary.json
playwright-tests/ai-generated/
  module-payments.spec.ts  (or PR-123-generated.spec.ts, scenario-*.spec.ts)
```

---

## Step 1 — Install

```bash
# From repo root
pnpm install
```

This pulls in the example-local deps (`@langchain/openai`, `@langchain/langgraph`,
`playwright`, `dotenv`, `zod`, `tsx`) through the monorepo workspace.

---

## Step 2 — Configure `.env`

Copy the template and set three required fields.

```bash
cd examples/playwright
cp .env.example .env
```

The agents talk to any OpenAI-compatible endpoint. Pick **one** of the
following recipes.

### Option A — local litellm proxy (recommended)

```ini
LITELLM_BASE_URL=http://localhost:4000/v1
LITELLM_MODEL=anthropic/claude-sonnet-4-5
LITELLM_API_KEY=sk-litellm-master-key
```

Start the proxy separately: `litellm --model anthropic/claude-sonnet-4-5`.

### Option B — direct OpenAI

```ini
LITELLM_BASE_URL=https://api.openai.com/v1
LITELLM_MODEL=gpt-4o
LITELLM_API_KEY=sk-...
```

### Option C — OpenRouter / Groq / Together / Anthropic-via-litellm

Use the provider's OpenAI-compatible base URL and model name. Same three env
vars.

### Full env var reference

| Variable                     | Default                                            | Meaning                                                              |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `LITELLM_BASE_URL`           | `http://localhost:4000/v1`                         | OpenAI-compatible base URL for all three agents                      |
| `LITELLM_API_KEY`            | `sk-placeholder`                                   | Bearer token passed as `Authorization: Bearer …`                     |
| `LITELLM_MODEL`              | `anthropic/claude-sonnet-4-5`                      | Model slug                                                           |
| `LITELLM_TEMPERATURE`        | `0`                                                | Sampling temperature                                                 |
| `LITELLM_MAX_TOKENS`         | `4096`                                             | Max completion tokens                                                |
| `HYPERSWITCH_HEALTH_URL`     | `http://localhost:8080/health`                     | Backend health URL (checked by `setupBackend`)                       |
| `HYPERSWITCH_START_SCRIPT`   | `playwright-tests/start_hyperswitch.sh`            | Script spawned if backend is down                                    |
| `HYPERSWITCH_STOP_CWD`       | `hyperswitch`                                      | `cwd` for `docker compose down -v` during cleanup                    |
| `BACKEND_START_TIMEOUT_MS`   | `240000`                                           | How long to wait for backend to become reachable                     |
| `BACKEND_POLL_STEP_MS`       | `5000`                                             | Poll interval while waiting                                          |
| `FRONTEND_URL`               | `http://localhost:9000`                            | Dashboard URL                                                        |
| `FRONTEND_PORT`              | `9000`                                             | Port to kill before restarting the frontend                          |
| `FRONTEND_BUILD_CMD`         | `npm run re:start`                               | Synchronous build step                                               |
| `FRONTEND_START_CMD`         | `npm run start`                               | Detached start command                                               |
| `FRONTEND_START_TIMEOUT_MS`  | `240000`                                           | How long to wait for frontend                                        |
| `FRONTEND_POLL_STEP_MS`      | `5000`                                             | Poll interval                                                        |
| `GENERATED_TESTS_DIR`        | `playwright-tests/ai-generated`                    | Where `.spec.ts` files land                                          |
| `EXISTING_TESTS_DIR`         | `playwright-tests/e2e`                             | Dir the planner/generator reference for existing patterns            |
| `PAGE_OBJECTS_DIR`           | `playwright-tests/support/pages`                   | Page Object Model dir                                                |
| `PLAYWRIGHT_PASSWORD`        | `Test@123456`                                      | Test user password injected into generated specs                     |
| `ENABLE_BROWSER_TOOLS`       | `1`                                                | `0` disables the Playwright browser tools (faster, no Chromium)      |
| `OUT_PREFIX`                 | `""`                                               | Prefix for `session`/`tests` paths — set to `.out` for isolated runs |

---

## Step 3 — (Optional) bring up the Hyperswitch stack

Skip this section if you only want to see the graph topology / phase
transitions / LLM planner output against a stubbed frontend.

The spec assumes the pipeline runs from inside a cloned Hyperswitch dashboard
repo where these are available from `$PWD`:

- `playwright-tests/start_hyperswitch.sh`
- `npm run re:start` and `npm run start`
- A docker-compose Hyperswitch backend in `./hyperswitch/`

If those aren't there, `setupBackend` and `setupFrontend` will fail-fast after
their timeout budgets and `summary` will report `status=failed`.

For local iteration without the real stack, point the env vars at any test
server you already have running:

```ini
HYPERSWITCH_HEALTH_URL=http://localhost:3000/
HYPERSWITCH_START_SCRIPT=true         # no-op command
FRONTEND_URL=http://localhost:3001/
FRONTEND_BUILD_CMD=true
FRONTEND_START_CMD=true
BACKEND_START_TIMEOUT_MS=3000
FRONTEND_START_TIMEOUT_MS=3000
```

---

## Step 4 — Run the pipeline

Two modes, three cleanup choices:

```bash
# full mode: plan → generate → heal → HITL → cleanup
npx tsx src/index.ts full clean
npx tsx src/index.ts full new-branch
npx tsx src/index.ts full commit      # only honours "commit" for PR targets

# heal-only mode: plan → heal → HITL → cleanup
npx tsx src/index.ts heal clean
```

The demo driver hard-codes two example inputs:

- `full`  → `"generate tests for module: payments"`
- `heal`  → `"heal failing tests for module: payments"`

To drive the graph yourself:

```ts
import { Command } from "@langchain/langgraph";
import { buildGraph } from "./src/graph.js";

const graph = buildGraph();
const config = { configurable: { thread_id: "my-run" } };

// 1. Start the pipeline
await graph.invoke(
  {
    rawInput: "generate tests for PR #1234",
    sessionDir: ".opencode/sessions/playwright-run",
    testsDir: "playwright-tests/ai-generated",
  },
  config,
);

// 2. The graph pauses at `awaitUserChoice`. Resume it:
await graph.invoke(new Command({ resume: "new-branch" }), config);
```

---

## What each node does (spec → code)

| Node                | Spec                        | Concrete side effects                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseInput`        | orchestrator §1             | Detect mode (`full` / `heal-only`) from the user message, parse target (PR # / module / scenario), for PR targets shell out to `gh pr view` + `gh pr diff` to attach real PR context, generate sessionId, write `input-context.json` + initial `session.json`               |
| `setupBackend`      | orchestrator §2 (backend)   | `fetch($HYPERSWITCH_HEALTH_URL)`. If non-200, `spawn("sh", [$HYPERSWITCH_START_SCRIPT])`, poll every `BACKEND_POLL_STEP_MS` for up to `BACKEND_START_TIMEOUT_MS`                                                                                                            |
| `setupFrontend`     | orchestrator §2 (frontend)  | If `$FRONTEND_URL` is up, `lsof -ti:$FRONTEND_PORT \| xargs kill` (SIGTERM, then -9). Run `$FRONTEND_BUILD_CMD` synchronously. Spawn `$FRONTEND_START_CMD` detached, capture PID. Poll up to `FRONTEND_START_TIMEOUT_MS`                                                    |
| `setupJoin`         | orchestrator §2 (verify)    | Verify both flags. Fail-fast if either service is still down                                                                                                                                                                                                               |
| `planTests`         | \_planner.md §3             | `createReactAgent` with SKILL.md + \_planner.md as system prompt, Playwright browser tools + fs tools. LLM returns JSON. Written to `test-plan.json`                                                                                                                       |
| `generateTests`     | \_generator.md §4 (Full)    | ReAct agent with \_generator.md. LLM returns a fenced ```typescript``` block. Written to `playwright-tests/ai-generated/{name}.spec.ts`                                                                                                                                    |
| `healTests` (loop)  | \_healer.md §5              | `npx playwright test {file} --reporter=json`, parse into `RunResults`, write `run-results.json`. If failures remain, call LLM with \_healer.md + failing file + failures JSON, ask for `{find, replace}` edits, apply them surgically. Loop ≤ `maxHealingAttempts` (3)     |
| `awaitUserChoice`   | orchestrator §6C            | LangGraph `interrupt()` with a summary. Caller resumes with `new Command({ resume: "commit"\|"new-branch"\|"clean" })`                                                                                                                                                     |
| `cleanup`           | orchestrator §6C (execute)  | Real `git checkout -b pw/{target}-{ts}` / `git add` / `git commit` / `git push`, or `rm -f $testsDir/*.spec.ts` + `rm -rf $sessionDir`. Always kill `frontendPid` if we started it, and `cd $HYPERSWITCH_STOP_CWD && docker compose down -v` if we started the backend     |
| `summary`           | orchestrator §6B            | Write `summary.json` matching orchestrator §6B schema, print the TEST RUN SUMMARY banner                                                                                                                                                                                   |

---

## Artifacts produced on every run

Paths are `{OUT_PREFIX}{sessionDir|testsDir}/…`. Defaults match SKILL.md.

| File                                                   | Schema source             | Written by                          |
| ------------------------------------------------------ | ------------------------- | ----------------------------------- |
| `.opencode/sessions/playwright-run/input-context.json` | orchestrator §1           | `parseInput`                        |
| `.opencode/sessions/playwright-run/session.json`       | orchestrator §1           | every node (surgical merge-write)   |
| `.opencode/sessions/playwright-run/test-plan.json`     | \_planner.md §3.6         | `planTests`                         |
| `.opencode/sessions/playwright-run/run-results.json`   | \_healer.md §5.1, §5.8    | `healTests` (each attempt)          |
| `.opencode/sessions/playwright-run/bug-report.md`      | \_healer.md §5.8          | `healTests` (only if failures left) |
| `.opencode/sessions/playwright-run/summary.json`       | orchestrator §6B          | `summary`                           |
| `playwright-tests/ai-generated/{name}.spec.ts`         | \_generator.md §4.4       | `generateTests`                     |

### Filename convention (SKILL.md)

- **PR target** → `PR-{number}-generated.spec.ts`
- **Module target** → `module-{name}.spec.ts`
- **Scenario target** → `scenario-{slug}.spec.ts`

### Module catalogue

`src/config.ts` encodes the SKILL.md Module-to-URL table for all 14 modules:

| Module              | URL                             | Prerequisites               |
| ------------------- | ------------------------------- | --------------------------- |
| `auth`              | `/dashboard/login`              | —                           |
| `home`              | `/dashboard/home`               | User                        |
| `payments`          | `/dashboard/payments`           | User + Connector            |
| `refunds`           | `/dashboard/refunds`            | User + Connector + Payment  |
| `disputes`          | `/dashboard/disputes`           | User + Connector + Payment  |
| `connectors`        | `/dashboard/connectors`         | User                        |
| `payout-connectors` | `/dashboard/payout-connectors`  | User                        |
| `routing`           | `/dashboard/routing`            | User + Connector            |
| `customers`         | `/dashboard/customers`          | User + Payments             |
| `analytics`         | `/dashboard/analytics-payments` | User + Connector + Payments |
| `users`             | `/dashboard/users`              | User (admin)                |
| `api-keys`          | `/dashboard/developer-api-keys` | User                        |
| `webhooks`          | `/dashboard/webhooks`           | User                        |
| `settings`          | `/dashboard/settings`           | User                        |

The planner injects the right API helpers (`signupUser`,
`createDummyConnectorAPI`, `createPaymentAPI`) into `preconditions.apiHelpers`
based on the target.

---

## Tool inventory (what the LLM can call)

Every agent gets `read_file` / `list_dir` plus the full Playwright-MCP
`browser_*` surface. The planner additionally gets two domain tools.

### Browser tools — `src/tools/browser.ts`

| Group        | Tool                              | Purpose                                                               |
| ------------ | --------------------------------- | --------------------------------------------------------------------- |
| Navigation   | `browser_navigate`                | Goto URL (waits for networkidle)                                      |
|              | `browser_navigate_back`           | Back button                                                           |
| Interaction  | `browser_click`                   | Click a selector                                                      |
|              | `browser_hover`                   | Hover                                                                 |
|              | `browser_type`                    | Fill an input                                                         |
|              | `browser_select_option`           | Select dropdown option(s)                                             |
|              | `browser_press_key`               | Keyboard (optionally focused on a selector)                           |
|              | `browser_drag`                    | Drag source → target                                                  |
|              | `browser_file_upload`             | Attach files to `<input type="file">`                                 |
|              | `browser_wait_for`                | Wait for selector state / text / networkidle                          |
|              | `browser_handle_dialog`           | Pre-arm accept/dismiss for the next JS dialog                         |
| Inspection   | `browser_snapshot`                | Condensed interactive-element list (URL, title, selectors)            |
|              | `browser_generate_locator`        | Best Playwright locator per SKILL.md §Selector Strategy               |
|              | `browser_console_messages`        | Last 50 `console.*` lines                                             |
|              | `browser_network_requests`        | Recent requests/responses, optionally filtered by URL substring       |
|              | `browser_evaluate`                | Run JS expression in page context                                     |
|              | `browser_run_code`                | Run a multi-line JS block (same engine, wider intent)                 |
|              | `browser_take_screenshot`         | Screenshot to disk                                                    |
| Verification | `browser_verify_element_visible`  | Is selector visible?                                                  |
|              | `browser_verify_list_visible`     | ✓/✗ table across many selectors                                       |
|              | `browser_verify_text_visible`     | Is text present?                                                      |
|              | `browser_verify_value`            | Input value matches expected?                                         |
| Storage      | `browser_cookie_get`              | Read cookies (optionally by name / URL)                               |
|              | `browser_storage_state`           | Dump full storage state                                               |
|              | `browser_set_storage_state`       | Inject cookies (pre-auth)                                             |
| Lifecycle    | `browser_close`                   | Close the shared browser (the graph also auto-closes after each run)  |

The Chromium process is a lazy singleton shared across all tool calls in a
run, so `console` and `network` logs are cumulative and survive tool
invocations.

### Planner-scoped tools — `src/tools/planner.ts`

| Tool                   | Behaviour                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `planner_setup_page`   | Full auth flow from SKILL.md in one deterministic call: (1) if already logged in on `/dashboard/home`, log out first; (2) POST to `signup_with_merchant_id`; (3) navigate to `/dashboard/login`; (4) fill email + password (tolerates `label`/`placeholder`/`data-testid` variants); (5) click Continue (`"continue"` / `"sign in"` / `"log in"` / submit button); (6) skip 2FA (`"skip now"` / `"skip"` / `"later"`); (7) navigate to `targetPath`. Returns a step-by-step diagnostic log so the LLM sees exactly what happened. |
| `planner_save_plan`    | Write the finished test plan JSON to the current run's `sessionDir/test-plan.json`. Preferred over returning JSON in the final message.          |

**All three agents** (planner, generator, healer) receive `planner_setup_page`
— `plannerToolsFor(cfg)` for the planner (which also gets `planner_save_plan`),
`sharedAuthToolsFor(cfg)` for generator + healer. None of them should ever
stitch `navigate → type → click → click` by hand for login; the playbook at
the top of their system prompt tells them to call `planner_setup_page` first.

---

## Graph topology

```
  START → parseInput ─┬─► setupBackend ─┐
                      └─► setupFrontend ─┴─► setupJoin ─► planTests
                                                              │
                              (mode === "full")               │ (heal-only)
                       ┌────────────────┴───────────────┐     │
                       ▼                                │     │
                generateTests ──► healTests ◄───────────┴─────┘
                                      │
                            (loop if failed>0 && attempts<3)
                                      │
                                      ▼
                            awaitUserChoice  [interrupt()]
                                      │
                                      ▼
                                  cleanup ──► summary ──► END
```

Any node that sets `status: "failed"` short-circuits straight to `summary`
(see `src/routing.ts`).

---

## Phase state machine

Matches SKILL.md §"State Machine" exactly. Observable two ways:
- returned state: `state.phaseHistory` (a `Phase[]` appended on every node)
- persisted: `session.json.phase` (surgical merge-write on every transition)

| Mode          | Flow                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Full**      | `parse` → `setup` → `planning` → `planning-complete` → `generating` → `generating-complete` → `healing` → `healing-complete` → `awaiting-user-choice` → `cleanup` → `complete` |
| **Heal-Only** | `parse` → `setup` → `planning` → `planning-complete` → `healing` → `healing-complete` → `awaiting-user-choice` → `cleanup` → `complete`                                        |

Verify with `npx tsx scripts/phase-trace.ts` (does not require an LLM; uses
the demo driver with a stubbed HITL resume).

---

## LangGraph features exercised

| Feature             | Where                                                                |
| ------------------- | -------------------------------------------------------------------- |
| Typed state         | `src/state.ts` — `Annotation.Root` with merge / append / last-wins   |
| Parallel nodes      | `parseInput` → `setupBackend` + `setupFrontend` → `setupJoin`        |
| Conditional branch  | `planTests` → `generateTests` (full) \| `healTests` (heal-only)      |
| Loop with max N     | `healTests` self-loop bounded by `maxHealingAttempts=3`              |
| Sub-agents          | `createReactAgent` in `src/agents/{planner,generator,healer}.ts`     |
| Tool binding        | `src/tools/{browser,fs}.ts` — Playwright browser + fs tools for LLMs |
| Human-in-the-loop   | `awaitUserChoice` uses `interrupt()` + `MemorySaver` checkpointer    |
| Failure short-circ. | Any node sets `status:"failed"` → router skips to `summary`          |
| Checkpointing       | `MemorySaver` on the compiled graph so `Command({ resume })` works   |

---

## File layout

```
examples/playwright/
  README.md
  .env.example               # template for provider + runtime config
  package.json               # "@examples/playwright"
  tsconfig.json

  qa-skills/                 # SOURCE SPECS — the graph implements these
    SKILL.md
    orchestrator.md
    _planner.md
    _generator.md
    _healer.md

  src/
    env.ts                   # .env loader + typed ENV object
    llm.ts                   # ChatOpenAI factory (OpenAI-compatible → litellm / OpenAI / …)
    state.ts                 # Annotation.Root, reducers, phaseHistory
    types.ts                 # TestPlan / RunResults / SessionFile / SummaryFile / …
    config.ts                # Module catalogue, filename conventions, URL consts
    routing.ts               # Conditional-edge routers
    graph.ts                 # StateGraph wiring + MemorySaver compile
    index.ts                 # Demo entry: full / heal × commit / new-branch / clean

    nodes/                   # One file per graph node
      parseInput.ts
      setupBackend.ts
      setupFrontend.ts
      setupJoin.ts
      planTests.ts
      generateTests.ts
      healTests.ts
      awaitUserChoice.ts
      cleanup.ts
      summary.ts

    agents/                  # Real LLM sub-agents (planner / generator / healer)
      playbook.ts            #   compact cheat-sheet injected atop every prompt
      prompts.ts             #   composes playbook + qa-skills/*.md into system prompt
      react.ts               #   wraps createReactAgent with shared tools
      planner.ts             #   _planner.md
      generator.ts           #   _generator.md
      healer.ts              #   _healer.md
      extract.ts             #   pulls JSON / fenced code from LLM output

    tools/
      browser.ts             # 26 Playwright-MCP browser_* tools
      browser/
        singleton.ts         #   lazy Chromium + console/network/dialog event capture
        snapshot.ts          #   captureSnapshot + generateLocator (SKILL.md selector strategy)
      planner.ts             # planner_save_plan (planner-only) + planner_setup_page (shared by all three agents via sharedAuthToolsFor)
      fs.ts                  # read_file / list_dir tools (for reading SKILL.md etc.)

    runtime/
      exec.ts                # spawn / sh / killByPort / killPid helpers
      http.ts                # isReachable / waitUntilReachable polling
      gh.ts                  # `gh pr view` + `gh pr diff` → PullRequestInfo
      playwright.ts          # `npx playwright test --reporter=json` runner + JSON → RunResults

    session/
      paths.ts               # resolve every artifact path from sessionDir
      files.ts               # ensureDir, readJson, writeJson, writeText
      sessionFile.ts         # surgical merge-write for session.json
      respond.ts             # respond(state, patch) — collapses patch+writeSession+return

  scripts/
    phase-trace.ts           # offline: prints full and heal-only phase flows

  web-ui/                    # dark-themed React cockpit — see web-ui/README.md
    server/                  #   Hono + SSE (start / status / stream / resume)
    src/                     #   React + @xyflow/react live graph canvas
```

---

## Troubleshooting

| Symptom                                                           | Likely cause                                                               | Fix                                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Planning failed: 404 Cannot POST /v1/chat/completions`           | `LITELLM_BASE_URL` is wrong or no proxy is running                         | Verify the base URL responds to `POST /chat/completions`; set OpenAI-direct creds as a sanity check                              |
| `Planning failed: 401`                                            | `LITELLM_API_KEY` is not accepted by the provider                          | Confirm the key, or that the litellm proxy master key matches                                                                    |
| `Backend did not come up at http://localhost:8080/health`         | No Hyperswitch running and `HYPERSWITCH_START_SCRIPT` doesn't exist        | Either run Hyperswitch, or set `HYPERSWITCH_HEALTH_URL` / `HYPERSWITCH_START_SCRIPT` to something reachable + a no-op            |
| `Frontend build failed (exit 1)`                                  | `$FRONTEND_BUILD_CMD` (default: `npm run re:start`) isn't a valid script | Override `FRONTEND_BUILD_CMD` / `FRONTEND_START_CMD` for your setup                                                              |
| Run hangs for 2+ minutes during setup                             | Default `BACKEND_START_TIMEOUT_MS=240000`                                  | Lower `BACKEND_START_TIMEOUT_MS` / `FRONTEND_START_TIMEOUT_MS` for quick iteration                                               |
| "browser.launch: Executable doesn't exist" at the planner step    | Playwright Chromium not installed                                          | `npx playwright install chromium`, or set `ENABLE_BROWSER_TOOLS=0` to skip browser exploration                                   |
| Graph never reaches `awaitUserChoice` — ends with `status=failed` | A previous node failed; `summary.json.status === "failed"` with the error  | Inspect `session.json.error` and the `logs` field in the state for the node that tripped                                         |
| Cleanup says `✗ exit=128` on `git push`                           | No upstream / not in a git repo / offline                                  | Use `clean` instead of `new-branch` / `commit`, or configure the repo                                                            |
| PR-number target runs but planner knows nothing about the PR      | `gh` CLI missing or not authed                                             | Install GitHub CLI and `gh auth login`, or hand-feed the diff via `rawInput`                                                     |

---

## How the AI agents actually talk to the LLM

**Only three nodes call the LLM: `planTests`, `generateTests`, `healTests`.**
Everything else — `parseInput` (incl. the `gh pr` fetch), `setupBackend`,
`setupFrontend`, `setupJoin`, `awaitUserChoice`, `cleanup`, `summary` — is
pure deterministic code (`child_process`, `fetch`, `fs`, Playwright's own
test runner).

1. `src/env.ts` loads `.env` via `dotenv` into a strongly-typed `ENV` object.
2. `src/llm.ts` wraps `ChatOpenAI` with `configuration.baseURL` = `ENV.litellm.baseURL`, so any OpenAI-compatible endpoint works without provider-specific code.
3. `src/agents/react.ts` uses LangGraph's `createReactAgent` with:
   - **System prompt** (in priority order): agent identity → `src/agents/playbook.ts` (a compact cheat-sheet distilled from all four qa-skills/*.md: auth recipe, module-URL map, selector priority, common gotchas, file-naming rules) → full `qa-skills/SKILL.md` → agent-specific `_<role>.md` → per-run context (sessionId, target, PR title/body/diff, test plan, failures, etc.). The playbook deliberately appears **above** the full markdown so the critical facts can't be skimmed past.
   - **Tools**: `read_file` / `list_dir` (always), the full Playwright browser tool surface when `ENABLE_BROWSER_TOOLS=1`, `planner_setup_page` for all three agents (shared auth helper so login is never manually stitched), `planner_save_plan` for the planner only.
4. Each agent (`planner.ts`, `generator.ts`, `healer.ts`) calls `runSubAgent(...)`, then either reads the tool-written artifact (planner preferred) or extracts a fenced ```json``` / ```typescript``` block with `src/agents/extract.ts`.
5. The graph **never sees the LLM directly** — it only sees the parsed output (TestPlan JSON, spec-file string, fix-edits JSON). Swapping providers is a one-line `.env` change.
6. If the LLM produces invalid output, the agent **throws** — there are no silent fallbacks. The graph maps the throw to `status: "failed"` and `summary` reports it.

---

## Running without the LLM (offline smoke test)

The state machine and graph wiring can be verified without any provider at
all:

```bash
npx tsc --noEmit         # typecheck
npx tsx scripts/phase-trace.ts
```

`phase-trace.ts` drives the graph with a stubbed interrupt resume. If your
`LITELLM_*` vars don't point at a real endpoint, the planner will fail-fast
with an HTTP error and the graph will short-circuit through `summary` — the
phase history still verifies correctly since `parse`, `setup`, and the
failure-path transitions all fire.
