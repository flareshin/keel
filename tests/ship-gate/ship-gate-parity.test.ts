import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compare, isDenyToPass, runShipGateParity, summary } from "./ship-gate-parity.ts";
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
    assert.equal(report.denyToPass, 0, "a push or merge python denies passed in node");
    assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
  });
});
