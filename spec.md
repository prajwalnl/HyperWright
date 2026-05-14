# Spec — Runtime-File Isolation Under `hcc-tmp/`

> Status: proposed · Owner: TBD · Targets branch: `initial-changes`

## 1. Goal

The `examples/playwright` package (henceforth "the repo") must stop producing runtime artifacts inside its own working tree. **Every file a run writes at runtime lives under a single, per-session root inside a configurable base directory (default `hcc-tmp/`).** The repo stays a pristine source tree: only source code, skills, fixtures, and config committed to git.

Stated positively:

- One canonical per-session root: `<HCC_TMP_BASE>/<sessionId>/`
- Every node reads and writes runtime files via paths derived from that root.
- `qa-skills/*.md` remain in the repo — they are source, not runtime.
- No node, tool, script, or helper writes anywhere else under the repo tree.

Stated negatively:

- **Never again** write to `./.opencode/…`, `./.web-ui-run/…`, `./.out/…`, or `os.tmpdir()` in node/tool code paths.
- **Never again** use module-level constants like `SESSION_DIR = ".opencode/..."` or `GENERATED_TESTS_DIR = "playwright-tests/..."` as if they were absolute.

---

## 2. Why now

Before we can host this service for multiple users we need the guarantee that no run can touch a file another run cares about, and that a single restart can't pollute the repo working tree. Getting the runtime path story right is a prerequisite for Phase 1 of the multi-tenancy plan (per-tenant runner, per-session logger, per-session browser singleton). It also closes several existing bugs — the `state.testsDir` banner mismatch, the `.web-ui-run/` dir growing inside the repo, and `input-context.json` being written to two different places.

---

## 3. Canonical session-root layout

```
$HCC_TMP_BASE/                                       # default: /Users/prajwal.nl/hcc-tmp, overridable via env
└── <sessionId>/                                     # one dir per run (UUID)
    ├── session.json                                 # status/phase/metrics — single source of truth
    ├── input-context.json                           # parsed input (written by setupContext)
    ├── test-plan.json                               # planner output
    ├── run-results.json                             # healer output
    ├── bug-report.md                                # healer failure report (only if failures remain)
    ├── summary.json                                 # final summary
    ├── web-ui-logs.json                             # web-ui only — sidecar logs for reconnect
    ├── logs/
    │   ├── setupContext.log
    │   ├── setupBackend.log
    │   ├── setupFrontend.log
    │   ├── setupJoin.log
    │   ├── planTests.log
    │   ├── generateTests.log
    │   ├── healTests.log
    │   ├── awaitUserChoice.log
    │   ├── cleanup.log
    │   └── summary.log
    ├── repo/                                        # the cloned hyperswitch-control-center
    │   └── hyperswitch-control-center/              # the working tree — renamed on-clone from upstream repo name
    │       ├── .ai-test-gen/                        # (removed — see §7)
    │       └── playwright-tests/
    │           └── ai-generated/                    # generated specs land here, read by `npx playwright test`
    │               └── <spec>.spec.ts
    └── scratch/
        └── screenshots/                             # browser_take_screenshot output
```

### Design rules

1. **One session = one dir**. The sessionId is the only key the caller ever needs.
2. Generated tests stay inside the cloned repo *because Playwright requires them there* to resolve `playwright.config.ts`, fixtures, `../support/helper`, etc. This is the *only* case where a runtime file lives inside a subtree that looks like source — and that subtree is itself the per-session runtime clone, not the main repo.
3. Anything that used to go to `os.tmpdir()` goes to `scratch/` instead, so cleanup doesn't need a second code path.
4. Nothing outside `$HCC_TMP_BASE/<sessionId>/` is written by the graph. (LLM HTTP, git HTTP, docker registry pulls are out of scope — those are network side effects, not file writes.)

---

## 4. Environment / configuration

Exactly one env var governs the base:

| Var | Default | Purpose |
| --- | --- | --- |
| `HCC_TMP_BASE` | `/Users/prajwal.nl/hcc-tmp` (current hardcode) becomes `${os.tmpdir()}/hcc-tmp` as portable default | Parent dir for every session root. Must be an absolute path or be resolved to one at load time. |

Retire or repurpose these env vars:

| Var | Current behavior | After this spec |
| --- | --- | --- |
| `OUT_PREFIX` | prefixes `SESSION_DIR`/`GENERATED_TESTS_DIR` for local CLI runs | remove; every run picks a fresh session root |
| `GENERATED_TESTS_DIR` | path to emit specs into, joined with repoPath | keep the **inner** path (`playwright-tests/ai-generated`) but treat it as a relative-to-repo constant, not a runtime path |
| `EXISTING_TESTS_DIR` / `PAGE_OBJECTS_DIR` | relative paths inside the cloned repo | unchanged (they are source locations inside the clone, not runtime output) |

