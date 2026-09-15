/**
 * Posts a short "preview built" status comment on the PR that triggered
 * this workflow run. Kept intentionally simple: it shells out to `gh` so
 * it does not need its own GitHub API client.
 */
import { execFileSync } from "node:child_process";

function parsePrNumber(argv: string[]): string {
  const idx = argv.indexOf("--pr");
  const value = idx === -1 ? undefined : argv[idx + 1];
  if (!value) {
    throw new Error("usage: preview-comment.ts --pr <number>");
  }
  return value;
}

const pr = parsePrNumber(process.argv.slice(2));
execFileSync("gh", ["pr", "comment", pr, "--body", "Preview build passed."], { stdio: "inherit" });
