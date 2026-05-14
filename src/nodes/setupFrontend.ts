import { ENV } from "../env.js";
import { killByPort, run, spawnBackground } from "../runtime/exec.js";
import { isReachable, waitUntilReachable } from "../runtime/http.js";
import { createNodeLogger, loggerFor } from "../session/log.js";
import { respond } from "../session/respond.js";
import type { QAStateType, QAStateUpdate } from "../state.js";

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

  l(`[setup-frontend] Checking if frontend is already running...`);
  // Each session may target a different PR / branch, so a frontend that's
  // already on :9000 is almost certainly stale code from a previous run.
  // Always kill + reinstall + rebuild + restart so the dashboard reflects
  // the current cloned working tree.
  if (await isReachable(ENV.frontend.url)) {
    l(`[setup-frontend] Port ${ENV.frontend.port} is occupied — killing stale frontend`);
    await killByPort(ENV.frontend.port, stream);
    l(`[setup-frontend] Killed process on port ${ENV.frontend.port}`);
  } else {
    l(`[setup-frontend] Port ${ENV.frontend.port} is free`);
    // Belt-and-braces: a dead-but-bound process can still hold the port
    // (crashed dev server that didn't free its socket). Try to free it
    // anyway — killByPort is a no-op if nothing's actually there.
    await killByPort(ENV.frontend.port, stream);
  }

  l(`[setup-frontend] Step 1/4: Installing npm dependencies...`);
  l(`[setup-frontend] Running: npm install`);
  const install = await run(
    "sh",
    ["-c", `cd "${repoPath}" && npm install`],
    {
      onStdout: (line) => stream(`  npm install: ${line}`),
      onStderr: (line) => stream(`  npm install: ${line}`),
    },
  );
  l(`[setup-frontend] npm install exited with code: ${install.code}`);

  if (install.code !== 0) {
    l(`[setup-frontend] ERROR: npm install failed`);
    l(`[setup-frontend] Stderr: ${install.stderr.slice(0, 500)}`);
    l(`[setup-frontend] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `npm install failed (exit ${install.code})`,
      servers: { frontendUp: false, frontendWasStarted: false, frontendPid: null },
      logs,
    });
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
    },
  );
  l(`[setup-frontend] Build exited with code: ${build.code}`);

  if (build.code !== 0) {
    l(`[setup-frontend] ERROR: Frontend build failed`);
    l(`[setup-frontend] Stderr: ${build.stderr.slice(0, 500)}`);
    l(`[setup-frontend] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Frontend build failed (exit ${build.code})`,
      servers: { frontendUp: false, frontendWasStarted: false, frontendPid: null },
      logs,
    });
  }
  l(`[setup-frontend] Frontend build completed successfully`);

  l(`[setup-frontend] Step 3/4: Starting frontend server...`);
  l(`[setup-frontend] Start command: ${ENV.frontend.startCmd}`);
  const child = spawnBackground("sh", ["-c", `cd "${repoPath}" && ${ENV.frontend.startCmd}`]);
  child.unref();
  const frontendPid = child.pid ?? null;
  l(`[setup-frontend] Frontend spawned with PID: ${frontendPid}`);

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
    l(`[setup-frontend] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Frontend did not come up at ${ENV.frontend.url}`,
      servers: { frontendUp: false, frontendWasStarted: true, frontendPid },
      logs,
    });
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
