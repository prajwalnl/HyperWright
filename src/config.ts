import type { PullRequestInfo, TargetType } from "./types.js";

export const DASHBOARD_BASE_URL = "http://localhost:9000";
export const BACKEND_BASE_URL = "http://localhost:8080";
export const BACKEND_HEALTH_URL = `${BACKEND_BASE_URL}/health`;

/**
 * Module-to-URL + preconditions mapping from SKILL.md.
 *
 * Keep this table in sync with the "Module-to-URL Mapping" and "Determine
 * Preconditions" tables in SKILL.md / _planner.md.
 */
export interface ModuleSpec {
  path: string;
  prerequisites: string[];
  apiHelpers: string[];
}

export const MODULE_CATALOG: Record<string, ModuleSpec> = {
  auth: {
    path: "/dashboard/login",
    prerequisites: [],
    apiHelpers: [],
  },
  home: {
    path: "/dashboard/home",
    prerequisites: ["User"],
    apiHelpers: ["signupUser"],
  },
  payments: {
    path: "/dashboard/payments",
    prerequisites: ["User", "Connector"],
    apiHelpers: ["signupUser", "createDummyConnectorAPI"],
  },
  refunds: {
    path: "/dashboard/refunds",
    prerequisites: ["User", "Connector", "Payment"],
    apiHelpers: ["signupUser", "createDummyConnectorAPI", "createPaymentAPI"],
  },
  disputes: {
    path: "/dashboard/disputes",
    prerequisites: ["User", "Connector", "Payment"],
    apiHelpers: ["signupUser", "createDummyConnectorAPI", "createPaymentAPI"],
  },
  connectors: {
    path: "/dashboard/connectors",
    prerequisites: ["User"],
    apiHelpers: ["signupUser"],
  },
  "payout-connectors": {
    path: "/dashboard/payout-connectors",
    prerequisites: ["User"],
    apiHelpers: ["signupUser"],
  },
  routing: {
    path: "/dashboard/routing",
    prerequisites: ["User", "Connector"],
    apiHelpers: ["signupUser", "createDummyConnectorAPI"],
  },
  customers: {
    path: "/dashboard/customers",
    prerequisites: ["User", "Payments"],
    apiHelpers: ["signupUser", "createPaymentAPI"],
  },
  analytics: {
    path: "/dashboard/analytics-payments",
    prerequisites: ["User", "Connector", "Payments"],
    apiHelpers: ["signupUser", "createDummyConnectorAPI", "createPaymentAPI"],
  },
  users: {
    path: "/dashboard/users",
    prerequisites: ["User (admin)"],
    apiHelpers: ["signupUser"],
  },
  "api-keys": {
    path: "/dashboard/developer-api-keys",
    prerequisites: ["User"],
    apiHelpers: ["signupUser"],
  },
  webhooks: {
    path: "/dashboard/webhooks",
    prerequisites: ["User"],
    apiHelpers: ["signupUser"],
  },
  settings: {
    path: "/dashboard/settings",
    prerequisites: ["User"],
    apiHelpers: ["signupUser"],
  },
};

export function resolveModule(target: string): ModuleSpec {
  return MODULE_CATALOG[target] ?? MODULE_CATALOG.payments;
}

/**
 * Aliases used by the inference helpers below. Keys are catalog module names;
 * values are extra tokens (singular forms, common synonyms) that should also
 * resolve to that module when matched in a path or scenario description.
 *
 * Order matters for ambiguous tokens: when scanning, the FIRST matching alias
 * wins, so put the more-specific entries (e.g. "payout-connectors" before
 * "connectors") first.
 */
const MODULE_ALIASES: Array<{ module: string; aliases: string[] }> = [
  { module: "payout-connectors", aliases: ["payout-connectors", "payoutconnector", "payouts", "payout"] },
  { module: "api-keys", aliases: ["api-keys", "apikeys", "api-key", "apikey"] },
  { module: "analytics", aliases: ["analytics", "analytic"] },
  { module: "connectors", aliases: ["connectors", "connector"] },
  { module: "customers", aliases: ["customers", "customer"] },
  { module: "disputes", aliases: ["disputes", "dispute"] },
  { module: "payments", aliases: ["payments", "payment"] },
  { module: "refunds", aliases: ["refunds", "refund"] },
  { module: "routing", aliases: ["routing"] },
  { module: "settings", aliases: ["settings", "setting"] },
  { module: "users", aliases: ["users", "user"] },
  { module: "webhooks", aliases: ["webhooks", "webhook"] },
  { module: "auth", aliases: ["auth", "login", "signup", "signin"] },
  { module: "home", aliases: ["dashboard-home"] },
];

/**
 * Count occurrences of each module's aliases in the haystack (lowercased,
 * word-boundary-ish via simple split-on-non-alnum). Returns the module with
 * the highest count, or null if nothing matched. Ties broken by alias order
 * (first declared wins).
 */
