import { runScenario } from "./runner.js";
import { ALL_SCENARIOS, findScenario } from "./scenarios/index.js";

function printUsage() {
  console.log(`Usage:
  npm run e2e -- <scenario-name>      Run one scenario
  npm run e2e -- --all                Run every scenario sequentially
  npm run e2e -- --list               List available scenarios

Reports land in tests/e2e/runs/<timestamp>_<scenario>/transcript.md
`);
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--help" || arg === "-h") {
    printUsage();
    process.exit(arg ? 0 : 1);
  }

  if (arg === "--list") {
    for (const s of ALL_SCENARIOS) {
      console.log(`${s.name.padEnd(28)} ${s.description}`);
    }
    return;
  }

  const targets = arg === "--all" ? ALL_SCENARIOS : [findScenario(arg)];
  if (targets.some((t) => !t)) {
    console.error(`Unknown scenario: ${arg}`);
    console.error(`Available: ${ALL_SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(2);
  }

  let failed = 0;
  for (const scenario of targets) {
    try {
      const run = await runScenario(scenario!);
      if (!run.passed) failed++;
    } catch (err) {
      failed++;
      console.error(`[${scenario!.name}] threw:`, err);
    }
  }

  console.log(`\nDone. ${targets.length - failed}/${targets.length} passed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
