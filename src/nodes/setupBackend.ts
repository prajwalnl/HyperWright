import { ENV } from "../env.js";
import { spawnBackground } from "../runtime/exec.js";
import { isReachable, waitUntilReachable } from "../runtime/http.js";
import { loggerFor } from "../session/log.js";
import { respond } from "../session/respond.js";
import type { QAStateType, QAStateUpdate } from "../state.js";

export async function setupBackendNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("setupBackend", logs);
  l(`[setup-backend] ========================================`);
  l(`[setup-backend] NODE START: setupBackend`);

  const repoPath = state.repo.repoPath || process.cwd();
  l(`[setup-backend] Working directory: ${repoPath}`);
  l(`[setup-backend] Health URL: ${ENV.backend.healthUrl}`);

  l(`[setup-backend] Checking if backend is already reachable...`);
  const wasUp = await isReachable(ENV.backend.healthUrl);
  l(`[setup-backend] Backend was ${wasUp ? "UP" : "DOWN"}`);

  let backendWasStarted = false;
  let ok = wasUp;

  if (!wasUp) {
    l(`[setup-backend] Backend not running, starting...`);
    l(`[setup-backend] Start script: ${ENV.backend.startScript}`);
    spawnBackground("sh", [ENV.backend.startScript], { cwd: repoPath });
    backendWasStarted = true;
    l(`[setup-backend] Waiting for backend to become reachable...`);
    l(`[setup-backend] Timeout: ${ENV.backend.startTimeoutMs}ms, Poll interval: ${ENV.backend.pollStepMs}ms`);

    ok = await waitUntilReachable(ENV.backend.healthUrl, {
      totalMs: ENV.backend.startTimeoutMs,
      stepMs: ENV.backend.pollStepMs,
    });

    l(`[setup-backend] Backend reachability check result: ${ok ? "SUCCESS" : "FAILED"}`);
  } else {
    l(`[setup-backend] Backend already running, skipping start`);
  }

  if (!ok) {
    l(`[setup-backend] ERROR: Backend did not come up`);
    l(`[setup-backend] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Backend did not come up at ${ENV.backend.healthUrl}`,
      servers: { backendUp: false, backendWasStarted },
      logs,
    });
  }

  l(`[setup-backend] Backend is UP and reachable`);
  l(`[setup-backend] Backend ${wasUp ? "was already up" : "was started"}`);
  l(`[setup-backend] NODE COMPLETE`);
  l(`[setup-backend] ========================================`);

  return respond(state, {
    servers: { backendUp: true, backendWasStarted },
    logs,
  });
}
