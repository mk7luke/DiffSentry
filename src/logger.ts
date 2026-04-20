import pino from "pino";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pino-pretty has a default export with CJS compat
import pretty from "pino-pretty";

export interface LogEntry {
  ts: string;
  level: string;
  msg: string;
  raw: string;
}

const RING_MAX = 200;
const ring: LogEntry[] = [];

const LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const prettyStream = pretty({ colorize: true });
const ringStream = {
  write(line: string) {
    try {
      const parsed = JSON.parse(line) as { time?: number; level?: number; msg?: string };
      const lvlNum = parsed.level ?? 30;
      const entry: LogEntry = {
        ts: new Date(parsed.time ?? Date.now()).toISOString(),
        level: LEVEL_NAMES[lvlNum] ?? String(lvlNum),
        msg: parsed.msg ?? "",
        raw: line.trim(),
      };
      ring.push(entry);
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    } catch {
      // ignore non-JSON lines
    }
  },
};

export const logger = pino(
  { level: process.env.LOG_LEVEL || "info" },
  pino.multistream([
    { stream: prettyStream as unknown as NodeJS.WritableStream },
    { stream: ringStream as unknown as NodeJS.WritableStream, level: "warn" },
  ]),
);

/** Snapshot of the recent warn/error log ring buffer (newest last). */
export function getRecentLogs(limit = 100): LogEntry[] {
  return ring.slice(-limit);
}
