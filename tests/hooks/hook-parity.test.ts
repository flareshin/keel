import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT } from "./helpers.ts";
import { runParity, summary } from "./hook-parity.ts";

const MIN_RECORDED_CASES = 300;
const MIN_ADVERSARIAL_CASES = 50;
const PARITY_TIMEOUT_MS = 30 * 60_000;
const HOOK_ENTRIES = [GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT];

describe("hook parity with the recorded Python hooks", () => {
  it("replays every recorded run of the former Python hook tests and the adversarial payloads through node and compares stdout, stderr, exit code and every file outside .git and remotes against the recorded Python outcome", { timeout: PARITY_TIMEOUT_MS }, () => {
    const report = runParity();
    console.log(summary(report));
    const recorded = report.cases - report.adversarial;
    assert.ok(recorded >= MIN_RECORDED_CASES, `only ${recorded} cases recorded`);
    assert.ok(report.adversarial >= MIN_ADVERSARIAL_CASES, `only ${report.adversarial} adversarial cases`);
    for (const entry of HOOK_ENTRIES) assert.ok((report.perHook.get(entry) ?? 0) > 0, `no case recorded for ${entry}`);
    assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
  });
});
