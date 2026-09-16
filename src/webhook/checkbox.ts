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

/** `- [x] <!-- {json} --> label`, on any list marker and any indent. */
const CHECKBOX_LINE = /^[ \t]*[-*][ \t]*\[([ xX])\][ \t]*(?:<!--([\s\S]*?)-->)?[ \t]*(.*)$/;

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

function parseBoxes(body: string): ParsedBox[] {
  const boxes: ParsedBox[] = [];
  for (const line of body.split("\n")) {
    const m = CHECKBOX_LINE.exec(line);
    if (!m) continue;
    const label = m[3].trim();
    let meta: unknown = null;
    if (m[2]) {
      try {
        meta = JSON.parse(m[2].trim());
      } catch {
        // Not our metadata — a plain HTML comment on somebody's task list.
      }
    }
    const checkboxId =
      meta && typeof meta === "object" && typeof (meta as { checkboxId?: unknown }).checkboxId === "string"
        ? (meta as { checkboxId: string }).checkboxId
        : null;
    boxes.push({ checked: m[1] !== " ", id: checkboxId ?? label, trigger: triggerFrom(meta, label) });
  }
  return boxes;
}

/**
 * Actions to run for an edit that turned `prevBody` into `body`.
 *
 * At most one delivery per action: ticking both boxes of a touch in a single
 * edit is a contradiction, not a request for two runs, and the stacked one
 * wins because it is the choice that leaves the head branch untouched. The
 * reply names the destination either way, so the user is never left guessing
 * which of the two happened.
 */
export function newlyCheckedTriggers(body: string, prevBody: string): CheckboxTrigger[] {
  const before = new Set(parseBoxes(prevBody).filter((b) => b.checked).map((b) => b.id));

  const byAction = new Map<CheckboxAction, CodegenDelivery>();
  for (const box of parseBoxes(body)) {
    if (!box.checked || !box.trigger || before.has(box.id)) continue;
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
