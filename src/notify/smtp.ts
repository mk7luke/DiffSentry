import net from "node:net";
import tls from "node:tls";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal SMTP client — just enough to send a plain-text email for the email
// notification channel, with no third-party dependency (keeps the single
// container lean). Supports:
//   - implicit TLS (port 465, NOTIFY_SMTP_SECURE=true)
//   - STARTTLS upgrade (port 587, the common submission port)
//   - plain unencrypted (port 25 — discouraged, but allowed for local relays)
//   - AUTH LOGIN / AUTH PLAIN when a user+pass are configured
//
// It is deliberately small: one recipient, text body, UTF-8. Anything fancier
// (HTML parts, attachments, multiple recipients) is out of scope — the alert
// emails are short status lines.
// ─────────────────────────────────────────────────────────────────────────────

export interface SmtpConfig {
  host: string;
  port: number;
  /** "From" address used for the envelope + header. */
  from: string;
  user?: string;
  pass?: string;
  /** Implicit TLS from the first byte (port 465). Otherwise STARTTLS is used
   *  opportunistically on a plain connection when the server advertises it. */
  secure?: boolean;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
}

/** Build an SmtpConfig from NOTIFY_SMTP_* env, or null when host/from are unset. */
export function smtpConfigFromEnv(): SmtpConfig | null {
  const host = (process.env.NOTIFY_SMTP_HOST ?? "").trim();
  const from = (process.env.NOTIFY_SMTP_FROM ?? "").trim();
  if (!host || !from) return null;
  const port = Number.parseInt(process.env.NOTIFY_SMTP_PORT ?? "", 10);
  const resolvedPort = Number.isFinite(port) && port > 0 ? port : 587;
  return {
    host,
    port: resolvedPort,
    from,
    user: (process.env.NOTIFY_SMTP_USER ?? "").trim() || undefined,
    pass: process.env.NOTIFY_SMTP_PASS || undefined,
    secure: process.env.NOTIFY_SMTP_SECURE === "true" || resolvedPort === 465,
  };
}

const CONNECT_TIMEOUT_MS = 10_000;

/** A live SMTP dialog over one socket. Reads CRLF-framed replies and writes
 *  commands, resolving each reply once the final (non-continuation) line lands.
 *
 *  Every read is bounded: it rejects after CONNECT_TIMEOUT_MS and immediately on
 *  a socket `error`/`close` so a hung or dropped server can never leave sendMail
 *  awaiting forever. Once the socket has failed, `deadError` short-circuits any
 *  later read so the rest of the dialog unwinds quickly. */
class SmtpSession {
  private socket: net.Socket;
  private buffer = "";
  private pending: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;
  /** Set once the socket has failed/closed; later reads reject with it at once. */
  private deadError: Error | null = null;
  /** The current socket's `data` handler, removed on rebind to avoid leaks. */
  private onData: ((chunk: string) => void) | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.setEncoding("utf8");
    const onData = (chunk: string) => {
      this.buffer += chunk;
      // A complete reply ends with a line "NNN <text>" (space after the code);
      // "NNN-<text>" lines are continuations.
      const lines = this.buffer.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (/^\d{3} /.test(line)) {
          // Final line of a reply — hand back everything buffered so far.
          const full = lines.slice(0, i + 1).join("\n");
          this.buffer = lines.slice(i + 1).join("\n");
          const p = this.pending;
          this.pending = null;
          p?.resolve(full);
          return;
        }
      }
    };
    this.onData = onData;
    socket.on("data", onData);
  }

  /** Swap in the TLS socket after a STARTTLS upgrade. */
  rebind(socket: net.Socket): void {
    if (this.onData) this.socket.removeListener("data", this.onData);
    this.socket = socket;
    this.buffer = "";
    this.attach(socket);
  }

  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.deadError) {
        reject(this.deadError);
        return;
      }
      const socket = this.socket;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.deadError = err;
        this.pending = null;
        cleanup();
        reject(err);
      };
      const onError = (err: Error) => fail(err instanceof Error ? err : new Error(String(err)));
      const onClose = () => fail(new Error("SMTP connection closed unexpectedly"));
      const timer = setTimeout(() => {
        socket.destroy();
        fail(new Error("SMTP read timeout"));
      }, CONNECT_TIMEOUT_MS);
      socket.once("error", onError);
      socket.once("close", onClose);
      // Wrap resolve/reject so the per-read listeners + timer are always torn
      // down, whether the reply lands (data handler) or end() rejects us.
      this.pending = {
        resolve: (v: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(v);
        },
        reject: (e: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(e);
        },
      };
    });
  }

  /** Read one reply and assert its status code is expected, else throw. */
  async readExpect(expect: number[], label: string): Promise<string> {
    const reply = await this.read();
    const code = Number.parseInt(reply.slice(0, 3), 10);
    if (!expect.includes(code)) {
      throw new Error(`SMTP ${label} failed: ${reply.split("\n")[0]}`);
    }
    return reply;
  }

  async command(line: string, expect: number[]): Promise<string> {
    this.socket.write(line + "\r\n");
    return this.readExpect(expect, `command (${line.split(" ")[0]})`);
  }

  rawWrite(data: string): void {
    this.socket.write(data);
  }

  end(): void {
    // Reject anything still awaiting so a teardown mid-dialog never hangs.
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(new Error("SMTP session ended"));
    }
    try {
      this.socket.end();
    } catch {
      // best effort
    }
  }
}

