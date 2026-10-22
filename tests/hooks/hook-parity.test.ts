import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT } from "./helpers.ts";
import { runParity, summary } from "./hook-parity.ts";

const MIN_CASES = 300;
const PARITY_TIMEOUT_MS = 30 * 60_000;
const PYTHON_ENTRIES = [GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT].map((entry) => entry.replace(/\.ts$/, ".py"));

describe("hook parity with the Python hooks", () => {
  it("replays every run of the Python hook tests through python and node with identical results", { timeout: PARITY_TIMEOUT_MS }, () => {
    const report = runParity();
    console.log(summary(report));
    assert.equal(report.recorder.failures + report.recorder.errors, 0, "the Python hook tests failed while recording");
    assert.ok(report.cases >= MIN_CASES, `only ${report.cases} cases recorded`);
    for (const entry of PYTHON_ENTRIES) assert.ok((report.perHook.get(entry) ?? 0) > 0, `no case recorded for ${entry}`);
    assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
  });
});
