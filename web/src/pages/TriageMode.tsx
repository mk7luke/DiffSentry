import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useFindings, usePRDiff, useTriageFinding } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { PageHeader } from "../components/primitives";
import { SeverityBadge, TriageBadge } from "../components/badges";
import { Markdown } from "../components/Markdown";
import { DiffSnippet } from "../components/DiffSnippet";
import { EmptyState, QueryBoundary } from "../components/states";
import { useAuth } from "../auth/useAuth";
import { useToast } from "../realtime/toast";
import { ApiError } from "../api/client";
import { relativeTime } from "../lib/format";
import type { FindingExplorerRow, PRFindingRow, TriageState } from "../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// Triage mode — a focused, keyboard-driven queue. One finding per large centred
// card: title, severity, the actual changed lines (via the D1 <DiffSnippet>),
// the rendered body, and big Accept / Dismiss / Snooze / Skip actions.
//
// The queue is a snapshot of the current Findings filter (read from the same URL
// query params as the explorer), frozen at mount + on sort change so triaging
// doesn't reshuffle the deck under the user. Triage reuses the shared
// useTriageFinding() mutation (same API + cache invalidation) and advances
// optimistically: the card moves on immediately and a local overlay reflects the
// decision, rolling back only if the write fails.
// ─────────────────────────────────────────────────────────────────────────────

/** Findings are fetched in one page; the server clamps the limit to 500. */
const QUEUE_LIMIT = 500;

const SEV_RANK: Record<string, number> = { critical: 4, major: 3, minor: 2, nit: 1 };

type SortKey = "severity" | "newest" | "oldest" | "path";

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: "severity", label: "Severity (high → low)" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "path", label: "Repo / path" },
];

function comparator(sort: SortKey): (a: FindingExplorerRow, b: FindingExplorerRow) => number {
  switch (sort) {
    case "severity":
      return (a, b) =>
        (SEV_RANK[(b.severity ?? "").toLowerCase()] ?? 0) - (SEV_RANK[(a.severity ?? "").toLowerCase()] ?? 0) ||
        Date.parse(b.created_at) - Date.parse(a.created_at);
    case "newest":
      return (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at);
    case "oldest":
      return (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at);
    case "path":
      return (a, b) =>
        `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`) ||
        (a.path ?? "").localeCompare(b.path ?? "") ||
        (a.line ?? 0) - (b.line ?? 0);
  }
}

/** Local yyyy-mm-dd a week out, used to seed the snooze date. */
function defaultSnoozeDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function TriageModePage() {
  const [params] = useSearchParams();
  const [sort, setSort] = useState<SortKey>("severity");

  const query = useFindings({
    severity: params.get("severity") ?? undefined,
    source: params.get("source") ?? undefined,
    repo: params.get("repo") ?? undefined,
    q: params.get("q") ?? undefined,
    fingerprint: params.get("fingerprint") ?? undefined,
    triage: params.get("triage") ?? undefined,
    age: params.get("age") ?? undefined,
    limit: QUEUE_LIMIT,
    offset: 0,
  });

  // Preserve the active filters when bouncing back to the list view.
  const backTo = params.toString() ? `/findings?${params.toString()}` : "/findings";
  // Remounting the deck on sort/filter change re-snapshots the queue and resets
  // the position — the right behaviour when the working set changes.
  const deckKey = `${sort}|${params.toString()}`;

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Findings", to: "/findings" }, { label: "Triage mode" }]} />
      <PageHeader
        title="Triage mode"
        subtitle="One finding at a time — accept, dismiss, or snooze without leaving the keyboard."
        right={
          <div className="triage-head-controls">
            <label className="field">
              Order
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <Link to={backTo} className="btn btn-ghost">
              ← Back to list
            </Link>
          </div>
        }
      />

      <QueryBoundary query={query} loadingLabel="Loading findings…">
        {(data) =>
          data.rows.length === 0 ? (
            <EmptyState
              title="Nothing to triage"
              hint={
                <>
                  No findings match the current filters.{" "}
                  <Link className="link" to={backTo}>
                    Adjust filters
                  </Link>
                  .
                </>
              }
            />
          ) : (
            <TriageDeck key={deckKey} rows={data.rows} total={data.total} sort={sort} backTo={backTo} />
          )
        }
      </QueryBoundary>
    </>
  );
}

interface TriageDeckProps {
  rows: FindingExplorerRow[];
  total: number;
  sort: SortKey;
  backTo: string;
}

