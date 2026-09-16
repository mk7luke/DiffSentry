import { describe, it, expect } from "vitest";
import { newlyCheckedTriggers, triggerCommandText } from "../../src/webhook/checkbox.js";
import { finishingTouchesBlock } from "../../src/reviewer.js";
import { parseCommand } from "../../src/commands.js";

function box(
  checked: boolean,
  meta: Record<string, unknown>,
  label: string,
): string {
  return `- [${checked ? "x" : " "}] <!-- ${JSON.stringify(meta)} --> ${label}`;
}

describe("reading DiffSentry's own checkboxes back", () => {
  it("routes on the metadata, not the label", () => {
    const before = box(false, { checkboxId: "a", action: "simplify", delivery: "stacked" }, "Create PR with simplified code");
    const after = box(true, { checkboxId: "a", action: "simplify", delivery: "stacked" }, "Create PR with simplified code");
    expect(newlyCheckedTriggers(after, before)).toEqual([
      { action: "simplify", delivery: "stacked" },
    ]);
  });

  it("tells two touches apart although both say `Create stacked PR`", () => {
    const docs = { checkboxId: "d", action: "generate_docstrings", delivery: "stacked" };
    const fix = { checkboxId: "f", action: "autofix", delivery: "stacked" };
    const before = [box(false, docs, "Create stacked PR"), box(false, fix, "Create stacked PR")].join("\n");
    const after = [box(false, docs, "Create stacked PR"), box(true, fix, "Create stacked PR")].join("\n");

    expect(newlyCheckedTriggers(after, before)).toEqual([{ action: "autofix", delivery: "stacked" }]);
  });

  it("ignores a box that was already ticked", () => {
    const b = box(true, { checkboxId: "a", action: "autofix", delivery: "branch" }, "Push a commit to this branch (recommended)");
    expect(newlyCheckedTriggers(b, b)).toEqual([]);
  });

  it("ignores an unticking", () => {
    const on = box(true, { checkboxId: "a", action: "autofix", delivery: "branch" }, "x");
    const off = box(false, { checkboxId: "a", action: "autofix", delivery: "branch" }, "x");
    expect(newlyCheckedTriggers(off, on)).toEqual([]);
  });

  it("ignores a task list that is not ours", () => {
    const after = "- [x] buy milk\n- [x] <!-- not json --> walk dog";
    expect(newlyCheckedTriggers(after, "- [ ] buy milk\n- [ ] <!-- not json --> walk dog")).toEqual([]);
  });

  it("runs one delivery per touch when both boxes are ticked at once", () => {
    const stacked = { checkboxId: "s", action: "generate_docstrings", delivery: "stacked" };
    const branch = { checkboxId: "b", action: "generate_docstrings", delivery: "branch" };
    const before = [box(false, stacked, "Create stacked PR"), box(false, branch, "Commit on current branch")].join("\n");
    const after = [box(true, stacked, "Create stacked PR"), box(true, branch, "Commit on current branch")].join("\n");

    // The stacked choice wins: it is the one that leaves the head branch alone.
    expect(newlyCheckedTriggers(after, before)).toEqual([
      { action: "generate_docstrings", delivery: "stacked" },
    ]);
  });

  it("still honours the labels on walkthroughs posted before delivery choice existed", () => {
    const before = `- [ ] <!-- {"checkboxId": "c2"} -->   Push docstring commit to this branch`;
    const after = `- [x] <!-- {"checkboxId": "c2"} -->   Push docstring commit to this branch`;
    expect(newlyCheckedTriggers(after, before)).toEqual([
      { action: "generate_docstrings", delivery: "branch" },
    ]);
  });

  it("gives an old `Create PR with unit tests` box the PR it always promised", () => {
    const before = `- [ ] <!-- {"checkboxId": "c1"} -->   Create PR with unit tests`;
    const after = `- [x] <!-- {"checkboxId": "c1"} -->   Create PR with unit tests`;
    expect(newlyCheckedTriggers(after, before)).toEqual([
      { action: "generate_tests", delivery: "stacked" },
    ]);
  });

  it("honours the two legacy review-body labels", () => {
    const ids = ['{"checkboxId": "x"}', '{"checkboxId": "y"}'];
    const before = [
      `- [ ] <!-- ${ids[0]} --> Push a commit to this branch (recommended)`,
      `- [ ] <!-- ${ids[1]} --> Create a new PR with the fixes`,
    ].join("\n");
    const after = [
      `- [ ] <!-- ${ids[0]} --> Push a commit to this branch (recommended)`,
      `- [x] <!-- ${ids[1]} --> Create a new PR with the fixes`,
    ].join("\n");
    expect(newlyCheckedTriggers(after, before)).toEqual([
      { action: "autofix", delivery: "stacked" },
    ]);
  });
});

describe("the synthetic command a checkbox dispatches", () => {
  it("round-trips through the command parser", () => {
    const cases = [
      { trigger: { action: "generate_docstrings", delivery: "stacked" }, type: "generate_docstrings" },
      { trigger: { action: "generate_tests", delivery: "stacked" }, type: "generate_tests" },
      { trigger: { action: "simplify", delivery: "stacked" }, type: "simplify" },
      { trigger: { action: "autofix", delivery: "stacked" }, type: "autofix" },
    ] as const;

    for (const c of cases) {
      const text = `@diffsentry ${triggerCommandText(c.trigger)}`;
      expect(parseCommand(text, "diffsentry")).toEqual({ type: c.type, delivery: "stacked" });
    }
  });

  it("leaves the branch destination as the default, with no flag", () => {
    expect(triggerCommandText({ action: "autofix", delivery: "branch" })).toBe("autofix");
    expect(parseCommand("@diffsentry autofix", "diffsentry")).toEqual({ type: "autofix" });
  });
});

