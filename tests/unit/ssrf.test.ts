import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkWebhookUrlSafe,
  hostLiteralIsPrivate,
  ipv4IsPrivate,
  ipv6IsPrivate,
  ipv6ToBytes,
  pinnedLookup,
} from "../../src/notify/ssrf.js";

// SSRF guard for outbound webhook targets. Fails closed: only public
// (global-unicast) addresses are allowed; everything else is rejected, and
// transition forms that embed an IPv4 are classified by that embedded IPv4.

describe("ipv4IsPrivate", () => {
  it("blocks loopback / private / link-local / reserved ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "192.0.2.5", // TEST-NET-1
      "198.18.0.1", // benchmarking
      "224.0.0.1", // multicast
      "255.255.255.255", // broadcast
    ]) {
      expect(ipv4IsPrivate(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4 literals", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
      expect(ipv4IsPrivate(ip), ip).toBe(false);
    }
  });

  it("treats malformed dotted-quads as private (fail closed)", () => {
    for (const ip of ["", "1.2.3", "1.2.3.4.5", "999.1.1.1", "a.b.c.d", "-1.0.0.0"]) {
      expect(ipv4IsPrivate(ip), ip).toBe(true);
    }
  });
});

describe("ipv6ToBytes", () => {
  it("expands compressed forms to 16 bytes", () => {
    expect(ipv6ToBytes("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6ToBytes("::")).toEqual(new Array(16).fill(0));
    const fe80 = ipv6ToBytes("fe80::1");
    expect(fe80?.slice(0, 2)).toEqual([0xfe, 0x80]);
    expect(fe80?.[15]).toBe(1);
  });

  it("expands a full uncompressed address", () => {
    expect(ipv6ToBytes("2001:0db8:0000:0000:0000:0000:0000:0001")).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it("expands an embedded trailing IPv4", () => {
    expect(ipv6ToBytes("::ffff:1.2.3.4")?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
  });

  it("strips a zone/scope id", () => {
    expect(ipv6ToBytes("fe80::1%eth0")).toEqual(ipv6ToBytes("fe80::1"));
  });

  it("returns null for unparseable input", () => {
    for (const ip of ["1::2::3", "fffff::1", "gg::1", "1.2.3.4", "::ffff:1.2.3", "::ffff:1.2.3.4.5"]) {
      expect(ipv6ToBytes(ip), ip).toBeNull();
    }
  });
});

describe("ipv6IsPrivate", () => {
  it("blocks non-global-unicast ranges", () => {
    for (const ip of [
      "::", // unspecified
      "::1", // loopback
      "fc00::1", // ULA
      "fd00::1", // ULA
      "fe80::1", // link-local
      "ff02::1", // multicast
      "2001:db8::1", // documentation
      "100::1", // discard-only
    ]) {
      expect(ipv6IsPrivate(ip), ip).toBe(true);
    }
  });

  it("allows global-unicast (2000::/3) public addresses", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(ipv6IsPrivate(ip), ip).toBe(false);
    }
  });

  it("classifies embedded-IPv4 transition forms by the inner IPv4", () => {
    // IPv4-mapped ::ffff:a.b.c.d
    expect(ipv6IsPrivate("::ffff:127.0.0.1")).toBe(true);
    expect(ipv6IsPrivate("::ffff:8.8.8.8")).toBe(false);
    // 6to4 2002::/16 (embedded IPv4 in bytes 2-5)
    expect(ipv6IsPrivate("2002:7f00:0001::")).toBe(true); // 127.0.0.1
    expect(ipv6IsPrivate("2002:0808:0808::")).toBe(false); // 8.8.8.8
    // NAT64 64:ff9b::/96
    expect(ipv6IsPrivate("64:ff9b::127.0.0.1")).toBe(true);
    expect(ipv6IsPrivate("64:ff9b::8.8.8.8")).toBe(false);
  });

  it("fails closed on unparseable input", () => {
    expect(ipv6IsPrivate("not-an-ip")).toBe(true);
  });
});

describe("hostLiteralIsPrivate", () => {
  it("blocks localhost and private IP literals of any family", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(hostLiteralIsPrivate(host), host).toBe(true);
    }
  });

  it("allows public IP literals", () => {
    for (const host of ["8.8.8.8", "2606:4700:4700::1111"]) {
      expect(hostLiteralIsPrivate(host), host).toBe(false);
    }
  });

  it("returns false for plain hostnames (resolved separately)", () => {
    expect(hostLiteralIsPrivate("example.com")).toBe(false);
  });
});

describe("checkWebhookUrlSafe", () => {
  // Snapshot + clear the env flags so each test runs against a known policy.
  const saved = {
    insecure: process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS,
    priv: process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS,
  };
  beforeEach(() => {
    delete process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS;
    delete process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS;
  });
  afterEach(() => {
    if (saved.insecure === undefined) delete process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS;
    else process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS = saved.insecure;
    if (saved.priv === undefined) delete process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS;
    else process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS = saved.priv;
  });

  it("allows an https URL to a public IP literal", async () => {
    expect(await checkWebhookUrlSafe("https://8.8.8.8/hook")).toBeNull();
  });

  it("rejects a non-http(s) scheme regardless of egress policy", async () => {
    expect(await checkWebhookUrlSafe("file:///etc/passwd")).toMatch(/http/i);
    expect(await checkWebhookUrlSafe("gopher://8.8.8.8/")).toMatch(/http/i);
  });

  it("rejects plain http unless the insecure flag is set", async () => {
    expect(await checkWebhookUrlSafe("http://8.8.8.8/hook")).toMatch(/https/i);
    process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS = "true";
    expect(await checkWebhookUrlSafe("http://8.8.8.8/hook")).toBeNull();
  });

  it("rejects private/loopback IP-literal targets", async () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://localhost/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://[fe80::1]/hook",
    ]) {
      expect(await checkWebhookUrlSafe(url), url).toMatch(/local or private/i);
    }
  });

  it("normalizes a trailing-dot FQDN so it can't slip past the literal check", async () => {
    expect(await checkWebhookUrlSafe("https://127.0.0.1./hook")).toMatch(/local or private/i);
  });

  it("rejects a malformed URL", async () => {
    expect(await checkWebhookUrlSafe("not a url")).toMatch(/valid webhook url/i);
  });

  it("permits private egress only when the explicit flag is set", async () => {
    process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS = "true";
    expect(await checkWebhookUrlSafe("https://127.0.0.1/hook")).toBeNull();
  });
});

