import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePRDiff } from "../api/hooks";
import { QueryBoundary, EmptyState } from "./states";
import { Markdown } from "./Markdown";
import { SeverityBadge, TriageBadge } from "./badges";
import { TriageMenu } from "./TriageControls";
import { parseUnifiedDiff, langFromPath, type DiffFile, type DiffLine } from "../lib/unified-diff";
import { highlightLine } from "../lib/highlight";
import type { PRFindingRow } from "../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// <DiffViewer> — the in-app inline diff. Renders the PR's unified diff with a
// file switcher, syntax highlighting, and severity-coloured gutter markers where
// findings are anchored. Clicking a marker opens an inline panel with the
// finding's rendered markdown body + triage actions (reusing <TriageMenu>, so it
// rides the same triage API + cache-invalidation as the rest of the app).
//
// Keyboard: j / k step through anchored findings (switching files as needed),
// t triages the active finding.
// ─────────────────────────────────────────────────────────────────────────────

const SEV_CLASS: Record<string, string> = {
  critical: "sev-crit",
  major: "sev-major",
  minor: "sev-minor",
  nit: "sev-nit",
};
const SEV_RANK: Record<string, number> = { critical: 4, major: 3, minor: 2, nit: 1 };

function sevClass(sev: string | null | undefined): string {
  return SEV_CLASS[(sev ?? "").toLowerCase()] ?? "muted";
}
function worstSev(findings: PRFindingRow[]): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const f of findings) {
    const r = SEV_RANK[(f.severity ?? "").toLowerCase()] ?? 0;
    if (r > bestRank) {
      bestRank = r;
      best = f.severity ?? null;
    }
  }
  return best;
}

const STATUS_TAG: Record<DiffFile["status"], { label: string; cls: string }> = {
  added: { label: "A", cls: "good" },
  deleted: { label: "D", cls: "danger" },
  modified: { label: "M", cls: "warn" },
  renamed: { label: "R", cls: "neutral" },
};

/** One anchored finding in document order — drives j/k navigation. */
interface NavEntry {
  id: number;
  path: string;
  line: number;
}

