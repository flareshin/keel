import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Observation, ObservedDelta, Run } from "../recorded-cases.ts";
import { GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT, SHIP_GATE } from "./helpers.ts";
import { adversarialInputDigest, FIXTURE_DIRECTORY, goldenOf, judgeCase, runParity, summary } from "./hook-parity.ts";
import type { RecordedAdversarial } from "./hook-parity.ts";
import { buildAdversarialSet } from "./hook-parity-adversarial.ts";

const MIN_RECORDED_CASES = 300;
const MIN_ADVERSARIAL_CASES = 50;
const MIN_WRONG_TYPE_CASES = 400;
const PARITY_TIMEOUT_MS = 30 * 60_000;
const HOOK_ENTRIES = [GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT, SHIP_GATE];
const DENY = 2;
const ROOT = "/root";
const FIRES = "data/logs/keel-fires.jsonl";
const DECODE_MASKED = "<JSON syntax error message>";

function fire(detail: string): string {
  return `{"ts": "<ts>", "rule_id": "K2", "hook": "report-gate", "outcome": "error", "session": "s", "detail": "${detail}"}\n`;
}

function recorded(code: number, stderr: string, fires = ""): ObservedDelta {
  return { code, stdout: "", stderr, set: fires === "" ? {} : { [FIRES]: fires }, removed: [] };
}

function run(code: number | null, stderr: string, fires = ""): Run {
  const observation: Observation = { code, stdout: "", stderr, files: new Map(fires === "" ? [] : [[FIRES, fires]]) };
  return { observation, initial: new Map() };
}

describe("hook parity with the golden snapshot of the node hooks", () => {
  it("replays every recorded run of the former Python hook tests and the adversarial payloads through node and compares stdout, stderr, exit code and every file outside .git and remotes against the golden outcome", { timeout: PARITY_TIMEOUT_MS }, () => {
    const report = runParity();
    console.log(summary(report));
    const recordedCases = report.cases - report.adversarial;
    assert.ok(recordedCases >= MIN_RECORDED_CASES, `only ${recordedCases} cases recorded`);
    assert.ok(report.adversarial >= MIN_ADVERSARIAL_CASES, `only ${report.adversarial} adversarial cases`);
    for (const entry of HOOK_ENTRIES) assert.ok((report.perHook.get(entry) ?? 0) > 0, `no case recorded for ${entry}`);
    assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
  });
});

describe("hook parity comparison", () => {
  it("reports a difference in exit code, stderr or a written file", () => {
    const denied = recorded(DENY, "[K1] git-guard: blocked\n");
    assert.deepEqual(judgeCase(denied, run(DENY, "[K1] git-guard: blocked\n"), ROOT), []);
    assert.equal(judgeCase(denied, run(0, "[K1] git-guard: blocked\n"), ROOT).length, 1);
    assert.equal(judgeCase(denied, run(DENY, "[K1] git-guard: blocked.\n"), ROOT).length, 1);
    assert.equal(judgeCase(recorded(0, "", fire("x")), run(0, "", fire("y")), ROOT).length, 1);
    assert.equal(judgeCase(recorded(0, ""), run(0, "", fire("x")), ROOT).length, 1);
  });

  it("names the recorded side golden in a difference", () => {
    assert.deepEqual(judgeCase(recorded(DENY, "old"), run(DENY, "new"), ROOT), ['stderr: golden "old" / node "new"']);
  });

  it("reports a recorded deny that node lets through as a difference", () => {
    assert.equal(judgeCase(recorded(DENY, "x"), run(0, "x"), ROOT).length, 1);
    assert.equal(judgeCase(recorded(DENY, "x"), run(null, "x"), ROOT).length, 1);
  });

  it("ignores the wording of a JSON syntax error in a fire detail, which differs between node versions", () => {
    const syntax = recorded(0, "", fire(`JsonSyntaxError: ${DECODE_MASKED}`));
    assert.deepEqual(judgeCase(syntax, run(0, "", fire("JsonSyntaxError: Expected property name or '}' in JSON at position 1")), ROOT), []);
    const payload = recorded(0, "", fire(`payload is not JSON: ${DECODE_MASKED}`));
    assert.deepEqual(judgeCase(payload, run(0, "", fire("payload is not JSON: Unexpected end of JSON input")), ROOT), []);
  });

  it("still compares a fire detail that is not a JSON syntax error", () => {
    const golden = recorded(0, "", fire("hook payload is not a JSON object"));
    assert.equal(judgeCase(golden, run(0, "", fire("hook payload is not an object")), ROOT).length, 1);
  });
});

describe("hook parity golden recording", () => {
  const observed = run(DENY, `denied in ${ROOT}/repo\n`, fire("JsonSyntaxError: Unexpected end of JSON input"));

  it("tokenizes the run's paths and masks its decode wording", () => {
    const golden = goldenOf(observed, ROOT);
    assert.equal(golden.stderr, "denied in {{ROOT}}/repo\n");
    assert.equal(golden.set[FIRES], fire(`JsonSyntaxError: ${DECODE_MASKED}`));
  });

  it("compares equal to the run it was recorded from", () => {
    assert.deepEqual(judgeCase(goldenOf(observed, ROOT), observed, ROOT), []);
  });
});

describe("hook parity wrong-type payloads", () => {
  it("records the golden outcome of every wrong-type payload", () => {
    const adversarial = buildAdversarialSet();
    try {
      const golden = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "adversarial.json"), "utf8")) as Record<string, RecordedAdversarial>;
      const wrongType = adversarial.cases.filter((adversarialCase) => adversarialCase.name.includes("wrong-type"));
      assert.ok(wrongType.length >= MIN_WRONG_TYPE_CASES, `${wrongType.length} wrong-type payloads`);
      for (const adversarialCase of wrongType) {
        assert.equal(golden[adversarialCase.name]?.input, adversarialInputDigest(adversarialCase, adversarial.sandbox.root), adversarialCase.name);
      }
    } finally {
      adversarial.sandbox.close();
    }
  });
});
