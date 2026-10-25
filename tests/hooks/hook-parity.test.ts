import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Observation, ObservedDelta, Run } from "../recorded-cases.ts";
import { GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT, SHIP_GATE } from "./helpers.ts";
import { adversarialInputDigest, EXPECTED_DIVERGENCES, FIXTURE_DIRECTORY, isDenyToPass, listedDifferences, runParity, summary } from "./hook-parity.ts";
import type { ListedDivergence, RecordedAdversarial } from "./hook-parity.ts";
import { buildAdversarialSet } from "./hook-parity-adversarial.ts";

const MIN_RECORDED_CASES = 300;
const MIN_ADVERSARIAL_CASES = 50;
const MIN_WRONG_TYPE_CASES = 400;
const PARITY_TIMEOUT_MS = 30 * 60_000;
const HOOK_ENTRIES = [GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT, SHIP_GATE];
const DENY = 2;
const ROOT = "/root";
const FIRES = "data/logs/keel-fires.jsonl";
const LISTED: ListedDivergence = { code: 0, detailStartsWith: "Error: EISDIR: illegal operation on a directory, read" };

function fire(detail: string, rule = "K2"): string {
  return `{"ts": "<ts>", "rule_id": "${rule}", "hook": "report-gate", "outcome": "error", "session": "s", "detail": "${detail}"}\n`;
}

function recorded(code: number, stderr: string, fires: string): ObservedDelta {
  return { code, stdout: "", stderr, set: { [FIRES]: fires }, removed: [] };
}

function run(code: number | null, stderr: string, fires: string): Run {
  const observation: Observation = { code, stdout: "", stderr, files: new Map([[FIRES, fires]]) };
  return { observation, initial: new Map() };
}

describe("hook parity with the recorded Python hooks", () => {
  it("replays every recorded run of the former Python hook tests and the adversarial payloads through node and compares stdout, stderr, exit code and every file outside .git and remotes against the recorded Python outcome", { timeout: PARITY_TIMEOUT_MS }, () => {
    const report = runParity();
    console.log(summary(report));
    const recorded = report.cases - report.adversarial;
    assert.ok(recorded >= MIN_RECORDED_CASES, `only ${recorded} cases recorded`);
    assert.ok(report.adversarial >= MIN_ADVERSARIAL_CASES, `only ${report.adversarial} adversarial cases`);
    for (const entry of HOOK_ENTRIES) assert.ok((report.perHook.get(entry) ?? 0) > 0, `no case recorded for ${entry}`);
    assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
    assert.equal(report.denyToPass, 0, "a recorded Python deny passed through node");
  });
});

describe("hook parity recorded divergences", () => {
  it("lists exactly the four recorded runs whose error text names a Python class or errno", () => {
    assert.deepEqual([...EXPECTED_DIVERGENCES].map(([id, listed]) => [id, listed.code]).sort(), [["0194", DENY], ["0205", 0], ["0232", 0], ["0277", 0]]);
    assert.deepEqual([...EXPECTED_DIVERGENCES.values()].map((listed) => listed.detailStartsWith).sort(), [
      "Error: EACCES: permission denied, open '",
      "Error: EEXIST: file already exists, mkdir '",
      "Error: EISDIR: illegal operation on a directory, read",
      "GuardError: boundary scanner did not run: OSError",
    ]);
  });

  it("accepts a listed row whose only difference is the wording of the fire detail", () => {
    const python = recorded(0, "", fire("IsADirectoryError: [Errno 21] Is a directory: '{{ROOT}}/a'"));
    const node = run(0, "", fire("Error: EISDIR: illegal operation on a directory, read"));
    assert.deepEqual(listedDifferences(LISTED, python, node, ROOT), []);
  });

  it("refuses a listed row whose detail does not carry the new wording", () => {
    const python = recorded(0, "", fire("IsADirectoryError: [Errno 21] Is a directory: '{{ROOT}}/a'"));
    const problems = listedDifferences(LISTED, python, run(0, "", fire("IsADirectoryError: [Errno 21] Is a directory")), ROOT);
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes("lack a detail starting"), problems.join("\n"));
  });

  it("refuses a listed row whose exit code is not the listed one", () => {
    const python = recorded(0, "", fire("x"));
    const problems = listedDifferences(LISTED, python, run(DENY, "", fire("Error: EISDIR: illegal operation on a directory, read")), ROOT);
    assert.ok(problems[0]?.includes("required 0"), problems.join("\n"));
  });

  it("still compares stderr and the fire rule, hook and outcome of a listed row", () => {
    const detail = "Error: EISDIR: illegal operation on a directory, read";
    const python = recorded(0, "[K2] report-gate: x\n", fire("old"));
    assert.equal(listedDifferences(LISTED, python, run(0, "report-gate: x\n", fire(detail)), ROOT).length, 1);
    assert.equal(listedDifferences(LISTED, python, run(0, "[K2] report-gate: x\n", fire(detail, "K1")), ROOT).length, 1);
    assert.deepEqual(listedDifferences(LISTED, python, run(0, "[K2] report-gate: x\n", fire(detail)), ROOT), []);
  });

  it("counts a recorded Python deny that node lets through as deny-to-pass", () => {
    const denied = recorded(DENY, "x", "");
    assert.equal(isDenyToPass(denied, run(0, "", "").observation), true);
    assert.equal(isDenyToPass(denied, run(null, "", "").observation), true);
    assert.equal(isDenyToPass(denied, run(DENY, "x", "").observation), false);
    assert.equal(isDenyToPass(recorded(0, "", ""), run(DENY, "x", "").observation), false);
    assert.equal(isDenyToPass(undefined, run(0, "", "").observation), false);
  });
});

describe("hook parity wrong-type payloads", () => {
  it("records the outcome of the hook before the typed readers for every wrong-type payload, listed or not, so a deny that passes is counted", () => {
    const adversarial = buildAdversarialSet();
    try {
      const recorded = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "adversarial.json"), "utf8")) as Record<string, RecordedAdversarial>;
      const wrongType = adversarial.cases.filter((adversarialCase) => adversarialCase.name.includes("wrong-type"));
      assert.ok(wrongType.length >= MIN_WRONG_TYPE_CASES, `${wrongType.length} wrong-type payloads`);
      for (const adversarialCase of wrongType) {
        assert.equal(recorded[adversarialCase.name]?.input, adversarialInputDigest(adversarialCase, adversarial.sandbox.root), adversarialCase.name);
      }
    } finally {
      adversarial.sandbox.close();
    }
  });
});
