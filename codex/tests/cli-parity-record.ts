import { recordAnswers, recordedAnswers } from "../../tests/recorded.ts";
import { GOLDEN_DOCUMENT, NESTED_TOML, SCENARIOS, replayScenario, scenarioTokens, withScenarioRoot } from "./cli-parity.ts";
import type { Observation } from "./cli-parity.ts";

function goldenOfScenarios(root: string): Array<[question: unknown, answer: Observation[]]> {
  return SCENARIOS.map((scenario) => [{ scenario: scenario.name }, replayScenario(scenario, root)]);
}

function recordedCrashDepths(): Array<[question: unknown, answer: unknown]> {
  return Object.keys(NESTED_TOML).map((name) => [{ crashDepth: name }, recordedAnswers(GOLDEN_DOCUMENT, [{ crashDepth: name }])[0]]);
}

function recordGolden(): void {
  withScenarioRoot((root) => {
    const scenarios = goldenOfScenarios(root);
    recordAnswers(GOLDEN_DOCUMENT, [...scenarios, ...recordedCrashDepths()], scenarioTokens(root));
    console.log(`recorded the golden outcome of ${scenarios.length} scenarios in ${GOLDEN_DOCUMENT}`);
  });
}

if (import.meta.main) recordGolden();