export function DiffViewer({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const query = usePRDiff(owner, repo, number);
  return (
    <QueryBoundary query={query} loadingLabel="Loading diff…">
      {(data) => (
        <DiffViewerBody
          diff={data.diff}
          truncated={data.truncated}
          diffError={data.diffError}
          findings={data.findings}
        />
      )}
    </QueryBoundary>
  );
}

function DiffViewerBody({
  diff,
  truncated,
  diffError,
  findings,
}: {
  diff: string | null;
  truncated: boolean;
  diffError: string | null;
  findings: PRFindingRow[];
}) {
  const files = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);

  // Group findings by { path, line }. First drop exact repeats across reviews
  // (same fingerprint, or id when absent, at the same location); the surviving
  // findings for a line are kept as a list and all rendered in that line's panel.
  // navList later uses only the first of each line as the anchor for nav/refs;
  // the API's severity-desc / recency sort makes that first the most salient.
  const anchored = useMemo(() => {
    const byPathLine = new Map<string, PRFindingRow[]>();
    const seen = new Set<string>();
    for (const f of findings) {
      if (!f.path || f.line == null) continue;
      const dedup = `${f.path}:${f.line}:${f.fingerprint ?? f.id}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      const key = `${f.path}:${f.line}`;
      const list = byPathLine.get(key);
      if (list) list.push(f);
      else byPathLine.set(key, [f]);
    }
    return byPathLine;
  }, [findings]);

  // Per-file finding counts + worst severity for the switcher.
  const fileFindings = useMemo(() => {
    const m = new Map<string, PRFindingRow[]>();
    for (const [key, list] of anchored) {
      const path = key.slice(0, key.lastIndexOf(":"));
      const acc = m.get(path);
      if (acc) acc.push(...list);
      else m.set(path, [...list]);
    }
    return m;
  }, [anchored]);

  // Ordered nav list: files in diff order, findings by line within each.
  const navList = useMemo<NavEntry[]>(() => {
    const out: NavEntry[] = [];
    for (const file of files) {
      // A Set so a malformed diff (e.g. a repeated hunk) that surfaces the same
      // new-side line twice still yields exactly one nav stop — otherwise j/k
      // would advance the index while appearing to sit on the same finding.
      const lines = new Set<number>();
      for (const hunk of file.hunks) {
        for (const ln of hunk.lines) {
          if (ln.newLine != null && anchored.has(`${file.path}:${ln.newLine}`)) lines.add(ln.newLine);
        }
      }
      for (const line of [...lines].sort((a, b) => a - b)) {
        // One nav stop per anchored line, keyed by the line's anchor finding
        // (its first) — the same id rowRefs/panelRefs use, so scroll + the `t`
        // shortcut resolve even when a line carries several findings.
        const first = (anchored.get(`${file.path}:${line}`) ?? [])[0];
        if (first) out.push({ id: first.id, path: file.path, line });
      }
    }
    return out;
  }, [files, anchored]);

  const firstWithFindings = files.find((f) => fileFindings.has(f.path));
  const [selectedPath, setSelectedPath] = useState<string>(
    () => (firstWithFindings ?? files[0])?.path ?? "",
  );
  const [activeId, setActiveId] = useState<number | null>(null);
  const [openPanels, setOpenPanels] = useState<Set<number>>(() => new Set());
  // When set, an effect clicks the active finding's triage trigger once its
  // panel is rendered (the `t` shortcut), then clears itself.
  const [triageRequest, setTriageRequest] = useState<number | null>(null);

  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const panelRefs = useRef(new Map<number, HTMLTableCellElement>());

  // Reconcile selection state when the findings payload changes (triage/SSE
  // refresh, diff reload): drop ids that no longer exist so navigation never
  // starts from a removed finding and openPanels can't retain a dead id whose
  // panel ref will never be recreated. Functional updates keep this keyed on
  // `findings` alone (no churn when activeId/triageRequest change).
  useEffect(() => {
    const valid = new Set(findings.map((f) => f.id));
    setOpenPanels((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setActiveId((cur) => (cur != null && !valid.has(cur) ? null : cur));
    setTriageRequest((cur) => (cur != null && !valid.has(cur) ? null : cur));
  }, [findings]);

  // Derive a valid file every render: honour the user's selection when it still
  // exists, else fall back to the same choice the reconciling effect makes
  // (first-with-findings, then first) so render and effect never disagree for a
  // frame.
  const selectedFile =
    files.find((f) => f.path === selectedPath) ?? firstWithFindings ?? files[0] ?? null;

  // Reconcile the selected file against async `files` updates: when the current
  // selection is empty or no longer present (e.g. a degraded diff:null first
  // load that later refetches with real content), fall back to the first file
  // with findings, else the first file — so the pane + active highlight follow.
  useEffect(() => {
    if (files.length === 0) return;
    if (!selectedPath || !files.some((f) => f.path === selectedPath)) {
      setSelectedPath((firstWithFindings ?? files[0]).path);
    }
  }, [files, firstWithFindings, selectedPath]);

  const togglePanel = useCallback((id: number) => {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Focus a finding: select its file, mark it active, open its panel, scroll to it.
  const focusFinding = useCallback(
    (entry: NavEntry) => {
      setSelectedPath(entry.path);
      setActiveId(entry.id);
      setOpenPanels((prev) => new Set(prev).add(entry.id));
    },
    [],
  );

  // After a focus/file switch lands, scroll the active row into view.
  useEffect(() => {
    if (activeId == null) return;
    const el = rowRefs.current.get(activeId);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeId, selectedPath]);

  // The `t` shortcut: once the active finding's panel is open, click its
  // TriageMenu trigger (aria-haspopup="dialog") to pop the triage controls.
  useEffect(() => {
    if (triageRequest == null) return;
    const cell = panelRefs.current.get(triageRequest);
    const trigger = cell?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    trigger?.click();
    // Always clear the request after one attempt — if no trigger exists (e.g.
    // TriageMenu rendered nothing because the user lacks the capability) we must
    // not leave the request latched, re-firing on every openPanels change.
    setTriageRequest(null);
  }, [triageRequest, openPanels]);

  // Keyboard navigation. Ignored while typing or when a popover/dialog is open.
  useEffect(() => {
    if (navList.length === 0) return;
    function onKey(e: KeyboardEvent) {
      // Only j/k/t are shortcuts — bail before any DOM work so the common case
      // (every other keypress while the diff view is mounted) costs nothing.
      if (e.key !== "j" && e.key !== "k" && e.key !== "t") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        return;
      }
      // Suppress shortcuts only while an actually-visible dialog is open (the
      // triage popover or the command palette), not merely because a dialog node
      // exists in the DOM. Both render outside .diffv (fixed-positioned at the
      // body), so this must be a document scan, not a viewer-scoped one.
      // getClientRects() is used rather than offsetParent so the check stays
      // correct for position:fixed dialogs (offsetParent is null for those even
      // when visible). getClientRects only runs when a dialog node exists.
      const dialogOpen = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"]'),
      ).some(
        (el) =>
          !el.hasAttribute("hidden") &&
          el.getAttribute("aria-hidden") !== "true" &&
          el.getClientRects().length > 0,
      );
      if (dialogOpen) return;
      if (e.key === "t") {
        if (activeId == null) return;
        e.preventDefault();
        setOpenPanels((prev) => new Set(prev).add(activeId));
        setTriageRequest(activeId);
        return;
      }
      // j / k
      e.preventDefault();
      const idx = activeId == null ? -1 : navList.findIndex((n) => n.id === activeId);
      const nextIdx =
        e.key === "j"
          ? idx < 0
            ? 0
            : Math.min(idx + 1, navList.length - 1)
          : idx < 0
            ? 0
            : Math.max(idx - 1, 0);
      focusFinding(navList[nextIdx]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navList, activeId, focusFinding]);

  if (!diff) {
    return (
      <div>
        <EmptyState
          title="Diff unavailable"
          hint={diffError ?? "The unified diff could not be loaded for this PR."}
        />
        {findings.length > 0 ? (
          <FindingFallbackList
            findings={findings}
            activeId={activeId}
            setActiveId={setActiveId}
          />
        ) : null}
      </div>
    );
  }

  if (files.length === 0) {
    return <EmptyState title="Empty diff" hint="This PR has no textual changes to display." />;
  }

  return (
    <div className="diffv">
      <nav className="diffv-files" aria-label="Changed files">
        {truncated ? (
          <div className="diffv-truncated" role="note">
            Large diff — truncated. Some files may be partial.
          </div>
        ) : null}
        {files.map((file) => {
          const ff = fileFindings.get(file.path) ?? [];
          const tag = STATUS_TAG[file.status];
          const base = file.path.slice(file.path.lastIndexOf("/") + 1);
          const dir = file.path.slice(0, file.path.length - base.length);
          return (
            <button
              key={file.path}
              type="button"
              className={`diffv-file${file.path === selectedFile?.path ? " active" : ""}`}
              onClick={() => setSelectedPath(file.path)}
              title={file.path}
            >
              <span className={`diffv-status chip ${tag.cls} uppercase`}>{tag.label}</span>
              <span className="diffv-file-name mono">
                {dir ? <span className="diffv-file-dir muted">{dir}</span> : null}
                <span className="diffv-file-base">{base}</span>
              </span>
              <span className="diffv-file-meta">
                {ff.length > 0 ? (
                  <span className={`diffv-dot ${sevClass(worstSev(ff))}`} title={`${ff.length} finding(s)`} />
                ) : null}
                <span className="diffv-adds">+{file.additions}</span>
                <span className="diffv-dels">−{file.deletions}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="diffv-main">
        {selectedFile ? (
          <DiffFileView
            file={selectedFile}
            anchored={anchored}
            openPanels={openPanels}
            activeId={activeId}
            onToggle={(id) => {
              setActiveId(id);
              togglePanel(id);
            }}
            rowRefs={rowRefs.current}
            panelRefs={panelRefs.current}
          />
        ) : null}
      </div>
    </div>
  );
}

function DiffFileView({
  file,
  anchored,
  openPanels,
  activeId,
  onToggle,
  rowRefs,
  panelRefs,
}: {
  file: DiffFile;
  anchored: Map<string, PRFindingRow[]>;
  openPanels: Set<number>;
  activeId: number | null;
  onToggle: (id: number) => void;
  rowRefs: Map<number, HTMLTableRowElement>;
  panelRefs: Map<number, HTMLTableCellElement>;
}) {
  const lang = langFromPath(file.path);

  return (
    <section className="diffv-file-view">
      <header className="diffv-filehead">
        <span className="mono strong">{file.path}</span>
        <span className="diffv-filehead-meta">
          <span className="diffv-adds">+{file.additions}</span>
          <span className="diffv-dels">−{file.deletions}</span>
        </span>
      </header>
      {file.binary ? (
        <div className="diffv-binary muted">Binary file — not shown.</div>
      ) : (
        <table className="diffv-code">
          <tbody>
            {file.hunks.map((hunk, hi) => (
              <HunkRows
                key={hi}
                file={file}
                hunk={hunk}
                lang={lang}
                anchored={anchored}
                openPanels={openPanels}
                activeId={activeId}
                onToggle={onToggle}
                rowRefs={rowRefs}
                panelRefs={panelRefs}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function HunkRows({
  file,
  hunk,
  lang,
  anchored,
  openPanels,
  activeId,
  onToggle,
  rowRefs,
  panelRefs,
}: {
  file: DiffFile;
  hunk: { header: string; lines: DiffLine[] };
  lang: string;
  anchored: Map<string, PRFindingRow[]>;
  openPanels: Set<number>;
  activeId: number | null;
  onToggle: (id: number) => void;
  rowRefs: Map<number, HTMLTableRowElement>;
  panelRefs: Map<number, HTMLTableCellElement>;
}) {
  return (
    <>
      <tr className="diffv-hunk-head">
        <td className="diffv-gutter" colSpan={3} />
        <td className="diffv-hunk-text mono">{hunk.header}</td>
      </tr>
      {hunk.lines.map((ln, li) => {
        const lineFindings = ln.newLine != null ? anchored.get(`${file.path}:${ln.newLine}`) : undefined;
        const sign = ln.type === "add" ? "+" : ln.type === "del" ? "−" : "";
        // The anchor finding for ref/scroll purposes is the first on the line.
        const anchorId = lineFindings?.[0]?.id;
        return (
          <Row
            key={li}
            line={ln}
            lang={lang}
            sign={sign}
            findings={lineFindings}
            anchorId={anchorId}
            activeId={activeId}
            openPanels={openPanels}
            onToggle={onToggle}
            rowRefs={rowRefs}
            panelRefs={panelRefs}
          />
        );
      })}
    </>
  );
}

function Row({
  line,
  lang,
  sign,
  findings,
  anchorId,
  activeId,
  openPanels,
  onToggle,
  rowRefs,
  panelRefs,
}: {
  line: DiffLine;
  lang: string;
  sign: string;
  findings: PRFindingRow[] | undefined;
  anchorId: number | undefined;
  activeId: number | null;
  openPanels: Set<number>;
  onToggle: (id: number) => void;
  rowRefs: Map<number, HTMLTableRowElement>;
  panelRefs: Map<number, HTMLTableCellElement>;
}) {
  const hasFindings = !!findings && findings.length > 0;
  const isOpen = hasFindings && findings!.some((f) => openPanels.has(f.id));
  const isActive = anchorId != null && anchorId === activeId;
  // Stable id linking the marker (aria-controls) to the panel row it discloses.
  const panelId = anchorId != null ? `diffv-panel-${anchorId}` : undefined;

  return (
    <>
      <tr
        className={`diffv-line ${line.type}${isActive ? " active" : ""}`}
        ref={
          anchorId != null
            ? (el) => {
                if (el) rowRefs.set(anchorId, el);
                else rowRefs.delete(anchorId);
              }
            : undefined
        }
      >
        <td className="diffv-marker">
          {hasFindings ? (
            <button
              type="button"
              className={`diffv-dot btn-reset ${sevClass(worstSev(findings!))}`}
              onClick={() => onToggle(findings![0].id)}
              aria-expanded={isOpen}
              aria-controls={isOpen ? panelId : undefined}
              aria-label={`${findings!.length} finding(s) on this line`}
              title={`${findings!.length} finding(s) — click to ${isOpen ? "hide" : "view"}`}
            />
          ) : null}
        </td>
        <td className="diffv-gutter diffv-old">{line.oldLine ?? ""}</td>
        <td className="diffv-gutter diffv-new">{line.newLine ?? ""}</td>
        <td className="diffv-content">
          <span className="diffv-sign" aria-hidden="true">{sign}</span>
          <code>{highlightLine(line.content, lang)}</code>
        </td>
      </tr>
      {hasFindings && isOpen ? (
        <tr className="diffv-panel-row">
          <td />
          <td
            id={panelId}
            colSpan={3}
            className="diffv-panel"
            ref={(el) => {
              const id = findings![0].id;
              if (el) panelRefs.set(id, el);
              else panelRefs.delete(id);
            }}
          >
            {findings!.map((f) => (
              <FindingPanel key={f.id} finding={f} />
            ))}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function FindingPanel({ finding }: { finding: PRFindingRow }) {
  return (
    <div className="diffv-finding">
      <div className="diffv-finding-head">
        <SeverityBadge severity={finding.severity} />
        <span className="strong">{finding.title ?? "—"}</span>
        {finding.source ? <span className="muted">· {finding.source}</span> : null}
        <span className="diffv-finding-actions">
          <TriageBadge row={finding} />
          <TriageMenu target={{ kind: "single", id: finding.id }} compact />
        </span>
      </div>
      {finding.body ? (
        <div className="diffv-finding-body">
          <Markdown source={finding.body.slice(0, 8000)} />
        </div>
      ) : null}
    </div>
  );
}

/** Shown when the diff can't be fetched: still let the user read + triage. */
function FindingFallbackList({
  findings,
  activeId,
  setActiveId,
}: {
  findings: PRFindingRow[];
  activeId: number | null;
  setActiveId: (id: number) => void;
}) {
  return (
    <ul className="diffv-fallback">
      {findings.map((f) => (
        <li key={f.id} className={f.id === activeId ? "active" : undefined}>
          <div className="diffv-finding-head">
            {/* Selection target is a real button (keyboard-focusable, Enter/Space
                activation). It wraps only non-interactive label content — the
                triage control is a sibling so we never nest buttons. */}
            <button
              type="button"
              className="diffv-fallback-select btn-reset"
              onClick={() => setActiveId(f.id)}
              aria-pressed={f.id === activeId}
            >
              <SeverityBadge severity={f.severity} />
              <span className="mono muted">
                {f.path ?? ""}
                {f.line ? `:${f.line}` : ""}
              </span>
              <span className="strong">{f.title ?? "—"}</span>
            </button>
            <span className="diffv-finding-actions">
              <TriageBadge row={f} />
              <TriageMenu target={{ kind: "single", id: f.id }} compact />
            </span>
          </div>
          {f.body ? (
            <div className="diffv-finding-body">
              <Markdown source={f.body.slice(0, 4000)} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
