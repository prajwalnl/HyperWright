import { ENV } from "../env.js";
import { run, spawnBackground } from "../runtime/exec.js";
import { ensurePortFree } from "../runtime/ports.js";
import { waitUntilReachable } from "../runtime/http.js";
import {
  abortSetupPhase,
  setupPhaseSignal,
  throwIfSetupAborted,
} from "../runtime/setupPhase.js";
import { createNodeLogger, loggerFor } from "../session/log.js";
import { respond } from "../session/respond.js";
import type { QAStateType, QAStateUpdate } from "../state.js";
import type { Servers } from "../types.js";

export async function setupFrontendNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("setupFrontend", logs);
  // stream — used for noisy child-process stdout/stderr. Writes to
  // logs/setupFrontend.log + SSE but NOT to state.logs, so a successful
  // npm install doesn't bloat the state checkpoint with thousands of lines.
  const stream = createNodeLogger("setupFrontend");
  l(`[setup-frontend] ========================================`);
  l(`[setup-frontend] NODE START: setupFrontend`);

  const repoPath = state.repo.repoPath || process.cwd();
  l(`[setup-frontend] Working directory: ${repoPath}`);
  l(`[setup-frontend] Frontend URL: ${ENV.frontend.url}`);
  l(`[setup-frontend] Frontend port: ${ENV.frontend.port}`);

  // Helper: most of setupFrontend's failure paths look the same. Centralize
  // the "abort the sibling + return failed" boilerplate so we don't drift.
  const fail = async (
    error: string,
    serverPatch: Partial<Servers> = { frontendUp: false, frontendWasStarted: false, frontendPid: null },
  ): Promise<QAStateUpdate> => {
    abortSetupPhase("frontend setup failed");
    l(`[setup-frontend] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error,
      servers: serverPatch,
      logs,
    });
  };

  // Per-call signal so a backend failure SIGTERMs the in-flight npm install /
  // build instead of letting them grind to completion before setupJoin notices.
  const phaseSignal = setupPhaseSignal() ?? undefined;

  l(`[setup-frontend] Ensuring port ${ENV.frontend.port} is free...`);
  // Each session may target a different PR / branch, so a frontend that's
  // already on :9000 is almost certainly stale code from a previous run.
  // ensurePortFree multi-pass + pgrp-signals defeats both crashed-but-bound
  // sockets AND respawn wrappers (nodemon / concurrently); the old
  // killByPort signalled one pid and never re-checked.
  const portResult = await ensurePortFree(ENV.frontend.port, { log: stream });
  if (!portResult.ok) {
    l(`[setup-frontend] ERROR: Could not free port ${ENV.frontend.port} after ${portResult.passes} passes`);
    return fail(`Port ${ENV.frontend.port} is still held after ${portResult.passes} kill passes`);
  }
  l(`[setup-frontend] Port ${ENV.frontend.port} is free (took ${portResult.passes} pass(es))`);

  try { throwIfSetupAborted(); } catch (e) {
    l(`[setup-frontend] aborted by sibling: ${(e as Error).message}`);
    return respond(state, { phase: "failed", status: "failed", error: (e as Error).message, logs });
  }

  l(`[setup-frontend] Step 1/4: Installing npm dependencies...`);
  l(`[setup-frontend] Running: npm install`);
  const install = await run(
    "sh",
    ["-c", `cd "${repoPath}" && npm install`],
    {
      onStdout: (line) => stream(`  npm install: ${line}`),
      onStderr: (line) => stream(`  npm install: ${line}`),
      signal: phaseSignal,
    },
  );
  l(`[setup-frontend] npm install exited with code: ${install.code}`);

  // The signal-fired path produces a non-zero exit because run() SIGTERMs the
  // child. Distinguish "sibling aborted us" from "npm install genuinely failed".
  if (phaseSignal?.aborted) {
    const reason = (phaseSignal.reason as Error | undefined)?.message ?? "aborted by sibling";
    l(`[setup-frontend] aborted mid-install: ${reason}`);
    return respond(state, { phase: "failed", status: "failed", error: reason, logs });
  }

  if (install.code !== 0) {
    l(`[setup-frontend] ERROR: npm install failed`);
    l(`[setup-frontend] Stderr: ${install.stderr.slice(0, 500)}`);
    return fail(`npm install failed (exit ${install.code})`);
  }
  l(`[setup-frontend] npm install completed successfully`);

  l(`[setup-frontend] Step 2/4: Building frontend...`);
  l(`[setup-frontend] Build command: ${ENV.frontend.buildCmd}`);
  const build = await run(
    "sh",
    ["-c", `cd "${repoPath}" && ${ENV.frontend.buildCmd}`],
    {
      onStdout: (line) => stream(`  build: ${line}`),
      onStderr: (line) => stream(`  build: ${line}`),
      signal: phaseSignal,
    },
  );
  l(`[setup-frontend] Build exited with code: ${build.code}`);

  if (phaseSignal?.aborted) {
    const reason = (phaseSignal.reason as Error | undefined)?.message ?? "aborted by sibling";
    l(`[setup-frontend] aborted mid-build: ${reason}`);
    return respond(state, { phase: "failed", status: "failed", error: reason, logs });
  }

  if (build.code !== 0) {
    l(`[setup-frontend] ERROR: Frontend build failed`);
    l(`[setup-frontend] Stderr: ${build.stderr.slice(0, 500)}`);
    return fail(`Frontend build failed (exit ${build.code})`);
  }
  l(`[setup-frontend] Frontend build completed successfully`);

  try { throwIfSetupAborted(); } catch (e) {
    l(`[setup-frontend] aborted by sibling: ${(e as Error).message}`);
    return respond(state, { phase: "failed", status: "failed", error: (e as Error).message, logs });
  }

  l(`[setup-frontend] Step 3/4: Starting frontend server...`);
  l(`[setup-frontend] Start command: ${ENV.frontend.startCmd}`);

  let child;
  try {
    // serverName + port wire this into the ProcessRegistry, so runner.stop()
    // can signal the entire pgrp (sh → npm → vite/webpack → workers) at once
    // instead of relying on the next setupFrontend run to find the orphan.
    child = spawnBackground(
      "sh",
      ["-c", `cd "${repoPath}" && ${ENV.frontend.startCmd}`],
      { serverName: "frontend", port: ENV.frontend.port },
    );
  } catch (spawnErr) {
    const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
    l(`[setup-frontend] ERROR: Failed to spawn frontend start command: ${msg}`);
    return fail(`Failed to spawn frontend: ${msg}`);
  }

  // Listen for immediate spawn errors (e.g., command not found)
  child.on("error", (err) => {
    l(`[setup-frontend] Spawn error event: ${err.message}`);
  });

  child.unref();
  const frontendPid = child.pid ?? null;
  l(`[setup-frontend] Frontend spawned with PID: ${frontendPid ?? "unknown"}`);

  l(`[setup-frontend] Step 4/4: Waiting for frontend to become reachable...`);
  l(`[setup-frontend] Timeout: ${ENV.frontend.startTimeoutMs}ms, Poll interval: ${ENV.frontend.pollStepMs}ms`);
  const ok = await waitUntilReachable(ENV.frontend.url, {
    totalMs: ENV.frontend.startTimeoutMs,
    stepMs: ENV.frontend.pollStepMs,
  });
  l(`[setup-frontend] Frontend reachability check result: ${ok ? "SUCCESS" : "FAILED"}`);

  if (!ok) {
    l(`[setup-frontend] ERROR: Frontend did not come up`);
    if (frontendPid) {
      l(`[setup-frontend] Killing frontend process ${frontendPid}...`);
      try { process.kill(frontendPid); } catch { /* already gone */ }
    }
    return fail(
      `Frontend did not come up at ${ENV.frontend.url}`,
      { frontendUp: false, frontendWasStarted: true, frontendPid },
    );
  }

  l(`[setup-frontend] Frontend is UP and reachable at ${ENV.frontend.url}`);
  l(`[setup-frontend] PID: ${frontendPid}`);
  l(`[setup-frontend] NODE COMPLETE`);
  l(`[setup-frontend] ========================================`);

  return respond(state, {
    servers: { frontendUp: true, frontendWasStarted: true, frontendPid },
    logs,
  });
}
