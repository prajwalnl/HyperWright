import type { TargetType } from "./types.js";

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
