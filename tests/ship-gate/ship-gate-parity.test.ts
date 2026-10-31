import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import type { ObservedDelta, Observation, Run } from "../recorded-cases.ts";
import { goldenOf, judgeCase, recordedCorpus, SHARD_COUNT, shardCases, withoutCheckoutRepoKey } from "./ship-gate-parity.ts";

const MIN_CASES = 600;
const SHARD_FILE = /^ship-gate-parity-shard-\d+\.test\.ts$/;
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
    assert.deepEqual(judgeCase(denied, run(DENY, "[K1] ship-gate: denied"), ROOT), []);
    assert.equal(judgeCase(denied, run(0, "[K1] ship-gate: denied"), ROOT).length, 1);
    assert.equal(judgeCase(denied, run(DENY, "[K1] ship-gate: denied."), ROOT).length, 1);
    assert.equal(judgeCase(recorded(0, "", { "data/a": "x" }), run(0, "", [["data/a", "y"]]), ROOT).length, 1);
    assert.equal(judgeCase(recorded(0, ""), run(0, "", [["data/a", "x"]]), ROOT).length, 1);
  });

  it("names the recorded side golden in a difference", () => {
    assert.deepEqual(judgeCase(recorded(DENY, "old"), run(DENY, "new"), ROOT), ['stderr: golden "old" / node "new"']);
  });

  it("reports a recorded deny that node lets through as a difference", () => {
    assert.equal(judgeCase(recorded(DENY, "x"), run(0, "x"), ROOT).length, 1);
    assert.equal(judgeCase(recorded(DENY, "x"), run(null, "x"), ROOT).length, 1);
  });

  it("ignores the wording of a JSON syntax error, which differs between node versions", () => {
    const golden = recorded(0, "ship-gate: internal error: JsonSyntaxError: <JSON syntax error message>\n");
    assert.deepEqual(judgeCase(golden, run(0, "ship-gate: internal error: JsonSyntaxError: Expected property name or '}' in JSON at position 1\n"), ROOT), []);
  });
});

describe("ship-gate parity golden recording", () => {
  const observed = run(DENY, `denied in ${ROOT}/repo: JsonSyntaxError: Unexpected end of JSON input\n`, [["repo/kept", `at ${ROOT}/repo`]]);

  it("tokenizes the run's paths and masks its decode wording", () => {
    const golden = goldenOf(observed, ROOT);
    assert.equal(golden.stderr, "denied in {{ROOT}}/repo: JsonSyntaxError: <JSON syntax error message>\n");
    assert.deepEqual(golden.set, { "repo/kept": "at {{ROOT}}/repo" });
  });

  it("compares equal to the run it was recorded from", () => {
    assert.deepEqual(judgeCase(goldenOf(observed, ROOT), observed, ROOT), []);
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

describe("ship-gate parity recorded corpus", () => {
  const corpus = recordedCorpus();

  it("holds enough cases, some from every suite", () => {
    assert.ok(corpus.length >= MIN_CASES, `only ${corpus.length} cases recorded`);
    for (const suite of ["python-keel", "ts-keel", "message-contract", "extra"]) {
      assert.ok(corpus.some((testCase) => testCase.suite === suite), `no case recorded for ${suite}`);
    }
  });

  it("gives every case to exactly one shard", () => {
    const shares = Array.from({ length: SHARD_COUNT }, (_unused, index) => shardCases(corpus, { index, count: SHARD_COUNT }));
    assert.equal(shares.reduce((total, share) => total + share.length, 0), corpus.length);
    assert.equal(new Set(shares.flat().map((testCase) => testCase.id)).size, corpus.length);
    assert.ok(shares.every((share) => share.length > 0), "a shard replays no case");
  });

  it("has one shard test file for each shard", () => {
    const files = readdirSync(import.meta.dirname).filter((name) => SHARD_FILE.test(name)).sort();
    const expected = Array.from({ length: SHARD_COUNT }, (_unused, index) => `ship-gate-parity-shard-${index + 1}.test.ts`).sort();
    assert.deepEqual(files, expected);
  });
});
