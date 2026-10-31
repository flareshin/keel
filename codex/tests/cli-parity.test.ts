import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recordedAnswers } from "../../tests/recorded.ts";
import { ADAPTER, GOLDEN_DOCUMENT, NESTED_TOML, SCENARIOS, put, replayScenario, scenarioTokens, withScenarioRoot } from "./cli-parity.ts";
import type { Observation } from "./cli-parity.ts";

const MISMATCHES_SHOWN = 400;
const MIN_INVOCATIONS = 100;

function differences(label: string, golden: Observation, node: Observation): string[] {
  const found: string[] = [];
  if (golden.status !== node.status) found.push(`${label}: exit golden ${golden.status} / node ${node.status}`);
  if (golden.stdout !== node.stdout) found.push(`${label}: stdout\n  golden: ${JSON.stringify(golden.stdout)}\n  node: ${JSON.stringify(node.stdout)}`);
  if (golden.stderr !== node.stderr) found.push(`${label}: stderr\n  golden: ${JSON.stringify(golden.stderr)}\n  node: ${JSON.stringify(node.stderr)}`);
  for (const key of new Set([...Object.keys(golden.files), ...Object.keys(node.files)])) {
    if (golden.files[key] !== node.files[key]) found.push(`${label}: file ${key}\n  golden: ${golden.files[key]?.slice(0, 200)}\n  node: ${node.files[key]?.slice(0, 200)}`);
  }
  return found;
}

describe("link and config parity with the golden snapshot of the node entries", () => {
  it("writes the same stdout, stderr, exit code and files for every invocation", () => {
    const mismatches: string[] = [];
    let invocations = 0;
    withScenarioRoot((root) => {
      for (const scenario of SCENARIOS) {
        const [golden] = recordedAnswers<unknown, Observation[]>(GOLDEN_DOCUMENT, [{ scenario: scenario.name }], scenarioTokens(root)) as [Observation[]];
        const observed = replayScenario(scenario, root);
        invocations += observed.length;
        assert.equal(observed.length, golden.length, `${scenario.name}: recorded ${golden.length} steps, replayed ${observed.length}`);
        observed.forEach((node, index) => mismatches.push(...differences(`${scenario.name} step ${index + 1}`, golden[index] as Observation, node)));
      }
    });
    console.log(`golden: ${invocations} cases, ${mismatches.length} mismatches`);
    assert.ok(invocations >= MIN_INVOCATIONS, `${invocations} invocations`);
    assert.equal(mismatches.length, 0, mismatches.slice(0, MISMATCHES_SHOWN).join("\n"));
  });
});

describe("config crash parity on deeply nested TOML", () => {
  function exitStatus(text: string): number | null {
    return withScenarioRoot((root) => {
      put(join(root, "candidate.toml"), text);
      const command = [process.execPath, join(ADAPTER, "bin", "config.ts")];
      const args = ["--profile", join(root, "profile"), "--file", join(root, "candidate.toml")];
      return spawnSync(command[0] as string, [...command.slice(1), ...args], { env: { ...process.env, HOME: root }, encoding: "utf8" }).status;
    });
  }

  for (const [name, shape] of Object.entries(NESTED_TOML)) {
    it(`crashes on ${name} at the same depth as Python`, () => {
      const [low] = recordedAnswers<unknown, [number]>(GOLDEN_DOCUMENT, [{ crashDepth: name }])[0] as [number];
      console.log(`parity config deep ${name}: python first crashes at depth ${low}`);
      assert.equal(exitStatus(shape(low - 1)), 0);
      assert.equal(exitStatus(shape(low)), 1);
    });
  }
});
