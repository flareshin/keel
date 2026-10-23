import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRuleChecksParity } from "./rule-checks-parity.ts";

const MIN_RUNS = 60;
const MIN_SIGNAL_LINES = 1000;

describe("rule-checks.ts parity with rule-checks.py", () => {
  it("prints the same stdout, stderr and exit code for the same repositories and arguments", async () => {
    const report = await runRuleChecksParity();
    console.log(`parity rule-checks: ${report.runs} cases, ${report.mismatches} mismatches (${report.signalLines} signal lines, exit codes ${JSON.stringify(report.exitCodes)})`);
    assert.ok(report.runs >= MIN_RUNS, `${report.runs} runs`);
    assert.ok(report.signalLines >= MIN_SIGNAL_LINES, `${report.signalLines} signal lines compared`);
    assert.equal(report.mismatches, 0, report.details.join("\n"));
  });
});