Retire these constants (in `src/config.ts`):

- `SESSION_DIR = ".opencode/sessions/playwright-run"` — **delete**
- `GENERATED_TESTS_DIR = "playwright-tests/ai-generated"` — **demote** to a repo-relative constant, move under a clearer name (e.g. `GENERATED_TESTS_RELPATH`)

---

## 5. New canonical helper

Add `src/session/sessionRoot.ts`:

```ts
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export interface SessionRoot {
  id: string;                            // the sessionId
  root: string;                          // $BASE/<id>
  session: string;                       // $BASE/<id>/session.json
  inputContext: string;                  // $BASE/<id>/input-context.json
  testPlan: string;                      // $BASE/<id>/test-plan.json
  runResults: string;                    // $BASE/<id>/run-results.json
  bugReport: string;                     // $BASE/<id>/bug-report.md
  summary: string;                       // $BASE/<id>/summary.json
  webUiLogs: string;                     // $BASE/<id>/web-ui-logs.json
  logsDir: string;                       // $BASE/<id>/logs
  repoDir: string;                       // $BASE/<id>/repo
  cloneDir: string;                      // $BASE/<id>/repo/hyperswitch-control-center
  generatedTestsDir: string;             // <cloneDir>/playwright-tests/ai-generated
  screenshotsDir: string;                // $BASE/<id>/scratch/screenshots
  scratchDir: string;                    // $BASE/<id>/scratch
}

export function hccTmpBase(): string {
  const raw = process.env.HCC_TMP_BASE?.trim();
  if (raw && path.isAbsolute(raw)) return raw;
  return path.join(os.tmpdir(), "hcc-tmp");
}

export function sessionRootFor(sessionId: string): SessionRoot { /* pure derivation */ }
export function newSessionRoot(): SessionRoot { return sessionRootFor(randomUUID()); }
```

**All runtime paths must be derived from `SessionRoot`.** No other path construction for runtime files is allowed in `src/**`, `web-ui/server/**`, or `scripts/**`.

`src/session/paths.ts::sessionPaths(sessionDir)` is replaced by fields on `SessionRoot`. Call sites migrate.

---

## 6. State changes

`QAState` (`src/state.ts`):

- `sessionDir: string` → **deprecated**. Replace with `sessionRoot: SessionRoot` (an opaque object the graph passes around). Individual path fields come off the struct; no more string-joining at call sites.
- `testsDir: string` → **delete**. Nodes derive from `sessionRoot.generatedTestsDir`.
- `repo.repoPath` → remains, but its value must equal `sessionRoot.cloneDir`. Add an assertion in `setupContext`.

Reducers:

- `sessionRoot`: lastWriteWins; default `null`. Assigned exactly once in `setupContext`.
- Everywhere else that was reading `state.sessionDir` / `state.testsDir` now reads `state.sessionRoot.*`.

Default path for `SESSION_DIR` / `GENERATED_TESTS_DIR` in `state.ts` must be removed; a state default cannot express "a valid session root" without a sessionId, and nothing should run before `setupContext` has assigned one.

---

## 7. File-by-file change list

Changes are grouped by layer. Each item states what to remove, add, and leave alone.

### 7.1 `src/config.ts`

- **Remove** `export const SESSION_DIR = ".opencode/sessions/playwright-run"`
- **Rename** `GENERATED_TESTS_DIR` → `GENERATED_TESTS_RELPATH` (or inline it into `sessionRoot` derivation). Its value is still `"playwright-tests/ai-generated"` but clearly a repo-relative path.
- **Unchanged**: `MODULE_CATALOG`, `DASHBOARD_BASE_URL`, etc. — these are config, not paths.

### 7.2 `src/env.ts`

- **Remove** `ENV.paths.generatedTestsDir` default `"playwright-tests/ai-generated"` — the value is now pulled from `sessionRoot` per-run, not env.
- **Add** `ENV.hccTmpBase` resolved via the helper in §5.
- **Remove** any references to `OUT_PREFIX` from demo scripts that still rely on it.

### 7.3 `src/state.ts`

- Replace `sessionDir` and `testsDir` annotations with `sessionRoot: SessionRoot | null` (lastWriteWins, default null).
- Remove the `import { GENERATED_TESTS_DIR, SESSION_DIR } from "./config.js"` line.

### 7.4 `src/session/paths.ts`

- **Delete**. Replaced by `SessionRoot` fields.

### 7.5 `src/session/sessionFile.ts`

