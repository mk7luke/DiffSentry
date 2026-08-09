import { describe, it, expect } from "vitest";
import { RELEASE_NOTES_PROMPT, sanitiseReleaseNotes } from "../../src/release-notes.js";

// The prompt asks the model for clean prose; `sanitiseReleaseNotes` is what
// makes it true. These tests pin the mechanical guarantees (no emoji, no em
// dashes, no curly quotes) and the two places where naive stripping would do
// damage: ranges written with an en dash, and code spans.

describe("sanitiseReleaseNotes", () => {
  it("strips emoji from headings and closes the gap they leave", () => {
    const input = ["### ✨ What's new", "", "### 🛠 Improvements", "", "### 🐛 Fixes", "", "### 💔 Breaking changes"].join(
      "\n",
    );

    expect(sanitiseReleaseNotes(input)).toBe(
      ["### What's new", "", "### Improvements", "", "### Fixes", "", "### Breaking changes"].join("\n"),
    );
  });

  it("strips emoji that carry a variation selector or a joiner", () => {
    // 🛠️ is the wrench plus U+FE0F; 👩‍💻 is two pictographs joined by a ZWJ.
    // Both must vanish whole, leaving no orphaned modifier behind.
    const out = sanitiseReleaseNotes("Ready 🛠️ to ship 👩‍💻 today");

    expect(out).toBe("Ready to ship today");
    expect(out).not.toMatch(/[️‍]/);
  });

  it("keeps pictographs that are punctuation rather than decoration", () => {
    expect(sanitiseReleaseNotes("Bundled fonts are © 2026 Acme, and Acme® is a trademark.")).toBe(
      "Bundled fonts are © 2026 Acme, and Acme® is a trademark.",
    );
  });

  it("turns an em dash clause break into a comma", () => {
    expect(sanitiseReleaseNotes("The check stays red — even when the last review only left comments.")).toBe(
      "The check stays red, even when the last review only left comments.",
    );
  });

  it("does not double up when the dash already follows punctuation", () => {
    expect(sanitiseReleaseNotes("Only critical and major findings block, — nits no longer do.")).toBe(
      "Only critical and major findings block, nits no longer do.",
    );
  });

  it("drops a dash left dangling at the end of a line", () => {
    expect(sanitiseReleaseNotes("Ship Check now lists blockers —\nand warnings separately.")).toBe(
      "Ship Check now lists blockers\nand warnings separately.",
    );
  });

  it("treats a dash between digits as a range, not a clause break", () => {
    expect(sanitiseReleaseNotes("Adds 2–3 bullets per section.")).toBe("Adds 2-3 bullets per section.");
  });

  it("straightens curly quotes, apostrophes and ellipses", () => {
    expect(sanitiseReleaseNotes("Updating a branch (via GitHub’s “Update branch”) no longer passes…")).toBe(
      `Updating a branch (via GitHub's "Update branch") no longer passes...`,
    );
  });

  it("leaves inline code spans exactly as written", () => {
    // A curly quote inside backticks is something the reader would type, so
    // rewriting it would hand them a string that does not match.
    const input = "Set `reviews.thread_gate: off` and `printf “hi”` to restore the old behaviour.";

    expect(sanitiseReleaseNotes(input)).toBe(input);
  });

  it("leaves fenced code blocks alone while cleaning the prose around them", () => {
    const input = [
      "Set the flag — on your default branch:",
      "",
      "```yaml",
      "reviews:",
      '  thread_gate: "off" # keep — this dash is code',
      "```",
      "",
      "Then re-run — the check clears.",
    ].join("\n");

    const out = sanitiseReleaseNotes(input);

    expect(out).toContain('  thread_gate: "off" # keep — this dash is code');
    expect(out).toContain("Set the flag, on your default branch:");
    expect(out).toContain("Then re-run, the check clears.");
  });

  it("protects an inline span that wraps across a line", () => {
    // Legal CommonMark: a code span may contain a newline. The first version of
    // CODE_SEGMENT required the span to close on its own line, so this was
    // treated as prose and the quotes and spacing inside it were rewritten.
    const input = 'Run `printf “hi”\n  --flag` to test';

    expect(sanitiseReleaseNotes(input)).toBe(input);
  });

  it("protects a language-tagged fence byte for byte", () => {
    // An info string on the opener is the common case, so pin it explicitly:
    // every class of character the sanitiser rewrites has to survive inside
    // the block while the prose on both sides is still cleaned.
    const fence = ['```yaml', 'reviews:', '  gate: "off"  # — em dash, “curly”, ✨ emoji', "```"].join("\n");
    const out = sanitiseReleaseNotes(`Prose with — a dash.\n${fence}\nMore — prose.`);

    expect(out).toContain(fence);
    expect(out).toContain("Prose with, a dash.");
    expect(out).toContain("More, prose.");
  });

  it("protects a fence that is never closed", () => {
    // CommonMark runs an unterminated fence to the end of the document, so the
    // em dash below is code, not prose.
    const input = ["```yaml", "reviews:", "  gate: off # — stays", ""].join("\n");

    expect(sanitiseReleaseNotes(input)).toContain("  gate: off # — stays");
  });

  it("does not let a stray backtick swallow the rest of the notes", () => {
    // A blank line ends the paragraph, so it cannot sit inside a code span.
    // Without that guard the lone backtick pairs with the one two paragraphs
    // down and everything between escapes sanitisation.
    const out = sanitiseReleaseNotes(
      ["A stray ` backtick", "", "Then — a dash", "", "And `code` here"].join("\n"),
    );

    expect(out).toContain("Then, a dash");
    expect(out).toContain("`code`");
  });

  it("does not let a stray fence opener pair with the next block's opener", () => {
    // "```yaml" carries an info string, so CommonMark will not accept it as a
    // closer. The stray opener therefore runs on, and the dash between them is
    // code as far as the renderer is concerned.
    const input = ["Run ``` odd", "prose with — a dash", "```yaml", 'k: "v"', "```"].join("\n");

    expect(sanitiseReleaseNotes(input)).toBe(input);
  });

  it("drops a title the model wrote for itself", () => {
    // The reply wrapper supplies "# Release Notes", so one from the model
    // renders as a second identical heading.
    const out = sanitiseReleaseNotes("# Release Notes\n\n### Improvements\n\n- Something changed.");

    expect(out).toBe("### Improvements\n\n- Something changed.");
    expect(out).not.toContain("Release Notes");
  });

  it("drops a self-title in its other shapes", () => {
    for (const title of ["# Release Notes", "## Release Notes", "# 📣 Release Notes", "#  release notes  "]) {
      const out = sanitiseReleaseNotes(`${title}\n\n### Bug fixes\n\n- Fixed a thing.`);
      expect(out, title).toBe("### Bug fixes\n\n- Fixed a thing.");
    }
  });

  it("keeps a leading heading that carries real content", () => {
    // Only a duplicate title is dropped. Anything else is the model's content.
    const input = "# Upgrade notes\n\n### Breaking changes\n\n- Set `gate: off`.";

    expect(sanitiseReleaseNotes(input)).toBe(input);
  });

  it("keeps a Release Notes heading that is not the first thing", () => {
    const input = "### Improvements\n\n- Something changed.\n\n## Release Notes archive";

    expect(sanitiseReleaseNotes(input)).toBe(input);
  });

  it("leaves already-clean notes untouched apart from trimming", () => {
    const clean = [
      "### Bug fixes",
      "",
      "- Fixed a case where a green check could sit next to unresolved threads after a branch update.",
    ].join("\n");

    expect(sanitiseReleaseNotes(`\n${clean}\n\n`)).toBe(clean);
  });

  it("produces output with none of the banned characters", () => {
    const messy = "🎉 Big news — we’ve shipped “v2” … 2–3x better 🚀";
    const out = sanitiseReleaseNotes(messy);

    expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(out).not.toMatch(/[—–“”‘’…]/);
    expect(out).toBe(`Big news, we've shipped "v2" ... 2-3x better`);
  });
});

describe("RELEASE_NOTES_PROMPT", () => {
  it("practises the style it asks for: no emoji, no em dashes, no curly quotes", () => {
    expect(RELEASE_NOTES_PROMPT).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(RELEASE_NOTES_PROMPT).not.toMatch(/[—–“”‘’]/);
  });

  it("asks for plain section headings rather than the old emoji ones", () => {
    for (const heading of ["### New features", "### Improvements", "### Bug fixes", "### Breaking changes"]) {
      expect(RELEASE_NOTES_PROMPT).toContain(heading);
    }
  });
});
