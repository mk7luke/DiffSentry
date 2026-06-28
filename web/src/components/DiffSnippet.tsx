import { useMemo } from "react";
import { parseUnifiedDiff, langFromPath, type DiffLine } from "../lib/unified-diff";
import { highlightLine } from "../lib/highlight";

// ─────────────────────────────────────────────────────────────────────────────
// <DiffSnippet> — a focused window of the actual changed lines around a single
// finding's anchor. Reuses the D1 inline-diff building blocks (the unified-diff
// parser, langFromPath, highlightLine, and the .diffv-* code styles) so the
// snippet renders identically to the full <DiffViewer>, just clipped to a few
// lines of context around `line` and with the anchored line highlighted.
//
// Returns a "not in diff" note when the finding's line can't be located in the
// current diff (the PR drifted since the finding was recorded, or the line falls
// in a truncated/omitted hunk) so the caller still shows the location text.
// ─────────────────────────────────────────────────────────────────────────────

/** Lines of context shown on each side of the anchored line. */
const CONTEXT = 4;

export function DiffSnippet({
  diff,
  path,
  line,
  truncated,
}: {
  diff: string | null;
  path: string | null;
  line: number | null;
  truncated?: boolean;
}) {
  const window = useMemo(() => {
    if (!diff || !path || line == null) return null;
    const files = parseUnifiedDiff(diff);
    const file = files.find((f) => f.path === path);
    if (!file || file.binary) return null;
    // Flatten the file's hunk lines and find the anchor by its new-side line
    // (the same side <DiffViewer> anchors findings to).
    const all: DiffLine[] = [];
    for (const h of file.hunks) all.push(...h.lines);
    const idx = all.findIndex((l) => l.newLine === line);
    if (idx < 0) return null;
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(all.length, idx + CONTEXT + 1);
    return { lines: all.slice(start, end), anchorIdx: idx - start, lang: langFromPath(path) };
  }, [diff, path, line]);

  const location = path ? `${path}${line != null ? `:${line}` : ""}` : "Unknown location";

  if (!window) {
    return (
      <div className="triage-snippet-missing">
        <span className="mono">{location}</span>
        <span className="muted">
          {" — "}
          {diff
            ? "the changed lines aren't in the current diff (the PR moved on since this finding, or the line is in a truncated hunk)."
            : "the diff for this PR couldn't be loaded."}
        </span>
      </div>
    );
  }

  return (
    <figure className="triage-snippet" aria-label={`Diff around ${location}`}>
      <figcaption className="triage-snippet-head mono">
        {location}
        {truncated ? <span className="muted"> · diff truncated</span> : null}
      </figcaption>
      <table className="diffv-code">
        <tbody>
          {window.lines.map((ln, i) => {
            const sign = ln.type === "add" ? "+" : ln.type === "del" ? "−" : "";
            const isAnchor = i === window.anchorIdx;
            return (
              <tr
                key={i}
                className={`diffv-line ${ln.type}${isAnchor ? " active" : ""}`}
                aria-current={isAnchor ? "true" : undefined}
              >
                <td className="diffv-gutter diffv-old">{ln.oldLine ?? ""}</td>
                <td className="diffv-gutter diffv-new">{ln.newLine ?? ""}</td>
                <td className="diffv-content">
                  <span className="diffv-sign" aria-hidden="true">
                    {sign}
                  </span>
                  <code>{highlightLine(ln.content, window.lang)}</code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </figure>
  );
}