function TriageDeck({ rows, total, sort, backTo }: TriageDeckProps) {
  const { capabilities } = useAuth();
  const { push } = useToast();
  const triage = useTriageFinding();
  const canTriage = capabilities.triageFindings;

  // Snapshot + sort the queue once at mount. The component is remounted (keyed)
  // when the sort or filters change, so this stays the frozen working set.
  const [queue] = useState<FindingExplorerRow[]>(() => [...rows].sort(comparator(sort)));
  const [index, setIndex] = useState(0);
  // Decisions applied this session, overlaid on the (frozen) snapshot rows so the
  // badge updates instantly and survives navigating back to a card.
  const [decided, setDecided] = useState<Map<number, TriageState>>(() => new Map());
  const [note, setNote] = useState("");
  const [snoozeUntil, setSnoozeUntil] = useState<string>(() => defaultSnoozeDate());

  const cardRef = useRef<HTMLElement>(null);

  const atEnd = index >= queue.length;
  const active = atEnd ? null : queue[index];

  const goNext = useCallback(() => setIndex((i) => Math.min(i + 1, queue.length)), [queue.length]);
  const goPrev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  // Move focus to the card as the position changes so keyboard users land on the
  // new finding (and screen readers re-announce it via the card's label).
  useEffect(() => {
    cardRef.current?.focus();
  }, [index]);

  const applyTriage = useCallback(
    (state: TriageState) => {
      if (!active || !canTriage) return;
      if (state === "snoozed" && !snoozeUntil) {
        push({ tone: "danger", title: "Pick a snooze-until date first." });
        return;
      }
      const id = active.id;
      const until = state === "snoozed" ? new Date(`${snoozeUntil}T23:59:59`).toISOString() : undefined;
      const noteVal = note.trim() || undefined;
      // Optimistic: record the decision and advance immediately.
      setDecided((prev) => new Map(prev).set(id, state));
      setNote("");
      goNext();
      triage
        .mutateAsync({ id, state, until, note: noteVal })
        .then((r) => {
          push({
            tone: "success",
            title: `Marked ${state}`,
            body: r.changed > 0 ? "Saved" : "Already up to date",
          });
        })
        .catch((err) => {
          // Roll the overlay back so the finding doesn't look triaged when it isn't.
          setDecided((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          const message =
            err instanceof ApiError
              ? err.code === "forbidden"
                ? "You don't have permission to triage."
                : err.message
              : "Triage failed.";
          push({ tone: "danger", title: "Triage failed", body: message });
        });
    },
    [active, canTriage, snoozeUntil, note, goNext, triage, push],
  );

  // Keyboard nav + triage. Mirrors <DiffViewer>: ignore while typing in a field
  // and while a dialog (the command palette) is visibly open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      ) {
        return;
      }
      const dialogOpen = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some(
        (el) =>
          !el.hasAttribute("hidden") &&
          el.getAttribute("aria-hidden") !== "true" &&
          el.getClientRects().length > 0,
      );
      if (dialogOpen) return;

      switch (e.key) {
        case "ArrowRight":
        case "j":
          e.preventDefault();
          goNext();
          break;
        case "ArrowLeft":
        case "k":
          e.preventDefault();
          goPrev();
          break;
        case "a":
        case "Enter":
          if (canTriage && active) {
            e.preventDefault();
            applyTriage("accepted");
          }
          break;
        case "d":
          if (canTriage && active) {
            e.preventDefault();
            applyTriage("dismissed");
          }
          break;
        case "s":
          if (canTriage && active) {
            e.preventDefault();
            applyTriage("snoozed");
          }
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, applyTriage, canTriage, active]);

  const tally = useMemo(() => {
    let accepted = 0;
    let dismissed = 0;
    let snoozed = 0;
    for (const s of decided.values()) {
      if (s === "accepted") accepted++;
      else if (s === "dismissed") dismissed++;
      else snoozed++;
    }
    return { accepted, dismissed, snoozed, total: decided.size };
  }, [decided]);

  if (atEnd) {
    return (
      <section className="triage-done card" aria-live="polite">
        <h2>End of queue</h2>
        <p className="muted">
          You reached the end of {queue.length} finding{queue.length === 1 ? "" : "s"}.
        </p>
        <dl className="triage-tally">
          <div>
            <dt>Accepted</dt>
            <dd className="good">{tally.accepted}</dd>
          </div>
          <div>
            <dt>Dismissed</dt>
            <dd>{tally.dismissed}</dd>
          </div>
          <div>
            <dt>Snoozed</dt>
            <dd className="warn">{tally.snoozed}</dd>
          </div>
        </dl>
        <div className="triage-done-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setIndex(0)}>
            ↺ Review again
          </button>
          <Link to={backTo} className="btn btn-primary">
            Back to findings
          </Link>
        </div>
      </section>
    );
  }

  return (
    <div className="triage-stage">
      <div className="triage-bar">
        <p className="triage-progress" aria-live="polite" role="status">
          {index + 1} <span className="muted">of</span> {queue.length}
          {total > queue.length ? <span className="muted"> · first {queue.length} of {total}</span> : null}
        </p>
        <div className="triage-progress-track" aria-hidden="true">
          <span className="triage-progress-fill" style={{ width: `${((index + 1) / queue.length) * 100}%` }} />
        </div>
        {tally.total > 0 ? (
          <p className="triage-session muted">{tally.total} triaged this session</p>
        ) : (
          <span />
        )}
      </div>

      <TriageCard
        key={active!.id}
        finding={active!}
        overlay={decided.get(active!.id)}
        cardRef={cardRef}
        position={`Finding ${index + 1} of ${queue.length}`}
      />

      {canTriage ? (
        <div className="triage-actions">
          <label className="field triage-note">
            Note (optional)
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why? (applies to your next decision)"
              maxLength={2000}
            />
          </label>
          <div className="triage-buttons">
            <button type="button" className="btn btn-primary triage-act" onClick={() => applyTriage("accepted")}>
              Accept <kbd>A</kbd>
            </button>
            <button type="button" className="btn btn-danger triage-act" onClick={() => applyTriage("dismissed")}>
              Dismiss <kbd>D</kbd>
            </button>
            <div className="triage-snooze">
              <button type="button" className="btn btn-ghost triage-act" onClick={() => applyTriage("snoozed")}>
                Snooze <kbd>S</kbd>
              </button>
              <input
                type="date"
                aria-label="Snooze until"
                value={snoozeUntil}
                onChange={(e) => setSnoozeUntil(e.target.value)}
              />
            </div>
            <button type="button" className="btn btn-ghost triage-act" onClick={goNext}>
              Skip <kbd>→</kbd>
            </button>
          </div>
        </div>
      ) : (
        <div className="triage-readonly card tone-accent">
          <p className="muted">You have read-only access — triage actions are disabled for your role.</p>
        </div>
      )}

      <p className="triage-legend muted" aria-hidden="true">
        <kbd>←</kbd>/<kbd>→</kbd> or <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>A</kbd> accept · <kbd>D</kbd> dismiss ·{" "}
        <kbd>S</kbd> snooze · <kbd>Enter</kbd> accept
      </p>
    </div>
  );
}