- Accept `SessionRoot` instead of `sessionDir: string`.
- `writeSession(state)` derives `state.sessionRoot.session`.

### 7.6 `src/session/logger.ts` (`LoggerService`)

- `initialize(sessionRoot: SessionRoot)` (not a raw dir string).
- `getLogDir()` returns `sessionRoot.logsDir`.
- Rest unchanged.

### 7.7 `src/session/respond.ts`

- No signature change, but dependent types update via `state.sessionRoot`.

### 7.8 `src/nodes/setupContext.ts`

- **Remove** the local `BASE_CLONE_DIR` hardcode.
- **Remove** the `getCloneDir` / `getRepoPath` helpers.
- **Compute** `sessionRoot = newSessionRoot()` (or reuse `state.sessionId` if the runner pre-assigned one — see §10 on web-ui integration).
- **`git clone`** destination is `sessionRoot.cloneDir` (not `.../hyperswitch-control-center`). The URL is unchanged; we put it at that path directly.
- **Write `input-context.json`** to `sessionRoot.inputContext` — *not* `<repoPath>/.ai-test-gen/input-context.json` (current bug).
- **Delete** any code that creates `<repoPath>/.ai-test-gen/`. That directory is no longer written.
- Return patch includes `sessionRoot`; the `repo.repoPath` echo is kept for backwards-compat of downstream reads, but must equal `sessionRoot.cloneDir`.

### 7.9 `src/nodes/parseInput.ts` and `src/nodes/cloneRepo.ts`

- **Delete both files.** They are dead code (not wired into `src/graph.ts`) and contain duplicate path logic. CLAUDE.md already flags `parseInput.ts` as legacy.

### 7.10 `src/nodes/generateTests.ts`

- Replace `const testsDir = \`${repoPath}/${ENV.paths.generatedTestsDir}\`` with `state.sessionRoot.generatedTestsDir`.
- `typecheckGeneratedFiles` runs `npx tsc --noEmit` with `cwd: state.sessionRoot.cloneDir`.

### 7.11 `src/nodes/healTests.ts`

- Same substitution for `testsDir`.
- `runPlaywrightTest(testFile, attempt, { cwd: state.sessionRoot.cloneDir })`.

### 7.12 `src/nodes/cleanup.ts`

- Same substitution.
- `rm -f ${testsDir}/*.spec.ts` → `rm -f ${sessionRoot.generatedTestsDir}/*.spec.ts`. Unchanged semantically, now fully scoped.
- `docker compose down -v` runs with `cwd: path.join(sessionRoot.cloneDir, ENV.backend.stopCwd)`. Still destructive — but only to *this session's* docker stack once §9 lands.

### 7.13 `src/nodes/summary.ts`

- Replace `state.sessionDir` / `state.testsDir` display values with `state.sessionRoot.root` and `state.sessionRoot.generatedTestsDir`.
- `sessionPaths(...)` call → direct `state.sessionRoot.*` reads.

### 7.14 `src/agents/planner.ts`, `generator.ts`, `healer.ts`

- `PlannerInput.sessionDir` → `PlannerInput.sessionRoot`. Same for the others.
- `sessionPaths(input.sessionDir)` → `input.sessionRoot.*`.
- Context lines passed to the LLM should print `state.sessionRoot.root` so the agent sees its actual session dir, not a relative path.

### 7.15 `src/tools/planner.ts`

- `PlannerToolsConfig.sessionDir` → `PlannerToolsConfig.sessionRoot`.
- `savePlanTool` writes to `cfg.sessionRoot.testPlan`.

### 7.16 `src/tools/browser.ts`

- `browser_take_screenshot` default path changes from `os.tmpdir()/pw-agent-*.png` to `state.sessionRoot.screenshotsDir/pw-agent-*.png`.
- Since the tool doesn't have direct access to state, thread a path resolver in through `sharedAuthToolsFor` / `plannerToolsFor` (add a `screenshotDir: string` field on the config struct and build the path there).

### 7.17 `src/agents/playbook.ts`

- Update the "Where things live on disk" section to describe the new layout:
  ```
  Session root        → $HCC_TMP_BASE/<sessionId>/
  Cloned repo         → $HCC_TMP_BASE/<sessionId>/repo/hyperswitch-control-center/
  Generated tests     → <cloneDir>/playwright-tests/ai-generated/
  Session artifacts   → $HCC_TMP_BASE/<sessionId>/{session,input-context,test-plan,run-results,summary}.json
  Logs                → $HCC_TMP_BASE/<sessionId>/logs/
  Screenshots         → $HCC_TMP_BASE/<sessionId>/scratch/screenshots/
  ```
