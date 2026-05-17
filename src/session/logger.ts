import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { WriteStream } from "node:fs";

interface NodeLogger {
  stream: WriteStream;
  path: string;
}

/**
 * Real-time logger service that writes logs to per-node files.
 * Emits events when new lines are written so the runner can broadcast via SSE.
 *
 * Design goals:
 * - Non-blocking: streams writes to disk
 * - Observable: EventEmitter for real-time streaming
 * - Cleanup-friendly: clear() wipes all log files
 * - Node-scoped: each node gets its own log file
 */
class LoggerService extends EventEmitter {
  private loggers = new Map<string, NodeLogger>();
  private sessionDir: string | null = null;
  /**
   * Lines logged before initialize() arrives. setupContext is the canonical
   * case — it runs before sessionDir exists (it *computes* sessionDir), so
   * its log lines would otherwise be dropped from the file (the EventEmitter
   * still fires, so the SSE/UI side is fine — only the per-node .log file
   * is missing). Buffered here and flushed on initialize().
   */
  private pendingLines = new Map<string, string[]>();

  /**
   * Initialize the logger for a new session.
   * Call this when a workflow starts.
   *
   * Idempotent: re-calling with the same sessionDir is a no-op so consume()
   * can call this on every chunk without thrashing open streams.
   */
  initialize(sessionDir: string): void {
    if (this.sessionDir === sessionDir) return;
    this.cleanup();
    this.sessionDir = sessionDir;
    this.ensureLogDir();

    // Flush anything logged before sessionDir was known (e.g. setupContext).
    for (const [node, lines] of this.pendingLines) {
      const logger = this.getOrCreateLogger(node);
      if (logger.stream.writable && !logger.stream.destroyed) {
        for (const line of lines) logger.stream.write(line + "\n");
      }
    }
    this.pendingLines.clear();
  }

  /**
   * Log a line for a specific node. Writes to file and emits 'log' event.
   *
   * Defensive against the clear() race: a previous graph still executing
   * after clear() has called .end() on its streams must NOT crash the Node
   * process. We skip the file write if the stream is no longer writable and
   * still emit the realtime event so the (still-subscribed) SSE clients keep
   * seeing late lines from a torn-down run.
   *
   * If called before initialize(), the line is buffered in `pendingLines`
   * and replayed to disk once sessionDir is known.
   */
  log(node: string, line: string): void {
    if (!this.sessionDir) {
      const buf = this.pendingLines.get(node) ?? [];
      buf.push(line);
      this.pendingLines.set(node, buf);
    } else {
      try {
        const logger = this.getOrCreateLogger(node);
        if (logger.stream.writable && !logger.stream.destroyed) {
          logger.stream.write(line + "\n");
        }
      } catch {
        /* logger torn down mid-write — drop the file write, keep realtime */
      }
    }
    this.emit("log", { node, line, timestamp: Date.now() });
  }

  /**
   * Get all logs for a node (for initial load/reconnection).
   */
  async getLogs(node: string): Promise<string[]> {
    if (!this.sessionDir) return [];

    const logPath = this.getLogPath(node);
    try {
      const content = await readFile(logPath, "utf-8");
      return content.split("\n").filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Archive current logs for a session before clearing.
   * Useful for post-mortem analysis.
   */
  async archive(archiveDir: string): Promise<void> {
    if (!this.sessionDir) return;

    const logDir = this.getLogDir();
    if (!existsSync(logDir)) return;

    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true });
    }

    for (const [node, logger] of this.loggers) {
      logger.stream.end();
      const src = logger.path;
      const dest = join(archiveDir, `${node}.log`);
      try {
        await rename(src, dest);
      } catch {
        // Ignore rename failures
      }
    }
    this.loggers.clear();
  }

  /**
   * Clear all log files and close streams.
   * Call this on stop/clear/reset.
   */
  cleanup(): void {
    for (const logger of this.loggers.values()) {
      logger.stream.end();
    }
    this.loggers.clear();
    this.sessionDir = null;
    this.pendingLines.clear();
  }

  /**
   * Close streams but keep files (for graceful shutdown).
   */
  close(): void {
    for (const logger of this.loggers.values()) {
      logger.stream.end();
    }
    this.loggers.clear();
  }

  private getOrCreateLogger(node: string): NodeLogger {
    if (this.loggers.has(node)) {
      return this.loggers.get(node)!;
    }

    if (!this.sessionDir) {
      throw new Error("Logger not initialized. Call initialize() first.");
    }

    const logPath = this.getLogPath(node);
    const stream = createWriteStream(logPath, { flags: "a" });
    // CRITICAL: Node writable streams emit 'error' on write-after-end. With
    // no listener, the process crashes with an unhandled error — exactly the
    // failure mode that turned reset+restart into 500-everything-after. The
    // listener swallows the post-cleanup write attempts; log() above also
    // checks `stream.writable` to avoid them in the first place.
    stream.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.warn(`[logger] stream error on ${node} (${logPath}):`, err.message);
    });

    const logger: NodeLogger = { stream, path: logPath };
    this.loggers.set(node, logger);

    return logger;
  }

  private getLogPath(node: string): string {
    return join(this.getLogDir(), `${node}.log`);
  }

  private getLogDir(): string {
    if (!this.sessionDir) {
      throw new Error("Logger not initialized");
    }
    return join(this.sessionDir, "logs");
  }

  private ensureLogDir(): void {
    const logDir = this.getLogDir();
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }
}

export const logger = new LoggerService();
