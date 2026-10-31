import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hookCases } from "./hook-parity-corpus.ts";
import type { HookParityReport, Observation } from "./hook-parity.ts";
import { crashLine, differences, inWorkers, sandboxPaths, withSyntaxMessageMasked } from "./hook-parity.ts";

const MIN_CASES = 150;
const DENIED = 2;

function observed(status: number | null, stdout: string, stderr = "", files: Record<string, string> = {}): Observation {
  return { status, stdout, stderr, files };
}

describe("pre-tool-use hook against the golden snapshot of its own results", () => {
  it("decides, exits and writes as recorded for every payload", async () => {
    const total = hookCases(sandboxPaths()).length;
    const reports = await inWorkers<HookParityReport>("check");
    const sum = (field: "cases" | "mismatches" | "denied" | "passed"): number => reports.reduce((count, report) => count + report[field], 0);
    const [cases, mismatches] = [sum("cases"), sum("mismatches")];
    console.log(`golden: ${cases} cases, ${mismatches} mismatches`);
    assert.equal(cases, total);
    assert.ok(cases >= MIN_CASES, `${cases} cases`);
    assert.ok(sum("denied") > 0 && sum("passed") > 0, "the corpus must exercise both denials and passes");
    assert.equal(mismatches, 0, reports.flatMap((report) => report.details).join("\n"));
  });
});

describe("hook parity comparison", () => {
  const golden = observed(0, '{"decision":"deny"}', "", { "data/x": "file:644:a" });

  it("accepts a run equal to the golden outcome", () => {
    assert.deepEqual(differences(golden, observed(0, '{"decision":"deny"}', "", { "data/x": "file:644:a" })), []);
  });

  it("reports a difference in exit code, stdout, stderr or a written file", () => {
    assert.equal(differences(golden, observed(DENIED, '{"decision":"deny"}', "", { "data/x": "file:644:a" })).length, 1);
    assert.equal(differences(golden, observed(0, '{"decision": "deny"}', "", { "data/x": "file:644:a" })).length, 1);
    assert.equal(differences(golden, observed(0, '{"decision":"deny"}', "warning", { "data/x": "file:644:a" })).length, 1);
    assert.equal(differences(golden, observed(0, '{"decision":"deny"}', "", { "data/x": "file:644:b" })).length, 1);
    assert.equal(differences(golden, observed(0, '{"decision":"deny"}')).length, 1);
  });

  it("reports a recorded denial that node lets through as a difference", () => {
    const denied = observed(DENIED, "", "blocked", {});
    assert.ok(differences(denied, observed(0, "")).length > 0);
    assert.ok(differences(denied, observed(null, "", "blocked")).length > 0);
  });

  it("masks the wording of a JSON syntax error, which differs between node versions", () => {
    const reason = '{"permissionDecisionReason":"keel Codex guard: invalid JSON: Expected property name or \\"}\\" in JSON at position 1"}';
    assert.equal(withSyntaxMessageMasked(reason), '{"permissionDecisionReason":"keel Codex guard: invalid JSON: <JSON syntax error message>"}');
  });

  it("keeps only the error line of a crash, whose stack frames carry paths and line numbers", () => {
    const stderr = "file:///checkout/pre-tool-use.ts:140\n  throw new TypeError(x);\n  ^\n\nTypeError: file_path must be a string, not number\n    at filePathOf (file:///checkout/pre-tool-use.ts:140:43)\n";
    assert.equal(crashLine(stderr), "TypeError: file_path must be a string, not number");
    assert.equal(crashLine("no error line"), "no error line");
  });
});
