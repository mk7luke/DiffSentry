// Minimal unified-diff parser. Turns the raw `git diff` text returned by the
// API into a structured per-file / per-hunk model the viewer can render and
// anchor findings to. Kept dependency-free and forgiving: anything it doesn't
// recognise is skipped rather than throwing, so a slightly unusual diff still
// renders the parts it understands.

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  /** Line number on the old (left) side, or null for an added line. */
  oldLine: number | null;
  /** Line number on the new (right) side, or null for a removed line. */
  newLine: number | null;
  /** The line content, without the leading +/-/space marker. */
  content: string;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ section` header line. */
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
  /** Path on the old side (a/…), or null for an added file. */
  oldPath: string | null;
  /** Path on the new side (b/…), or null for a deleted file. */
  newPath: string | null;
  /** Display/anchor path — the new path when present, else the old path. */
  path: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Strip a leading `a/` or `b/` git prefix from a diff path. */
function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = () => {
    if (file) {
      if (hunk) file.hunks.push(hunk);
      // Fall back to the path captured from the `diff --git` header if the
      // ---/+++ lines never set a concrete display path.
      file.path = stripPrefix(file.newPath ?? file.oldPath ?? file.path ?? "");
      files.push(file);
    }
    hunk = null;
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      pushFile();
      // `diff --git a/foo b/bar` — capture a tentative path; overridden by ---/+++.
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = {
        oldPath: null,
        newPath: null,
        path: m ? m[2] : "",
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!file) continue;

    if (raw.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ") || raw.startsWith("rename to ")) {
      file.status = "renamed";
      continue;
    }
    if (raw.startsWith("Binary files ")) {
      file.binary = true;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      file.oldPath = p === "/dev/null" ? null : stripPrefix(p);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file.newPath = p === "/dev/null" ? null : stripPrefix(p);
      continue;
    }
    if (raw.startsWith("@@")) {
      if (hunk) file.hunks.push(hunk);
      const m = raw.match(HUNK_RE);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: raw, lines: [] };
      continue;
    }
    if (!hunk) continue;

    // "\ No newline at end of file" — metadata, not a real line.
    if (raw.startsWith("\\")) continue;

    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ type: "add", oldLine: null, newLine: newNo, content });
      newNo += 1;
      file.additions += 1;
    } else if (marker === "-") {
      hunk.lines.push({ type: "del", oldLine: oldNo, newLine: null, content });
      oldNo += 1;
      file.deletions += 1;
    } else {
      // Context line (leading space) — or an empty trailing split artifact.
      hunk.lines.push({ type: "context", oldLine: oldNo, newLine: newNo, content });
      oldNo += 1;
      newNo += 1;
    }
  }
  pushFile();
  return files;
}

/** A short language hint derived from a file path, for the highlighter. */
export function langFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "ts";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "py":
      return "py";
    case "rb":
      return "rb";
    case "go":
      return "go";
    case "rs":
      return "rs";
    case "java":
    case "kt":
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "hpp":
    case "cs":
    case "swift":
      return "clike";
    case "sh":
    case "bash":
    case "zsh":
      return "sh";
    case "yml":
    case "yaml":
      return "yaml";
    case "json":
      return "json";
    case "css":
    case "scss":
      return "css";
    case "html":
    case "xml":
    case "vue":
    case "svelte":
      return "markup";
    default:
      return "plain";
  }
}
