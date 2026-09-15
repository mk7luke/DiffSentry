import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { runWorker } from "../src/worker.js";

describe("runWorker", () => {
  it("prunes rows older than the retention window using the injected clock", () => {
    const store = new Store();
    store.insert({ ownerId: "a", title: "old", body: "x" });
    const removed = runWorker(store, () => Date.now() + 100_000, 1000);
    expect(removed).toBe(1);
    expect(store.list("a")).toEqual([]);
  });

  it("does not prune rows still inside the window", () => {
    const store = new Store();
    store.insert({ ownerId: "a", title: "fresh", body: "x" });
    const removed = runWorker(store, Date.now, 60_000);
    expect(removed).toBe(0);
  });
});
