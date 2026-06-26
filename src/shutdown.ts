import type { Server } from "node:http";
import { logger } from "./logger.js";
import { reviewQueue } from "./realtime/queue.js";
import { notificationEngine } from "./notify/engine.js";
import { flushDatabase, closeDatabase } from "./storage/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Process resilience — crash-safe and shutdown-clean.
//
// Two concerns live here:
//   1. Crash safety: unhandledRejection / uncaughtException are logged with full
//      context via the pino logger and then the process exits non-zero. We do
//      NOT swallow them — a process in an undefined state must die so the
//      orchestrator (Docker/systemd/k8s) can restart it from a known-good boot.
//   2. Graceful shutdown: on SIGTERM/SIGINT we stop accepting new HTTP
//      connections, cancel in-flight reviews (the queue's AbortController
//      mechanism), flush + close the SQLite handle, then exit 0. A hard timeout
//      guarantees we exit even if some step wedges (e.g. a stuck socket).
//
// Every step is a clean no-op when persistence is disabled (DB_PATH=""): the
// db helpers short-circuit on a null handle, the queue/notification engine are
// process-local and always present.
// ─────────────────────────────────────────────────────────────────────────────

/** Hard cap on how long graceful shutdown may run before we force-exit. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Resolve the shutdown deadline, overridable via SHUTDOWN_TIMEOUT_MS. */
function shutdownTimeoutMs(): number {
  const raw = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/** Latched so a second signal (or a signal mid-shutdown) can't re-enter. */
let shuttingDown = false;

/** Latched so a repeat registerProcessHandlers() call can't stack duplicate
 *  process listeners (mirrors the idempotent boot of the bus / queue /
 *  notification engine elsewhere in the codebase). */
let handlersRegistered = false;

/** Synchronous best-effort DB close shared by the fatal-error paths. We
 *  deliberately do NOT flush/checkpoint here (unlike the graceful path):
 *  closeDatabase() is the essential resource release, committed transactions are
 *  already durable in the WAL, and SQLite checkpoints the WAL on the final
 *  connection close anyway. Skipping the flush keeps this path minimal in an
 *  already-undefined process state and guarantees the close itself runs — a
 *  throwing flush must not pre-empt closeDatabase(). better-sqlite3 close() is
 *  synchronous, so this is safe right before process.exit. */
function closePersistenceBestEffort(): void {
  try {
    closeDatabase();
  } catch {
    // Best-effort only — we're already on the way out.
  }
}

/** Stop accepting new connections and resolve once the server is fully closed.
 *  Long-lived sockets (SSE dashboard streams, keep-alive) would otherwise hold
 *  close() open indefinitely, so we drop them explicitly; the hard timeout in
 *  gracefulShutdown is the final backstop if any of this wedges. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close((err) => {
      if (err) logger.debug({ err }, "shutdown: server.close reported an error");
      resolve();
    });
    // Both guarded — added in Node 18.2; no-ops on older runtimes.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

/**
 * Run the graceful shutdown sequence and exit. Idempotent: the first call wins,
 * later calls return immediately. `server` may be null (e.g. shutdown before the
 * listener came up).
 */
export async function gracefulShutdown(signal: string, server: Server | null): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated");

  // Backstop: if any step below hangs (a stuck socket, a slow checkpoint), force
  // a non-zero exit so the process can never wedge forever. Unref'd so the timer
  // itself never keeps the loop alive.
  const timeout = setTimeout(() => {
    logger.error(
      { signal, timeoutMs: shutdownTimeoutMs() },
      "Graceful shutdown timed out — forcing exit",
    );
    process.exit(1);
  }, shutdownTimeoutMs());
  if (typeof timeout.unref === "function") timeout.unref();

  try {
    // 1. Cancel in-flight reviews first so their request handlers unwind before
    //    we tear the server down.
    const canceled = reviewQueue.cancelAll();
    if (canceled > 0) logger.info({ canceled }, "Canceled in-flight reviews");

    // 2. Stop the alert engine (clears its bus subscription + digest timer).
    notificationEngine.stop();

    // 3. Stop accepting new HTTP connections and drain existing ones.
    if (server) {
      await closeServer(server);
      logger.info("HTTP server closed");
    }

    // 4. Flush pending DB writes and close the handle (no-op when DB disabled).
    flushDatabase();
    closeDatabase();
    logger.info("Persistence flushed and closed");

    clearTimeout(timeout);
    logger.info({ signal }, "Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    logger.error({ err, signal }, "Error during graceful shutdown — forcing exit");
    process.exit(1);
  }
}

/**
 * Test-only: clear the module-level lifecycle latches so each unit test starts
 * from a clean slate (the latches are process-wide and otherwise persist for the
 * life of the worker). Production code never calls this — a real process shuts
 * down, and registers its handlers, exactly once.
 */
export function resetLifecycleStateForTests(): void {
  shuttingDown = false;
  handlersRegistered = false;
}

/**
 * Install the crash-safety + graceful-shutdown handlers. Call once at boot after
 * the HTTP listener is created.
 */
export function registerProcessHandlers(server: Server): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // An unhandled rejection leaves a promise chain in an unknown state; Node's
  // own roadmap treats this as fatal. Log the full reason and exit non-zero.
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal({ err, reason }, "Unhandled promise rejection — exiting non-zero for restart");
    closePersistenceBestEffort();
    process.exit(1);
  });

  // An uncaught exception means the process state is undefined. Never swallow:
  // log with origin + stack, close the DB best-effort, and exit non-zero.
  process.on("uncaughtException", (err, origin) => {
    logger.fatal({ err, origin }, "Uncaught exception — exiting non-zero for restart");
    closePersistenceBestEffort();
    process.exit(1);
  });

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM", server));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT", server));
}