- Remove references to `.opencode/sessions/playwright-run/`.

### 7.18 `src/index.ts`

- Remove `OUT_PREFIX` + `path.join(prefix, SESSION_DIR)` / `GENERATED_TESTS_DIR` logic.
- CLI runner constructs one `SessionRoot` via `newSessionRoot()` and hands it to the graph through initial state:
  ```ts
  const sessionRoot = newSessionRoot();
  await ensureDir(sessionRoot.root);
  await graph.invoke({ rawInput, sessionRoot }, { configurable: { thread_id: sessionRoot.id } });
  ```
- Final banner prints `sessionRoot.root` and `sessionRoot.generatedTestsDir`.

### 7.19 `scripts/phase-trace.ts`

- Stop writing under `.out/phase-trace`. Use `newSessionRoot()`.
- Initialise the logger before invoking the graph:
  ```ts
  const sessionRoot = newSessionRoot();
  await ensureDir(sessionRoot.logsDir);
  logger.initialize(sessionRoot);
  await graph.invoke({ rawInput: "...", sessionRoot }, { configurable: { thread_id: sessionRoot.id } });
  ```

### 7.20 `web-ui/server/runner.ts`

- Delete all `path.join(".web-ui-run", SESSION_DIR, threadId, …)` usages.
- The web-ui's `threadId` **is** the sessionId. `Runner.start` calls `newSessionRoot()` (or `sessionRootFor(threadId)` after `threadId = randomUUID()`).
- Session discovery (`loadLatestRun`, `listSessions`) reads from `hccTmpBase()`, not `.web-ui-run/…`.
- `web-ui-logs.json` path: `sessionRoot.webUiLogs`.
- The `.web-ui-run/` prefix that currently distinguishes web-ui runs from CLI runs is gone — there is no need to distinguish, because both now produce the same per-session layout, and the sessionId itself is the isolation boundary.

### 7.21 `web-ui/src/**` (client)

- No API surface changes. The client talks to the server via threadId; it never sees disk paths. Only update whatever visible banner prints a hardcoded `.web-ui-run/…` path, if any.

---

## 8. Skills files

`qa-skills/*.md` stay in the repo. They are read at startup by `src/agents/prompts.ts::loadSkillContext` and treated as immutable source. No runtime writes under `qa-skills/` are permitted.

If a future feature needs per-run skill overrides, it belongs in `<sessionRoot>/skills-overrides/` and must layer on top of the repo skill files — never mutate the repo copies.

---

## 9. Docker and backend side effects (out of scope but noted)

`docker compose up/down -v` in `setupBackend` / `cleanup` still affects a shared Docker daemon on the host. Full per-session isolation of that layer is a separate, bigger piece of work (per-session compose project name, per-session port ranges). This spec does **not** attempt to fix that. It does, however, require:

- `cleanup` only removes resources it started (already true in code).
- No cleanup command references a path outside `sessionRoot`. Specifically: `cwd: sessionRoot.cloneDir`-relative only.

---

## 10. Web-ui / server-runner integration

The runner must stop rolling its own path convention:

1. On `/api/workflow/start`, generate `sessionRoot = newSessionRoot()`. Use `sessionRoot.id` as `thread_id`.
2. Call `logger.initialize(sessionRoot)` (not a raw dir).
3. Hand `sessionRoot` into initial state: `{ rawInput, sessionRoot }`.
4. `loadLatestRun()` scans `hccTmpBase()` for directories containing `session.json` and sorts by `mtime`.
5. `listSessions()` similarly scans `hccTmpBase()`. Returns `[{ sessionId, startedAt, status }]`. No path leakage to the client.
6. `loadSession(id)` resolves `sessionRootFor(id)` and reads its files.

Do not preserve `.web-ui-run/` naming as a legacy alias. Delete references outright; a one-time migration tool (optional, §13) can move existing sessions over.

---

## 11. Things that must not happen

Any PR claiming to implement this spec must fail review if:

- `git grep` for `.opencode` turns up references in `src/`, `web-ui/server/`, or `scripts/`. (Matches inside `qa-skills/*.md` are fine — skill docs may reference the spec path, but code must not.)
- `git grep` finds `.web-ui-run`, `.out/phase-trace`, or `OUT_PREFIX` anywhere except in CHANGELOG / this spec / comments explaining the migration.
- `os.tmpdir()` appears in any file under `src/tools/` or `src/nodes/`.
- `BASE_CLONE_DIR`, `SESSION_DIR`, `GENERATED_TESTS_DIR` appear as string literals anywhere in `src/`.
- A node writes via a path not derived from `state.sessionRoot`.
- `state.sessionDir` or `state.testsDir` are read anywhere.

