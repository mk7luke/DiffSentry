import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTagDigest } from "../src/tags.js";
import type { Report } from "../src/store.js";

function report(id: number): Report {
  return { id, ownerId: "a", title: `r${id}`, body: "x", tags: [], createdAt: Date.now() };
}

describe("buildTagDigest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts tags across the given reports", async () => {
    const responses: Record<number, string[]> = { 1: ["billing"], 2: ["billing", "urgent"] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const id = Number(url.match(/reports\/(\d+)\//)?.[1]);
        return { ok: true, json: async () => responses[id] ?? [] } as Response;
      }),
    );

    const digest = await buildTagDigest([report(1), report(2)]);
    expect(digest).toEqual([
      { tag: "billing", count: 2 },
      { tag: "urgent", count: 1 },
    ]);
  });

  it("returns an empty digest for no reports", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(await buildTagDigest([])).toEqual([]);
  });
});
