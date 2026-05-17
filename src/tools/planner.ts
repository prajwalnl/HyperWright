import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Page } from "playwright";
import { ENV } from "../env.js";
import { signupWithMerchantId } from "../runtime/hyperswitchApi.js";
import { writeJson } from "../session/files.js";
import { sessionPaths } from "../session/paths.js";
import { ensurePage } from "./browser/singleton.js";
import { DASHBOARD_BASE_URL } from "../config.js";
import type { Creds } from "../types.js";

/**
 * Factories for the `playwright-test*planner_*` tool namespace.
 *
 * - `authSetupTool` (`planner_setup_page`) — shared by all three agents.
 *   Deterministic: signup_with_merchant_id → login UI → skip 2FA → land on
 *   target. Returns a diagnostic log so the LLM can see each step.
 *
 * - `savePlanTool` (`planner_save_plan`) — planner-only. Writes the finished
 *   test plan JSON to sessionDir/test-plan.json.
 *
 * - `plannerToolsFor` / `sharedAuthToolsFor` — aggregated exports so each
 *   agent only imports what it needs.
 */

export interface PlannerToolsConfig {
  sessionDir: string;
  baseUrl?: string;
  /**
   * Session-wide auth creds. When provided, planner_setup_page reuses them and
   * skips signup_with_merchant_id — the user already exists from setupJoin.
   * The agent can still override via the tool's email/password args, but in
   * normal use it omits both and we go straight to login UI with these.
   */
  creds?: Creds | null;
}

export function plannerToolsFor(
  cfg: PlannerToolsConfig,
): StructuredToolInterface[] {
  return [authSetupTool(cfg), savePlanTool(cfg)];
}

export function sharedAuthToolsFor(
  cfg: PlannerToolsConfig,
): StructuredToolInterface[] {
  return [authSetupTool(cfg)];
}

// ---------------------------------------------------------------------------
// planner_save_plan (planner-only)
// ---------------------------------------------------------------------------