function connectPlain(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const cleanup = () => {
      socket.setTimeout(0);
      socket.removeListener("error", onError);
    };
    // Settle exactly once and destroy the socket on failure, so a timed-out or
    // errored connect attempt can't leak a live handle (or double-reject).
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    socket.once("error", onError);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("SMTP connect timeout")));
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    });
  });
}

function connectTls(host: string, port: number, existing?: net.Socket): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({ host, port, servername: host, socket: existing }, () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    });
    const cleanup = () => {
      socket.setTimeout(0);
      socket.removeListener("error", onError);
    };
    // Bound the TLS handshake the same way connectPlain bounds the TCP connect,
    // so an unreachable/half-open TLS endpoint can't hang sendMail forever.
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    socket.once("error", onError);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("SMTP TLS connect timeout")));
  });
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word so non-ASCII subjects survive. ASCII passes through.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Reject CR/LF so a value can't break out of an SMTP command or header line
 *  (header / command injection). */
function assertNoCrlf(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`SMTP ${field} must not contain CR or LF characters`);
  }
}

/** Require a single bare email address (no CRLF, no display name / extra
 *  addresses) for envelope + header use. */
function assertSingleAddress(value: string, field: string): void {
  assertNoCrlf(value, field);
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(value)) {
    throw new Error(`SMTP ${field} must be a single email address`);
  }
}

/** Send one plain-text email. Throws on any protocol/connection failure. */
export async function sendMail(cfg: SmtpConfig, msg: SmtpMessage): Promise<void> {
  // Defend the boundary: cfg.from comes from env and sendMail is exported, so
  // validate here even though the API already checks the channel recipient.
  assertSingleAddress(cfg.from, "from");
  assertSingleAddress(msg.to, "to");
  assertNoCrlf(msg.subject, "subject");
  let socket: net.Socket = cfg.secure
    ? await connectTls(cfg.host, cfg.port)
    : await connectPlain(cfg.host, cfg.port);
  const session = new SmtpSession(socket);
  try {
    await session.readExpect([220], "greeting"); // server must greet with 220
    const ehloName = "diffsentry.local";
    let ehlo = await session.command(`EHLO ${ehloName}`, [250]);

    // Opportunistic STARTTLS on a plain connection when offered.
    if (!cfg.secure && /STARTTLS/i.test(ehlo)) {
      await session.command("STARTTLS", [220]);
      socket = await connectTls(cfg.host, cfg.port, socket);
      session.rebind(socket);
      ehlo = await session.command(`EHLO ${ehloName}`, [250]);
    }

    if (cfg.user && cfg.pass) {
      // Only attempt a mechanism the server actually advertised in EHLO; fail
      // with a clear error otherwise rather than blindly sending AUTH LOGIN.
      const hasPlain = /auth[ -][^\n]*\bplain\b/i.test(ehlo);
      const hasLogin = /auth[ -][^\n]*\blogin\b/i.test(ehlo);
      if (hasPlain) {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, "utf8").toString("base64");
        await session.command(`AUTH PLAIN ${token}`, [235]);
      } else if (hasLogin) {
        await session.command("AUTH LOGIN", [334]);
        await session.command(Buffer.from(cfg.user, "utf8").toString("base64"), [334]);
        await session.command(Buffer.from(cfg.pass, "utf8").toString("base64"), [235]);
      } else {
        throw new Error("SMTP server does not advertise a supported AUTH mechanism (PLAIN or LOGIN)");
      }
    }

    await session.command(`MAIL FROM:<${cfg.from}>`, [250]);
    await session.command(`RCPT TO:<${msg.to}>`, [250, 251]);
    await session.command("DATA", [354]);

    const date = new Date().toUTCString();
    const body = msg.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const message =
      `From: ${cfg.from}\r\n` +
      `To: ${msg.to}\r\n` +
      `Subject: ${encodeHeader(msg.subject)}\r\n` +
      `Date: ${date}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n` +
      `\r\n` +
      body +
      `\r\n.\r\n`;
    session.rawWrite(message);
    await session.readExpect([250], "DATA"); // message must be accepted (250)
    await session.command("QUIT", [221]).catch(() => undefined);
  } finally {
    session.end();
  }
  logger.debug({ to: msg.to, host: cfg.host }, "smtp: mail sent");
}
