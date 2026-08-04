import { describe, it, expect } from "vitest";
import { extractSlashCommand, addressesBot } from "../../src/slash-commands.js";
import { parseCommand, suggestCommand, formatUnknownCommandMessage } from "../../src/commands.js";
import { parseIssueCommand } from "../../src/issue-commands.js";

const BOT = "diffsentry";

describe("extractSlashCommand", () => {
  it("reads a bare command", () => {
    expect(extractSlashCommand("/review", BOT)).toMatchObject({
      text: "review",
      name: "review",
      syntax: "slash-bare",
    });
  });

  it("reads a namespaced command", () => {
    expect(extractSlashCommand("/diffsentry review", BOT)).toMatchObject({
      text: "review",
      syntax: "slash-namespaced",
    });
  });

  it("treats a lone namespace as help", () => {
    expect(extractSlashCommand("/diffsentry", BOT)).toMatchObject({ text: "help" });
  });

  it("expands hyphenated multi-word spellings", () => {
    expect(extractSlashCommand("/full-review", BOT)?.text).toBe("full review");
    expect(extractSlashCommand("/generate-tests", BOT)?.text).toBe("generate tests");
    expect(extractSlashCommand("/diffsentry full-review", BOT)?.text).toBe("full review");
  });

  it("keeps command arguments", () => {
    expect(extractSlashCommand("/diff 123", BOT)?.text).toBe("diff 123");
    expect(extractSlashCommand("/learn we prefer tabs", BOT)?.text).toBe("learn we prefer tabs");
  });

  it("is case-insensitive on the namespace", () => {
    expect(extractSlashCommand("/DiffSentry Review", BOT)?.syntax).toBe("slash-namespaced");
  });

  // ─── Anchoring ────────────────────────────────────────────────

  it("ignores a slash that is not at the start of a line", () => {
    expect(extractSlashCommand("please run /review when you can", BOT)).toBeNull();
  });

  it("finds a command on a later line", () => {
    expect(extractSlashCommand("Looks good to me.\n\n/review", BOT)?.text).toBe("review");
  });

  it("ignores commands inside fenced code blocks", () => {
    const body = ["Here's the repro:", "```", "/review", "```"].join("\n");
    expect(extractSlashCommand(body, BOT)).toBeNull();
  });

  it("ignores commands inside tilde-fenced blocks", () => {
    expect(extractSlashCommand("~~~\n/review\n~~~", BOT)).toBeNull();
  });

  it("still finds a command after a closed code block", () => {
    const body = ["```", "/pause", "```", "/review"].join("\n");
    expect(extractSlashCommand(body, BOT)?.text).toBe("review");
  });

  it("ignores commands inside quoted replies", () => {
    expect(extractSlashCommand("> /review\n\nI don't think so.", BOT)).toBeNull();
  });

  it("ignores commands in indented code blocks", () => {
    expect(extractSlashCommand("Example:\n\n    /review", BOT)).toBeNull();
  });

  it("ignores absolute paths and URLs-as-paths", () => {
    expect(extractSlashCommand("/usr/local/bin/diffsentry", BOT)).toBeNull();
    expect(extractSlashCommand("/api/v2/reviews returns 500", BOT)).toBeNull();
  });

  // ─── Coexistence with GitHub and other bots ───────────────────

  it("never claims GitHub's own composer commands", () => {
    for (const reserved of ["/code", "/table", "/details", "/template", "/alerts", "/saved-replies"]) {
      expect(extractSlashCommand(reserved, BOT)).toBeNull();
    }
  });

  it("returns another bot's command as an unrecognized bare command", () => {
    // Extraction is syntactic; parseCommand is what drops it silently.
    expect(extractSlashCommand("/lgtm", BOT)?.syntax).toBe("slash-bare");
  });

  // ─── Switches ─────────────────────────────────────────────────

  it("respects the master switch", () => {
    expect(extractSlashCommand("/diffsentry review", BOT, { enabled: false })).toBeNull();
  });

  it("drops bare commands but keeps namespaced ones when bare is off", () => {
    expect(extractSlashCommand("/review", BOT, { bare: false })).toBeNull();
    expect(extractSlashCommand("/diffsentry review", BOT, { bare: false })?.text).toBe("review");
  });
});

