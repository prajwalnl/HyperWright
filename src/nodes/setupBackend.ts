import { ENV } from "../env.js";
import { spawnBackground } from "../runtime/exec.js";
import { isReachable, waitUntilReachable } from "../runtime/http.js";
import { abortSetupPhase } from "../runtime/setupPhase.js";
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
  let backendPid: number | null = null;
  let ok = wasUp;

  if (!wasUp) {
    l(`[setup-backend] Backend not running, starting...`);
    l(`[setup-backend] Start script: ${ENV.backend.startScript}`);

    let child;
    try {
      // serverName lands this in the ProcessRegistry so Stop kills the whole
      // backend pgrp (start_hyperswitch.sh → cargo → server) at once.
      child = spawnBackground("sh", [ENV.backend.startScript], {
        cwd: repoPath,
        serverName: "backend",
      });
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      l(`[setup-backend] ERROR: Failed to spawn backend start script: ${msg}`);
      abortSetupPhase("backend spawn failed");
      l(`[setup-backend] ========================================`);
      return respond(state, {
        phase: "failed",
        status: "failed",
        error: `Failed to spawn backend: ${msg}`,
        servers: { backendUp: false, backendWasStarted: false, backendPid: null },
        logs,
      });
    }

    // Listen for immediate spawn errors (e.g., script not found)
    child.on("error", (err) => {
      l(`[setup-backend] Spawn error event: ${err.message}`);
    });

    backendPid = child.pid ?? null;
    backendWasStarted = true;
    l(`[setup-backend] Backend spawned with PID: ${backendPid ?? "unknown"}`);
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
    if (backendPid) {
      l(`[setup-backend] Killing backend process ${backendPid}...`);
      try { process.kill(backendPid); } catch { /* already gone */ }
    }
    abortSetupPhase("backend setup failed");
    l(`[setup-backend] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Backend did not come up at ${ENV.backend.healthUrl}`,
      servers: { backendUp: false, backendWasStarted, backendPid },
      logs,
    });
  }

  l(`[setup-backend] Backend is UP and reachable`);
  l(`[setup-backend] Backend ${wasUp ? "was already up" : "was started"}`);
  if (backendPid) {
    l(`[setup-backend] Backend PID: ${backendPid}`);
  }
  l(`[setup-backend] NODE COMPLETE`);
  l(`[setup-backend] ========================================`);

  return respond(state, {
    servers: { backendUp: true, backendWasStarted, backendPid },
    logs,
  });
}
