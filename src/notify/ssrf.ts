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
// gated and the NOTIFY_ALLOW_INSECURE_WEBHOOKS flag exists for intentional
// self-hosted internal relays / tests.
// ─────────────────────────────────────────────────────────────────────────────

/** Allow http + loopback/private targets (tests / self-hosted internal relays).
 *  Read lazily so harnesses can set the env before the first call. */
export function allowInsecureWebhooks(): boolean {
  return process.env.NODE_ENV === "test" || process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS === "true";
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

/** Is an IPv6 literal loopback/unique-local/link-local/multicast — or an
 *  IPv4-mapped/-embedded address whose embedded IPv4 is private? */
export function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible (::127.0.0.1) dotted forms.
  const dotted = lower.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return ipv4IsPrivate(dotted[1]);
  // IPv4-mapped in hex form (::ffff:7f00:0001).
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const embedded = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
    return ipv4IsPrivate(embedded);
  }
  return (
    lower === "::" || // unspecified
    lower === "::1" || // loopback
    /^f[cd][0-9a-f]{2}:/.test(lower) || // fc00::/7 unique-local
    /^fe[89ab][0-9a-f]:/.test(lower) || // fe80::/10 link-local
    lower.startsWith("ff") // multicast
  );
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
 * Validate that `v` is a safe outbound webhook URL: `https` (unless the insecure
 * flag is set) targeting a host that is not — and does not resolve to — a
 * loopback/private/link-local/reserved address. Resolves hostnames via DNS and
 * checks every returned address. Returns an error string, or null when safe.
 */
export async function checkWebhookUrlSafe(v: string): Promise<string | null> {
  const allowInsecure = allowInsecureWebhooks();
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return "A valid webhook URL is required.";
  }
  if (parsed.protocol !== "https:" && !(allowInsecure && parsed.protocol === "http:")) {
    return "Webhook URLs must use https.";
  }
  // Escape hatch (test / self-hosted internal relays): skip the egress checks.
  if (allowInsecure) return null;

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
