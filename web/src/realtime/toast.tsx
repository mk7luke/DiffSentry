import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useEventStream,
  type ActionPayload,
  type ConfigUpdatePayload,
  type LearningChangePayload,
  type ReviewLifecyclePayload,
  type StreamEnvelope,
  type WebhookReplayPayload,
} from "./useEventStream";

// ─────────────────────────────────────────────────────────────────────────────
// Toast / live feed primitive.
//
// Two jobs:
//   1. Imperative toasts — useToast().push(...) from <ActionButton> and any
//      feature that wants to surface a result.
//   2. A live feed — it subscribes to the event stream and auto-toasts review
//      lifecycle + action events, so anything happening server-side shows up
//      without a refresh (the W0.4 acceptance criterion).
//
// Kept deliberately small: a capped list, auto-dismiss, no external deps.
// ─────────────────────────────────────────────────────────────────────────────

export type ToastTone = "info" | "success" | "danger" | "pending";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  /** ms before auto-dismiss; 0 keeps it until dismissed. Default 6000. */
  ttl?: number;
}

interface ToastContextValue {
  push: (t: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_TOASTS = 5;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `t${counter}_${Date.now()}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track timers so dismiss() can cancel a pending auto-dismiss.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // On unmount, clear every pending auto-dismiss timer so a queued setTimeout
  // can't fire dismiss() (→ setState) after the provider is gone.
  useEffect(() => {
    const timersAtMount = timers.current;
    return () => {
      for (const timer of timersAtMount.values()) clearTimeout(timer);
      timersAtMount.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id"> & { id?: string }) => {
      const id = t.id ?? nextId();
      setToasts((list) => {
        // Replace an existing toast with the same id (e.g. pending → success).
        const without = list.filter((x) => x.id !== id);
        const next = [...without, { ...t, id }];
        const capped = next.slice(-MAX_TOASTS);
        // Clear timers for toasts evicted by the cap so a stale setTimeout can't
        // later fire dismiss() for a toast that's already gone. clearTimeout +
        // Map.delete are idempotent, so StrictMode's double-invoked updater is safe.
        if (capped.length < next.length) {
          const retained = new Set(capped.map((x) => x.id));
          for (const x of next) {
            if (retained.has(x.id)) continue;
            const timer = timers.current.get(x.id);
            if (timer) clearTimeout(timer);
            timers.current.delete(x.id);
          }
        }
        return capped;
      });
      const ttl = t.ttl ?? 6000;
      const existing = timers.current.get(id);
      if (existing) {
        clearTimeout(existing);
        // Delete the entry too: a ttl:0 replacement skips the scheduling block
        // below, so without this the map would keep a stale (cleared) handle.
        timers.current.delete(id);
      }
      if (ttl > 0) {
        const timer = setTimeout(() => {
          // If a later push reused this id and replaced the timer, this callback
          // is stale — skip it so it can't dismiss the newer toast or clear its
          // timer. Otherwise it's still the active timer, so dismiss normally.
          if (timers.current.get(id) === timer) dismiss(id);
        }, ttl);
        if (typeof timer === "object" && "unref" in timer) (timer as { unref?: () => void }).unref?.();
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <StreamToasts />
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

/** Bridges the SSE stream into toasts. Rendered once inside the provider. */
function StreamToasts() {
  const { push } = useToast();
  const onEvent = useCallback(
    (env: StreamEnvelope) => {
      if (env.topic === "review.started" || env.topic === "review.finished" || env.topic === "review.failed") {
        const p = env.payload as ReviewLifecyclePayload;
        const ref = `${p.owner}/${p.repo}#${p.number}`;
        if (env.topic === "review.started") {
          push({ id: `review-${ref}`, tone: "pending", title: `Review started · ${ref}`, body: p.mode ? `${p.mode} review` : undefined, ttl: 0 });
        } else if (env.topic === "review.finished") {
          push({ id: `review-${ref}`, tone: "success", title: `Review finished · ${ref}` });
        } else {
          push({ id: `review-${ref}`, tone: "danger", title: `Review failed · ${ref}`, body: p.error });
        }
        return;
      }
      if (env.topic === "action.performed") {
        const p = env.payload as ActionPayload;
        const ref = `${p.owner}/${p.repo}#${p.number}`;
        const who = p.actor ? `@${p.actor}` : "someone";
        push({
          tone: p.result === "ok" || p.result === "accepted" ? "info" : "danger",
          title: `${who} · ${p.action} · ${ref}`,
          body: p.detail,
        });
        return;
      }
      if (env.topic === "config.updated") {
        const p = env.payload as ConfigUpdatePayload;
        const who = p.actor ? `@${p.actor}` : "someone";
        push({
          tone: "info",
          title: `${who} updated config · ${p.owner}/${p.repo}`,
          body: p.mode === "pr" ? `Opened PR #${p.prNumber}` : `Committed to ${p.branch}`,
        });
        return;
      }
      if (env.topic === "learning.changed") {
        const p = env.payload as LearningChangePayload;
        const who = p.actor ? `@${p.actor}` : "someone";
        const where = p.scope === "global" ? "global" : `${p.owner}/${p.repo}`;
        const what = p.action === "bulk_delete" ? `deleted ${p.count ?? 0} learnings` : `learning ${p.action}`;
        push({ tone: "info", title: `${who} · ${what}`, body: where });
        return;
      }
      if (env.topic === "webhook.replayed") {
        const p = env.payload as WebhookReplayPayload;
        const who = p.actor ? `@${p.actor}` : "someone";
        push({
          tone: "info",
          title: `${who} replayed webhook · ${p.event}`,
          body: p.newDeliveryId ? `New delivery #${p.newDeliveryId} (from #${p.id})` : `Replayed delivery #${p.id}`,
        });
      }
    },
    [push],
  );
  useEventStream(onEvent);
  return null;
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.tone === "pending" ? <span className="spinner toast-spinner" /> : <span className="toast-dot" />}
          <div className="toast-text">
            <div className="toast-title">{t.title}</div>
            {t.body ? <div className="toast-body">{t.body}</div> : null}
          </div>
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
