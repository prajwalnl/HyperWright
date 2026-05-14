import { MODULE_CATALOG } from "../config.js";

/**
 * Render the Module → URL cheat-sheet from MODULE_CATALOG so the catalogue
 * has a single source. Adding/editing/removing a module in config.ts
 * automatically updates what the agents see.
 */
function renderModuleUrlTable(): string {
  const names = Object.keys(MODULE_CATALOG);
  const width = Math.max(...names.map((n) => n.length)) + 2;
  return names
    .map((name) => `${name.padEnd(width)}${MODULE_CATALOG[name].path}`)
    .join("\n");
}

/**
 * Group modules by their prerequisite signature so the playbook prints
 * "payments, routing → User + Connector" instead of one row per module.
 */
function renderPrerequisitesTable(): string {
  const groups = new Map<string, string[]>();
  for (const [name, spec] of Object.entries(MODULE_CATALOG)) {
    const key =
      spec.prerequisites.length === 0
        ? "(none — unauthenticated)"
        : spec.prerequisites.join(" + ");
    const list = groups.get(key) ?? [];
    list.push(name);
    groups.set(key, list);
  }
  const rows = Array.from(groups.entries()).map(([prereqs, mods]) => ({
    mods: mods.join(", "),
    prereqs,
  }));
  const width = Math.max(...rows.map((r) => r.mods.length)) + 2;
  return rows
    .map((r) => `${r.mods.padEnd(width)}→ ${r.prereqs}`)
    .join("\n");
}

/**
 * Condensed playbook injected at the TOP of every agent's system prompt,
 * ABOVE the full SKILL.md + agent-specific .md. This is the cheat-sheet the
 * model must never forget — things that were previously spread across four
 * markdown files and kept tripping agents up.
 *
 * The module/prerequisite tables are rendered from MODULE_CATALOG
 * (src/config.ts) — do NOT hand-maintain them here.
 *
 * Keep the rest short. The full SKILL.md is still available below for
 * reference, but the critical facts live here so the model sees them first.
 */
export const AGENT_PLAYBOOK = `# Playbook (READ FIRST)

## Application topology
- Backend (Hyperswitch, Rust)  → http://localhost:8080  · health at /health
- Dashboard (React+ReScript)   → http://localhost:9000  · base path /dashboard
- All user-facing URLs start with /dashboard/...

## AUTH FLOW — ALWAYS use \`planner_setup_page\` (HARD RULE — do NOT stitch this by hand)

The login flow has been canonicalised in code. You MUST call \`planner_setup_page\`
ONCE at the start of exploration with \`{ targetPath: "/dashboard/<your-module>" }\`.
You MUST NOT use \`browser_navigate\` / \`browser_type\` / \`browser_click\` to
authenticate manually. Even if \`planner_setup_page\` returns an error message in
its log output, do NOT fall back to manual auth — instead retry \`planner_setup_page\`
once (the tool is idempotent), and if it still fails report the failure and stop.

What the tool does deterministically (so you don't have to discover it):
  1. POSTs to {backend}/user/signup_with_merchant_id with the session creds
     (or skips signup entirely if creds came from setupJoin).
  2. Navigates to /dashboard/login.
  3. Fills email via \`input[placeholder="Enter your Email"]\` (proven), with
     placeholder/label fallbacks.
  4. Fills password via \`input[placeholder="Enter your Password"]\` (proven).
  5. Clicks the submit button via \`[data-button-for="continue"]\`
     (uniquely identifies the visible Continue button — text/role/submit
     fallbacks all pulled in a hidden duplicate, so this selector has no
     fallbacks).
  6. On the 2FA screen clicks \`text=Skip now\` (proven), with "Skip" /
     "Later" / role-based fallbacks.
  7. If already on /dashboard/home, logs out first.
  8. Navigates to your targetPath.

THIS MEANS: if the next tool call after \`planner_setup_page\` lands you on
the target page, your auth is done. Move straight to module exploration.
Do NOT inspect the login page DOM, do NOT type into login inputs, do NOT
click "Continue" — every line of that code path lives in
\`src/tools/planner.ts::authSetupTool\` and has been validated against the
current build.

## Module → URL map (use these paths, never guess)
${renderModuleUrlTable()}

## Module prerequisites (seed via API helpers, never click through the UI)
${renderPrerequisitesTable()}

## API helpers available in playwright-tests/support/commands.ts
- signupUser(email, password, context)
- generateUniqueEmail()
- createDummyConnectorAPI(merchantId, label, context)
- createAPIKey(merchantId, token, context)
- createPaymentAPI(merchantId, context)
- ompLineage(page) → { orgId, merchantId, profileId }
- loginUI(page, email, password)

## Selector strategy (priority order)
1. getByRole(role, { name })        ← preferred for buttons/links/headings
2. getByLabel(text)                 ← form inputs
3. getByPlaceholder(text)
4. getByText(text, { exact: false })
5. getByTestId("...")               ← fallback if semantic selectors don't exist
6. locator('[data-*=...]')
7. CSS / XPath                       ← LAST resort

## Common gotchas (do NOT ignore)
- Skip-2FA button may render as "Skip now", "Skip", or "Later" — match loosely
- After any navigation: await page.waitForLoadState("networkidle")
- After API-dependent render: use { timeout: 10000 } on waits
- Strict-mode violations: prefer getByRole with a distinctive name, or getByTestId
- Feature-flagged UI: intercept /dashboard/config/feature* in beforeEach and set the flag to true
- If a selector probe fails, use browser_snapshot to rediscover, then browser_generate_locator to get the recommended Playwright locator

## Artifact filename convention (generator)
- PR target       → PR-{number}-generated.spec.ts
- Module target   → module-{name}.spec.ts
- Scenario target → scenario-{slug}.spec.ts

## Where things live on disk
- Generated tests    → playwright-tests/ai-generated/
- Existing tests     → playwright-tests/e2e/              ← reuse patterns from here
- Page Object Models → playwright-tests/support/pages/    ← extend, don't rewrite
- Session artifacts  → .opencode/sessions/playwright-run/

## Tool discipline
- browser_snapshot → ALWAYS before probing a new page (don't guess selectors)
- browser_generate_locator → to upgrade a fragile CSS selector to a stable Playwright one
- browser_console_messages / browser_network_requests → use when a step fails
- Prefer the planner_save_plan tool (planner) over emitting JSON in a final message

## Output discipline
- Emit code / JSON inside a SINGLE fenced block — no prose around it
- Use @playwright/test imports, never legacy playwright APIs
- beforeEach must: generateUniqueEmail → signupUser → loginUI (or route-intercept feature flags first)
`;
