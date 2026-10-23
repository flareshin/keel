import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isRecording } from "../../tests/recorded.ts";
import { hookCases } from "./hook-parity-corpus.ts";
import type { HookParityReport } from "./hook-parity.ts";
import { sandboxPaths } from "./hook-parity.ts";

const WORKER = join(import.meta.dirname, "hook-parity-worker.ts");
const MAX_WORKERS = 8;
const MIN_CASES = 150;

function runWorker(index: number, count: number): Promise<HookParityReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, String(index), String(count)]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => (status === 0 ? resolve(JSON.parse(stdout) as HookParityReport) : reject(new Error(stderr))));
  });
}

describe("pre-tool-use hook parity with pre-tool-use.py", () => {
  it("returns the same stdout, stderr, exit code and files for every payload", async () => {
    const corpus = hookCases(sandboxPaths());
    const total = corpus.length;
    const workers = isRecording() ? 1 : Math.min(MAX_WORKERS, availableParallelism());
    const reports = await Promise.all(Array.from({ length: workers }, (_unused, index) => runWorker(index, workers)));
    const cases = reports.reduce((sum, report) => sum + report.cases, 0);
    const mismatches = reports.reduce((sum, report) => sum + report.mismatches, 0);
    const denied = reports.reduce((sum, report) => sum + report.denied, 0);
    const divergences = reports.reduce((sum, report) => sum + report.divergences, 0);
    const contextual = reports.reduce((sum, report) => sum + report.contextual, 0);
    const passed = reports.reduce((sum, report) => sum + report.passed, 0);
    console.log(`parity hook: ${cases} cases, ${mismatches} mismatches (${denied} denied, ${contextual} with context, ${passed} passed silently, ${divergences} expected policy divergences)`);
    assert.equal(divergences, corpus.filter((testCase) => testCase.divergence !== undefined).length);
    assert.ok(divergences > 0);
    assert.equal(cases, total);
    assert.ok(cases >= MIN_CASES, `${cases} cases`);
    assert.ok(denied > 0 && passed > 0, "the corpus must exercise both denials and passes");
    assert.equal(mismatches, 0, reports.flatMap((report) => report.details).join("\n"));
  });
});