function pickByAliasFrequency(haystack: string): string | null {
  const lower = haystack.toLowerCase();
  let bestModule: string | null = null;
  let bestCount = 0;
  let bestRank = MODULE_ALIASES.length;
  MODULE_ALIASES.forEach((entry, rank) => {
    let count = 0;
    for (const alias of entry.aliases) {
      // Use a regex with non-word boundaries to avoid partial matches
      // (e.g. "auth" shouldn't match "author"). The alias may itself contain
      // a hyphen, so escape and treat hyphen as a literal.
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "g");
      const matches = lower.match(re);
      if (matches) count += matches.length;
    }
    if (count === 0) return;
    if (
      bestModule === null ||
      count > bestCount ||
      (count === bestCount && rank < bestRank)
    ) {
      bestModule = entry.module;
      bestCount = count;
      bestRank = rank;
    }
  });
  return bestModule;
}

/**
 * Extract the changed file paths from a unified diff. Looks at the
 * `diff --git a/<path> b/<path>` headers since they reliably appear once per
 * file even for binary/renamed entries.
 */
function changedFilesFromDiff(diff: string): string[] {
  const out: string[] = [];
  const re = /^diff --git a\/(\S+) b\/(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    out.push(m[2]); // post-rename path
  }
  return out;
}

/**
 * Pick the module a planner run should target.
 *
 * - module   → lookup, throw on unknown (the user typed it; silent fallback
 *              would explore the wrong page).
 * - pr       → infer from changed file paths; fall back to PR title/body if
 *              the paths don't carry an obvious module name.
 * - scenario → infer from the scenario description text.
 * - branch   → infer from the branch name.
 *
 * Throws when no signal can be extracted. Callers should treat this as a
 * planning failure ("could not infer module") rather than letting the planner
 * silently explore /dashboard/payments.
 */
export function pickModuleForTarget(
  targetType: TargetType,
  target: string,
  pr: PullRequestInfo | null,
): ModuleSpec {
  if (targetType === "module") {
    const spec = MODULE_CATALOG[target];
    if (!spec) {
      throw new Error(
        `Unknown module "${target}". Valid keys: ${Object.keys(MODULE_CATALOG).join(", ")}`,
      );
    }
    return spec;
  }

  if (targetType === "pr") {
    if (!pr) {
      throw new Error(`PR target ${target} missing PullRequestInfo — cannot infer module`);
    }
    const files = changedFilesFromDiff(pr.diff || "");
    const fromPaths = files.length > 0 ? pickByAliasFrequency(files.join(" ")) : null;
    const fromText = pickByAliasFrequency(`${pr.title}\n${pr.body || ""}`);
    const chosen = fromPaths ?? fromText;
    if (!chosen) {
      throw new Error(
        `Could not infer dashboard module from PR #${target}. Re-run with an explicit "module: <name>" directive.`,
      );
    }
    return MODULE_CATALOG[chosen];
  }

  if (targetType === "scenario") {
    const chosen = pickByAliasFrequency(target);
    if (!chosen) {
      throw new Error(
        `Could not infer dashboard module from scenario "${target}". Re-run with "module: <name>" or include a module keyword.`,
      );
    }
    return MODULE_CATALOG[chosen];
  }

  // branch
  const chosen = pickByAliasFrequency(target);
  if (!chosen) {
    throw new Error(
      `Could not infer dashboard module from branch name "${target}". Re-run with "module: <name>".`,
    );
  }
  return MODULE_CATALOG[chosen];
}

/**
 * Setup steps derived from SKILL.md "Browser exploration - handle authentication".
 */
export function setupStepsFor(module: ModuleSpec): string[] {
  const steps = [
    "Generate unique email",
    "Create test user via signup_with_merchant_id API (signupUser)",
    "Navigate to /dashboard/login and log in via UI",
    "Handle 2FA by clicking 'Skip now'",
  ];
  if (module.prerequisites.includes("Connector")) {
    steps.push("createDummyConnectorAPI(merchantId, label, context)");
  }
  if (
    module.prerequisites.includes("Payment") ||
    module.prerequisites.includes("Payments")
  ) {
    steps.push("createPaymentAPI(merchantId, context)");
  }
  steps.push(`Navigate to ${module.path}`);
  return steps;
}

/**
 * Generator file-naming convention from SKILL.md.
 *
 *   PR       → PR-{number}-{slug}.spec.ts
 *   branch   → branch-{slug}.spec.ts
 *   module   → module-{name}.spec.ts
 *   scenario → scenario-{slug}.spec.ts
 */
export function buildTestFileName(
  targetType: TargetType,
  target: string,
): string {
  const slug = target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  switch (targetType) {
    case "pr":
      return `PR-${target}-generated.spec.ts`;
    case "branch":
      return `branch-${slug}.spec.ts`;
    case "module":
      return `module-${slug}.spec.ts`;
    case "scenario":
      return `scenario-${slug}.spec.ts`;
  }
}

export const GENERATED_TESTS_DIR = "playwright-tests/ai-generated";
export const SESSION_DIR = ".opencode/sessions/playwright-run";
