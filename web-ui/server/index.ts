import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { runner } from "./runner.js";
import type { StartRequest, WorkflowEvent } from "./types.js";
import type { UserChoice } from "../../src/types.js";

const app = new Hono();

app.use("/api/*", cors({ origin: "*" }));

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/workflow/status", (c) => c.json(runner.status()));

app.get("/api/workflow/sessions", async (c) => {
  const sessions = await runner.listSessions();
  return c.json(sessions);
});

app.post("/api/workflow/sessions/:id/load", async (c) => {
  const id = c.req.param("id");
  const ok = await runner.loadSession(id);
  if (!ok) return c.json({ error: "Session not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/workflow/nodes/:id/logs", (c) => {
  const id = c.req.param("id");
  return c.json({ node: id, lines: runner.getNodeLogs(id) });
});

app.post("/api/workflow/start", async (c) => {
  let body: StartRequest;
  try {
    body = await c.req.json<StartRequest>();
  } catch (err) {
    return c.json({ error: `invalid JSON body: ${(err as Error).message}` }, 400);
  }
  if (!body?.rawInput || typeof body.rawInput !== "string") {
    return c.json({ error: "rawInput is required" }, 400);
  }
  // Fire and forget — the client subscribes via SSE for progress. But we
  // synchronously check for the "already running" case so the user sees a
  // real 409 instead of staring at a silent UI. Other errors propagate via
  // the SSE `error` event.
  try {
    if (runner.status().running) {
      return c.json({ error: "A workflow is already running" }, 409);
    }
    // Clamp heal-attempts to a sane range so a typo'd 0 doesn't skip healing
    // entirely and a typo'd 999 doesn't stall the run forever.
    let maxHealingAttempts: number | undefined;
    if (typeof body.maxHealingAttempts === "number") {
      const n = Math.trunc(body.maxHealingAttempts);
      if (Number.isFinite(n)) {
        maxHealingAttempts = Math.max(1, Math.min(10, n));
      }
    }
    void runner
      .start(body.rawInput.trim(), body.targetType, maxHealingAttempts)
      .catch((err) => {
        console.error("[runner.start] failed:", err);
      });
    return c.json({ ok: true });
  } catch (err) {
    console.error("[/api/workflow/start] error:", err);
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/workflow/resume", async (c) => {
  const body = await c.req.json<{ choice: UserChoice }>();
  const valid: UserChoice[] = ["commit-push", "cleanup"];
  if (!valid.includes(body.choice)) {
    return c.json(
      { error: "choice must be commit-push | cleanup" },
      400,
    );
  }
  try {
    runner.resume(body.choice).catch(() => {
      /* error surfaces via SSE */
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
});

app.post("/api/workflow/stop", (c) => {
  try {
    runner.stop();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/workflow/clear", async (c) => {
  try {
    await runner.clear();
    return c.json({ ok: true });
  } catch (err) {
    console.error("[/api/workflow/clear] error:", err);
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/workflow/stream", (c) => {
  return streamSSE(c, async (sse) => {
    const status = runner.status();
    if (status.snapshot) {
      // On (re)connect — including after a laptop sleep that dropped the SSE
      // or a page reload that discarded client state — replay enough events
      // to let a fresh client reconstruct the live lifecycle:
      //   1. `started` (if still running) so state.running becomes true again
      //   2. `state` with the real nextNodes (not []), so the running node
      //      keeps glowing and the canvas stays in sync
      //   3. terminal event (finished / stopped / error) if the workflow
      //      ended while the client was disconnected
      //   4. `awaiting_choice` if paused at HITL
      if (status.running) {
        await writeEvent(sse, {
          type: "started",
          thread: status.threadId ?? status.snapshot.sessionId,
        });
      }
      await writeEvent(sse, {
        type: "state",
        snapshot: status.snapshot,
        currentNodes: status.currentNodes,
        nextNodes: status.nextNodes,
      });
      if (!status.running && status.terminal) {
        await writeEvent(sse, status.terminal);
      }
      if (status.awaitingChoice) {
        await writeEvent(sse, { type: "awaiting_choice" });
      }
    }

    const unsubscribe = runner.subscribe((event) => {
      void writeEvent(sse, event);
    });

    // Heartbeat every 15s so proxies don't close the connection.
    const heartbeat = setInterval(() => {
      void sse.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
    }, 15_000);

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(heartbeat);
        resolve();
      });
    });
  });
});

async function writeEvent(
  sse: { writeSSE: (data: { event: string; data: string }) => Promise<void> },
  event: WorkflowEvent,
): Promise<void> {
  await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
}

// Last-line-of-defense process handlers. Without these, an unhandled
// rejection or stream error from a torn-down graph can crash the server
// process — and every subsequent request returns a Vite-proxy 500 with no
// useful clue. We log loudly and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

const port = Number(process.env.WEB_UI_PORT ?? 7800);
const hostname = process.env.WEB_UI_HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[hyperwright] listening on http://${hostname}:${info.port}`);
});
