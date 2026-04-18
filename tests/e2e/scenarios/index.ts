import type { Scenario } from "../types.js";
import { scenario as divideByZero } from "./divide-by-zero.js";
import { scenario as sqlInjection } from "./sql-injection.js";
import { scenario as wipTitleSkip } from "./wip-title-skip.js";
import { scenario as chatHelp } from "./chat-help.js";

export const ALL_SCENARIOS: Scenario[] = [
  divideByZero,
  sqlInjection,
  wipTitleSkip,
  chatHelp,
];

export function findScenario(name: string): Scenario | undefined {
  return ALL_SCENARIOS.find((s) => s.name === name);
}
