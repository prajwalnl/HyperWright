# QA Pipeline — Web UI

Dark-themed React + Hono cockpit for the `@examples/playwright` LangGraph.

- **Input panel** (left) — free-text input + optional input-type dropdown (PR / module / scenario / auto-detect) and a Start button
- **Graph canvas** (center) — live view of all 10 nodes and their connections via `@xyflow/react`; current node(s) pulse (parallel nodes like `setupBackend` + `setupFrontend` highlight simultaneously), visited path goes green, failed terminal goes red; click any node to filter the log panel to that node, click the node again or click the empty canvas to return to global logs; controls top-right, minimap bottom-right, legend bottom-left; zoom + pan supported
- **Status panel** (left, below input) — mode, target, BE/FE service status, phase trail, metrics (tests planned/generated/passed/failed/fixed + heal attempts), generated files, last error
- **Log panel** (right) — streaming logs filtered to the selected node (or all nodes if none selected)
- **HITL bar** (right, bottom) — appears when `awaitUserChoice` pauses; Commit / New branch / Clean buttons resume the graph

Everything updates in real time over an EventSource stream from the Hono backend.

The layout is a three-column grid (`320px · flex · 380px`) with responsive breakpoints at 1280/1024px that shrink the side columns while keeping the center canvas flexible.

---

## Run it

From the example root (`examples/playwright/`):

```bash
cp .env.example .env   # provider creds (if not already configured)

cd web-ui
pnpm install           # or: pnpm install --filter @examples/playwright-web-ui (from repo root)

pnpm dev               # starts Hono on :7800 and Vite on :5173 (concurrently)
```

Open http://localhost:5173.

The Vite dev server proxies `/api/*` to the Hono backend automatically.

### Production

```bash
pnpm build             # bundles client into web-ui/dist/
BACKEND_URL=http://localhost:7800 pnpm start    # just the Hono server
# serve web-ui/dist/ with any static file server
```

### Env

Inherits everything from `../.env` (`LITELLM_*`, `HYPERSWITCH_*`, `FRONTEND_*`, etc.). You can override the UI port:

| Variable        | Default | Meaning            |
| --------------- | ------- | ------------------ |
| `WEB_UI_PORT`   | `7800`  | Hono backend port  |
| `BACKEND_URL`   | `http://localhost:7800` | Vite proxy target when running `pnpm dev` |

---

## Architecture

```
web-ui/
  package.json            # "@examples/playwright-web-ui"
  vite.config.ts          # proxies /api → Hono
  index.html
  server/
    index.ts              # Hono app (SSE + REST)
    runner.ts             # EventEmitter-based graph runner (single-user)
    types.ts              # WorkflowEvent / WorkflowSnapshot
  src/
    main.tsx              # React entry
    App.tsx               # three-column layout
    types.ts              # re-exports server types
    hooks/
      useWorkflow.ts      # EventSource subscription + reducer
    components/
      InputPanel.tsx      # input + type dropdown + start
      StatusPanel.tsx     # mode/target/services/phase/metrics
      GraphCanvas.tsx     # @xyflow/react canvas (animated edges)
      QANode.tsx          # custom node (idle/running/done/failed/selected)
      LogPanel.tsx        # per-node + global logs with auto-scroll
      HITLBar.tsx         # commit / new-branch / clean
    state/
      graphLayout.ts      # static positions matching graph.ts topology
    styles/
      globals.css         # CSS-variable dark theme + animations
```

### Events

The backend broadcasts these SSE events; the client reduces them into UI state:

| Event              | Payload                                 |
| ------------------ | --------------------------------------- |
| `started`          | `{ thread: string }`                    |
| `state`            | `{ snapshot, currentNodes[] }`          |
| `log`              | `{ node, line }`                        |
| `awaiting_choice`  | (empty — shows the HITL bar)            |
| `finished`         | `{ status: "complete" \| "failed" }`    |
| `error`            | `{ message }`                           |

### REST surface

| Method | Path                              | Purpose                                    |
| ------ | --------------------------------- | ------------------------------------------ |
| GET    | `/api/health`                     | Liveness                                   |
| GET    | `/api/workflow/status`            | Current snapshot (for reconnects)          |
| GET    | `/api/workflow/stream`            | SSE feed of `WorkflowEvent`                |
| POST   | `/api/workflow/start`             | Begin a run. Body: `{ rawInput, targetType? }` |
| POST   | `/api/workflow/resume`            | Resume from HITL. Body: `{ choice }`       |
| GET    | `/api/workflow/nodes/:id/logs`    | Snapshot of a node's log lines             |

### Shutdown

The web server is single-user and keeps a `MemorySaver` checkpointer per run — just kill the `pnpm dev` process when you're done. Artifacts land under `.web-ui-run/.opencode/sessions/playwright-run/<thread>/` and `.web-ui-run/playwright-tests/ai-generated/<thread>/`.
