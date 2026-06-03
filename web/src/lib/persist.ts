import type { QueryClient } from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/react-query-persist-client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

// ─────────────────────────────────────────────────────────────────────────────
// Offline "last-viewed data" — a user-scoped, logout-purged TanStack Query
// persister backed by localStorage.
//
// We persist the in-memory query cache so a cold offline launch of the PWA can
// paint the last data the user saw (overview, findings, the PR they were on)
// instead of empty skeletons. The service worker deliberately does NOT cache
// /api responses (see vite.config.ts) — keeping authenticated data here, in a
// store we fully control, lets us enforce the security properties the SW can't:
//
//   • Namespaced to this browser and busted on identity change. When /me
//     resolves to a different login than the cache was written under, we wipe
//     it (reconcileCacheOwner) so user B never reads user A's cached findings.
//   • Purged on logout (purgePersistedCache), wired to the "Sign out" link.
//   • Short-lived: entries older than MAX_AGE are dropped on restore.
//   • Only successful queries are written; errors/pending are never persisted.
//
// Bump CACHE_BUSTER to invalidate every persisted cache after a shape change.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "dsq-cache-v1";
const OWNER_KEY = "dsq-cache-owner";
const CACHE_BUSTER = "v1";
const MAX_AGE = 1000 * 60 * 60 * 24; // 24h

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // e.g. cookies/storage blocked — degrade to in-memory only.
  }
}

const store = storage();

// localStorage satisfies the AsyncStorage interface (get/set/removeItem), so
// the async persister works against it synchronously under the hood.
const persister = store
  ? createAsyncStoragePersister({ storage: store, key: STORAGE_KEY })
  : null;

const persistOptions = {
  maxAge: MAX_AGE,
  buster: CACHE_BUSTER,
  dehydrateOptions: {
    // Persist only resolved data — never error or in-flight states.
    shouldDehydrateQuery: (query: { state: { status: string } }) => query.state.status === "success",
  },
};

/**
 * Restore any cached data for this browser, then keep persisting future
 * writes. Awaited before first paint so an offline launch shows last-viewed
 * data immediately. No-ops gracefully when storage is unavailable.
 */
export async function initPersistence(queryClient: QueryClient): Promise<void> {
  if (!persister) return;
  try {
    await persistQueryClientRestore({ queryClient, persister, ...persistOptions });
    persistQueryClientSubscribe({ queryClient, persister, ...persistOptions });
  } catch {
    // A corrupt or unreadable cache must never block boot — start fresh.
    try {
      await persister.removeClient();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Bind the persisted cache to the signed-in user. If it was written under a
 * different login, wipe it before that stale data is trusted. Call once /me
 * resolves to a concrete login.
 */
export function reconcileCacheOwner(login: string, queryClient: QueryClient): void {
  if (!store || !login) return;
  const owner = store.getItem(OWNER_KEY);
  if (owner && owner !== login) {
    void purgePersistedCache(queryClient);
  }
  store.setItem(OWNER_KEY, login);
}

/** Drop all persisted + in-memory cached data. Wired to sign-out. */
export async function purgePersistedCache(queryClient: QueryClient): Promise<void> {
  queryClient.clear();
  if (store) store.removeItem(OWNER_KEY);
  if (persister) {
    try {
      await persister.removeClient();
    } catch {
      /* ignore */
    }
  }
}
