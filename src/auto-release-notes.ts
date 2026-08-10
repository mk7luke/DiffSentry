import { sanitiseReleaseNotes } from "./release-notes.js";
import type { RepoConfig } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Release notes posted without anyone asking, once the PR's head commit has a
// finished review that went green, no review thread left unresolved, and every
// check passed.
//
// The command path (`@bot release-notes`) and this one share everything that
// decides *what* the notes say: the prompt and the sanitiser both live in
// release-notes.ts. What lives here is the part that only the automatic path
// needs: the opt-in gate, and the marker scheme that keeps five suites finishing
// at once from producing five comments.
// ─────────────────────────────────────────────────────────────────────────────

/** Identifies the automatic release-notes comment for find-or-update. */
export const AUTO_RELEASE_NOTES_MARKER = "<!-- DiffSentry Auto Release Notes -->";

/**
 * Records which commit a posted set of notes describes.
 *
 * Kept as a second marker rather than folded into the first so the comment
 * stays findable across pushes: `AUTO_RELEASE_NOTES_MARKER` is the stable
 * handle `upsertComment` matches on, and this one is the freshness stamp read
 * back out of the body it finds.
 */
export function headMarker(sha: string): string {
  return `<!-- DiffSentry Auto Release Notes head: ${sha} -->`;
}

/**
 * Whether an existing comment already describes this commit.
 *
 * This is the durable half of the idempotency story. The in-process guard in
 * the reviewer covers deliveries that overlap; this covers everything else:
 * a redelivery hours later, a replayed webhook, a restart between the model
 * call and the post.
 */
export function describesHead(body: string | null | undefined, headSha: string): boolean {
  return !!body && body.includes(headMarker(headSha));
}

/**
 * Whether `.diffsentry.yaml` has opted this repo in.
 *
 * Off by default, and the default has to survive nonsense. `loadRepoConfig`
 * runs `yaml.load` and casts the result to `RepoConfig` (`REPO_CONFIG_SCHEMA`
 * documents the shape but nothing enforces it at runtime), so `auto` arrives as
 * whatever the user typed. YAML also quotes the value the moment someone writes
 * `auto: "true"`, which is a reasonable thing to write and would otherwise be a
 * silent no-op, so the obvious string spellings are accepted too.
 *
 * Everything else, a number, a list, a typo, reads as unset. Erring toward off
 * is the safe direction: the cost of ignoring a malformed opt-in is a missing
 * comment, and the cost of guessing the other way is an unrequested comment on
 * every green PR in the repo.
 */
export function isAutoReleaseNotesEnabled(config: RepoConfig | undefined): boolean {
  const raw: unknown = config?.release_notes?.auto;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return ["true", "yes", "on"].includes(raw.trim().toLowerCase());
  return false;
}

/**
 * Render the comment body, markers included.
 *
 * The heading matches the one the `release-notes` command posts, because to a
 * reader they are the same artefact arriving by a different route. The footer
 * differs: this one was not asked for, so it says what triggered it and how to
 * turn it off.
 */
export function renderAutoReleaseNotes(opts: {
  notes: string;
  headSha: string;
  botName: string;
}): string {
  return [
    AUTO_RELEASE_NOTES_MARKER,
    headMarker(opts.headSha),
    "",
    "# Release Notes",
    "",
    sanitiseReleaseNotes(opts.notes),
    "",
    `<sub>Drafted automatically once the review of \`${opts.headSha.slice(0, 7)}\` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. ` +
      `Re-run by hand with \`@${opts.botName} release-notes\`, or set \`release_notes.auto: false\` in \`.diffsentry.yaml\` to stop.</sub>`,
  ].join("\n");
}
