import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiSend, ApiError } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { useToast } from "../realtime/toast";
import type { Capabilities } from "../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// <ActionButton> — the generic write-action control every interactive feature
// reuses. POSTs to a command endpoint, shows a pending spinner, and surfaces the
// result (including the server's audit-logged outcome) as a toast.
//
// Capability-gated client-side (the server still enforces requireRole + CSRF):
// when `capability` is set and the current role lacks it, the button renders
// disabled with an explanatory title rather than 403-ing on click.
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionButtonProps {
  /** Path under /api/v1 — e.g. `/repos/o/r/prs/5/review`. */
  path: string;
  /** HTTP method. Defaults to POST. */
  method?: "POST" | "PUT" | "DELETE";
  /** JSON body to send. */
  body?: unknown;
  /** Button label. */
  children: ReactNode;
  /** Label shown while the request is in flight. Defaults to "Working…". */
  pendingLabel?: ReactNode;
  /** Capability the action requires; the button is disabled without it. */
  capability?: keyof Capabilities;
  /** Visual style. Defaults to "ghost". */
  variant?: "primary" | "ghost" | "danger";
  /** Optional confirm() prompt before sending. */
  confirm?: string;
  /** Toast title on success. Defaults to "Done". */
  successTitle?: string;
  /** Query keys to invalidate on success (refetch fresh data). */
  invalidateKeys?: unknown[][];
  /** Called with the response data on success. */
  onDone?: (data: unknown) => void;
  /** Optional leading icon. */
  icon?: ReactNode;
}

interface ActionResult {
  result?: string;
  detail?: string;
  action?: string;
}

export function ActionButton(props: ActionButtonProps) {
  const { capabilities } = useAuth();
  const { push } = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);

  const allowed = !props.capability || capabilities[props.capability];
  const variant = props.variant ?? "ghost";
  const btnClass = `btn ${variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-ghost"}`;

  async function run() {
    if (pending || !allowed) return;
    if (props.confirm && !window.confirm(props.confirm)) return;
    setPending(true);
    try {
      const data = await apiSend<ActionResult>(props.path, { method: props.method ?? "POST", body: props.body });
      // The endpoint echoes the audit-logged result ("ok" | "accepted").
      const detail = data?.detail;
      push({
        tone: data?.result === "accepted" ? "info" : "success",
        title: props.successTitle ?? "Done",
        body: detail,
      });
      for (const key of props.invalidateKeys ?? []) {
        void qc.invalidateQueries({ queryKey: key });
      }
      props.onDone?.(data);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.code === "forbidden"
            ? "You don't have permission for this action."
            : err.message
          : "Action failed.";
      push({ tone: "danger", title: "Action failed", body: message });
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className={btnClass}
      onClick={run}
      disabled={pending || !allowed}
      aria-disabled={pending || !allowed}
      aria-busy={pending}
      title={!allowed ? "Requires a higher role" : undefined}
    >
      {pending ? <span className="spinner btn-spinner" /> : props.icon}
      {pending ? props.pendingLabel ?? "Working…" : props.children}
    </button>
  );
}
