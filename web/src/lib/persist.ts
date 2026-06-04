import { hydrate, type QueryClient } from "@tanstack/react-query";
import { persistQueryClientSubscribe } from "@tanstack/react-query-persist-client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistedClient } from "@tanstack/react-query-persist-client";

// ─────────────────────────────────────────────────────────────────────────────
// Offline "last-viewed data" — a user-scoped, logout-purged TanStack Query
// persister backed by localStorage.
//
// We persist the in-memory query cache so a cold offline launch of the PWA can
// paint the last data the user saw (overview, findings, the PR they were on)
// instead of empty skeletons. The service worker deliberately does NOT cache
// /api responses (see vite.config.ts) — keeping authenticated data here, in a
// store we fully control, lets us enforce the security properties the SW can't.
//
// SECURITY — owner-gated restore. The cached data must never be shown to the
// wrong user on a shared device, so restore is split into two phases:
//
//   1. boot (initPersistence): read the persisted blob but DON'T hydrate it
//      into the live cache yet — just stash it and start persisting writes.
//   2. after /me resolves (applyPersistedDataForOwner): only NOW, with the live
//      authenticated login in hand, do we hydrate the data — and only if it
//      matches the login the cache was written under. A mismatch wipes it.
//
// We deliberately do NOT hydrate at boot when offline: with no network there's
// no way to prove the current session still belongs to the cache's owner (a
// cookie could have expired or the account switched while the app wasn't open
// to purge), so rendering it would risk showing the previous user's data.
// Offline therefore shows the cached app shell only; authenticated data paints
// once connectivity lets /me verify the owner. (The PWA acceptance bar is a
// graceful cached shell — not stale authed data shown without verification.)
//
// The identity query (["me"]) is never persisted: it must always be fetched
// fresh online so a stale cached identity can't make user B look like user A
// (its 5-minute staleTime would otherwise suppress the refetch). Combined with
// the deferred restore, user A's data is never hydrated into user B's UI.
//
// Also: purged on logout (purgePersistedCache, wired to "Sign out"), capped at
// MAX_AGE, and only successful queries are ever written. Bump CACHE_BUSTER to
// invalidate every persisted cache after a cache-shape change.
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
    // Persist resolved data only — and never the identity query, which must be
    // re-fetched fresh so a stale cached login can't masquerade as the current
    // user (see the security note above).
    shouldDehydrateQuery: (query: { state: { status: string }; queryKey: readonly unknown[] }) =>
      query.state.status === "success" && query.queryKey[0] !== "me",
  },
};

// The persisted blob read at boot, held until /me lets us decide whether to
// trust it. Consumed (cleared) the first time a concrete login reconciles it.
let pendingRestore: PersistedClient | null = null;

// The active persistence subscription's teardown, so a repeated
// initPersistence() (StrictMode/HMR remount, future bootstrap refactor)
// replaces rather than stacks subscribers.
let unsubscribePersistence: (() => void) | null = null;

function isFresh(client: PersistedClient | undefined): client is PersistedClient {
  return !!client && client.buster === CACHE_BUSTER && Date.now() - client.timestamp <= MAX_AGE;
}

/**
 * Boot phase. Read (but don't yet hydrate) the persisted cache and start
 * persisting future writes. Hydration is always deferred to
 * applyPersistedDataForOwner, which runs once /me verifies the owner — so a
 * user's cached data is never rendered before the active session is confirmed,
 * online or offline. Awaited before first paint. No-ops gracefully when
 * storage is unavailable.
 */
export async function initPersistence(queryClient: QueryClient): Promise<void> {
  if (!persister) return;
  try {
    const restored = await persister.restoreClient();
    if (isFresh(restored)) {
      pendingRestore = restored;
    } else if (restored) {
      await persister.removeClient(); // stale / busted — drop it.
    }
  } catch {
    // A corrupt or unreadable cache must never block boot — start fresh.
    try {
      await persister.removeClient();
    } catch {
      /* ignore */
    }
  } finally {
    // Always start persisting future writes, even if the restore above threw —
    // otherwise a single corrupt read would silently disable persistence for
    // the whole session. Tear down any prior subscription first so repeated
    // init calls replace rather than stack subscribers.
    unsubscribePersistence?.();
    unsubscribePersistence = persistQueryClientSubscribe({ queryClient, persister, ...persistOptions });
  }
}

/**
 * Reconcile the persisted cache against the signed-in user. Call when /me
 * settles. With a concrete `login` we either hydrate the cached data (owner
 * matches) or wipe it (owner differs) — so a different user on this device
 * never sees the previous user's data. With no login (offline / signed out /
 * still loading) `pendingRestore` stays pending and no cached authenticated
 * data is hydrated, so nothing renders until owner verification succeeds.
 */
export function applyPersistedDataForOwner(login: string | null, queryClient: QueryClient): void {
  if (!store || !login) return;
  const owner = store.getItem(OWNER_KEY);

  // Trust the staged cache only when the owner marker exactly matches this
  // login. A missing owner marker is NOT a match: we can't prove an owner-less
  // blob belongs to this user, so it must not be hydrated.
  if (pendingRestore && owner === login) {
    hydrate(queryClient, pendingRestore.clientState);
    pendingRestore = null;
    return; // OWNER_KEY already equals login — nothing to write.
  }

  // Otherwise the staged/persisted blob can't be trusted for this login (a
  // different owner, or an owner marker that's absent while a blob is staged).
  // Drop it — in memory and on disk — and claim the cache for the verified
  // login. purgePersistedCache writes OWNER_KEY itself, so we never call
  // setItem right after it removes the key.
  if (pendingRestore || (owner && owner !== login)) {
    pendingRestore = null;
    void purgePersistedCache(queryClient, login);
    return;
  }

  // Already this user's verified cache, nothing staged — leave it as is.
  if (owner === login) return;

  // Genuine first run on this device (no owner marker yet). The persistence
  // subscriber may already have written an *ownerless* blob this session, so
  // drop any persisted client before claiming the cache — we never bind an
  // unverified on-disk blob to this login. The live queryClient is untouched
  // (no clear / refetch); the subscriber re-persists under the new owner on the
  // next change.
  if (persister) void persister.removeClient();
  store.setItem(OWNER_KEY, login);
}

/**
 * Drop all persisted + in-memory cached data. Pass `nextOwner` to immediately
 * re-claim the (now-empty) cache for a verified login; omit it (sign-out) to
 * leave the cache owner-less. The OWNER_KEY write/clear happens synchronously
 * here, before the async client removal, so callers never have to set it
 * separately and risk racing this function's own removal.
 */
export async function purgePersistedCache(
  queryClient: QueryClient,
  nextOwner: string | null = null,
): Promise<void> {
  pendingRestore = null;
  queryClient.clear();
  if (store) {
    if (nextOwner) store.setItem(OWNER_KEY, nextOwner);
    else store.removeItem(OWNER_KEY);
  }
  if (persister) {
    try {
      await persister.removeClient();
    } catch {
      /* ignore */
    }
  }
}