function savePlanTool(cfg: PlannerToolsConfig): StructuredToolInterface {
  return tool(
    async ({ plan }) => {
      const p = sessionPaths(cfg.sessionDir);
      await writeJson(p.testPlan, plan);
      return `Saved test-plan.json → ${p.testPlan}`;
    },
    {
      name: "planner_save_plan",
      description:
        "Write the finished test plan JSON to sessionDir/test-plan.json. Call this ONCE when the plan is complete and matches _planner.md §3.6. Preferred over returning JSON in a final message.",
      schema: z.object({
        plan: z.any().describe("Full test plan JSON object."),
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// planner_setup_page (shared)
// ---------------------------------------------------------------------------

function authSetupTool(cfg: PlannerToolsConfig): StructuredToolInterface {
  return tool(
    async ({ targetPath, email, password, skipAuth }) => {
      const lines = await performAuthSetup({
        targetPath,
        email,
        password,
        skipAuth,
        creds: cfg.creds ?? null,
        baseUrl: cfg.baseUrl ?? DASHBOARD_BASE_URL,
      });
      return lines.join("\n");
    },
    {
      name: "planner_setup_page",
      description:
        "Re-run the auth flow if the page has been invalidated (signed out, session expired). The orchestrator already calls this once before invoking the agent, so under normal circumstances you do NOT need to call it. If you do call it, the flow is: signup_with_merchant_id → /dashboard/login → Continue → Skip 2FA → targetPath.",
      schema: z.object({
        targetPath: z
          .string()
          .describe("Dashboard path to land on, e.g. /dashboard/payments")
          .optional(),
        email: z.string().email().optional(),
        password: z.string().optional(),
        skipAuth: z
          .boolean()
          .optional()
          .describe("Skip signup/login — only navigate."),
      }),
    },
  );
}

interface PerformAuthSetupOpts {
  targetPath?: string;
  email?: string;
  password?: string;
  skipAuth?: boolean;
  creds: Creds | null;
  baseUrl?: string;
}

/**
 * Deterministic auth flow, reusable from both the LLM tool wrapper above and
 * directly from the planTests node (which lifts the call out of the agent so
 * the agent can't accidentally skip or re-order it). Returns a per-step log
 * the caller can fold into its own logger.
 */
export async function performAuthSetup(
  opts: PerformAuthSetupOpts,
): Promise<string[]> {
  const base = opts.baseUrl ?? DASHBOARD_BASE_URL;
  const page = await ensurePage();
  const log: string[] = [];

  if (opts.skipAuth) {
    const url = base + (opts.targetPath ?? "/dashboard/home");
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    log.push(`navigated (auth skipped) → ${page.url()}`);
    return log;
  }

  const reuseSession =
    !opts.email && !opts.password && opts.creds !== null;
  const creds = reuseSession
    ? opts.creds!
    : {
        email:
          opts.email ??
          `test_${Date.now()}_${randomUUID().slice(0, 8)}@example.com`,
        password: opts.password ?? ENV.playwrightPassword,
      };

  try {
    await logoutIfLoggedIn(page, base, log);
    if (!reuseSession) {
      log.push(await signupUser(creds));
    } else {
      log.push(`reusing session creds (${creds.email}) — skipping signup`);
    }
    log.push(await loginUI(page, base, creds));
    log.push(await skipTwoFactor(page));
    if (opts.targetPath) {
      await page.goto(base + opts.targetPath, {
        waitUntil: "networkidle",
        timeout: 30_000,
      });
      log.push(`navigated → ${page.url()}`);
    } else {
      log.push(`landed → ${page.url()}`);
    }
    log.push(`credentials: ${creds.email}`);
    return log;
  } catch (err) {
    log.push(`ERROR: ${(err as Error).message}`);
    log.push(`current URL: ${page.url()}`);
    throw new AuthSetupError((err as Error).message, log);
  }
}

/**
 * Wraps an auth-setup failure with the step-by-step log already gathered,
 * so the caller (planTestsNode) can surface the full trail rather than just
 * the final error.message.
 */
export class AuthSetupError extends Error {
  constructor(message: string, public readonly steps: string[]) {
    super(message);
    this.name = "AuthSetupError";
  }
}

// --- Auth-flow helpers ------------------------------------------------------

async function logoutIfLoggedIn(
  page: Page,
  base: string,
  log: string[],
): Promise<void> {
  const url = page.url();
  if (!url.includes("/dashboard/") || url.includes("/dashboard/login")) return;

  try {
    const account = page
      .getByRole("button", { name: /account|profile|menu/i })
      .or(page.locator('[data-testid="user-menu"], [aria-label*="account" i]'))
      .first();
    if (await account.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await account.click({ timeout: 5_000 });
      const logout = page
        .getByRole("menuitem", { name: /log\s*out|sign\s*out/i })
        .or(page.getByRole("button", { name: /log\s*out|sign\s*out/i }))
        .first();
      await logout.click({ timeout: 5_000 });
      await page.waitForURL(/\/dashboard\/login/, { timeout: 10_000 });
      log.push("logged out prior session");
      return;
    }
  } catch {
    /* fall through to a hard nav */
  }

  await page.goto(`${base}/dashboard/login`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  log.push("forced navigation to /dashboard/login");
}

async function signupUser(creds: {
  email: string;
  password: string;
}): Promise<string> {
  const result = await signupWithMerchantId(creds);
  if (result.status === 0) {
    return `signup_with_merchant_id failed (${result.body}) — continuing`;
  }
  const tail = result.ok ? "" : ` body=${(result.body || "").slice(0, 200)}`;
  return `signup_with_merchant_id → ${result.status}${tail}`;
}

/**
 * Selector strategy for the dashboard login flow.
 *
 * The dashboard's React+ReScript build does NOT expose semantic roles for
 * the Continue button — `getByRole("button", { name: /continue/i })` times
 * out. Empirically the only locators that work consistently are:
 *   - email:    input[placeholder="Enter your Email"]
 *   - password: input[placeholder="Enter your Password"]
 *   - submit:   [data-button-for="continue"]   (uniquely identifies the
 *               visible Continue button; text/role/submit fallbacks all
 *               resolve to a hidden duplicate via .or())
 *   - skip 2FA: text=Skip now
 *
 * Email/password use chained fallbacks because their visible markup is
 * stable across forks. The submit button is pinned to the data attribute
 * with no fallback — anything looser pulls in the hidden duplicate and
 * times out.
 */
async function loginUI(
  page: Page,
  base: string,
  creds: { email: string; password: string },
): Promise<string> {
  if (!page.url().includes("/dashboard/login")) {
    await page.goto(`${base}/dashboard/login`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
  }

  // .filter({ visible: true }) is critical — many React+ReScript builds
  // include hidden duplicate submit buttons that .or() chains will resolve
  // to before the visible one. Without the filter, .first() picks a hidden
  // <button type="submit" class="hidden"> and click() times out waiting
  // for visibility.
  const emailBox = page
    .locator('input[placeholder="Enter your Email"]')
    .or(page.getByPlaceholder(/email/i))
    .or(page.getByLabel(/email/i))
    .or(page.locator('[data-testid="email-input"], input[type="email"]'))
    .filter({ visible: true })
    .first();
  const passBox = page
    .locator('input[placeholder="Enter your Password"]')
    .or(page.getByPlaceholder(/password/i))
    .or(page.getByLabel(/password/i))
    .or(page.locator('[data-testid="password-input"], input[type="password"]'))
    .filter({ visible: true })
    .first();
  // The dashboard's login Continue button is uniquely identified by
  // [data-button-for="continue"]. Earlier fallbacks (text-based, role-based,
  // bare button[type="submit"]) all matched hidden duplicates in the form
  // and resolved through .or() to a non-clickable element. Use the
  // dedicated attribute selector and nothing else.
  const continueBtn = page.locator('[data-button-for="continue"]');

  await emailBox.fill(creds.email, { timeout: 10_000 });
  await passBox.fill(creds.password, { timeout: 10_000 });
  await continueBtn.click({ timeout: 10_000 });
  return "submitted login";
}

async function skipTwoFactor(page: Page): Promise<string> {
  // text=Skip now is the proven match. Other variants are fallbacks for
  // future builds.
  const skip = page
    .locator("text=Skip now")
    .or(page.locator('button:has-text("Skip now")'))
    .or(page.locator('button:has-text("Skip")'))
    .or(page.locator('button:has-text("Later")'))
    .or(page.getByRole("button", { name: /skip\s*now|^\s*skip\s*$|later|remind\s*me\s*later/i }))
    .or(page.locator('[data-testid="skip-now"], [data-testid="skip-2fa"]'))
    .filter({ visible: true })
    .first();

  try {
    await skip.waitFor({ state: "visible", timeout: 8_000 });
    await skip.click({ timeout: 5_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
    return "2FA skipped";
  } catch {
    return "2FA screen did not appear (continuing)";
  }
}
