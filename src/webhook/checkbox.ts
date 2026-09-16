import { CodegenDelivery } from "../types.js";

/**
 * Reading DiffSentry's own checkboxes back off a comment it posted.
 *
 * Two surfaces render them:
 *  - the walkthrough issue comment — the four ✨ Finishing Touches
 *    (`finishingTouchesBlock` in reviewer.ts);
 *  - the review body — 🪄 Autofix (`renderAutofixSection` in review-body.ts).
 *
 * Both now offer each action twice, once per destination, so the *label* no
 * longer identifies an action: `Create stacked PR` appears under two different
 * touches. Routing therefore comes out of the HTML comment beside `checkboxId`,
 * where CodeRabbit keeps its own (`radioGroupId`).
 *
 * Labels stay as the fallback, because walkthroughs posted before this change
 * are still live on open PRs and their checkboxes must keep working.
 */

export type CheckboxAction = "generate_tests" | "generate_docstrings" | "simplify" | "autofix";

export interface CheckboxTrigger {
  action: CheckboxAction;
  delivery: CodegenDelivery;
}

const ACTIONS = new Set<string>([
  "generate_tests",
  "generate_docstrings",
  "simplify",
  "autofix",
]);

/**
 * Checkbox labels DiffSentry emitted before delivery choice existed, plus the
 * two review-body labels. Kept because a walkthrough posted last week is still
 * on an open PR with these exact strings in it.
 *
 * `Create PR with unit tests` maps to `stacked`, which is what it always said
 * and never did: the handler behind it pushed a commit to the head branch.
 */
const LEGACY_LABELS: Array<{ label: string; trigger: CheckboxTrigger }> = [
  { label: "Create PR with unit tests", trigger: { action: "generate_tests", delivery: "stacked" } },
  { label: "Push docstring commit to this branch", trigger: { action: "generate_docstrings", delivery: "branch" } },
  { label: "Push simplification commit to this branch", trigger: { action: "simplify", delivery: "branch" } },
  { label: "Push autofix commit to this branch", trigger: { action: "autofix", delivery: "branch" } },
  { label: "Push a commit to this branch (recommended)", trigger: { action: "autofix", delivery: "branch" } },
  { label: "Create a new PR with the fixes", trigger: { action: "autofix", delivery: "stacked" } },
];

/**
 * The opening of a checkbox line: indent, list marker, the box itself, and the
 * whitespace after it. `- [x]` and `*  [ ]` both qualify, on any indent.
 *
 * Only the opening. What follows — an optional `<!-- {json} -->` and then the
 * label — is sliced off by hand below rather than matched, because the obvious
 * regex for it (`[ \t]*(?:<!--([\s\S]*?)-->)?[ \t]*(.*)$`) puts two unbounded
 * runs over the same class on either side of an optional group. Those two
 * compete for every space and tab between them, so once the tail fails the
 * engine tries every way of splitting that run — quadratic in its length
 * (CodeQL `js/polynomial-redos`). The text being parsed is the body of an
 * edited comment, which anyone who can comment on the PR controls, so its
 * parse has to be linear by construction rather than merely fast on the shapes
 * we ourselves emit. `indexOf` is linear and cannot backtrack; what is left in
 * the pattern below has no two quantifiers that could compete for a character.
 */
const CHECKBOX_PREFIX = /^[ \t]*[-*][ \t]*\[([ xX])\][ \t]*/;

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

interface ParsedBox {
  checked: boolean;
  /** Stable identity within one comment body: the checkboxId, else the label. */
  id: string;
  trigger: CheckboxTrigger | null;
}

function triggerFrom(meta: unknown, label: string): CheckboxTrigger | null {
  if (meta && typeof meta === "object") {
    const m = meta as { action?: unknown; delivery?: unknown };
    if (typeof m.action === "string" && ACTIONS.has(m.action)) {
      const delivery: CodegenDelivery = m.delivery === "stacked" ? "stacked" : "branch";
      return { action: m.action as CheckboxAction, delivery };
    }
  }
  const legacy = LEGACY_LABELS.find((l) => label.includes(l.label));
  return legacy ? { ...legacy.trigger } : null;
}

