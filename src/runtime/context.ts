/**
 * Workflow-scoped AbortSignal.
 *
 * Set by the runner immediately before invoking the graph, cleared in the
 * `finally`. Nodes and helpers (`run`, `isReachable`, `runSubAgent`, …)
 * read from here so that Stop interrupts in-flight HTTP / LLM / child-process
 * work instead of letting it run to completion in the background.
 *
 * Module-level state is acceptable because the runner enforces single-flight
 * workflows (runStatus guard in start()).
 */

let currentSignal: AbortSignal | null = null;

export function setRuntimeSignal(signal: AbortSignal | null): void {
  currentSignal = signal;
}

export function getRuntimeSignal(): AbortSignal | null {
  return currentSignal;
}

/**
 * Throw if Stop has been requested. Cheap to call frequently; use this at
 * the top of long-running loops or between expensive steps. The thrown
 * error is shaped to match Node's standard AbortError so existing
 * .match(/abort/i) checks in handleStreamError continue to work.
 */
export function throwIfAborted(): void {
  if (currentSignal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Combine the workflow signal with an additional one (e.g. a per-call
 * timeout) so the resulting signal aborts when either does. Returns the
 * additional signal as-is if no workflow signal is set.
 */
export function combineSignals(extra: AbortSignal): AbortSignal {
  if (!currentSignal) return extra;
  // AbortSignal.any exists on Node 20+; if it's missing fall back to a
  // controller that listens to both.
  const anyCtor = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyCtor === "function") return anyCtor([currentSignal, extra]);
  const ac = new AbortController();
  const fwd = () => ac.abort();
  if (currentSignal.aborted) ac.abort();
  else currentSignal.addEventListener("abort", fwd, { once: true });
  if (extra.aborted) ac.abort();
  else extra.addEventListener("abort", fwd, { once: true });
  return ac.signal;
}
