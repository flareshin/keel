import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { differencesFromRecorded } from "../recorded-cases.ts";
import type { ObservedDelta, Observation, Run } from "../recorded-cases.ts";
import { EXPECTED_DIVERGENCES, isDenyToPass, judgeCase, runShipGateParity, summary, withoutCheckoutRepoKey } from "./ship-gate-parity.ts";

const MIN_CASES = 600;
const PARITY_TIMEOUT_MS = 120 * 60_000;
const DENY = 2;
const ROOT = "/root";

function recorded(code: number, stderr: string, set: Record<string, string> = {}): ObservedDelta {
  return { code, stdout: "", stderr, set, removed: [] };
}

function observation(code: number | null, stderr: string, files: Array<[string, string]> = []): Observation {
  return { code, stdout: "", stderr, files: new Map(files) };
}

function run(code: number | null, stderr: string, files: Array<[string, string]> = []): Run {
  return { observation: observation(code, stderr, files), initial: new Map() };
}

describe("ship-gate parity comparison", () => {
  it("reports a difference in exit code, stderr or a written file", () => {
    const denied = recorded(DENY, "[K1] ship-gate: denied");
    assert.deepEqual(differencesFromRecorded(denied, run(DENY, "[K1] ship-gate: denied"), ROOT), []);
    assert.equal(differencesFromRecorded(denied, run(0, "[K1] ship-gate: denied"), ROOT).length, 1);
    assert.equal(differencesFromRecorded(denied, run(DENY, "[K1] ship-gate: denied."), ROOT).length, 1);
    assert.equal(differencesFromRecorded(recorded(0, "", { "data/a": "x" }), run(0, "", [["data/a", "y"]]), ROOT).length, 1);
    assert.equal(differencesFromRecorded(recorded(0, ""), run(0, "", [["data/a", "x"]]), ROOT).length, 1);
  });

  it("counts a recorded python deny that node lets through, by exit 0, exit 1 or a timeout, as deny-to-pass", () => {
    assert.equal(isDenyToPass(recorded(DENY, "x"), observation(0, "")), true);
    assert.equal(isDenyToPass(recorded(DENY, "x"), observation(1, "")), true);
    assert.equal(isDenyToPass(recorded(DENY, "x"), observation(null, "")), true);
    assert.equal(isDenyToPass(recorded(0, ""), observation(DENY, "x")), false);
    assert.equal(isDenyToPass(recorded(DENY, "x"), observation(DENY, "x")), false);
  });
});

describe("ship-gate parity checkout repo key", () => {
  const line = '{"hook": "ship-gate", "outcome": "pass", "repo": "someone/keel"}';

  it("replaces the key the checkout's origin remote names", () => {
    assert.equal(withoutCheckoutRepoKey(line, "someone/keel"), '{"hook": "ship-gate", "outcome": "pass", "repo": "{{KEEL_REPO}}"}');
  });

  it("also replaces the key the fixtures were recorded with", () => {
    const recorded = '{"repo": "flareshin/keel"}\n' + line;
    assert.equal(withoutCheckoutRepoKey(recorded, "someone/keel"), '{"repo": "{{KEEL_REPO}}"}\n{"hook": "ship-gate", "outcome": "pass", "repo": "{{KEEL_REPO}}"}');
  });

  it("leaves other text alone when the checkout has no origin remote", () => {
    assert.equal(withoutCheckoutRepoKey(line, null), line);
  });
});

describe("ship-gate parity listed divergences", () => {
  const label = "gh-answer-nested-200000";

  it("lists the over-bound rows for the gh answer, the evidence file, stdin and a list command, and the python comment deletions that no longer keep evidence", () => {
    assert.deepEqual([...EXPECTED_DIVERGENCES.keys()].sort(), [
      "command-list-nested-10001", "command-list-nested-9999", "evidence-file-nested-10001", "evidence-file-nested-200000", "gh-answer-nested-10001", "gh-answer-nested-200000",
      "py-comment-deletion-python-keel-0003", "py-comment-deletion-python-keel-0469", "py-comment-deletion-python-keel-0470", "py-comment-deletion-python-keel-0474",
      "py-comment-deletion-python-keel-0475", "py-comment-deletion-python-keel-0476", "py-comment-deletion-python-keel-0477",
      "py-comment-deletion-ts-keel-0003", "py-comment-deletion-ts-keel-0469", "py-comment-deletion-ts-keel-0470", "py-comment-deletion-ts-keel-0474",
      "py-comment-deletion-ts-keel-0475", "py-comment-deletion-ts-keel-0476", "py-comment-deletion-ts-keel-0477",
      "stdin-ls-nested-10001", "stdin-ls-nested-200000", "stdin-push-nested-10001", "stdin-push-nested-200000",
    ]);
    assert.deepEqual([...new Set(EXPECTED_DIVERGENCES.values())], [DENY]);
  });

  it("accepts a listed row only when node gives the required exit, whatever python did", () => {
    assert.deepEqual(judgeCase(label, recorded(DENY, "python text"), run(DENY, "node text"), ROOT), { listed: true, problems: [] });
    assert.deepEqual(judgeCase(label, recorded(0, ""), run(DENY, "node text"), ROOT), { listed: true, problems: [] });
    const passed = judgeCase(label, recorded(DENY, "python text"), run(0, ""), ROOT);
    assert.equal(passed.listed, false);
    assert.ok(passed.problems[0]?.includes("requires node exit 2, got 0"), passed.problems.join("\n"));
  });

  it("holds an unlisted row to the strict comparison", () => {
    assert.deepEqual(judgeCase("", recorded(DENY, "same"), run(DENY, "same"), ROOT), { listed: false, problems: [] });
    assert.equal(judgeCase("", recorded(DENY, "python text"), run(DENY, "node text"), ROOT).problems.length, 1);
    assert.equal(judgeCase("other-nested-5", recorded(DENY, "python text"), run(DENY, "node text"), ROOT).problems.length, 1);
  });
});

describe("ship-gate parity with the recorded Python hook", () => {
  it("replays every payload the former Python ship-gate tests sent, and the extra ones, through node and compares the result with the recorded Python outcome", { timeout: PARITY_TIMEOUT_MS }, () => {
    const report = runShipGateParity();
    for (const line of summary(report)) console.log(line);
    for (const detail of report.details.slice(0, 10)) console.log(detail);
    assert.ok(report.cases >= MIN_CASES, `only ${report.cases} cases recorded`);
    for (const suite of ["python-keel", "ts-keel", "message-contract", "extra"]) {
      assert.ok((report.perSuite.get(suite) ?? 0) > 0, `no case recorded for ${suite}`);
    }
    assert.equal(report.listedDivergences, EXPECTED_DIVERGENCES.size, "a listed divergence row was not checked");
    assert.equal(report.denyToPass, 0, "a push or merge the recorded Python run denied passed in node");
    assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
  });
});