---

## 12. Acceptance criteria

A clean implementation must pass all of the following, with no manual cleanup in between:

1. **Clean-tree check**: after `pnpm demo:full` or a successful web-ui run, `git status` inside `examples/playwright/` shows no new files or dirs. Not `.opencode/`, not `.web-ui-run/`, not `.out/`. Existing CHANGELOG/lockfile updates are of course fine.
2. **Session-root completeness**: every artifact listed in §3 that the run would normally produce is present under `$HCC_TMP_BASE/<sessionId>/`. No artifact is missing, no artifact is elsewhere.
3. **Isolation check**: two concurrent CLI runs (different thread_ids, same process) produce two disjoint session roots and never touch each other's files. (Concurrent runs still share ports and docker — those are §9, out of scope — but file-level they must be disjoint.)
4. **Restart safety**: killing and restarting the web-ui server does not lose pre-restart session artifacts. `loadLatestRun` still finds them. `loadSession(id)` for any pre-restart sessionId still reproduces its snapshot + logs.
5. **Phase-trace works**: `npx tsx scripts/phase-trace.ts` runs end-to-end without initialising anything beyond `newSessionRoot() + logger.initialize()`. Artifacts land under `$HCC_TMP_BASE/<sessionId>/`, not `./.out/`.
6. **Skill doc integrity**: `qa-skills/` has not been modified except for deliberate updates in this spec (playbook's on-disk paths section). No runtime writes land inside `qa-skills/`.
7. **Banner correctness**: `summary` node prints `sessionRoot.root` and `sessionRoot.generatedTestsDir` with the values that `generateTests` / `healTests` actually used. No path mismatch.
8. **Type safety**: `npx tsc --noEmit` clean in both the root package and `web-ui/`.

---

## 13. Migration plan

Phased, each step merged separately, each step passing type check and phase-trace on its own.

1. **Introduce `sessionRoot.ts` helper + types.** Do not wire it in yet. Add tests for `sessionRootFor(id)`.
2. **Teach `setupContext` to accept a pre-existing `sessionRoot`**. If absent, generate one. Write clone into `sessionRoot.cloneDir`. Write `input-context.json` to `sessionRoot.inputContext`. Old `sessionDir` still read as fallback for one revision.
3. **Thread `sessionRoot` through state**. Add the field, keep the old ones deprecated but functional. Every node switches to read from `state.sessionRoot` if present, else fall back to `state.sessionDir` / `state.testsDir`.
4. **Retire `parseInput.ts` + `cloneRepo.ts`** (dead code; separate small commit).
5. **Delete `SESSION_DIR` + `GENERATED_TESTS_DIR` constants** and the fallback paths in state. Nothing compiles without `sessionRoot`.
6. **Update web-ui runner** to use `sessionRoot`. Remove `.web-ui-run/` joining.
7. **Update `scripts/phase-trace.ts`** (also fixes the pre-existing logger-not-initialised crash).
8. **Update `playbook.ts`** "Where things live on disk" text.
9. **Optional one-time migration tool** (`scripts/migrate-legacy-sessions.ts`): move existing `.web-ui-run/.opencode/sessions/playwright-run/<id>/…` → `$HCC_TMP_BASE/<id>/…`. Not required for correctness; only useful if preserving old runs matters.
10. **Gate it in CI** with `git grep` checks from §11 so the legacy patterns can't come back.

---

## 14. Out of scope

The following are related but belong to later phases (see the earlier multi-tenancy audit):

- Swapping `MemorySaver` for a persistent checkpointer.
- Per-session backend/frontend ports.
- Per-tenant auth and SSE fan-out scoping.
- Disk eviction / rotation policy for `$HCC_TMP_BASE/`.
- Docker compose project-name isolation.

They will compose cleanly on top of this spec, but none of them is required for the "no runtime files in the repo" outcome.

---

## 15. Open questions

1. Should `$HCC_TMP_BASE` default to `os.tmpdir()/hcc-tmp` (portable) or keep `/Users/<user>/hcc-tmp` for the current developer ergonomics? Proposal: default `os.tmpdir()/hcc-tmp`; document an override in `.env.example`.
2. Do we rename `repo/hyperswitch-control-center/` to just `repo/`? Upside: one less path segment. Downside: drift from what a dev sees when they `cd` into the clone manually. Proposal: keep the repo name for dev clarity; the one extra segment is trivial.
3. Does the phase-trace script share sessions with real runs, or always get its own? Proposal: always its own — it runs headlessly, artifacts are disposable, and sharing would confuse `listSessions()`.
