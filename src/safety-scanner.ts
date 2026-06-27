import type { FileChange, ReviewComment } from "./types.js";
import { renderInlineCommentBody } from "./ai/parse.js";
import { createHash } from "node:crypto";
import { SECRET_PATTERNS } from "./secret-patterns.js";

// SECRET_PATTERNS now lives in ./secret-patterns.js (a leaf module) so the log
// redactor can share the exact same shapes without creating an import cycle.
// Each entry's regex is designed to match on a single ADDED line of the diff
// (after stripping the leading +).

const MERGE_MARKER_PATTERNS = [
  /^<{7}\s/, // <<<<<<< branch
  /^={7}\s*$/, // =======
  /^>{7}\s/, // >>>>>>> branch
];

function fpFor(path: string, line: number, kind: string): string {
  return createHash("sha1")
    .update(`${path}:${line}:${kind}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Iterate the +-added lines of every changed file's patch and emit
 * pre-AI inline review comments for any leaked secret or stray merge
 * conflict marker. These get posted as part of the regular review.
 */
export function runSafetyScanners(files: FileChange[]): ReviewComment[] {
  const comments: ReviewComment[] = [];

  for (const f of files) {
    if (!f.patch) continue;
    let rightLine = 0;
    for (const raw of f.patch.split("\n")) {
      const hunkMatch = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (hunkMatch) {
        rightLine = parseInt(hunkMatch[1], 10);
        continue;
      }
      if (raw.startsWith("---") || raw.startsWith("+++")) continue;
      if (raw.startsWith("-")) continue;
      const isAdded = raw.startsWith("+");
      const content = raw.startsWith("+") || raw.startsWith(" ") ? raw.slice(1) : raw;

      if (isAdded) {
        // Secret scanning (added lines only — pre-existing leaks are out of scope)
        for (const sp of SECRET_PATTERNS) {
          if (sp.regex.test(content)) {
            const fingerprint = fpFor(f.filename, rightLine, `secret-${sp.id}`);
            const title = `Possible ${sp.label} committed in source.`;
            const body =
              `A pattern matching **${sp.label}** was detected on this line. ` +
              `If this is a real credential, treat it as compromised: rotate immediately, ` +
              `purge from git history (\`git filter-repo\` or BFG), and audit access logs. ` +
              `If it's a fixture or example, swap to a placeholder like \`AKIAIOSFODNN7EXAMPLE\` ` +
              `or move to an env var so future scans don't trip.\n\n` +
              `_Detected by DiffSentry's safety scanner — pattern id: \`${sp.id}\`._`;
            const aiAgentPrompt =
              `In ${f.filename} at line ${rightLine}, replace the literal ${sp.label} ` +
              `with a placeholder or move it behind an environment variable lookup. ` +
              `Do not push the literal value back to git; rotate the credential out-of-band.`;
            comments.push({
              path: f.filename,
              line: rightLine,
              side: "RIGHT",
              type: "security",
              severity: "critical",
              title,
              suggestion: undefined,
              suggestionLanguage: "diff",
              aiAgentPrompt,
              fingerprint,
              body: renderInlineCommentBody({
                title,
                body,
                type: "security",
                severity: "critical",
                aiAgentPrompt,
                fingerprint,
              }),
            });
          }
        }

        // Merge marker detection (added lines only)
        for (const mp of MERGE_MARKER_PATTERNS) {
          if (mp.test(content)) {
            const fingerprint = fpFor(f.filename, rightLine, "merge-marker");
            const title = "Stray merge conflict marker committed.";
            const body =
              "This line contains a merge conflict marker (`<<<<<<<`, `=======`, or `>>>>>>>`). " +
              "These should be resolved before commit — the file as-is will not parse and will likely break the build.";
            const aiAgentPrompt = `In ${f.filename} at line ${rightLine}, remove the merge conflict markers and finish resolving the conflict. The file currently contains literal '<<<<<<<' / '=======' / '>>>>>>>' lines.`;
            comments.push({
              path: f.filename,
              line: rightLine,
              side: "RIGHT",
              type: "issue",
              severity: "critical",
              title,
              aiAgentPrompt,
              fingerprint,
              body: renderInlineCommentBody({
                title,
                body,
                type: "issue",
                severity: "critical",
                aiAgentPrompt,
                fingerprint,
              }),
            });
            break;
          }
        }
      }
      rightLine++;
    }
  }

  return comments;
}
