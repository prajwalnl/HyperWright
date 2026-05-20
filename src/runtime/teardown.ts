import { ENV } from "../env.js";
import { killPid, run } from "./exec.js";
import type { Servers } from "../types.js";

/**
 * Shape returned by stopServers — lets callers update their state snapshot
 * to reflect the new server-down values without duplicating the merge
 * locally. `frontendStopped`/`backendStopped` distinguish "we asked it to
 * stop" from "it was already down".
 */
export interface TeardownResult {
  frontendStopped: boolean;
  backendStopped: boolean;
}

/**
 * Stop the backend and frontend servers we started this session. Each kill
 * is wrapped in its own try/catch so a docker-down failure can't skip the
 * frontend kill (or vice versa). Idempotent: gated on `*WasStarted` flags,
 * so calling on a session that never started servers is a cheap no-op.
 *
 * Shared by:
 *   - the manual "Stop Servers" button in the web-ui (runner.stopServers)
 *   - any future graph node that needs explicit teardown
 *
 * The `summary` node no longer calls this automatically — teardown is now
 * user-triggered to support continuous-development iteration where servers
 * persist across runs.
 */
export async function stopServers(
  servers: Servers,
  repoPath: string,
  log: (line: string) => void,
): Promise<TeardownResult> {
  let frontendStopped = false;
  let backendStopped = false;

  if (servers.frontendWasStarted && servers.frontendPid != null) {
    try {
      log(`[teardown] Stopping frontend (PID: ${servers.frontendPid})...`);
      await killPid(servers.frontendPid, "SIGTERM");
      frontendStopped = true;
      log(`[teardown] Frontend stopped`);
    } catch (err) {
      log(`[teardown] Frontend stop warning: ${(err as Error).message}`);
    }
  } else {
    log(`[teardown] Frontend: not started, skipping`);
  }

  if (servers.backendWasStarted) {
    try {
      const backendCwd = `${repoPath}/${ENV.backend.stopCwd}`;
      log(`[teardown] Stopping backend at ${backendCwd}...`);
      const r = await run("sh", ["-c", "docker compose down -v"], {
        cwd: backendCwd,
      });
      if (r.code === 0) {
        backendStopped = true;
        log(`[teardown] Backend stopped`);
      } else {
        log(`[teardown] Backend stop exited ${r.code} (continuing)`);
      }
    } catch (err) {
      log(`[teardown] Backend stop warning: ${(err as Error).message}`);
    }
  } else {
    log(`[teardown] Backend: not started, skipping`);
  }

  return { frontendStopped, backendStopped };
}