/** Split one line into box state, the raw HTML comment, and the label. */
function parseLine(line: string): { checked: boolean; raw: string | null; label: string } | null {
  const m = CHECKBOX_PREFIX.exec(line);
  if (!m) return null;
  let rest = line.slice(m[0].length);
  let raw: string | null = null;
  if (rest.startsWith(COMMENT_OPEN)) {
    const close = rest.indexOf(COMMENT_CLOSE, COMMENT_OPEN.length);
    // An unterminated `<!--` is not a comment — it stays part of the label,
    // which is what the pattern this replaced did with it too.
    if (close !== -1) {
      raw = rest.slice(COMMENT_OPEN.length, close);
      rest = rest.slice(close + COMMENT_CLOSE.length);
    }
  }
  return { checked: m[1] !== " ", raw, label: rest.trim() };
}

function parseBoxes(body: string): ParsedBox[] {
  const boxes: ParsedBox[] = [];
  for (const line of body.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { checked, raw, label } = parsed;
    let meta: unknown = null;
    if (raw) {
      try {
        meta = JSON.parse(raw.trim());
      } catch {
        // Not our metadata — a plain HTML comment on somebody's task list.
      }
    }
    const checkboxId =
      meta && typeof meta === "object" && typeof (meta as { checkboxId?: unknown }).checkboxId === "string"
        ? (meta as { checkboxId: string }).checkboxId
        : null;
    boxes.push({ checked, id: checkboxId ?? label, trigger: triggerFrom(meta, label) });
  }
  return boxes;
}

/**
 * Actions to run for an edit that turned `prevBody` into `body`.
 *
 * At most one delivery per action — and that holds across edits, not only
 * within one.
 *
 * Within one edit, ticking both boxes of a touch is a contradiction rather
 * than a request for two runs, and the stacked one wins because it is the
 * choice that leaves the head branch untouched. The reply names the
 * destination either way, so the user is never left guessing which happened.
 *
 * Across edits, ticking the second box is a change of mind that arrives too
 * late. The first delivery has already run and a pushed commit cannot be
 * un-pushed, so the second is dropped rather than run beside it. Otherwise a
 * user who reconsidered got both: a commit on their branch *and* a stacked PR
 * carrying the same fixes, which is then empty or in conflict with it.
 *
 * `prevBody` is what makes that possible with nothing stored. It is the
 * comment as it stood before this edit, so a box of the same touch already
 * ticked there is a delivery that has already run — GitHub holds the record
 * for us, per comment, for as long as the comment lives. It also leaves both
 * gestures intact, which a durable "autofix has run on PR 7" would not:
 * unticking one box and ticking the other really does change the destination,
 * and unticking and re-ticking the same box really does ask for a rerun.
 *
 * What it does not cover is one action offered on two surfaces: autofix is in
 * the walkthrough comment and in the review body, which have separate edit
 * histories, so ticking it in both still delivers twice. Closing that needs
 * per-PR state, which is unavailable whenever persistence is off — a rule that
 * silently lapses in some deployments is worse than the narrow gap it closes.
 */
export function newlyCheckedTriggers(body: string, prevBody: string): CheckboxTrigger[] {
  const previous = parseBoxes(prevBody);
  const before = new Set(previous.filter((b) => b.checked).map((b) => b.id));
  const alreadyDelivered = new Set<CheckboxAction>();
  for (const box of previous) {
    if (box.checked && box.trigger) alreadyDelivered.add(box.trigger.action);
  }

  const byAction = new Map<CheckboxAction, CodegenDelivery>();
  for (const box of parseBoxes(body)) {
    if (!box.checked || !box.trigger || before.has(box.id)) continue;
    if (alreadyDelivered.has(box.trigger.action)) continue;
    const existing = byAction.get(box.trigger.action);
    if (existing === "stacked") continue;
    byAction.set(box.trigger.action, box.trigger.delivery);
  }

  return Array.from(byAction, ([action, delivery]) => ({ action, delivery }));
}

/**
 * The `@bot …` phrase that runs a trigger, for the synthetic comment the
 * dispatcher routes through the normal command handler. `--stacked` is the
 * flag `src/commands.ts` parses; the head-branch destination is the default and
 * needs no flag.
 */
export function triggerCommandText(trigger: CheckboxTrigger): string {
  const verb = trigger.action.replace(/_/g, " ");
  return trigger.delivery === "stacked" ? `${verb} --stacked` : verb;
}
