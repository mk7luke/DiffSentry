/**
 * Release notes for a single PR, written the way a maintainer writes them.
 *
 * Two halves, and they do different jobs. RELEASE_NOTES_PROMPT asks the model
 * for the right *content* — real section names, one change per bullet, the
 * trigger for each fix. `sanitiseReleaseNotes` then enforces the handful of
 * rules that are purely mechanical: no emoji, no em dashes, no curly quotes.
 *
 * The prompt asks for those too, and mostly gets them. "Mostly" is the problem:
 * a house style that holds nine times in ten is not a house style. Anything a
 * regex can guarantee is guaranteed here instead of hoped for upstream.
 */

/**
 * Instructions for the model. Deliberately concrete about what a good bullet
 * looks like, because "write like a developer" on its own reliably produces a
 * changelog that reads like a press release.
 */
export const RELEASE_NOTES_PROMPT = `Write release notes for this PR, in the voice of the engineer who shipped it.

Audience: the people who use this software. They are not marketers and they are not on your team, so they know the product but not the codebase. Write the way curl, ripgrep, Django and the GitHub changelog write: plain, specific, and concrete about what changed.

Do not write a title. The comment you are filling in already has a "Release Notes" heading above your text, so start directly with the first section heading below. A title of your own would render as a second one.

Format:

### New features
<bullets for behaviour that did not exist before>

### Improvements
<bullets for behaviour that existed and now works better>

### Bug fixes
<bullets for things that were broken and now are not>

### Breaking changes
<bullets for anything that changes behaviour people already depend on>

Omit any section with nothing to say. Do not add sections that are not on this list.

How to write a bullet:
- One change per bullet. Say what the software does now, not what you did to the code. "The check stays red while critical findings are open", not "Refactored the gating logic".
- Present tense for new behaviour, past tense for fixes. "Fixed a case where..." is the standard opening for a fix.
- Name the real thing: the command, flag, setting, config key, screen or menu item, in backticks. A reader should be able to go find it.
- For a fix, give the trigger in a clause so people can tell whether it affected them: "Fixed a case where a green check could sit next to unresolved threads after a branch update."
- Keep it to one sentence, roughly 25 words. Two sentences only when the second one earns its place.
- For breaking changes, say what breaks, who it hits, and what to do instead. Put the remedy in the same bullet.

Do not use:
- Emoji, anywhere, including in headings.
- Em dashes or en dashes. Use a comma, a full stop, parentheses, or rewrite the sentence.
- Curly quotes. Straight quotes only, and prefer backticks for anything the reader would type.
- Marketing adjectives: seamless, effortless, powerful, robust, delightful, blazing, comprehensive, game changing, unlock, elevate, supercharge, streamline.
- Announcement throat clearing: "We're excited to", "We're thrilled to", "Say hello to".
- The "not just X, but Y" construction, and its variants.
- Lists padded to three items for rhythm. Two real bullets beat three with a filler.
- A bolded label at the front of every bullet.
- A closing summary, a "Conclusion", or a sentence restating the heading it sits under.
- Internal jargon: refactored, unblocked, leveraged, plumbed through, wired up.

Two more rules. Do not restate the section heading in its first bullet. Only describe changes you can point at in the diff: no speculation about performance or reliability that the code does not show, and no numbers you did not read somewhere.

If the diff has no user-visible effect at all, say so in one line instead of padding the sections.`;

/**
 * Pictographs that read as punctuation rather than decoration. Stripping these
 * alongside the emoji would quietly corrupt a legal notice or a product name.
 */
const KEEP_PICTOGRAPHS = new Set(["©", "®", "™"]);

/**
 * Emoji, plus the modifiers that only ever appear as part of one: variation
 * selector-16, zero-width joiner, keycap, skin tones, regional indicators.
 *
 * Matching on Extended_Pictographic rather than Emoji_Presentation is
 * deliberate. Some emoji are text-presentation by default and arrive without
 * the FE0F selector (the wrench in "🛠 Improvements" is one), so the narrower
 * property misses exactly the characters most likely to show up in a heading.
 *
 * The modifiers are listed as alternatives rather than folded into the class:
 * they are combining marks, and `no-misleading-character-class` rejects those
 * inside a character class even when escaped.
 */
const EMOJI =
  /\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{20E3}|\u{200D}/gu;

/**
 * Everything the renderer will show as code, so sanitising can skip it.
 *
 * Fences come first so an inline span never claims part of one. The four
 * alternatives, in order:
 *
 * 1. A closed fence. The closer must sit at the start of a line and carry no
 *    info string, matching CommonMark. Accepting ``` ```yaml ``` as a closer
 *    would let a stray opener pair with the *next* block's opener.
 * 2. An unclosed fence, which CommonMark runs to the end of the document.
 *    Without this an unterminated block gets no protection at all.
 * 3. A run of lines indented by four spaces or a tab. This is only *sometimes*
 *    an indented code block, so every match is put through `isIndentedCode`
 *    before it is trusted. See that function for why.
 * 4. An inline span. It may wrap across a line, which is legal, but a blank
 *    line ends the paragraph and so cannot appear inside one. That guard is
 *    what stops a single stray backtick from swallowing the rest of the notes.
 */
const CODE_SEGMENT = new RegExp(
  [
    "^ {0,3}```[^\\n]*\\n[\\s\\S]*?^ {0,3}```[ \\t]*$",
    "^ {0,3}```[\\s\\S]*$",
    "(?:^(?: {4}|\\t)[^\\n]*(?:\\n|$))+",
    "`(?:[^`\\n]|\\n(?![ \\t]*\\n))*`",
  ].join("|"),
  "gm",
);

