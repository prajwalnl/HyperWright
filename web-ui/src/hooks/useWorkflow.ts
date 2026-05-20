import { useCallback, useEffect, useRef, useState } from "react";
import type {
  InterruptPayload,
  StartRequest,
  WorkflowEvent,
  WorkflowSnapshot,
} from "../types.js";
import type { RunStatus } from "../../server/types.js";
import type { UserChoice } from "../../../src/types.js";

const STORAGE_KEY = "qa-workflow-state-v1";

interface PersistedState {
  snapshot: WorkflowSnapshot | null;
  currentNodes: string[];
  nextNodes: string[];
  visitedNodes: string[];
  logsByNode: Array<[string, string[]]>;
  runStatus: RunStatus;
  error: string | null;
  interruptPayload: InterruptPayload | null;
}

function serializeState(state: WorkflowState): PersistedState {
  return {
    snapshot: state.snapshot,
    currentNodes: Array.from(state.currentNodes),
    nextNodes: Array.from(state.nextNodes),
    visitedNodes: Array.from(state.visitedNodes),
    logsByNode: Array.from(state.logsByNode.entries()),
    runStatus: state.runStatus,
    error: state.error,
    interruptPayload: state.interruptPayload,
  };
}

function deserializeState(persisted: PersistedState): WorkflowState {
  // Live runStatus values (running / paused / stopping) describe an
  // in-process server workflow. After a page reload no such workflow exists
  // from the client's perspective; the SSE replay will re-emit the actual
  // current status if it's still live. So we collapse those to "stopped" /
  // "idle" pending the server's word.
  const persistedStatus = persisted.runStatus ?? "idle";
  const status: RunStatus =
    persistedStatus === "running" ||
    persistedStatus === "paused" ||
    persistedStatus === "stopping"
      ? "stopped"
      : persistedStatus;
  return {
    snapshot: persisted.snapshot,
    currentNodes: new Set(persisted.currentNodes),
    nextNodes: new Set(persisted.nextNodes),
    visitedNodes: new Set(persisted.visitedNodes),
    logsByNode: new Map(persisted.logsByNode),
    runStatus: status,
    error: persisted.error,
    interruptPayload: persisted.interruptPayload ?? null,
  };
}

function loadPersistedState(): WorkflowState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    return deserializeState(parsed);
  } catch {
    return null;
  }
}

function savePersistedState(state: WorkflowState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState(state)));
  } catch {
  }
}

export interface WorkflowState {
  snapshot: WorkflowSnapshot | null;
  currentNodes: Set<string>;
  nextNodes: Set<string>;
  visitedNodes: Set<string>;
  logsByNode: Map<string, string[]>;
  /**
   * Source of truth for the runner lifecycle on the client. All button
   * enablement and badge labels derive from this; the old `running`,
   * `finished`, `stopped`, `awaitingChoice` booleans are computed properties
   * on top of it (see `deriveFlags` in App.tsx).
   */
  runStatus: RunStatus;
  error: string | null;
  /**
   * Payload from the `interrupt()` inside the `summary` node — populated
   * when runStatus is "paused" and consumed by HITLBar to render the bug
   * report preview alongside the choice buttons. Null otherwise.
   */
  interruptPayload: InterruptPayload | null;
}

// Map each phase to ONLY the nodes that are guaranteed to have run once that
// phase first appears in phaseHistory. `setup` is emitted by both setupContext
// (end of parse+clone) and setupJoin (after the parallel backend/frontend
// branches fan in), so when phaseHistory first contains "setup" we can only
// say setupContext has finished — setupBackend/setupFrontend/setupJoin are
// tracked via per-chunk currentNodes as they actually complete.
const PHASE_TO_NODES: Record<string, string[]> = {
  setup: ["setupContext"],
  planning: ["planTests"],
  "planning-complete": ["planTests"],
  generating: ["generateTests"],
  "generating-complete": ["generateTests"],
  healing: ["healTests"],
  "healing-complete": ["healTests"],
  // `summary` now owns the awaiting-choice + finalizing phases — both happen
  // inside the single terminal node, not in a separate `finalize` node.
  "awaiting-user-choice": ["summary"],
  finalizing: ["summary"],
  complete: ["summary"],
  failed: ["summary"],
};

