import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { textOfBlob } from "../recorded-cases.ts";
import type { ObservedDelta, Observation, Run } from "../recorded-cases.ts";
import { fullCorpusRequested, goldenOf, judgeCase, loadStore, recordedCorpus, replayedCorpus, runShipGateParity, SHARD_COUNT, shardCases, summary, withoutCheckoutRepoKey } from "./ship-gate-parity.ts";
import type { RecordedCase, RecordedStore, ShipGateParityReport } from "./ship-gate-parity.ts";
import { fineClass, maskedOutcome, sampleCorpus, samplingGroup } from "./ship-gate-parity-sample.ts";

const MIN_CASES = 800;
const MIN_RECORDED_CASES = 1500;
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
  const all = recordedCorpus();
  const corpus = replayedCorpus(false);

  it("records enough cases, some from every suite", () => {
    assert.ok(all.length >= MIN_RECORDED_CASES, `only ${all.length} cases recorded`);
    for (const suite of ["python-keel", "ts-keel", "message-contract", "extra"]) {
      assert.ok(all.some((testCase) => testCase.suite === suite), `no case recorded for ${suite}`);
    }
  });

  it("replays enough cases by default, fewer than it records, and every recorded case with the full switch", () => {
    assert.ok(corpus.length >= MIN_CASES, `only ${corpus.length} cases replayed`);
    assert.ok(corpus.length < all.length, "the default replays no fewer cases than are recorded");
    assert.deepEqual(replayedCorpus(true).map((testCase) => testCase.id), all.map((testCase) => testCase.id));
  });

  it("gives every replayed case to exactly one shard", () => {
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

const ANSWER = '{"state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "statusCheckRollup": [], "baseRefName": "main", "headRefOid": "abc"}';
const FIRES = "data/logs/keel-fires.jsonl";

function fire(outcome: string, detail: string): string {
  return JSON.stringify({ detail, hook: "ship-gate", outcome, rule_id: "K1", ts: "<ts>" });
}

function denial(stderr: string, ...fires: string[]): ObservedDelta {
  return { code: DENY, stdout: "", stderr, set: { [FIRES]: fires.join("\n") + "\n" }, removed: [] };
}

function recordedCase(id: string, suite: RecordedCase["suite"], test: string, expected: ObservedDelta, snapshot = "plain"): RecordedCase {
  return { id, suite, test, label: "", script: "hooks/ship-gate/ship-gate.ts", args: [], cwd: ROOT, stdin: "", env: 0, snapshot, expected };
}

const SYNTHETIC_STORE = {
  blobs: { answer: `t${ANSWER}`, partial: 't{"baseRefName": "main"}', stub: "t#!/bin/bash" },
  trees: {
    plain: [],
    shape: [["gh.json", "f", 0o644, "answer"]],
    partial: [["gh.json", "f", 0o644, "partial"]],
    stubbed: [["gh.json", "f", 0o644, "answer"], ["responses/failing", "f", 0o755, "stub"]],
  },
  rootLength: 0,
  envs: [],
} as unknown as RecordedStore;

describe("ship-gate parity sample over synthetic cases", () => {
  const denied = denial("[K1] denied push of feature\nRun it yourself in your terminal: cd /root && push origin feature\n", fire("deny", "chain rv-1 reviewed from 23050cb356"));
  const keptIds = (cases: RecordedCase[]): string[] => sampleCorpus(cases, SYNTHETIC_STORE).map((testCase) => testCase.id);

  it("keeps the first ts-keel case of each outcome class in each kind of native test", () => {
    const otherSpelling = denial("[K1] denied push of feature\nRun it yourself in your terminal: cd /root && push origin HEAD\n", fire("deny", "chain rv-1 reviewed from ffffffffff"));
    const otherDetail = denial("[K1] denied push of feature\n", fire("deny", "chain rv-2 is not approved"));
    const cases = [
      recordedCase("ts-1", "ts-keel", "t.Class.test_a", denied), recordedCase("ts-2", "ts-keel", "t.Class.test_b", otherSpelling),
      recordedCase("ts-3", "ts-keel", "t.Class.test_c", otherDetail), recordedCase("ts-4", "ts-keel", "t.Class.test_everySpelling_getsItsExpectedVerdict", denied),
    ];
    assert.deepEqual(keptIds(cases), ["ts-1", "ts-3", "ts-4"]);
  });

  it("tells outcome classes apart by the last two fires lines, the exit code and the written files", () => {
    const earlierFire = denial("[K1] denied push of feature\n", fire("record", "gc"), fire("deny", "chain rv-1 reviewed from 23050cb356"));
    const written = { ...denied, set: { ...denied.set, "data/state/keel/gc.stamp": "x" } };
    const passed = { ...denied, code: 0 };
    const cases = [
      recordedCase("ts-1", "ts-keel", "t.Class.test_a", denied), recordedCase("ts-2", "ts-keel", "t.Class.test_b", earlierFire),
      recordedCase("ts-3", "ts-keel", "t.Class.test_c", written), recordedCase("ts-4", "ts-keel", "t.Class.test_d", passed),
    ];
    assert.deepEqual(keptIds(cases), ["ts-1", "ts-2", "ts-3", "ts-4"]);
  });

  it("looks only at the last two fires lines", () => {
    const withEarlierFire = (detail: string): ObservedDelta => denial(denied.stderr, fire("record", detail), fire("record", "gc"), fire("deny", "chain rv-1 is not approved"));
    const cases = [recordedCase("ts-1", "ts-keel", "t.Class.test_a", withEarlierFire("first")), recordedCase("ts-2", "ts-keel", "t.Class.test_b", withEarlierFire("second"))];
    assert.deepEqual(keptIds(cases), ["ts-1"]);
  });

  it("masks compact timestamps in stderr, written paths and removed paths", () => {
    const stamped = (stamp: string): ObservedDelta => ({
      ...denied, stderr: `[K1] expired review-${stamp}.json\n`, set: { ...denied.set, [`data/review-${stamp}.json`]: "x" }, removed: [`data/old-${stamp}.json`],
    });
    const cases = [recordedCase("ts-1", "ts-keel", "t.Class.test_a", stamped("20261023T060915Z")), recordedCase("ts-2", "ts-keel", "t.Class.test_b", stamped("20261023T060943Z"))];
    assert.deepEqual(keptIds(cases), ["ts-1"]);
  });

  it("masks hex hashes in stderr, written paths and removed paths", () => {
    const hashed = (hash: string): ObservedDelta => ({
      ...denied, stderr: `[K1] expired review-${hash}.json\n`, set: { ...denied.set, [`data/review-${hash}.json`]: "x" }, removed: [`data/old-${hash}.json`],
    });
    const cases = [recordedCase("ts-1", "ts-keel", "t.Class.test_a", hashed("9b10b788")), recordedCase("ts-2", "ts-keel", "t.Class.test_b", hashed("ffc9aad2"))];
    assert.deepEqual(keptIds(cases), ["ts-1"]);
  });

  it("keeps python-keel only where its masked outcome differs from its ts-keel twin, and then keeps both", () => {
    const sameButForHashes = denial(denied.stderr, fire("deny", "chain rv-1 reviewed from 99999999aa"));
    const different = denial("[K1] denied push of feature\n", fire("deny", "chain rv-9 is not approved"));
    const cases = [
      recordedCase("py-1", "python-keel", "t.Class.test_a", sameButForHashes), recordedCase("py-2", "python-keel", "t.Class.test_b", different),
      recordedCase("ts-1", "ts-keel", "t.Class.test_a", denied), recordedCase("ts-2", "ts-keel", "t.Class.test_b", denied),
    ];
    assert.deepEqual(keptIds(cases), ["py-2", "ts-1", "ts-2"]);
  });

  it("pairs repeated test names by their order, and keeps a python-keel case that has no ts-keel twin", () => {
    const other = denial("[K1] other\n", fire("deny", "other"));
    const cases = [
      recordedCase("py-1", "python-keel", "t.Class.test_a", denied), recordedCase("py-2", "python-keel", "t.Class.test_a", other), recordedCase("py-3", "python-keel", "t.Class.test_lonely", denied),
      recordedCase("ts-1", "ts-keel", "t.Class.test_a", denied), recordedCase("ts-2", "ts-keel", "t.Class.test_a", denied),
    ];
    assert.deepEqual(keptIds(cases), ["py-2", "py-3", "ts-1", "ts-2"]);
  });

  it("keeps the groups no native test covers whole", () => {
    const cases = [
      recordedCase("ex-1", "extra", "malformed_payloads", denied), recordedCase("ex-2", "extra", "malformed_payloads", denied),
      recordedCase("mc-1", "message-contract", "t.Class.test_a", denied), recordedCase("mc-2", "message-contract", "t.Class.test_a", denied),
      recordedCase("ex-3", "extra", "merge_spellings", denied, "partial"), recordedCase("ex-4", "extra", "merge_spellings", denied, "partial"),
      recordedCase("ex-5", "extra", "merge_spellings", denied, "stubbed"), recordedCase("ex-6", "extra", "merge_spellings", denied, "stubbed"),
    ];
    assert.deepEqual(keptIds(cases), cases.map((testCase) => testCase.id));
  });

  it("samples the merge_spellings gh answer shapes, which carry the seven standard fields and no stub responses", () => {
    const cases = [recordedCase("ex-1", "extra", "merge_spellings", denied, "shape"), recordedCase("ex-2", "extra", "merge_spellings", denied, "shape")];
    assert.equal(samplingGroup(cases[0] as RecordedCase, SYNTHETIC_STORE), "extra:gh-answer-shapes");
    assert.deepEqual(keptIds(cases), ["ex-1"]);
  });
});

describe("ship-gate parity run selection and report", () => {
  const report = (overrides: Partial<ShipGateParityReport>): ShipGateParityReport => ({ cases: 1, recorded: 1, sampled: false, mismatches: 0, perSuite: new Map(), details: [], ...overrides });

  it("replays the sample unless SHIP_GATE_PARITY_FULL is 1", () => {
    assert.equal(fullCorpusRequested({}), false);
    assert.equal(fullCorpusRequested({ SHIP_GATE_PARITY_FULL: "1" }), true);
    assert.equal(fullCorpusRequested({ SHIP_GATE_PARITY_FULL: "0" }), false);
    assert.equal(fullCorpusRequested({ SHIP_GATE_PARITY_FULL: "" }), false);
  });

  it("reports a full run as N cases and a sampled run as N of M cases", () => {
    assert.deepEqual(summary(report({})), ["golden: 1 cases, 0 mismatches"]);
    assert.deepEqual(summary(report({ cases: 0, sampled: true })), ["golden: 0 of 1 cases (sample), 0 mismatches"]);
    assert.deepEqual(summary(report({ cases: 3, recorded: 9, sampled: true, mismatches: 2 })), ["golden: 3 of 9 cases (sample), 2 mismatches"]);
  });

  it("reads a text blob and leaves a binary blob to its reader", () => {
    assert.equal(textOfBlob("tabc"), "abc");
    assert.equal(textOfBlob("bYWJj"), undefined);
  });

  describe("with SHIP_GATE_PARITY_CASES", () => {
    const sampledOut = recordedCorpus().find((testCase) => !replayedCorpus(false).some((kept) => kept.id === testCase.id)) as RecordedCase;

    function withCasesFilter<T>(pattern: string, action: () => T): T {
      const previous = process.env["SHIP_GATE_PARITY_CASES"];
      process.env["SHIP_GATE_PARITY_CASES"] = pattern;
      try {
        return action();
      } finally {
        if (previous === undefined) delete process.env["SHIP_GATE_PARITY_CASES"];
        else process.env["SHIP_GATE_PARITY_CASES"] = previous;
      }
    }

    it("fails and names the full switch when the filter matches only cases the sample dropped", () => {
      assert.ok(sampledOut, "the sample dropped no case");
      assert.throws(() => withCasesFilter(`^${sampledOut.id}$`, () => runShipGateParity(undefined, undefined, false)), /matches 1 recorded cases.*SHIP_GATE_PARITY_FULL=1/);
    });

    it("replays nothing and does not fail when the filter matches no recorded case", () => {
      const result = withCasesFilter("^no-such-case$", () => runShipGateParity(undefined, undefined, false));
      assert.equal(result.cases, 0);
      assert.equal(result.recorded, 0);
    });
  });
});

describe("ship-gate parity sample over the recorded golden", () => {
  const all = recordedCorpus();
  const store = loadStore();
  const sample = sampleCorpus(all, store);
  const keptIds = new Set(sample.map((testCase) => testCase.id));
  const twinOf = (testCase: RecordedCase): RecordedCase => all.find((candidate) => candidate.id === testCase.id.replace("python-keel", "ts-keel")) as RecordedCase;
  const classesOf = (cases: RecordedCase[]): string[] => [...new Set(cases.map((testCase) => `${samplingGroup(testCase, store)}\n${fineClass(testCase.expected)}`))].sort();

  it("keeps every outcome class that the full corpus has", () => {
    const classes = (cases: RecordedCase[]): string[] => [...new Set(cases.map((testCase) => fineClass(testCase.expected)))].sort();
    assert.deepEqual(classes(sample), classes(all));
  });

  it("keeps every outcome class of each sampled group, and fewer cases than the groups hold", () => {
    const sampledGroups = (cases: RecordedCase[]): RecordedCase[] => cases.filter((testCase) => samplingGroup(testCase, store) !== null);
    assert.deepEqual(classesOf(sampledGroups(sample)), classesOf(sampledGroups(all)));
    assert.ok(sampledGroups(sample).length < sampledGroups(all).length);
  });

  it("keeps every case of the groups no native test covers", () => {
    for (const testCase of all.filter((candidate) => candidate.suite !== "python-keel" && samplingGroup(candidate, store) === null)) {
      assert.ok(keptIds.has(testCase.id), `${testCase.id} (${testCase.test}) was dropped`);
    }
  });

  it("keeps a python-keel case exactly when it differs from its ts-keel twin, and keeps the twin too", () => {
    const pythonCases = all.filter((testCase) => testCase.suite === "python-keel");
    assert.ok(pythonCases.length > 0);
    for (const testCase of pythonCases) {
      const twin = twinOf(testCase);
      assert.equal(twin.test, testCase.test, `${testCase.id} has no twin of the same test`);
      const differs = maskedOutcome(testCase.expected) !== maskedOutcome(twin.expected);
      assert.equal(keptIds.has(testCase.id), differs, testCase.id);
      if (differs) assert.ok(keptIds.has(twin.id), `${twin.id} is the twin of ${testCase.id}`);
    }
  });

  it("is the same sample every time, in corpus order", () => {
    assert.deepEqual(sampleCorpus(all, store).map((testCase) => testCase.id), sample.map((testCase) => testCase.id));
    assert.deepEqual(sample.map((testCase) => testCase.id), all.filter((testCase) => keptIds.has(testCase.id)).map((testCase) => testCase.id));
  });
});