describe("parseCommand — slash path", () => {
  it("routes bare and namespaced commands identically", () => {
    expect(parseCommand("/review", BOT)).toEqual({ type: "review" });
    expect(parseCommand("/diffsentry review", BOT)).toEqual({ type: "review" });
  });

  it("handles multi-word and argument commands", () => {
    expect(parseCommand("/full-review", BOT)).toEqual({ type: "full_review" });
    expect(parseCommand("/diff 42", BOT)).toEqual({ type: "diff_pr", target: "42" });
    expect(parseCommand("/learn we prefer tabs", BOT)).toEqual({
      type: "learn",
      content: "we prefer tabs",
    });
    expect(parseCommand("/5why the retry loop", BOT)).toEqual({
      type: "five_why",
      target: "the retry loop",
    });
  });

  it("never falls through to chat on the slash path", () => {
    // The whole point of the split: a typo must not become an AI chat call.
    expect(parseCommand("/diffsentry what do you think of this design", BOT)).toEqual({
      type: "unknown_command",
      name: "what",
      syntax: "slash-namespaced",
    });
  });

  it("catches a bare typo of one of our commands", () => {
    expect(parseCommand("/reveiw", BOT)).toEqual({
      type: "unknown_command", name: "reveiw", syntax: "slash-bare",
    });
    expect(parseCommand("/summry", BOT)).toEqual({
      type: "unknown_command", name: "summry", syntax: "slash-bare",
    });
  });

  it("stays silent on other bots' commands", () => {
    // Prow and friends share the bare namespace; none of these is close enough
    // to our vocabulary to be a typo, so we must not answer them.
    for (const foreign of ["/lgtm", "/retest", "/approve", "/hold", "/reopen",
                           "/retitle", "/override", "/assign", "/cc", "/kind",
                           "/area", "/milestone", "/test", "/close"]) {
      expect(parseCommand(foreign, BOT), foreign).toBeNull();
    }
  });

  it("flags unrecognized namespaced commands, since they are ours", () => {
    expect(parseCommand("/diffsentry frobnicate", BOT)).toEqual({
      type: "unknown_command",
      name: "frobnicate",
      syntax: "slash-namespaced",
    });
  });
});

describe("parseCommand — mention path is unchanged", () => {
  it("still parses commands", () => {
    expect(parseCommand("@diffsentry review", BOT)).toEqual({ type: "review" });
    expect(parseCommand("@diffsentry full review", BOT)).toEqual({ type: "full_review" });
  });

  it("still falls through to chat for free-form text", () => {
    expect(parseCommand("@diffsentry why is this slow?", BOT)).toEqual({
      type: "chat",
      message: "why is this slow?",
    });
  });

  it("returns null when we are not addressed", () => {
    expect(parseCommand("just a normal comment", BOT)).toBeNull();
  });

  it("stays conversational when the slash is mid-sentence", () => {
    expect(parseCommand("@diffsentry what does /review do?", BOT)).toEqual({
      type: "chat",
      message: "what does /review do?",
    });
  });

  it("prefers a line-anchored command over an incidental mention", () => {
    // The mention here is a cc, not a question — running the review is right.
    expect(parseCommand("/review\n\ncc @diffsentry", BOT)).toEqual({ type: "review" });
  });
});

describe("parseIssueCommand", () => {
  it("accepts slash commands from the issue vocabulary", () => {
    expect(parseIssueCommand("/summary", BOT)).toEqual({ type: "summary" });
    expect(parseIssueCommand("/plan auth layer", BOT)).toEqual({
      type: "plan",
      target: "auth layer",
    });
  });

  it("rejects PR-only commands as unknown when namespaced", () => {
    // `review` is meaningless on an issue — there is no diff.
    expect(parseIssueCommand("/diffsentry review", BOT)).toEqual({
      type: "unknown_command",
      name: "review",
      syntax: "slash-namespaced",
    });
  });

  it("ignores PR-only bare commands on issues", () => {
    expect(parseIssueCommand("/review", BOT)).toBeNull();
  });

  it("keeps the mention chat fallback", () => {
    expect(parseIssueCommand("@diffsentry any ideas?", BOT)).toEqual({
      type: "chat",
      message: "any ideas?",
    });
  });

  it("accepts the whole issue vocabulary as slash commands", () => {
    expect(parseIssueCommand("/summary", BOT)).toEqual({ type: "summary" });
    expect(parseIssueCommand("/pause", BOT)).toEqual({ type: "pause" });
    expect(parseIssueCommand("/resume", BOT)).toEqual({ type: "resume" });
    expect(parseIssueCommand("/configuration", BOT)).toEqual({ type: "configuration" });
    expect(parseIssueCommand("/help", BOT)).toEqual({ type: "help" });
    expect(parseIssueCommand("/learn we ship on Fridays", BOT)).toEqual({
      type: "learn", content: "we ship on Fridays",
    });
  });

  it("handles diff-shaped PR commands per addressing form", () => {
    // These have nothing to operate on in an issue. Namespaced says so;
    // bare stays silent, since the word is a real command elsewhere and so
    // earns no "did you mean".
    for (const cmd of ["tldr", "review", "ship", "diff"]) {
      expect(parseIssueCommand(`/diffsentry ${cmd}`, BOT), cmd).toEqual({
        type: "unknown_command", name: cmd, syntax: "slash-namespaced",
      });
      expect(parseIssueCommand(`/${cmd}`, BOT), cmd).toBeNull();
    }
  });
});

