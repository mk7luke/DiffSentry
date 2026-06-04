import { useRef, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useToast } from "../realtime/toast";
import { useBulkTriage, useTriageFinding, type TriageVars } from "../api/hooks";
import { ApiError } from "../api/client";
import type { TriageState } from "../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// <TriageMenu> — the reusable accept / dismiss / snooze control. One button
// opens a small popover with a state segmented control, an optional note, and
// (for snooze) a date. It drives the single-finding or bulk endpoint depending
// on the target, then surfaces the result as a toast.
//
// Capability-gated: hidden entirely for roles without `triageFindings` (the
// server still enforces requireRole('author') + CSRF). The TriageBadge keeps
// showing the current state for everyone — only the *control* is gated.
// ─────────────────────────────────────────────────────────────────────────────

export type TriageTarget =
  | { kind: "single"; id: number }
  | { kind: "bulk"; ids: number[] }
  | { kind: "class"; fingerprint: string };

interface TriageMenuProps {
  target: TriageTarget;
  /** Trigger label. Defaults to "Triage". */
  label?: string;
  /** Visual style of the trigger button. Defaults to "ghost". */
  variant?: "primary" | "ghost" | "danger";
  /** Called after a successful triage (e.g. to clear a bulk selection). */
  onDone?: () => void;
  /** Compact trigger (smaller padding) for dense table rows. */
  compact?: boolean;
}

const STATES: Array<{ value: TriageState; label: string; tone: string }> = [
  { value: "accepted", label: "Accept", tone: "good" },
  { value: "dismissed", label: "Dismiss", tone: "danger" },
  { value: "snoozed", label: "Snooze", tone: "warn" },
];

export function TriageMenu({ target, label = "Triage", variant = "ghost", onDone, compact }: TriageMenuProps) {
  const { capabilities } = useAuth();
  const { push } = useToast();
  const single = useTriageFinding();
  const bulk = useBulkTriage();
  const btnRef = useRef<HTMLButtonElement>(null);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [state, setState] = useState<TriageState>("dismissed");
  const [note, setNote] = useState("");
  const [until, setUntil] = useState("");

  if (!capabilities.triageFindings) return null;

  const pending = single.isPending || bulk.isPending;
  const targetCount = target.kind === "bulk" ? target.ids.length : undefined;
  const btnClass = `btn ${variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-ghost"}`;

  function openMenu() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const left = Math.min(Math.max(8, r.left), window.innerWidth - 300);
      setPos({ top: r.bottom + 6, left });
    }
    setOpen(true);
  }

  async function apply() {
    if (state === "snoozed" && !until) {
      push({ tone: "danger", title: "Pick a snooze-until date first." });
      return;
    }
    const vars: TriageVars = {
      state,
      // Treat the picked day as end-of-day local so "snooze until today" still
      // has a future deadline; the server validates it is in the future.
      until: state === "snoozed" ? new Date(`${until}T23:59:59`).toISOString() : undefined,
      note: note.trim() || undefined,
    };
    try {
      let changed = 0;
      if (target.kind === "single") {
        changed = (await single.mutateAsync({ id: target.id, ...vars })).changed;
      } else if (target.kind === "bulk") {
        changed = (await bulk.mutateAsync({ ids: target.ids, ...vars })).changed;
      } else {
        changed = (await bulk.mutateAsync({ fingerprint: target.fingerprint, ...vars })).changed;
      }
      push({
        tone: "success",
        title: `Marked ${state}`,
        body: changed > 0 ? `${changed} finding${changed === 1 ? "" : "s"} updated` : "Already up to date",
      });
      setOpen(false);
      setNote("");
      setUntil("");
      onDone?.();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.code === "forbidden"
            ? "You don't have permission to triage."
            : err.message
          : "Triage failed.";
      push({ tone: "danger", title: "Triage failed", body: message });
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={btnClass}
        style={compact ? { padding: "3px 8px", fontSize: 11.5 } : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        disabled={pending || (target.kind === "bulk" && target.ids.length === 0)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {pending ? <span className="spinner btn-spinner" /> : null}
        {label}
        {targetCount !== undefined ? ` (${targetCount})` : ""}
      </button>
      {open ? (
        <>
          {/* Click-away backdrop. */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 60 }}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label="Triage finding"
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              zIndex: 61,
              width: 288,
              background: "var(--bg-elev-2)",
              border: "1px solid var(--line-strong)",
              borderRadius: 10,
              boxShadow: "var(--shadow-hover)",
              padding: 12,
            }}
          >
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {STATES.map((s) => {
                const active = state === s.value;
                return (
                  <button
                    key={s.value}
                    type="button"
                    className={`btn ${active ? "btn-primary" : "btn-ghost"}`}
                    style={{ flex: 1, padding: "5px 0", fontSize: 12 }}
                    onClick={() => setState(s.value)}
                    aria-pressed={active}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            {state === "snoozed" ? (
              <label className="field" style={{ display: "block", marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>Snooze until</span>
                <input
                  type="date"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                  style={{ width: "100%", marginTop: 4 }}
                />
              </label>
            ) : null}
            <label className="field" style={{ display: "block", marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: "var(--text-3)" }}>Note (optional)</span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why?"
                maxLength={2000}
                style={{ width: "100%", marginTop: 4 }}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn btn-link" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={apply} disabled={pending}>
                {pending ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
