# HyperWright

> AI-powered QA pipeline that plans, generates, and heals Playwright tests

<!-- SCREENSHOT_PLACEHOLDER: Hero GIF showing Web UI in action -->

## Overview

HyperWright transforms PRs into tested PRs. It's a **LangGraph StateGraph** that orchestrates LLM agents to:

1. **Plan** — Explore your UI via Playwright MCP to discover selectors
2. **Generate** — Create typed Playwright tests (+ Page Objects)
3. **Heal** — Auto-fix failing tests (up to 3 attempts)
4. **Ship** — Open companion PR with tests, traces, and bug reports

### Why We Built It

| Before (Cypress) | After (HyperWright) |
|------------------|---------------------|
| 60 tests, 14 min | **388 tests, 8 min** (-43%) |
| Manual selectors | **AI-discovered selectors** |
| No type safety | **TypeScript + compile-time validation** |
| Broken tests pile up | **Self-healing with MCP** |

## Quick Start

```bash
# Install
pnpm install
npx playwright install chromium
cp .env.example .env
# Edit .env with your LLM credentials

# Run full pipeline
npx tsx src/index.ts full clean

# Or launch Web UI
cd web-ui && pnpm dev
```

## Architecture

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  Input  │───▶│  Setup  │───▶│  Plan   │───▶│ Generate│
└─────────┘    └─────────┘    │ (LLM)   │    │ (LLM)   │
                              └─────────┘    └────┬────┘
                                                  │
┌─────────┐    ┌─────────┐    ┌─────────┐        │
│  Ship   │◀───│ Cleanup │◀───│   HITL  │◀───────┼────┐
│  (PR)   │    │         │    │ (Pause) │        │    │
└─────────┘    └─────────┘    └─────────┘        │    │
                                                 ▼    │
                                          ┌─────────┐ │
                                          │  Heal   │─┘ (retry ≤3)
                                          │(Run+Fix)│
                                          └─────────┘
```

**Key insight**: The model decides *what* to test. The graph decides *flow* — with checkpointing, branching, and healing loops.

## Features

### 🤖 LLM-Powered Agents

- **Planner** — Uses Playwright MCP to explore live UI, source real selectors
- **Generator** — Outputs typed `.spec.ts` + Page Objects following project conventions
- **Healer** — Diagnoses failures via traces, proposes surgical fixes

### 🎨 Interactive Web UI

<!-- SCREENSHOT_PLACEHOLDER: Web UI showing live graph -->

Dark-themed React + Hono dashboard featuring:
- Live graph visualization (nodes pulse during execution)
- Per-node streaming logs
- Real-time metrics & HITL controls

```bash
cd web-ui && pnpm dev  # http://localhost:5173
```

### 📊 Self-Healing Tests

```
Test fails → Capture trace → LLM analyzes → Proposes fix → Applies edit → Re-runs
     ↑___________________________________________________________________________│
                                    (up to 3 attempts)
```

If healing fails, the PR still ships with `bug-report.md` — failures never disappear.

## Usage

### CLI

```bash
# Full pipeline: plan → generate → heal → HITL
npx tsx src/index.ts full [commit|new-branch|clean]

# Heal-only: for existing tests
npx tsx src/index.ts heal clean

# Verify graph (no LLM needed)
npx tsx scripts/phase-trace.ts
```

### Programmatic

```typescript
import { Command } from "@langchain/langgraph";
import { buildGraph } from "./src/graph.js";

const graph = buildGraph();

// Start
await graph.invoke({
  rawInput: "generate tests for module: payments",
  sessionDir: ".opencode/sessions/playwright-run",
}, config);

// Resume from HITL
await graph.invoke(new Command({ resume: "new-branch" }), config);
```

## Configuration

Key environment variables:

| Variable | Purpose |
|----------|---------|
| `LITELLM_BASE_URL` | OpenAI-compatible endpoint |
| `LITELLM_MODEL` | Model (e.g., `anthropic/claude-sonnet-4-5`) |
| `LITELLM_API_KEY` | API key |
| `HYPERSWITCH_*` | Backend config |
| `FRONTEND_*` | Frontend config |
| `ENABLE_BROWSER_TOOLS` | Set `0` to skip Chromium |

See [`.env.example`](.env.example) for all options.

## Project Structure

```
hyperwright/
├── qa-skills/           # Agent specs (SKILL.md, _planner.md, etc.)
├── src/
│   ├── nodes/          # Graph nodes (10 total)
│   ├── agents/         # LLM sub-agents
│   ├── tools/          # MCP browser tools
│   └── session/        # Persistence
├── web-ui/             # React + Hono dashboard
└── scripts/            # Utilities
```

## How It Works

### 1. Input Parsing
Detects mode (`full`/`heal`), target (PR#/module/scenario), clones repo, starts services.

### 2. Browser Exploration (Planner)
Calls Playwright MCP tools (`browser_navigate`, `browser_snapshot`, etc.) to explore UI and discover selectors from actual rendered DOM — never hallucinated.

### 3. Test Generation
Outputs typed specs following project conventions:
- `PR-{n}-generated.spec.ts`
- `module-{name}.spec.ts`
- `scenario-{slug}.spec.ts`

### 4. Self-Healing Loop
Runs tests → parses failures → LLM proposes `{find, replace}` edits → applies surgically → retries. Up to 3 attempts.

### 5. Human-in-the-Loop
Interrupts for approval:
- `commit` — Add to existing PR
- `new-branch` — Create `pw/{target}-{timestamp}` branch
- `clean` — Discard artifacts

## Development Notes

- **ESM with `.js` extensions** — `import "./graph.js"` even for `.ts`
- **Use `loggerFor()`** — Never `console.log` in nodes
- **Fail fast** — Return `status: "failed"`, don't throw
- **Sync mirrors** — When editing `src/graph.ts`, update `web-ui/src/state/graphLayout.ts`

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Planning 404 | Check `LITELLM_BASE_URL` |
| Backend timeout | Set `HYPERSWITCH_START_SCRIPT=true` for no-op |
| Chromium missing | `npx playwright install chromium` |

## Roadmap

- [ ] Auto-trigger on PR open (GitHub bot)
- [ ] Session resumption from checkpoints
- [ ] Enhanced visual regression testing

---

Built with [LangGraph](https://github.com/langchain-ai/langgraph) + [Playwright](https://playwright.dev) by the Hyperswitch team.
