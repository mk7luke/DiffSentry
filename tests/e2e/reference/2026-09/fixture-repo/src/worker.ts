import type { Store } from "./store.js";

/**
 * Prunes reports older than `retentionMs`, using an injected clock so tests
 * never need to wait on real time. Returns the number of rows removed.
 */
export function runWorker(store: Store, now: () => number, retentionMs: number): number {
  return store.prune(retentionMs, now());
}