/** One finding's card. Pulls the PR diff (for the snippet + the finding body,
 *  which the explorer row omits) keyed by PR, so siblings in the same PR reuse
 *  the cache. */
function TriageCard({
  finding,
  overlay,
  cardRef,
  position,
}: {
  finding: FindingExplorerRow;
  overlay?: TriageState;
  cardRef: React.RefObject<HTMLElement>;
  position: string;
}) {
  const diffQuery = usePRDiff(finding.owner, finding.repo, finding.number);
  // The explorer row has no body; pull the full finding from the PR diff payload.
  const full: PRFindingRow | undefined = diffQuery.data?.findings.find((f) => f.id === finding.id);

  return (
    <section
      className="triage-card card"
      tabIndex={-1}
      ref={cardRef}
      aria-label={`${position}: ${finding.title ?? "untitled"}, severity ${finding.severity ?? "unknown"}`}
    >
      <header className="triage-card-head">
        <SeverityBadge severity={finding.severity} />
        {overlay ? <TriageBadge row={decisionRow(overlay)} /> : <TriageBadge row={finding} />}
        <Link
          className="link triage-card-pr"
          to={`/repos/${encodeURIComponent(finding.owner)}/${encodeURIComponent(finding.repo)}/pr/${finding.number}`}
        >
          {finding.owner}/{finding.repo} #{finding.number}
        </Link>
        {finding.source ? <span className="muted">· {finding.source}</span> : null}
        <span className="muted triage-card-when">{relativeTime(finding.created_at)}</span>
      </header>

      <h2 className="triage-card-title">{finding.title ?? "(untitled finding)"}</h2>

      {diffQuery.isPending ? (
        <div className="triage-snippet-missing muted">Loading changed lines…</div>
      ) : (
        <DiffSnippet
          diff={diffQuery.data?.diff ?? null}
          path={finding.path}
          line={finding.line}
          truncated={diffQuery.data?.truncated}
        />
      )}

      <div className="triage-card-body">
        {full?.body ? (
          <Markdown source={full.body.slice(0, 12000)} />
        ) : diffQuery.isPending ? null : (
          <p className="muted">No description was recorded for this finding.</p>
        )}
      </div>
    </section>
  );
}

/** A minimal triage-columns shape so <TriageBadge> can render an optimistic
 *  decision before the server round-trip lands. */
function decisionRow(state: TriageState): {
  accepted: number | null;
  snoozed_until: string | null;
  triaged_by: string | null;
  triaged_at: string | null;
  triage_note: string | null;
} {
  return {
    accepted: state === "accepted" ? 1 : state === "dismissed" ? 0 : null,
    // A far-future deadline so triageStateOf() reads this back as "snoozed".
    snoozed_until: state === "snoozed" ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null,
    triaged_by: null,
    triaged_at: null,
    triage_note: null,
  };
}
