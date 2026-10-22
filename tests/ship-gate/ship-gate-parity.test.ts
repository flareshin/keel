import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compare, EXPECTED_DIVERGENCES, isDenyToPass, judgeCase, runShipGateParity, summary } from "./ship-gate-parity.ts";
import type { Observation } from "./ship-gate-parity.ts";

const MIN_CASES = 600;
const PARITY_TIMEOUT_MS = 120 * 60_000;
const DENY = 2;

function observation(code: number, stderr: string, files: Array<[string, string]> = []): Observation {
  return { code, stdout: "", stderr, files: new Map(files) };
}

describe("ship-gate parity comparison", () => {
  it("reports a difference in exit code, stderr or a written file", () => {
    const denied = observation(DENY, "[K1] ship-gate: denied");
    assert.deepEqual(compare(denied, observation(DENY, "[K1] ship-gate: denied")), []);
    assert.equal(compare(denied, observation(0, "[K1] ship-gate: denied")).length, 1);
    assert.equal(compare(denied, observation(DENY, "[K1] ship-gate: denied.")).length, 1);
    assert.equal(compare(observation(0, "", [["data/a", "x"]]), observation(0, "", [["data/a", "y"]])).length, 1);
    assert.equal(compare(observation(0, ""), observation(0, "", [["data/a", "x"]])).length, 1);
  });

  it("counts only a python deny that node passes as deny-to-pass", () => {
    assert.equal(isDenyToPass(observation(DENY, "x"), observation(0, "")), true);
    assert.equal(isDenyToPass(observation(0, ""), observation(DENY, "x")), false);
    assert.equal(isDenyToPass(observation(DENY, "x"), observation(DENY, "x")), false);
  });
});

describe("ship-gate parity listed divergences", () => {
  const label = "gh-answer-nested-200000";

  it("lists the over-bound rows for the gh answer, the evidence file and stdin at both depths", () => {
    assert.deepEqual([...EXPECTED_DIVERGENCES.keys()].sort(), [
      "evidence-file-nested-10001", "evidence-file-nested-200000", "gh-answer-nested-10001", "gh-answer-nested-200000",
      "stdin-ls-nested-10001", "stdin-ls-nested-200000", "stdin-push-nested-10001", "stdin-push-nested-200000",
    ]);
    assert.deepEqual([...new Set(EXPECTED_DIVERGENCES.values())], [DENY]);
  });

  it("accepts a listed row only when node gives the required exit, whatever python did", () => {
    assert.deepEqual(judgeCase(label, observation(DENY, "python text"), observation(DENY, "node text")), { listed: true, problems: [] });
    assert.deepEqual(judgeCase(label, observation(0, ""), observation(DENY, "node text")), { listed: true, problems: [] });
    const passed = judgeCase(label, observation(DENY, "python text"), observation(0, ""));
    assert.equal(passed.listed, false);
    assert.ok(passed.problems[0]?.includes("requires node exit 2, got 0"), passed.problems.join("\n"));
  });

  it("holds an unlisted row to the strict comparison", () => {
    assert.deepEqual(judgeCase("", observation(DENY, "same"), observation(DENY, "same")), { listed: false, problems: [] });
    assert.equal(judgeCase("", observation(DENY, "python text"), observation(DENY, "node text")).problems.length, 1);
    assert.equal(judgeCase("other-nested-5", observation(DENY, "python text"), observation(DENY, "node text")).problems.length, 1);
  });
});

describe("ship-gate parity with the Python hook", () => {
  it("replays every payload the Python ship-gate tests send, and extra ones, through python and node with identical results", { timeout: PARITY_TIMEOUT_MS }, () => {
    const report = runShipGateParity();
    for (const line of summary(report)) console.log(line);
    for (const detail of report.details.slice(0, 10)) console.log(detail);
    for (const recorder of report.recorders) {
      assert.equal(recorder.failures + recorder.errors, 0, `the Python tests failed while recording ${recorder.label}`);
    }
    assert.ok(report.cases >= MIN_CASES, `only ${report.cases} cases recorded`);
    for (const suite of ["python-keel", "ts-keel", "message-contract", "extra"]) {
      assert.ok((report.perSuite.get(suite) ?? 0) > 0, `no case recorded for ${suite}`);
    }
    assert.equal(report.listedDivergences, EXPECTED_DIVERGENCES.size, "a listed divergence row was not checked");
    assert.equal(report.denyToPass, 0, "a push or merge python denies passed in node");
    assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
  });
});
