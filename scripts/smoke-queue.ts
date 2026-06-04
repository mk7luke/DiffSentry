/**
 * Smoke-test the review-queue registry + GET /api/v1/queue + the queue.updated
 * SSE channel against a temp SQLite DB. Run: npx tsx scripts/smoke-queue.ts
 *
 * Asserts:
 *   - enqueue → /queue shows a "queued" card with an AbortSignal
 *   - start()/phase() → card flips to "running" with the live phase
 *   - complete() → card terminal "done" AND a review.done row lands in events
 *   - cancel() actually aborts the in-flight signal and marks the card canceled
 *   - a superseding enqueue aborts the prior attempt and bumps the attempt count
 *   - the SSE stream delivers a live queue.updated event without polling
 */
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-queue-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { reviewQueue } = await import("../src/realtime/queue.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  const learningsDir = path.join(os.tmpdir(), `ds-queue-smoke-learnings-${Date.now()}`);
  fs.mkdirSync(learningsDir, { recursive: true });

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  async function get(pathname: string): Promise<{ status: number; json: any }> {
    return await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}${pathname}`, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({ status: r.statusCode ?? 0, json: body ? JSON.parse(body) : null });
          });
        })
        .on("error", reject);
    });
  }
  const entriesNow = async () => (await get("/api/v1/queue")).json.data.entries as any[];
  const find = (rows: any[], num: number) => rows.find((e) => e.number === num);

  function ok(label: string, cond: boolean) {
    if (!cond) throw new Error(`[${label}] assertion failed`);
    console.log(`  ✓ ${label}`);
  }

  try {
    // ── queued ──────────────────────────────────────────────────────────
    const h7 = reviewQueue.enqueue("acme", "web", 7, "full");
    let rows = await entriesNow();
    ok("enqueue → /queue shows queued card", find(rows, 7)?.state === "queued" && find(rows, 7)?.mode === "full");
    ok("enqueue hands back a live (un-aborted) signal", h7.signal.aborted === false);

    // ── running + phase ─────────────────────────────────────────────────
    h7.start("reviewing");
    rows = await entriesNow();
    ok("start() → running with phase + startedAt", find(rows, 7)?.state === "running" && find(rows, 7)?.phase === "reviewing" && !!find(rows, 7)?.startedAt);

    // ── done + persisted terminal event ─────────────────────────────────
    h7.complete();
    rows = await entriesNow();
    ok("complete() → terminal done with finishedAt", find(rows, 7)?.state === "done" && !!find(rows, 7)?.finishedAt);
    const events = db.prepare(`SELECT kind FROM events WHERE owner=? AND repo=? AND number=?`).all("acme", "web", 7) as { kind: string }[];
    ok("complete() persisted review.done to events", events.some((e) => e.kind === "review.done"));

    // ── cancel actually aborts the in-flight signal ─────────────────────
    const h8 = reviewQueue.enqueue("acme", "web", 8, "incremental");
    h8.start();
    reviewQueue.cancel("acme", "web", 8);
    ok("cancel() aborted the in-flight signal", h8.signal.aborted === true);
    rows = await entriesNow();
    ok("cancel() → card marked canceled", find(rows, 8)?.state === "canceled");
    // A finally-path complete() after cancel must NOT resurrect the card.
    h8.complete();
    rows = await entriesNow();
    ok("post-cancel complete() is a no-op", find(rows, 8)?.state === "canceled");

    // ── superseding enqueue aborts the prior attempt ────────────────────
    const h9a = reviewQueue.enqueue("acme", "web", 9, "incremental");
    h9a.start();
    const h9b = reviewQueue.enqueue("acme", "web", 9, "full");
    ok("re-enqueue aborted the prior attempt's signal", h9a.signal.aborted === true);
    rows = await entriesNow();
    ok("re-enqueue bumped attempt + reset to queued/full", find(rows, 9)?.attempt === 2 && find(rows, 9)?.state === "queued" && find(rows, 9)?.mode === "full");
    // The superseded handle must not be able to finalize the new attempt.
    h9a.complete();
    rows = await entriesNow();
    ok("superseded handle cannot finalize the new attempt", find(rows, 9)?.state === "queued");
    h9b.complete();

    // ── SSE delivers queue.updated live ─────────────────────────────────
    const sseSeen = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const r = http.request(
        { hostname: "127.0.0.1", port, path: "/api/v1/stream", method: "GET", headers: { Accept: "text/event-stream" } },
        (res) => {
          if (res.statusCode !== 200) return reject(new Error(`stream status ${res.statusCode}`));
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buf += chunk;
            if (buf.includes("event: queue.updated")) {
              r.destroy();
              resolve(buf);
            }
          });
          setTimeout(() => reviewQueue.enqueue("acme", "web", 99, "full").complete(), 30);
        },
      );
      r.on("error", (err) => {
        if (!buf.includes("event: queue.updated")) reject(err);
      });
      r.end();
      setTimeout(() => reject(new Error("SSE timeout")), 3000);
    });
    ok("SSE stream delivered queue.updated live", sseSeen.includes("event: queue.updated"));

    console.log("\nall queue smoke checks passed ✓");
  } finally {
    server.close();
    closeDatabase();
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      // best effort
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
