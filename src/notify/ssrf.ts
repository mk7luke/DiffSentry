import net from "node:net";
import dns from "node:dns/promises";

// ─────────────────────────────────────────────────────────────────────────────
// SSRF guard for outbound webhook targets — shared by the notifications API
// (config save time) and the channel adapters (send time), so a hostname that
// is re-pointed to a private address between save and delivery (DNS rebinding)
// is still rejected when the request actually fires.
//
// Note: a narrow TOCTOU window remains between this resolution and the HTTP
// client's own internal resolution. Fully closing it would require a
// connect-time pinned dispatcher (custom undici Agent), which we avoid to keep
// the single-container deployment dependency-free. The route is admin + CSRF
// gated, with two independent escape hatches for self-hosted/test use:
// NOTIFY_ALLOW_INSECURE_WEBHOOKS (permit http) and NOTIFY_ALLOW_PRIVATE_WEBHOOKS
// (permit private/loopback egress).
// ─────────────────────────────────────────────────────────────────────────────

// Two independent relaxations, so enabling plain-http for an internal relay does
// NOT also open up private/loopback/metadata egress (and vice-versa). Read
// lazily so harnesses can set the env before the first call.

/** Allow a plain `http://` scheme (otherwise https is required). */
export function allowInsecureScheme(): boolean {
  return process.env.NODE_ENV === "test" || process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS === "true";
}

/** Allow webhook targets on loopback/private/link-local/reserved networks.
 *  Separate, explicit opt-in for intentional self-hosted internal relays. */
export function allowPrivateEgress(): boolean {
  return process.env.NODE_ENV === "test" || process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS === "true";
}

/** Is a dotted-quad IPv4 in a loopback/private/link-local/reserved range?
 *  A malformed value is treated as private (fail closed). */
export function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || // 0.0.0.0/8 "this network" / unspecified
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a >= 224 // multicast + reserved
  );
}

/**
 * Expand an IPv6 literal (any valid textual form, incl. `::` compression and a
 * trailing embedded IPv4) to its 16 bytes, or null if unparseable. Done by
 * value rather than regex-over-text so compressed forms (`fc00::1`, `fe80::1`)
 * are classified correctly.
 */
export function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%"); // strip a scope/zone id (fe80::1%eth0)
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing embedded IPv4 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) → two hextets.
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0 && s.slice(lastColon + 1).includes(".")) {
    const v4 = s.slice(lastColon + 1).split(".").map((x) => Number(x));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  return bytes;
}

/** Is an IPv6 literal loopback/unspecified/unique-local/link-local/multicast —
 *  or an IPv4-mapped address whose embedded IPv4 is private? Fails closed on an
 *  unparseable value. */
export function ipv6IsPrivate(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable → treat as unsafe
  // IPv4-mapped ::ffff:a.b.c.d (first 10 bytes zero, bytes 10-11 = 0xff).
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return ipv4IsPrivate(b.slice(12).join("."));
  }
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** Block a host that is itself a private/loopback IP literal (any family) or
 *  localhost. Returns false for plain hostnames (those are resolved separately). */
export function hostLiteralIsPrivate(host: string): boolean {
  if (host === "localhost") return true;
  const fam = net.isIP(host);
  if (fam === 4) return ipv4IsPrivate(host);
  if (fam === 6) return ipv6IsPrivate(host);
  return false;
}

/**
 * Validate that `v` is a safe outbound webhook URL: `https` (unless the insecure-
 * scheme flag is set) targeting a host that is not — and does not resolve to — a
 * loopback/private/link-local/reserved address (unless private egress is
 * explicitly allowed). Resolves hostnames via DNS and checks every returned
 * address. Returns an error string, or null when safe.
 *
 * Scheme and egress are separate opt-ins: enabling plain-http for an internal
 * relay does not by itself permit private/metadata targets.
 */
export async function checkWebhookUrlSafe(v: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return "A valid webhook URL is required.";
  }
  // Positive scheme allowlist, enforced independently of the egress policy so a
  // non-http(s) scheme (file:, ftp:, data:, gopher:, …) can never be stored —
  // regardless of the private-egress opt-in below.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Webhook URLs must use http(s).";
  }
  if (parsed.protocol === "http:" && !allowInsecureScheme()) {
    return "Webhook URLs must use https.";
  }
  // Private/loopback egress is a distinct, explicit opt-in (self-hosted relays).
  if (allowPrivateEgress()) return null;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host) || host === "localhost") {
    return hostLiteralIsPrivate(host)
      ? "Webhook URLs may not target local or private network addresses."
      : null;
  }
  // Hostname: resolve and reject if ANY result is a private/loopback address.
  try {
    const results = await dns.lookup(host, { all: true });
    if (results.length === 0) return "Webhook host did not resolve.";
    for (const r of results) {
      const priv = r.family === 6 ? ipv6IsPrivate(r.address) : ipv4IsPrivate(r.address);
      if (priv) return "Webhook URLs may not resolve to local or private network addresses.";
    }
  } catch {
    return "Webhook host did not resolve.";
  }
  return null;
}
