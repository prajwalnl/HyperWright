import { randomUUID } from "node:crypto";
import { ENV } from "../env.js";
import { signupWithMerchantId } from "../runtime/hyperswitchApi.js";
import { loggerFor } from "../session/log.js";
import { respond } from "../session/respond.js";
import type { QAStateType, QAStateUpdate } from "../state.js";
import type { Creds } from "../types.js";

/** Fan-in for setupBackend + setupFrontend. After both are up, also signs up
 * the session-wide test user via signup_with_merchant_id and stashes the creds
 * in state + session.json so planner / healer can reuse them via
 * planner_setup_page (no per-call signup). Generated test specs continue to
 * create their own per-test users in beforeEach. */
export async function setupJoinNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("setupJoin", logs);
  l(`[setup-join] ========================================`);
  l(`[setup-join] NODE START: setupJoin`);

  const { backendUp, frontendUp } = state.servers;
  l(`[setup-join] Backend status: ${backendUp ? "UP" : "DOWN"}`);
  l(`[setup-join] Frontend status: ${frontendUp ? "UP" : "DOWN"}`);

  if (!backendUp || !frontendUp) {
    l(`[setup-join] ERROR: Environment setup failed`);
    l(`[setup-join] ========================================`);
    l(`[setup-join] verification failed`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Environment setup failed (backend=${backendUp}, frontend=${frontendUp})`,
      logs,
    });
  }

  l(`[setup-join] Both services are healthy`);

  let creds: Creds | null = state.creds ?? null;
  if (!creds) {
    creds = {
      email: `test_${Date.now()}_${randomUUID().slice(0, 8)}@example.com`,
      password: ENV.playwrightPassword,
    };
    l(`[setup-join] Creating session user: ${creds.email}`);
    const ok = await signupSessionUser(creds, l);
    if (!ok) {
      l(`[setup-join] ERROR: Session user signup failed`);
      l(`[setup-join] ========================================`);
      return respond(state, {
        phase: "failed",
        status: "failed",
        error: `Session user signup failed for ${creds.email}`,
        logs,
      });
    }
    l(`[setup-join] Session user created`);
  } else {
    l(`[setup-join] Reusing existing session user: ${creds.email}`);
  }

  l(`[setup-join] NODE COMPLETE`);
  l(`[setup-join] ========================================`);

  return respond(state, {
    creds,
    phase: "setup",
    phaseHistory: ["setup"],
    logs,
  });
}

async function signupSessionUser(
  creds: Creds,
  l: (line: string) => void,
): Promise<boolean> {
  const result = await signupWithMerchantId(creds);
  l(`[setup-join] signup_with_merchant_id → ${result.status || "(no response)"}`);
  if (!result.ok) {
    // Surface the response body so a 400 / 422 actually tells us what's wrong
    // (missing field, password complexity, duplicate user, etc.) instead of
    // failing opaquely.
    const tail = (result.body ?? "").slice(0, 500);
    if (tail) l(`[setup-join] signup response body: ${tail}`);
  }
  return result.ok;
}