describe("addressesBot", () => {
  it("accepts mentions and slash commands", () => {
    expect(addressesBot("@diffsentry hello", BOT)).toBe(true);
    expect(addressesBot("/review", BOT)).toBe(true);
    expect(addressesBot("/diffsentry review", BOT)).toBe(true);
  });

  it("rejects unrelated comments", () => {
    expect(addressesBot("LGTM, shipping", BOT)).toBe(false);
    expect(addressesBot("see /docs/readme.md", BOT)).toBe(false);
  });

  it("accepts another bot's command syntactically, since parse drops it later", () => {
    // The gate is deliberately loose; the cost is one no-op parse.
    expect(addressesBot("/lgtm", BOT)).toBe(true);
  });
});

describe("suggestCommand", () => {
  it("suggests the obvious near-miss", () => {
    expect(suggestCommand("reveiw")).toBe("review");
    expect(suggestCommand("summry")).toBe("summary");
  });

  it("declines to suggest for unrelated words", () => {
    expect(suggestCommand("frobnicate")).toBeNull();
  });

  it("declines to suggest for an exact match", () => {
    // "/review on an issue" is a valid command in the wrong place, not a typo.
    expect(suggestCommand("review")).toBeNull();
  });

  it("covers matcher aliases, not just the canonical names", () => {
    // The corpus is derived from the matcher's tables, so aliases are included.
    expect(suggestCommand("rememer")).toBe("remember");
    expect(suggestCommand("benchmrk")).toBe("benchmark");
  });
});

describe("formatUnknownCommandMessage", () => {
  it("answers a bare typo in bare form", () => {
    const msg = formatUnknownCommandMessage(BOT, "reveiw", "slash-bare");
    expect(msg).toContain("Unknown command `/reveiw`");
    expect(msg).toContain("Did you mean `/review`?");
  });

  it("answers a namespaced typo in namespaced form", () => {
    // Critical on repos with SLASH_COMMANDS_BARE=false: suggesting the bare
    // spelling would send the user to a command this bot then ignores.
    const msg = formatUnknownCommandMessage(BOT, "reveiw", "slash-namespaced");
    expect(msg).toContain("Unknown command `/diffsentry reveiw`");
    expect(msg).toContain("Did you mean `/diffsentry review`?");
    expect(msg).not.toMatch(/`\/review`/);
  });

  it("points at help in the matching form when there is no suggestion", () => {
    expect(formatUnknownCommandMessage(BOT, "frobnicate", "slash-namespaced"))
      .toContain("Run `/diffsentry help`");
    expect(formatUnknownCommandMessage(BOT, "frobnicate", "slash-bare"))
      .toContain("Run `/help`");
  });

  it("shows argument placeholders so the suggestion is directly usable", () => {
    expect(formatUnknownCommandMessage(BOT, "lern", "slash-bare"))
      .toContain("Did you mean `/learn <text>`?");
    expect(formatUnknownCommandMessage(BOT, "dif", "slash-bare"))
      .toContain("Did you mean `/diff <PR-number>`?");
  });

  it("carries the addressing form on the parsed command", () => {
    expect(parseCommand("/diffsentry frobnicate", BOT)).toEqual({
      type: "unknown_command", name: "frobnicate", syntax: "slash-namespaced",
    });
    expect(parseCommand("/reveiw", BOT)).toEqual({
      type: "unknown_command", name: "reveiw", syntax: "slash-bare",
    });
  });
});
