import * as dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve `.env` relative to this source file, not process.cwd(), so the
// example works whether you run it from examples/playwright/ or from
// examples/playwright/web-ui/.
const EXAMPLE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
dotenv.config({ path: path.join(EXAMPLE_ROOT, ".env") });

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const ENV = {
  litellm: {
    baseURL: req("LITELLM_BASE_URL", "http://localhost:4000/v1"),
    apiKey: req("LITELLM_API_KEY", "sk-must-override-via-.env"),
    model: req("LITELLM_MODEL", "gpt-4o-mini"),
    temperature: Number(opt("LITELLM_TEMPERATURE", "0")),
    maxTokens: Number(opt("LITELLM_MAX_TOKENS", "4096")),
  },
  backend: {
    healthUrl: opt("HYPERSWITCH_HEALTH_URL", "http://localhost:8080/health"),
    startScript: opt(
      "HYPERSWITCH_START_SCRIPT",
      "playwright-tests/start_hyperswitch.sh",
    ),
    stopCwd: opt("HYPERSWITCH_STOP_CWD", "hyperswitch"),
    startTimeoutMs: Number(opt("BACKEND_START_TIMEOUT_MS", "240000")),
    pollStepMs: Number(opt("BACKEND_POLL_STEP_MS", "5000")),
  },
  frontend: {
    url: opt("FRONTEND_URL", "http://localhost:9000"),
    port: Number(opt("FRONTEND_PORT", "9000")),
    buildCmd: opt("FRONTEND_BUILD_CMD", "npm run re:start"),
    startCmd: opt("FRONTEND_START_CMD", "npm run start"),
    startTimeoutMs: Number(opt("FRONTEND_START_TIMEOUT_MS", "240000")),
    pollStepMs: Number(opt("FRONTEND_POLL_STEP_MS", "5000")),
  },
  paths: {
    generatedTestsDir: opt("GENERATED_TESTS_DIR", "playwright-tests/ai-generated"),
    existingTestsDir: opt("EXISTING_TESTS_DIR", "playwright-tests/e2e"),
    pageObjectsDir: opt("PAGE_OBJECTS_DIR", "playwright-tests/support/pages"),
  },
  playwrightPassword: opt("PLAYWRIGHT_PASSWORD", "Test@123456"),
  enableBrowserTools: opt("ENABLE_BROWSER_TOOLS", "1") === "1",
};

export function maskedEnvSummary(): string {
  const mask = (s: string) =>
    s.length <= 8 ? "***" : `${s.slice(0, 4)}…${s.slice(-4)}`;
  return [
    `litellm.baseURL=${ENV.litellm.baseURL}`,
    `litellm.model=${ENV.litellm.model}`,
    `litellm.apiKey=${mask(ENV.litellm.apiKey)}`,
    `backend=${ENV.backend.healthUrl}`,
    `frontend=${ENV.frontend.url}`,
    `enableBrowserTools=${ENV.enableBrowserTools}`,
  ].join(" | ");
}
