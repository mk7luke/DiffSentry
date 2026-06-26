import pino from "pino";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pino-pretty has a default export with CJS compat
import pretty from "pino-pretty";
import { SECRET_PATTERNS } from "./secret-patterns.js";

export interface LogEntry {
  ts: string;
  level: string;
  msg: string;
  raw: string;
}

const RING_MAX = 200;
const ring: LogEntry[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Secret redaction for the in-memory log tail. The dashboard surfaces the
// recent warn/error ring buffer (getRecentLogs), so any credential that lands in
// a log message — a token echoed in an error, a webhook URL with an embedded
// secret, a stray PEM block — would otherwise be readable there. We scrub known
// secret SHAPES out of every line before it enters the ring, reusing the exact
// patterns the diff safety scanner uses (src/secret-patterns.js) so detection
// stays consistent across both surfaces.
// ─────────────────────────────────────────────────────────────────────────────

// Pre-compile a global-flag variant of each pattern so a single line with two
// secrets gets both replaced (String#replace only swaps the first match without
// the /g flag).
const REDACTION_PATTERNS: Array<{ id: string; regex: RegExp }> = SECRET_PATTERNS.map((p) => ({
  id: p.id,
  regex: new RegExp(p.regex.source, p.regex.flags.includes("g") ? p.regex.flags : `${p.regex.flags}g`),
}));

/**
 * Replace any substring matching a known secret shape with `[REDACTED:<id>]`.
 * Operates on arbitrary text (a log message or a full serialized log line), so
 * it catches secrets in nested error/context fields, not just the `msg`. Safe to
 * run over JSON text: the replacement contains no quote/brace characters.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const { id, regex } of REDACTION_PATTERNS) {
    regex.lastIndex = 0; // defensive: stateful /g regex reused across calls
    out = out.replace(regex, `[REDACTED:${id}]`);
  }
  return out;
}

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
      // Parse the ORIGINAL line for structure (redaction can't break the JSON
      // shape), then redact both the message and the full serialized line before
      // either is retained — so secrets in nested fields are scrubbed too.
      const entry: LogEntry = {
        ts: new Date(parsed.time ?? Date.now()).toISOString(),
        level: LEVEL_NAMES[lvlNum] ?? String(lvlNum),
        msg: redactSecrets(parsed.msg ?? ""),
        raw: redactSecrets(line.trim()),
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

/**
 * Set the active log level at runtime (used by the command-center settings).
 * Pino accepts any of its level names; an unrecognized value is ignored so a
 * bad override can never silence the logger entirely.
 */
export function setLogLevel(level: string): void {
  if (!Object.values(LEVEL_NAMES).includes(level)) {
    logger.warn({ level }, "setLogLevel: ignoring unrecognized level");
    return;
  }
  logger.level = level;
}
