import type { Request, Response, Router } from "express";
import { bus, type BusEnvelope } from "../realtime/bus.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/stream — Server-Sent Events.
//
// Forwards every bus event to the connected client as an SSE message whose
// `event:` is the bus topic and `data:` is the JSON envelope. A periodic
// heartbeat comment keeps idle proxies from dropping the connection, and a
// reconnecting client (EventSource sets the Last-Event-ID header automatically)
// is replayed the events it missed from the bus ring buffer.
//
// Registered on the API router so it sits behind the same auth gate as every
// other endpoint — any authenticated role may subscribe (the stream is
// read-only; nothing here mutates state).
// ─────────────────────────────────────────────────────────────────────────────

/** Heartbeat interval. Override with DASHBOARD_SSE_HEARTBEAT_MS (min 1000ms). */
const HEARTBEAT_MS = (() => {
  const raw = Number.parseInt(process.env.DASHBOARD_SSE_HEARTBEAT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 25_000;
})();

function writeEnvelope(res: Response, env: BusEnvelope): void {
  // One SSE message: id (reconnection cursor), event (topic), data (envelope).
  res.write(`id: ${env.id}\n`);
  res.write(`event: ${env.topic}\n`);
  res.write(`data: ${JSON.stringify(env)}\n\n`);
}

function parseLastEventId(req: Request): number {
  // EventSource resends the last id via this header on auto-reconnect; we also
  // accept a ?lastEventId= query param for manual/initial catch-up.
  const header = req.headers["last-event-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const query = typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined;
  const n = Number.parseInt(fromHeader ?? query ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Register the SSE route on an Express router (mounted under /api/v1). */
export function registerStreamRoute(router: Router): void {
  router.get("/stream", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell nginx (and similar) not to buffer the response — SSE needs flushing.
      "X-Accel-Buffering": "no",
    });
    // Advise the client's auto-reconnect backoff and flush headers immediately.
    res.write("retry: 3000\n\n");

    // Replay anything the client missed before attaching the live listener, so
    // there is no gap between the replay window and new events.
    const lastId = parseLastEventId(req);
    if (lastId > 0) {
      for (const env of bus.replayAfter(lastId)) writeEnvelope(res, env);
    }

    const unsubscribe = bus.subscribe((env) => {
      try {
        writeEnvelope(res, env);
      } catch (err) {
        logger.debug({ err }, "sse: write failed");
      }
    });

    const heartbeat = setInterval(() => {
      // A comment line (starts with ':') is ignored by EventSource but keeps
      // the socket and any intermediary proxies alive.
      res.write(`: keep-alive\n\n`);
    }, HEARTBEAT_MS);
    // Don't let the heartbeat timer hold the event loop open at shutdown.
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);

    logger.debug({ lastId }, "sse: client connected");
  });
}