describe("every checkbox the finishing-touches block renders is routable", () => {
  const block = finishingTouchesBlock("feat/thing");
  const lines = block.split("\n").filter((l) => l.trim().startsWith("- ["));

  it("renders both destinations for all four touches", () => {
    expect(lines).toHaveLength(8);
  });

  it("dispatches every one of them", () => {
    const checkedAll = block.replace(/- \[ \]/g, "- [x]");
    const triggers = newlyCheckedTriggers(checkedAll, block);
    // One per touch — the stacked box of each pair wins the tie.
    expect(triggers.map((t) => t.action).sort()).toEqual([
      "autofix",
      "generate_docstrings",
      "generate_tests",
      "simplify",
    ]);
    expect(triggers.every((t) => t.delivery === "stacked")).toBe(true);
  });

  it("dispatches each branch-destination box on its own", () => {
    for (const line of lines.filter((l) => l.includes('"delivery":"branch"'))) {
      const after = block.replace(line, line.replace("- [ ]", "- [x]"));
      const triggers = newlyCheckedTriggers(after, block);
      expect(triggers).toHaveLength(1);
      expect(triggers[0].delivery).toBe("branch");
    }
  });

  it("uses the corpus labels for each destination", () => {
    // tests/e2e/reference/2026-09/coderabbit/walkthrough.md:164,171 and the
    // `✨ Simplify code` block captured in the parity fixture.
    expect(block).toContain("Create stacked PR");
    expect(block).toContain("Commit on current branch");
    expect(block).toContain("Create PR with unit tests");
    expect(block).toContain("Commit unit tests in branch `feat/thing`");
    expect(block).toContain("Create PR with simplified code");
    expect(block).toContain("Commit simplified code in branch `feat/thing`");
  });

  it("does not advertise a radio group nothing reads", () => {
    expect(block).not.toContain("radioGroupId");
  });

  it("keeps its four summaries", () => {
    expect(block).toContain("<summary>🧪 Generate unit tests (beta)</summary>");
    expect(block).toContain("<summary>📝 Generate docstrings (beta)</summary>");
    expect(block).toContain("<summary>🧹 Simplify (beta)</summary>");
    expect(block).toContain("<summary>🪄 Autofix unresolved comments (beta)</summary>");
  });
});

describe("the shape of a checkbox line", () => {
  const m = (delivery: string) =>
    JSON.stringify({ checkboxId: `id-${delivery}`, action: "autofix", delivery });

  it("recognises every marker, indent and tick the renderers can produce", () => {
    const forms = [
      `- [x] <!-- ${m("branch")} --> Push a commit to this branch (recommended)`,
      `- [X] <!-- ${m("branch")} --> Push a commit to this branch (recommended)`,
      `* [x] <!-- ${m("branch")} --> Push a commit to this branch (recommended)`,
      `   - [x]   <!-- ${m("branch")} -->   Push a commit to this branch (recommended)`,
      `\t-\t[x]\t<!-- ${m("branch")} -->\tPush a commit to this branch (recommended)`,
      `- [x]<!-- ${m("branch")} -->Push a commit to this branch (recommended)`,
    ];
    for (const after of forms) {
      const before = after.replace(/\[[xX]\]/, "[ ]");
      expect(newlyCheckedTriggers(after, before)).toEqual([
        { action: "autofix", delivery: "branch" },
      ]);
    }
  });

  it("falls back to the label when the comment is never closed", () => {
    // `<!--` with no `-->` is not metadata; the whole tail is the label, and
    // the legacy label table still routes it.
    const after = `- [x] <!-- {"checkboxId": "z" Push a commit to this branch (recommended)`;
    const before = after.replace("[x]", "[ ]");
    expect(newlyCheckedTriggers(after, before)).toEqual([
      { action: "autofix", delivery: "branch" },
    ]);
  });

  it("ignores a line that only looks like one", () => {
    const after = ["[x] not a list item", "- (x) wrong bracket", "- [y] not a tick"].join("\n");
    expect(newlyCheckedTriggers(after, after.replace(/x/g, " "))).toEqual([]);
  });

  it("parses an adversarial body promptly", () => {
    // The body of an edited comment is attacker-controlled. A run of tabs after
    // the box used to be split every possible way between two competing
    // quantifiers; parsing must stay linear in the body's length. The bound is
    // deliberately loose — this guards against catastrophic backtracking, not
    // against a slow machine.
    const oneHugeLine = `- [ ] ${"\t".repeat(200_000)}`;
    const manyLines = Array.from({ length: 2_000 }, () => `*[ ]${"\t".repeat(200)}`).join("\n");
    const live = `- [x] <!-- ${m("stacked")} --> Create a new PR with the fixes`;

    const started = Date.now();
    expect(newlyCheckedTriggers(oneHugeLine, oneHugeLine)).toEqual([]);
    expect(newlyCheckedTriggers(`${manyLines}\n${live}`, `${manyLines}\n${live.replace("[x]", "[ ]")}`)).toEqual([
      { action: "autofix", delivery: "stacked" },
    ]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
