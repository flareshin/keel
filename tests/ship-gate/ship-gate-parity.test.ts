import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { differencesFromRecorded } from "../recorded-cases.ts";
import type { ObservedDelta, Observation, Run } from "../recorded-cases.ts";
import { DECISION_PATH_CHANGED, EXPECTED_DIVERGENCES, isDenyToPass, judgeCase, runShipGateParity, summary, withoutCheckoutRepoKey } from "./ship-gate-parity.ts";

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

  const rowsRequiring = (code: number) => [...EXPECTED_DIVERGENCES].filter(([, required]) => required === code).map(([row]) => row).sort();

  it("lists the over-bound rows, the python comment deletions, and the rows whose JSON reading or wording changed, each with the exit node must give", () => {
    assert.deepEqual(rowsRequiring(DENY), [
      "command-list-nested-10001", "command-list-nested-9999", "evidence-file-nested-10001", "evidence-file-nested-200000", "gh-answer-nested-10001", "gh-answer-nested-200000",
      "py-comment-deletion-python-keel-0003", "py-comment-deletion-python-keel-0469", "py-comment-deletion-python-keel-0470", "py-comment-deletion-python-keel-0474",
      "py-comment-deletion-python-keel-0475", "py-comment-deletion-python-keel-0476", "py-comment-deletion-python-keel-0477",
      "py-comment-deletion-ts-keel-0003", "py-comment-deletion-ts-keel-0469", "py-comment-deletion-ts-keel-0470", "py-comment-deletion-ts-keel-0474",
      "py-comment-deletion-ts-keel-0475", "py-comment-deletion-ts-keel-0476", "py-comment-deletion-ts-keel-0477",
      "stdin-ls-nested-10001", "stdin-ls-nested-200000", "stdin-push-nested-10001", "stdin-push-nested-200000",
      "extra-0018", "extra-0025", "extra-0026", "extra-0030", "extra-0031", "extra-0035", "extra-0514", "extra-0517", "extra-0518",
      "extra-0539", "extra-0540", "extra-0549", "extra-0560", "extra-0562", "extra-0563", "extra-0565", "extra-0602", "extra-0604", "extra-0605",
      "python-keel-0119", "ts-keel-0119",
      "extra-0543", "extra-0544", "extra-0545", "extra-0548", "extra-0634", "extra-0635", "extra-0637",
      "python-keel-0027", "python-keel-0028", "python-keel-0029", "python-keel-0030", "python-keel-0031", "python-keel-0046", "python-keel-0047",
      "ts-keel-0027", "ts-keel-0028", "ts-keel-0029", "ts-keel-0030", "ts-keel-0031", "ts-keel-0046", "ts-keel-0047",
    ].sort());
    assert.deepEqual(rowsRequiring(0), [
      "extra-0019", "extra-0020", "extra-0036", "extra-0037", "extra-0041", "extra-0042", "extra-0046", "extra-0062",
      "extra-0526", "extra-0527", "extra-0531", "extra-0532", "extra-0536", "extra-0561", "extra-0564",
      "extra-0610", "extra-0632", "python-keel-0033", "ts-keel-0033",
    ].sort());
  });

  it("accepts a listed row only when node gives the required exit, whatever python did", () => {
    assert.deepEqual(judgeCase(label, recorded(DENY, "python text"), run(DENY, "node text"), ROOT), { listed: true, problems: [] });
    assert.deepEqual(judgeCase(label, recorded(0, ""), run(DENY, "node text"), ROOT), { listed: true, problems: [] });
    const passed = judgeCase(label, recorded(DENY, "python text"), run(0, ""), ROOT);
    assert.equal(passed.listed, false);
    assert.ok(passed.problems[0]?.includes("requires node exit 2, got 0"), passed.problems.join("\n"));
  });

  it("waives the rule-tag and fires check only for listed rows whose decision path changed", () => {
    assert.deepEqual([...DECISION_PATH_CHANGED].sort(), [
      "command-list-nested-10001", "command-list-nested-9999",
      "extra-0019", "extra-0020", "extra-0025", "extra-0026", "extra-0030", "extra-0031", "extra-0035",
      "extra-0036", "extra-0037", "extra-0041", "extra-0042", "extra-0046",
      "py-comment-deletion-python-keel-0470", "py-comment-deletion-python-keel-0477",
      "py-comment-deletion-ts-keel-0470", "py-comment-deletion-ts-keel-0477", "stdin-push-nested-10001",
    ]);
    for (const row of DECISION_PATH_CHANGED) assert.ok(EXPECTED_DIVERGENCES.has(row), `${row} is not a listed divergence`);
    const lostTag = judgeCase("extra-0019", recorded(0, "[K1] python text\n"), run(0, "node text\n"), ROOT);
    assert.deepEqual(lostTag, { listed: true, problems: [] });
  });

  it("still holds a listed row whose recorded exit matches to the rule tags on stderr and the rule, hook and outcome of each fire", () => {
    const fires = (rule: string) => `{"detail":"python","hook":"ship-gate","outcome":"deny","rule_id":"${rule}"}\n`;
    const firesKey = "home/.claude/state/keel-fires.jsonl";
    assert.deepEqual(judgeCase(label, recorded(DENY, "[K1] python text\n", { [firesKey]: fires("K1") }), run(DENY, "[K1] node text\n", [[firesKey, fires("K1").replace("python", "node")]]), ROOT),
      { listed: true, problems: [] });
    const lostTag = judgeCase(label, recorded(DENY, "[K1] python text\n"), run(DENY, "node text\n"), ROOT);
    assert.equal(lostTag.listed, false);
    assert.ok(lostTag.problems[0]?.includes("rule tags"), lostTag.problems.join("\n"));
    const otherRule = judgeCase(label, recorded(DENY, "", { [firesKey]: fires("K1") }), run(DENY, "", [[firesKey, fires("K2")]]), ROOT);
    assert.equal(otherRule.listed, false);
    assert.ok(otherRule.problems[0]?.includes("fires"), otherRule.problems.join("\n"));
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
