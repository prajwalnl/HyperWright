/**
 * Setup-phase abort coordination.
 *
 * setupBackend and setupFrontend fan out in parallel from setupContext. If
 * one fails fast (port held, build error, script missing), the other would
 * otherwise burn 5+ minutes on `npm install` / build / start before
 * setupJoin sees the failure and bails. This module gives both nodes a
 * shared AbortSignal — each:
 *
 *   1. calls `setupPhaseSignal()` to get the current controller's signal
 *   2. checks it at yield points (between npm install / build / start)
 *   3. on its own failure, calls `abortSetupPhase("backend ...")` so the
 *      sibling sees signal.aborted at its next check.
 *
 * Reset at the start of every workflow via `resetSetupPhase()` — setupContext
 * is the natural place (it's the first node and runs before the fan-out).
 *
 * Module-level state is acceptable because the runner enforces single-flight
 * workflows (same justification as runtime/context.ts).
 */

let controller: AbortController | null = null;

export function resetSetupPhase(): void {
  controller = new AbortController();
}

export function setupPhaseSignal(): AbortSignal | null {
  return controller?.signal ?? null;
}

export function abortSetupPhase(reason: string): void {
  controller?.abort(new Error(reason));
}

/**
 * Throw if the setup phase has been aborted by a sibling. Cheap; call between
 * long steps (npm install → build → start) so the other half doesn't keep
 * working after a fast failure.
 */
export function throwIfSetupAborted(): void {
  if (controller?.signal.aborted) {
    const reason =
      (controller.signal.reason as Error | undefined)?.message ??
      "setup-phase aborted by sibling";
    throw new Error(reason);
  }
}
