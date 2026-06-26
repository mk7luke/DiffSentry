import type { Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Disable persistence for the whole file BEFORE any openDatabase() runs: the
// review queue's finalize() best-effort-persists via recordEvent(), which would
// otherwise open ./data/diffsentry.db. With DB_PATH="" the first open latches
// the singleton disabled, so flush/close are exercised on the no-op path —
// exactly the persistence-disabled behavior we want to assert. Captured and
// restored in afterAll so the env mutation stays self-contained to this file.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
process.env.DB_PATH = "";

import { reviewQueue } from "../../src/realtime/queue.js";
import { flushDatabase, closeDatabase, openDatabase } from "../../src/storage/db.js";
import { gracefulShutdown, registerProcessHandlers, resetLifecycleStateForTests } from "../../src/shutdown.js";

// The shuttingDown / handlersRegistered latches are process-wide and persist for
// the life of the worker. Reset them before every test so the suite is
// order-independent — a test that engages a latch can't silently change how a
// later test sees gracefulShutdown() / registerProcessHandlers().
beforeEach(() => {
  resetLifecycleStateForTests();
});

afterAll(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
});

describe("reviewQueue.cancelAll", () => {
  it("aborts every in-flight review and returns the count", () => {
    const a = reviewQueue.enqueue("o", "r", 1, "full");
    const b = reviewQueue.enqueue("o", "r", 2, "incremental");
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);

    const canceled = reviewQueue.cancelAll();

    expect(canceled).toBeGreaterThanOrEqual(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    // Every entry has reached a terminal state — nothing left active.
    expect(reviewQueue.snapshot().filter((e) => e.state === "queued" || e.state === "running")).toHaveLength(0);
  });

  it("is a no-op (returns 0) when nothing is running", () => {
    reviewQueue.cancelAll(); // drain anything left by a prior test
    expect(reviewQueue.cancelAll()).toBe(0);
  });
});

describe("flushDatabase / closeDatabase with persistence disabled", () => {
  it("no-op cleanly when DB_PATH is empty", () => {
    expect(openDatabase()).toBeNull();
    expect(() => flushDatabase()).not.toThrow();
    expect(() => closeDatabase()).not.toThrow();
  });
});

describe("gracefulShutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drains the server, cancels reviews, and exits 0 (idempotent)", async () => {
    // In production process.exit(0) is the last statement gracefulShutdown runs;
    // stubbing it to a no-op lets the awaited call return so we can assert the
    // sequence ran AND that a second signal is a no-op (the `shuttingDown` latch).
    // The two phases are asserted explicitly below rather than in separate tests
    // because the latch state is what links them.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const close = vi.fn((cb?: (err?: Error) => void) => cb?.());
    const closeIdle = vi.fn();
    const closeAll = vi.fn();
    const server = { close, closeIdleConnections: closeIdle, closeAllConnections: closeAll } as unknown as Server;

    const handle = reviewQueue.enqueue("o", "r", 99, "full");

    // Phase 1 — first signal runs the full drain → cancel → close → exit(0).
    await gracefulShutdown("SIGTERM", server);

    expect(close).toHaveBeenCalledTimes(1);
    // Both socket-draining calls fire so keep-alive + long-lived (SSE) sockets
    // can't hold close() open past the deadline.
    expect(closeIdle).toHaveBeenCalledTimes(1);
    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(handle.signal.aborted).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);

    // Phase 2 — because process.exit was stubbed the process is still alive in
    // the test, so a second signal exercises the `shuttingDown` latch: it must
    // return immediately without re-running any shutdown step.
    close.mockClear();
    await gracefulShutdown("SIGINT", server);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("registerProcessHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the crash-safety + signal handlers exactly once (idempotent)", () => {
    const server = { close: vi.fn((cb?: () => void) => cb?.()) } as unknown as Server;
    // Stub process.on so we observe the registrations WITHOUT attaching real
    // listeners to the live process — no global teardown (removeAllListeners)
    // that could clobber listeners the test runner itself owns.
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    registerProcessHandlers(server);

    const events = onSpy.mock.calls.map((c) => c[0]);
    expect(events).toEqual(
      expect.arrayContaining(["unhandledRejection", "uncaughtException", "SIGTERM", "SIGINT"]),
    );
    const firstCallCount = onSpy.mock.calls.length;

    // Idempotent: a repeat call must not stack duplicate listeners.
    registerProcessHandlers(server);
    expect(onSpy.mock.calls.length).toBe(firstCallCount);

    onSpy.mockRestore();
  });
});