/** A bullet or ordered-list marker, at any indentation. */
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;

/**
 * Decides whether a run of indented lines is really an indented code block.
 *
 * Four spaces means code only at the top level. Inside a list it means
 * continuation, and release notes are mostly lists, so the naive reading is
 * not just imprecise, it is backwards for the common case: a nested bullet
 * like "    - Nits no longer block, so you can merge with “minor” notes open."
 * would be handed back untouched with its dash and curly quotes intact.
 *
 * So the run counts as code only when the nearest preceding non-blank line is
 * neither a list item nor itself indented, which is what tells us we are at the
 * top level rather than inside one. An indented block also cannot interrupt a
 * paragraph, so a blank line has to separate it from whatever came before.
 */
function isIndentedCode(text: string, offset: number): boolean {
  if (offset === 0) return true;

  const before = text.slice(0, offset);
  if (!/\n[ \t]*\n$/.test(before)) return false;

  const preceding = before.split("\n").filter((line) => line.trim() !== "").pop();
  if (preceding === undefined) return true;

  return !LIST_ITEM.test(preceding) && !/^(?: {2,}|\t)/.test(preceding);
}

/**
 * Applies the mechanical half of the house style to one run of prose.
 *
 * Dash handling is the only part that has to think. An en dash between digits
 * is a range, so it becomes a hyphen; everywhere else a dash is standing in for
 * a clause break, so it becomes a comma. A dash at the end of a line has no
 * following clause to join, so it just goes.
 */
function sanitiseProse(text: string): string {
  return (
    text
      .replace(EMOJI, (char) => (KEEP_PICTOGRAPHS.has(char) ? char : ""))
      // Ranges: "2–3 bullets" is a hyphen, not a clause break.
      .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
      // Trailing dash: nothing follows it to join with, so a comma would dangle.
      .replace(/\s*[–—]\s*$/gm, "")
      // Clause break. Skip the comma when the text already supplies punctuation.
      .replace(/\s*[–—]\s*/g, (_m, offset: number, whole: string) =>
        /[,;:]$/.test(whole.slice(0, offset).trimEnd()) ? " " : ", ",
      )
      .replace(/[“”„‟]/g, '"')
      .replace(/[‘’‚‛]/g, "'")
      .replace(/…/g, "...")
      // An emoji removed from "### ✨ What's new" leaves a double space behind.
      // The lookbehind keeps this off leading indentation: collapsing the four
      // spaces on a nested bullet to one would flatten it into a sibling.
      .replace(/(?<=\S)[^\S\n]{2,}/g, " ")
      // Anchor on the newline, not on `$` with /m. A prose segment ends
      // wherever the next code span begins, which is usually mid-line, and `$`
      // would treat that as end-of-line and swallow the space before it.
      .replace(/[^\S\n]+(?=\n)/g, "")
  );
}

/** A heading of any level at the very top of the text, plus its own line. */
const LEADING_HEADING = /^\s*(#{1,6})([^\n]*)(?:\n|$)/;

/**
 * Drops a "Release Notes" title the model wrote for itself.
 *
 * The reply wrapper already supplies the heading, so one from the model renders
 * as a second identical title. The prompt asks it not to; this is the half that
 * does not depend on the model complying.
 *
 * Comparison is on the heading text reduced to letters and digits, rather than
 * a regex over the decoration. Emoji, bold markers, a trailing colon, odd
 * spacing and separators like "Release-Notes" all collapse to the same string,
 * so one rule covers them instead of a pattern that grows an alternative every
 * time the model finds a new way to write it. This runs before EMOJI, so the
 * emoji in "# 📣 Release Notes" is still attached at this point.
 *
 * Still narrow in what it removes: only an exact "releasenotes" match goes.
 * "# Upgrade notes" and "# Release notes for v2.0" both carry content beyond
 * the bare title and are kept.
 */
function dropSelfTitle(text: string): string {
  const heading = LEADING_HEADING.exec(text);
  if (!heading) return text;

  const words = heading[2].replace(/[^a-z0-9]/gi, "").toLowerCase();
  return words === "releasenotes" ? text.slice(heading[0].length) : text;
}

/**
 * Strips the banned characters from model-written release notes, leaving code
 * spans untouched: a fenced block may legitimately contain any of them, and
 * rewriting a quote inside a snippet turns working code into broken code.
 */
export function sanitiseReleaseNotes(input: string): string {
  // Before segmenting: a leading title cannot be inside a fence, because a doc
  // that opens with a fence starts with backticks rather than a heading.
  const raw = dropSelfTitle(input);
  let out = "";
  let cursor = 0;

  CODE_SEGMENT.lastIndex = 0;
  for (let match = CODE_SEGMENT.exec(raw); match !== null; match = CODE_SEGMENT.exec(raw)) {
    // An indented run is the one candidate that might not be code at all.
    // Leaving it for the prose pass is the safe default: the cost of sanitising
    // a snippet is a broken example, but the cost of skipping a nested bullet
    // is a dash or an emoji shipped to the reader, which is the whole point.
    if (/^(?: {4}|\t)/.test(match[0]) && !isIndentedCode(raw, match.index)) continue;

    out += sanitiseProse(raw.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }

  return (out + sanitiseProse(raw.slice(cursor))).trim();
}
