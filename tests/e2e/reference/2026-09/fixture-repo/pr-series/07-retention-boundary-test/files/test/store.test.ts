import { describe, it, expect } from "vitest";
import { Store } from "../src/store.js";

describe("Store", () => {
  it("returns only the requesting owner's reports", () => {
    const s = new Store();
    s.insert({ ownerId: "a", title: "one", body: "x" });
    s.insert({ ownerId: "b", title: "two", body: "y" });
    expect(s.list("a").map((r) => r.title)).toEqual(["one"]);
  });

  it("assigns a monotonic id", () => {
    const s = new Store();
    const first = s.insert({ ownerId: "a", title: "one", body: "x" });
    const second = s.insert({ ownerId: "a", title: "two", body: "y" });
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("returns an empty list for an unknown owner", () => {
    expect(new Store().list("nobody")).toEqual([]);
  });

  it("prunes rows older than the retention window", () => {
    const s = new Store();
    s.insert({ ownerId: "a", title: "old", body: "x" });
    const removed = s.prune(1000, Date.now() + 5000);
    expect(removed).toBe(1);
    expect(s.list("a")).toEqual([]);
  });

  it("keeps rows within the retention window", () => {
    const s = new Store();
    s.insert({ ownerId: "a", title: "fresh", body: "x" });
    const removed = s.prune(60_000, Date.now());
    expect(removed).toBe(0);
    expect(s.list("a")).toHaveLength(1);
  });

  it("keeps a row exactly at the retention boundary", () => {
    const s = new Store();
    const now = 1_000_000;
    const originalNow = Date.now;
    Date.now = () => now - 1000;
    s.insert({ ownerId: "a", title: "old", body: "x" });
    Date.now = originalNow;

    const removed = s.prune(1000, now);
    expect(removed).toBe(0);
    expect(s.list("a")).toHaveLength(1);
  });
});