describe("pinnedLookup (DNS pinning at connect time)", () => {
  const saved = process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS;
  beforeEach(() => {
    delete process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS;
    else process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS = saved;
  });

  const lookupOnce = (host: string, options: { family?: number; all?: boolean } = {}) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown; family?: number }>((resolve) => {
      pinnedLookup(host, options, (err, address, family) => resolve({ err, address, family }));
    });

  it("rejects a host that resolves only to a private/loopback address", async () => {
    // localhost resolves to 127.0.0.1 / ::1 — both private, so nothing is safe.
    const { err, address } = await lookupOnce("localhost");
    expect(err).toBeInstanceOf(Error);
    expect(address).toBeUndefined();
  });

  it("returns the private address when private egress is explicitly allowed", async () => {
    process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS = "true";
    const { err, address } = await lookupOnce("localhost", { family: 4 });
    expect(err).toBeNull();
    expect(address).toMatch(/^127\./);
  });

  it("returns validated public addresses for a real hostname", async () => {
    // dns.example resolves to public addresses (93.184.x / 96.7.x range).
    const { err, address, family } = await lookupOnce("example.com", { family: 4 });
    // Tolerate offline CI (DNS failure) — but if it resolves, it must be a v4
    // address and must not be a private one (the whole point of the pin).
    if (err) {
      expect(err).toBeInstanceOf(Error);
      return;
    }
    expect(typeof address).toBe("string");
    expect(family).toBe(4);
    expect(ipv4IsPrivate(address as string)).toBe(false);
  });
});
