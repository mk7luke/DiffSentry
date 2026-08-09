import { describe, it, expect } from "vitest";
import {
  AUTO_RELEASE_NOTES_MARKER,
  describesHead,
  headMarker,
  isAutoReleaseNotesEnabled,
  renderAutoReleaseNotes,
} from "../../src/auto-release-notes.js";
import { mergeWithDefaults } from "../../src/repo-config.js";
import { validateRepoConfig } from "../../src/config-schema.js";
import type { RepoConfig } from "../../src/types.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

describe("isAutoReleaseNotesEnabled", () => {
  it("is off when the repo has no config at all", () => {
    expect(isAutoReleaseNotesEnabled(undefined)).toBe(false);
    expect(isAutoReleaseNotesEnabled({})).toBe(false);
  });

  it("is off by default once defaults are merged in", () => {
    // The behaviour existing installs depend on: merging defaults must not turn
    // this on for a repo that never asked for it.
    expect(isAutoReleaseNotesEnabled(mergeWithDefaults({}))).toBe(false);
  });

  it("is on for a literal true", () => {
    expect(isAutoReleaseNotesEnabled({ release_notes: { auto: true } })).toBe(true);
    expect(isAutoReleaseNotesEnabled(mergeWithDefaults({ release_notes: { auto: true } }))).toBe(true);
  });

  it("accepts the string spellings YAML produces when the value is quoted", () => {
    for (const raw of ["true", "True", " YES ", "on"]) {
      expect(isAutoReleaseNotesEnabled({ release_notes: { auto: raw } } as unknown as RepoConfig)).toBe(true);
    }
  });

  it("reads anything else as off", () => {
    // loadRepoConfig casts yaml.load's output straight to RepoConfig, so a
    // malformed value arrives here as whatever the user typed. Erring toward
    // off keeps a typo from posting on every green PR in the repo.
    const junk: unknown[] = ["yep", "1", "false", 1, 0, [], {}, null];
    for (const raw of junk) {
      expect(isAutoReleaseNotesEnabled({ release_notes: { auto: raw } } as unknown as RepoConfig)).toBe(false);
    }
  });
});

describe("release_notes in the config schema", () => {
  it("accepts the documented shape", () => {
    expect(validateRepoConfig({ release_notes: { auto: true } })).toEqual([]);
  });

  it("rejects a wrong type and an unknown key", () => {
    expect(validateRepoConfig({ release_notes: { auto: "true" } })).toEqual([
      { path: "release_notes.auto", message: "expected boolean, got string" },
    ]);
    expect(validateRepoConfig({ release_notes: { enabled: true } })).toEqual([
      { path: "release_notes.enabled", message: "unknown option" },
    ]);
  });
});

describe("describesHead", () => {
  it("recognises notes already posted for this commit", () => {
    const body = renderAutoReleaseNotes({ notes: "### Bug fixes\n- Fixed a thing.", headSha: SHA, botName: "diffsentry" });
    expect(describesHead(body, SHA)).toBe(true);
  });

  it("does not match notes written for a different commit", () => {
    // The re-run case: a new head is a new set of notes, and the comment gets
    // rewritten rather than left stale.
    const body = renderAutoReleaseNotes({ notes: "### Bug fixes\n- Fixed a thing.", headSha: OTHER_SHA, botName: "diffsentry" });
    expect(describesHead(body, SHA)).toBe(false);
  });

  it("does not match a hand-run release-notes comment", () => {
    // The command path posts no markers, so it must never be mistaken for an
    // automatic post and suppress one.
    expect(describesHead("# Release Notes\n\n### Bug fixes\n- Fixed a thing.", SHA)).toBe(false);
  });

  it("handles a missing comment", () => {
    expect(describesHead(null, SHA)).toBe(false);
    expect(describesHead(undefined, SHA)).toBe(false);
    expect(describesHead("", SHA)).toBe(false);
  });

  it("does not confuse one commit's marker for another's prefix", () => {
    expect(describesHead(headMarker(SHA), SHA.slice(0, 12))).toBe(false);
  });
});

describe("renderAutoReleaseNotes", () => {
  const body = renderAutoReleaseNotes({
    notes: "### New features\n- Added a `--verbose` flag — it prints more.",
    headSha: SHA,
    botName: "diffsentry",
  });

  it("carries the marker upsertComment finds it by, and the head stamp", () => {
    expect(body).toContain(AUTO_RELEASE_NOTES_MARKER);
    expect(body).toContain(headMarker(SHA));
  });

  it("uses the same heading as the command path", () => {
    expect(body).toContain("# Release Notes");
  });

  it("runs the notes through the shared sanitiser", () => {
    // Same house style as `@bot release-notes`, because it is the same artefact
    // arriving by a different route.
    expect(body).not.toContain("—");
    expect(body).toContain("flag, it prints more.");
  });

  it("says what triggered it and how to stop it", () => {
    expect(body).toContain(SHA.slice(0, 7));
    expect(body).toContain("release_notes.auto: false");
    expect(body).toContain("@diffsentry release-notes");
  });
});
