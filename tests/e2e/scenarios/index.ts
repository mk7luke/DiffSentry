import type { Scenario } from "../types.js";
import { scenario as divideByZero } from "./divide-by-zero.js";
import { scenario as sqlInjection } from "./sql-injection.js";
import { scenario as wipTitleSkip } from "./wip-title-skip.js";
import { scenario as chatHelp } from "./chat-help.js";
import { scenario as multiFileCohorts } from "./multi-file-cohorts.js";
import { scenario as preMergeChecks } from "./pre-merge-checks.js";
import { scenario as nitpickCollapse } from "./nitpick-collapse.js";
import { scenario as chatPause } from "./chat-pause.js";
import { scenario as poemWalkthrough } from "./poem-walkthrough.js";
import { scenario as pathFilter } from "./path-filter.js";
import { scenario as chatQuestion } from "./chat-question.js";
import { scenario as linkedIssue } from "./linked-issue.js";

export const ALL_SCENARIOS: Scenario[] = [
  divideByZero,
  sqlInjection,
  wipTitleSkip,
  chatHelp,
  chatPause,
  chatQuestion,
  multiFileCohorts,
  preMergeChecks,
  nitpickCollapse,
  poemWalkthrough,
  pathFilter,
  linkedIssue,
];

export function findScenario(name: string): Scenario | undefined {
  return ALL_SCENARIOS.find((s) => s.name === name);
}
