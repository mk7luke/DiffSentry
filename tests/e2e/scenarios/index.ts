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
import { scenario as incrementalReview } from "./incremental-review.js";
import { scenario as trivialSkip } from "./trivial-skip.js";
import { scenario as riskAndCoverage } from "./risk-and-coverage.js";
import { scenario as chatTldr } from "./chat-tldr.js";
import { scenario as chatTour } from "./chat-tour.js";
import { scenario as secretScanner } from "./secret-scanner.js";
import { scenario as mergeMarker } from "./merge-marker.js";
import { scenario as chatShip } from "./chat-ship.js";
import { scenario as chatRubberDuck } from "./chat-rubber-duck.js";
import { scenario as chatFiveWhy } from "./chat-five-why.js";
import { scenario as depChanges } from "./dep-changes.js";
import { scenario as commitCoach } from "./commit-coach.js";
import { scenario as descriptionDrift } from "./description-drift.js";
import { scenario as chatEli5 } from "./chat-eli5.js";

export const ALL_SCENARIOS: Scenario[] = [
  divideByZero,
  sqlInjection,
  wipTitleSkip,
  chatHelp,
  chatPause,
  chatQuestion,
  chatTldr,
  chatTour,
  chatShip,
  chatRubberDuck,
  chatFiveWhy,
  chatEli5,
  multiFileCohorts,
  preMergeChecks,
  nitpickCollapse,
  poemWalkthrough,
  pathFilter,
  linkedIssue,
  trivialSkip,
  incrementalReview,
  riskAndCoverage,
  secretScanner,
  mergeMarker,
  depChanges,
  commitCoach,
  descriptionDrift,
];

export function findScenario(name: string): Scenario | undefined {
  return ALL_SCENARIOS.find((s) => s.name === name);
}