const INITIAL_STATE: WorkflowState = {
  snapshot: null,
  currentNodes: new Set(),
  nextNodes: new Set(),
  visitedNodes: new Set(),
  logsByNode: new Map(),
  runStatus: "idle",
  error: null,
  interruptPayload: null,
};

export function useWorkflow(): {
  state: WorkflowState;
  start: (req: StartRequest) => Promise<void>;
  resume: (choice: UserChoice) => Promise<void>;
  stop: () => Promise<void>;
  stopServers: () => Promise<void>;
  reset: () => Promise<void>;
} {
  const [state, setState] = useState<WorkflowState>(() => loadPersistedState() ?? INITIAL_STATE);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    savePersistedState(state);
  }, [state]);

  useEffect(() => {
    const es = new EventSource("/api/workflow/stream");
    esRef.current = es;

    const handler = (event: MessageEvent) => {
      try {
        const evt = JSON.parse(event.data) as WorkflowEvent;
        setState((prev) => reduce(prev, evt));
      } catch {
        /* ignore malformed */
      }
    };

    for (const t of [
      "started",
      "state",
      "log",
      "awaiting_choice",
      "stopping",
      "finished",
      "stopped",
      "reset",
      "error",
    ]) {
      es.addEventListener(t, handler);
    }

    return () => es.close();
  }, []);

  const start = useCallback(async (req: StartRequest) => {
    // Seed nextNodes with setupContext so the graph shows it as "running"
    // immediately. The server's first `state` event only fires once
    // setupContext *completes*, so without this seed the first node would
    // sit idle until done, then jump straight to green.
    setState(() => ({
      ...INITIAL_STATE,
      runStatus: "running",
      nextNodes: new Set(["setupContext"]),
    }));
    const res = await fetch("/api/workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setState((prev) => ({
        ...prev,
        runStatus: "failed",
        error: body.error ?? `HTTP ${res.status}`,
      }));
    }
  }, []);

  const resume = useCallback(async (choice: UserChoice) => {
    await fetch("/api/workflow/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice }),
    });
  }, []);

  const stop = useCallback(async () => {
    await fetch("/api/workflow/stop", { method: "POST" });
  }, []);

  const stopServers = useCallback(async () => {
    await fetch("/api/workflow/stop-servers", { method: "POST" });
  }, []);

  const reset = useCallback(async () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    await fetch("/api/workflow/clear", { method: "POST" });
    setState(INITIAL_STATE);
  }, []);

  return { state, start, resume, stop, stopServers, reset };
}

function reduce(prev: WorkflowState, evt: WorkflowEvent): WorkflowState {
  switch (evt.type) {
    case "started":
      return {
        ...prev,
        runStatus: "running",
        error: null,
      };
    case "state": {
      const current = new Set(evt.currentNodes);
      const next = new Set(evt.nextNodes);
      const visited = new Set(prev.visitedNodes);
      for (const n of evt.currentNodes) visited.add(n);
      for (const ph of evt.snapshot.phaseHistory) {
        for (const n of PHASE_TO_NODES[ph] ?? []) visited.add(n);
      }
      return {
        ...prev,
        snapshot: evt.snapshot,
        currentNodes: current,
        nextNodes: next,
        visitedNodes: visited,
      };
    }
    case "log": {
      const logs = new Map(prev.logsByNode);
      const arr = logs.get(evt.node) ?? [];
      logs.set(evt.node, [...arr, evt.line]);
      return { ...prev, logsByNode: logs };
    }
    case "awaiting_choice":
      return {
        ...prev,
        runStatus: "paused",
        interruptPayload: evt.payload ?? prev.interruptPayload,
      };
    case "stopping":
      return { ...prev, runStatus: "stopping" };
    case "finished":
      return {
        ...prev,
        runStatus: evt.status === "failed" ? "failed" : "complete",
        currentNodes: new Set(),
        nextNodes: new Set(),
        interruptPayload: null,
      };
    case "stopped":
      return {
        ...prev,
        runStatus: "stopped",
        currentNodes: new Set(),
        nextNodes: new Set(),
        interruptPayload: null,
      };
    case "reset":
      // Server-initiated reset (rare — usually the client drives it via the
      // reset callback, which also clears localStorage). When it does arrive,
      // collapse to the initial state.
      return { ...INITIAL_STATE };
    case "error":
      return { ...prev, error: evt.message, runStatus: "failed" };
    default:
      return prev;
  }
}
