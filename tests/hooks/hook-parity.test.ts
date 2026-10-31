import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import type { Observation, ObservedDelta, Run } from "../recorded-cases.ts";
import { GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT, SHIP_GATE } from "./helpers.ts";
import { adversarialInputDigest, FIXTURE_DIRECTORY, fullCorpusRequested, goldenOf, judgeCase, runParity, summary, withCorpus } from "./hook-parity.ts";
import type { ParityReport, RecordedAdversarial } from "./hook-parity.ts";
import { buildAdversarialSet } from "./hook-parity-adversarial.ts";
import { jsonLimitCases } from "./hook-parity-json-limits.ts";
import { fineClass, sampleCases, samplingGroup } from "./hook-parity-sample.ts";
import type { SampleCandidate } from "./hook-parity-sample.ts";
import { wrongTypeCases } from "./hook-parity-wrong-types.ts";

const MIN_RECORDED_CASES = 300;
const MIN_ADVERSARIAL_CASES = 50;
const MIN_SAMPLED_RECORDED_CASES = 100;
const MIN_SAMPLED_ADVERSARIAL_CASES = 300;
const MIN_WRONG_TYPE_CASES = 400;
const PARITY_TIMEOUT_MS = 30 * 60_000;
const HOOK_ENTRIES = [GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT, SHIP_GATE];
const DENY = 2;
const ROOT = "/root";
const FIRES = "data/logs/keel-fires.jsonl";
const DECODE_MASKED = "<JSON syntax error message>";

function fire(detail: string): string {
  return `{"ts": "<ts>", "rule_id": "K2", "hook": "report-gate", "outcome": "error", "session": "s", "detail": "${detail}"}\n`;
}

function recorded(code: number, stderr: string, fires = "", overrides: Partial<ObservedDelta> = {}): ObservedDelta {
  return { code, stdout: "", stderr, set: fires === "" ? {} : { [FIRES]: fires }, removed: [], ...overrides };
}

function run(code: number | null, stderr: string, fires = ""): Run {
  const observation: Observation = { code, stdout: "", stderr, files: new Map(fires === "" ? [] : [[FIRES, fires]]) };
  return { observation, initial: new Map() };
}

describe("hook parity with the golden snapshot of the node hooks", () => {
  it("replays a sample of the recorded runs of the former Python hook tests and the adversarial payloads (all of them with HOOK_PARITY_FULL=1) through node and compares stdout, stderr, exit code and every file outside .git and remotes against the golden outcome", { timeout: PARITY_TIMEOUT_MS }, () => {
    const report = runParity();
    console.log(summary(report));
    const full = fullCorpusRequested();
    const recordedCases = report.cases - report.adversarial;
    assert.ok(recordedCases >= (full ? MIN_RECORDED_CASES : MIN_SAMPLED_RECORDED_CASES), `only ${recordedCases} cases replayed`);
    assert.ok(report.adversarial >= (full ? MIN_ADVERSARIAL_CASES : MIN_SAMPLED_ADVERSARIAL_CASES), `only ${report.adversarial} adversarial cases replayed`);
    assert.equal(report.sampled, !full);
    assert.equal(report.cases < report.corpus, !full);
    for (const entry of HOOK_ENTRIES) assert.ok((report.perHook.get(entry) ?? 0) > 0, `no case recorded for ${entry}`);
    assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
  });
});

describe("hook parity comparison", () => {
  it("reports a difference in exit code, stderr or a written file", () => {
    const denied = recorded(DENY, "[K1] git-guard: blocked\n");
    assert.deepEqual(judgeCase(denied, run(DENY, "[K1] git-guard: blocked\n"), ROOT), []);
    assert.equal(judgeCase(denied, run(0, "[K1] git-guard: blocked\n"), ROOT).length, 1);
    assert.equal(judgeCase(denied, run(DENY, "[K1] git-guard: blocked.\n"), ROOT).length, 1);
    assert.equal(judgeCase(recorded(0, "", fire("x")), run(0, "", fire("y")), ROOT).length, 1);
    assert.equal(judgeCase(recorded(0, ""), run(0, "", fire("x")), ROOT).length, 1);
  });

  it("names the recorded side golden in a difference", () => {
    assert.deepEqual(judgeCase(recorded(DENY, "old"), run(DENY, "new"), ROOT), ['stderr: golden "old" / node "new"']);
  });

  it("reports a recorded deny that node lets through as a difference", () => {
    assert.equal(judgeCase(recorded(DENY, "x"), run(0, "x"), ROOT).length, 1);
    assert.equal(judgeCase(recorded(DENY, "x"), run(null, "x"), ROOT).length, 1);
  });

  it("ignores the wording of a JSON syntax error in a fire detail, which differs between node versions", () => {
    const syntax = recorded(0, "", fire(`JsonSyntaxError: ${DECODE_MASKED}`));
    assert.deepEqual(judgeCase(syntax, run(0, "", fire("JsonSyntaxError: Expected property name or '}' in JSON at position 1")), ROOT), []);
    const payload = recorded(0, "", fire(`payload is not JSON: ${DECODE_MASKED}`));
    assert.deepEqual(judgeCase(payload, run(0, "", fire("payload is not JSON: Unexpected end of JSON input")), ROOT), []);
  });

  it("still compares a fire detail that is not a JSON syntax error", () => {
    const golden = recorded(0, "", fire("hook payload is not a JSON object"));
    assert.equal(judgeCase(golden, run(0, "", fire("hook payload is not an object")), ROOT).length, 1);
  });
});

describe("hook parity golden recording", () => {
  const observed = run(DENY, `denied in ${ROOT}/repo\n`, fire("JsonSyntaxError: Unexpected end of JSON input"));

  it("tokenizes the run's paths and masks its decode wording", () => {
    const golden = goldenOf(observed, ROOT);
    assert.equal(golden.stderr, "denied in {{ROOT}}/repo\n");
    assert.equal(golden.set[FIRES], fire(`JsonSyntaxError: ${DECODE_MASKED}`));
  });

  it("compares equal to the run it was recorded from", () => {
    assert.deepEqual(judgeCase(goldenOf(observed, ROOT), observed, ROOT), []);
  });
});

describe("hook parity wrong-type payloads", () => {
  it("records the golden outcome of every wrong-type payload", () => {
    const adversarial = buildAdversarialSet();
    try {
      const golden = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "adversarial.json"), "utf8")) as Record<string, RecordedAdversarial>;
      const wrongType = adversarial.cases.filter((adversarialCase) => adversarialCase.name.includes("wrong-type"));
      assert.ok(wrongType.length >= MIN_WRONG_TYPE_CASES, `${wrongType.length} wrong-type payloads`);
      for (const adversarialCase of wrongType) {
        assert.equal(golden[adversarialCase.name]?.input, adversarialInputDigest(adversarialCase, adversarial.sandbox.root), adversarialCase.name);
      }
    } finally {
      adversarial.sandbox.close();
    }
  });
});

const RENAMED_NATIVE_TESTS: Record<string, string> = {
  status_reportsNoResumePoint_whenOnlyAutoSnapshot: "status_reportsNoResumePoint_whenOnlyAutoSnapshotFromAnOlderVersion",
};
const GIT_GUARD_FIRE = '{"ts": "<ts>", "rule_id": "K1", "hook": "git-guard", "outcome": "deny", "session": "s", "detail": "reason"}\n';
const BLOCKED = "[K1] git-guard: blocked\n- [K1] reason\n";
const RETRY_HINT = "Run it yourself in your terminal: cd /root/repo && git push\n";

interface FireLine {
  hook?: string;
  outcome?: string;
  rule?: string;
  detail?: string;
  session?: string;
}

function firesLog(...lines: FireLine[]): string {
  return lines.map((line) => (
    `{"ts": "<ts>", "rule_id": "${line.rule ?? "K1"}", "hook": "${line.hook ?? "git-guard"}", "outcome": "${line.outcome ?? "deny"}", "session": "${line.session ?? "s"}", "detail": "${line.detail ?? "reason"}"}\n`
  )).join("");
}

function recordedCase(test: string, script: string, expected: ObservedDelta | undefined): SampleCandidate {
  return expected === undefined ? { test, script } : { test, script, expected };
}

function adversarialCase(test: string, script: string, expected: ObservedDelta | undefined): SampleCandidate {
  return { ...recordedCase(test, script, expected), input: "digest" };
}

function keptTests(cases: SampleCandidate[]): string[] {
  return sampleCases(cases).map((testCase) => testCase.test);
}

describe("hook parity sample over synthetic cases", () => {
  const denied = recorded(DENY, BLOCKED, GIT_GUARD_FIRE);

  it("keeps the first recorded case of each outcome class of each hook", () => {
    const cases = [
      recordedCase("first", GIT_GUARD, denied), recordedCase("repeat", GIT_GUARD, denied),
      recordedCase("other hook", ENV_PREFLIGHT, denied), recordedCase("other hook repeat", ENV_PREFLIGHT, denied),
      recordedCase("other reason", GIT_GUARD, recorded(DENY, "[K1] git-guard: blocked\n- [K1] other reason\n", GIT_GUARD_FIRE)),
    ];
    assert.deepEqual(keptTests(cases), ["first", "other hook", "other reason"]);
  });

  it("tells outcome classes apart by exit code, stdout, stderr reason, written file and removed file", () => {
    const variants: Array<[string, ObservedDelta]> = [
      ["exit code", recorded(0, BLOCKED, GIT_GUARD_FIRE)],
      ["stdout", recorded(DENY, BLOCKED, GIT_GUARD_FIRE, { stdout: '{"decision": "block"}' })],
      ["stderr reason", recorded(DENY, `${BLOCKED}- [K2] a second reason\n`, GIT_GUARD_FIRE)],
      ["written file", { ...denied, set: { ...denied.set, "data/state/x.json": "{}" } }],
      ["removed file", { ...denied, removed: ["data/handoff/x.md"] }],
    ];
    for (const [label, variant] of variants) {
      assert.deepEqual(keptTests([recordedCase("base", GIT_GUARD, denied), recordedCase(label, GIT_GUARD, variant)]), ["base", label], label);
    }
  });

  it("compares the set of written files and not what they hold", () => {
    const otherContent = recorded(DENY, BLOCKED, firesLog({ session: "another session" }));
    assert.deepEqual(keptTests([recordedCase("base", GIT_GUARD, denied), recordedCase("other content", GIT_GUARD, otherContent)]), ["base"]);
  });

  it("leaves a retry hint out of the stderr reasons, however it reads, and keeps any other line", () => {
    const hinted = (hint: string): ObservedDelta => recorded(DENY, BLOCKED + hint, GIT_GUARD_FIRE);
    const cases = [
      recordedCase("no hint", GIT_GUARD, denied), recordedCase("hint", GIT_GUARD, hinted(RETRY_HINT)),
      recordedCase("other hint", GIT_GUARD, hinted("Run it yourself in your terminal: cd /root/other && git push --force\n")),
    ];
    assert.deepEqual(keptTests(cases), ["no hint"]);
    assert.deepEqual(keptTests([recordedCase("other line", GIT_GUARD, hinted("Retry it yourself: git push\n")), recordedCase("none", GIT_GUARD, denied)]), ["other line", "none"]);
  });

  it("looks only at the last two fires lines", () => {
    const tail: FireLine[] = [{ detail: "second to last" }, { detail: "last" }];
    const withEarlier = (detail: string): ObservedDelta => recorded(DENY, BLOCKED, firesLog({ detail }, ...tail));
    assert.deepEqual(keptTests([recordedCase("first", GIT_GUARD, withEarlier("first")), recordedCase("second", GIT_GUARD, withEarlier("second"))]), ["first"]);
    const twoLines = recorded(DENY, BLOCKED, firesLog(...tail));
    const oneLine = recorded(DENY, BLOCKED, firesLog({ detail: "last" }));
    assert.deepEqual(keptTests([recordedCase("two lines", GIT_GUARD, twoLines), recordedCase("one line", GIT_GUARD, oneLine)]), ["two lines", "one line"]);
  });

  it("tells fires lines apart by hook, outcome, rule and detail, and not by session", () => {
    const fires = (line: FireLine): ObservedDelta => recorded(DENY, BLOCKED, firesLog(line));
    const variants: Array<[string, FireLine]> = [["hook", { hook: "report-gate" }], ["outcome", { outcome: "warn" }], ["rule", { rule: "K2" }], ["detail", { detail: "another detail" }]];
    for (const [label, line] of variants) {
      assert.deepEqual(keptTests([recordedCase("base", GIT_GUARD, fires({})), recordedCase(label, GIT_GUARD, fires(line))]), ["base", label], label);
    }
    assert.deepEqual(keptTests([recordedCase("base", GIT_GUARD, fires({})), recordedCase("session", GIT_GUARD, fires({ session: "another" }))]), ["base"]);
  });

  describe("masks", () => {
    const masks: Array<[string, string, string]> = [["compact timestamps", "20261023T060915Z", "20261023T060943Z"], ["hex hashes", "9b10b788", "ffc9aad2"]];
    const places: Array<[string, (mask: string) => ObservedDelta]> = [
      ["stdout", (mask) => recorded(DENY, BLOCKED, GIT_GUARD_FIRE, { stdout: `review-${mask}.json` })],
      ["stderr", (mask) => recorded(DENY, `${BLOCKED}- [K1] expired review-${mask}.json\n`, GIT_GUARD_FIRE)],
      ["fires detail", (mask) => recorded(DENY, BLOCKED, firesLog({ detail: `review-${mask}.json` }))],
      ["written path", (mask) => ({ ...denied, set: { ...denied.set, [`data/review-${mask}.json`]: "x" } })],
      ["removed path", (mask) => ({ ...denied, removed: [`data/old-${mask}.json`] })],
    ];
    for (const [maskName, first, second] of masks) {
      for (const [place, expectedWith] of places) {
        it(`reads two ${maskName} in the ${place} as one value`, () => {
          assert.deepEqual(keptTests([recordedCase("first", GIT_GUARD, expectedWith(first)), recordedCase("second", GIT_GUARD, expectedWith(second))]), ["first"]);
        });
      }
    }

    it("still tells apart short words that only look like a hash", () => {
      const word = (text: string): ObservedDelta => recorded(DENY, `${BLOCKED}- [K1] ${text}\n`, GIT_GUARD_FIRE);
      assert.deepEqual(keptTests([recordedCase("cafe", GIT_GUARD, word("cafe")), recordedCase("beef", GIT_GUARD, word("beef"))]), ["cafe", "beef"]);
    });
  });

  it("samples the recorded cases and the wrong-type payloads apart, each from its own first of a class", () => {
    const cases = [
      recordedCase("recorded", GIT_GUARD, denied), adversarialCase("git-guard wrong-type command number#0", GIT_GUARD, denied),
      adversarialCase("git-guard wrong-type command list#0", GIT_GUARD, denied), recordedCase("recorded again", GIT_GUARD, denied),
    ];
    assert.deepEqual(keptTests(cases), ["recorded", "git-guard wrong-type command number#0"]);
  });

  it("keeps the adversarial payloads that are not wrong-type whole", () => {
    const cases = [
      adversarialCase("git-guard command 0#0", GIT_GUARD, denied), adversarialCase("git-guard command 0#1", GIT_GUARD, denied),
      adversarialCase("git-guard denying command over-limit integer", GIT_GUARD, denied), adversarialCase("git-guard denying command over-limit integer", GIT_GUARD, denied),
    ];
    assert.deepEqual(keptTests(cases), cases.map((testCase) => testCase.test));
  });

  it("keeps a case with no golden outcome, so that the replay reports it", () => {
    const cases = [adversarialCase("git-guard wrong-type a", GIT_GUARD, undefined), adversarialCase("git-guard wrong-type b", GIT_GUARD, undefined), recordedCase("recorded", GIT_GUARD, undefined)];
    assert.deepEqual(keptTests(cases), ["git-guard wrong-type a", "git-guard wrong-type b", "recorded"]);
  });

  it("puts a case without an input digest in the recorded group and names the wrong-type payloads by their name", () => {
    assert.equal(samplingGroup({ test: "test_git_guard.AttributionTest.test_x" }), "recorded");
    assert.equal(samplingGroup({ test: "git-guard wrong-type command number#0", input: "digest" }), "wrong-type");
    assert.equal(samplingGroup({ test: "git-guard command 0#0", input: "digest" }), null);
    assert.equal(samplingGroup({ test: "model-assign tool_input 3000-deep arrays", input: "digest" }), null);
  });

  it("keeps the cases it samples in corpus order", () => {
    const cases = [
      recordedCase("b", GIT_GUARD, recorded(0, "b")), recordedCase("a", GIT_GUARD, recorded(0, "a")), recordedCase("b again", GIT_GUARD, recorded(0, "b")),
      adversarialCase("kept whole", GIT_GUARD, denied),
    ];
    assert.deepEqual(keptTests(cases), ["b", "a", "kept whole"]);
  });

  it("builds an outcome class from the hook and the masked outcome", () => {
    assert.notEqual(fineClass(GIT_GUARD, denied), fineClass(ENV_PREFLIGHT, denied));
    assert.equal(fineClass(GIT_GUARD, denied), fineClass(GIT_GUARD, { ...denied, stderr: denied.stderr + RETRY_HINT }));
  });
});

describe("hook parity run selection and report", () => {
  const report = (overrides: Partial<ParityReport>): ParityReport => ({ cases: 1, corpus: 1, sampled: false, adversarial: 0, mismatches: 0, perHook: new Map(), details: [], ...overrides });

  it("replays the sample unless HOOK_PARITY_FULL is 1", () => {
    assert.equal(fullCorpusRequested({}), false);
    assert.equal(fullCorpusRequested({ HOOK_PARITY_FULL: "1" }), true);
    assert.equal(fullCorpusRequested({ HOOK_PARITY_FULL: "0" }), false);
    assert.equal(fullCorpusRequested({ HOOK_PARITY_FULL: "" }), false);
  });

  it("reports a full run as N cases and a sampled run as N of M cases", () => {
    assert.equal(summary(report({})), "golden: 1 cases, 0 mismatches");
    assert.equal(summary(report({ cases: 0, sampled: true })), "golden: 0 of 1 cases (sample), 0 mismatches");
    assert.equal(summary(report({ cases: 3, corpus: 9, sampled: true, mismatches: 2 })), "golden: 3 of 9 cases (sample), 2 mismatches");
  });
});

describe("hook parity sample over the recorded golden", () => {
  const nativeTests = readdirSync(import.meta.dirname).filter((name) => name.endsWith(".test.ts") && !name.startsWith("hook-parity")).map((name) => readFileSync(join(import.meta.dirname, name), "utf8")).join("\n");
  let corpus: SampleCandidate[];
  let sample: SampleCandidate[];
  let sampleMembers: Set<SampleCandidate>;
  const groupOf = (testCase: SampleCandidate): string => samplingGroup(testCase) ?? "kept whole";
  const classOf = (testCase: SampleCandidate): string => `${groupOf(testCase)}\n${fineClass(testCase.script, testCase.expected as ObservedDelta)}`;
  const sampledGroups = (cases: SampleCandidate[]): SampleCandidate[] => cases.filter((testCase) => samplingGroup(testCase) !== null);

  before(() => {
    corpus = withCorpus((cases) => cases.map(({ test, script, input, expected }) => ({ test, script, ...(input === undefined ? {} : { input }), ...(expected === undefined ? {} : { expected }) })));
    sample = sampleCases(corpus);
    sampleMembers = new Set(sample);
  });

  it("records enough cases, some for every hook", () => {
    const recordedCases = corpus.filter((testCase) => testCase.input === undefined);
    assert.ok(recordedCases.length >= MIN_RECORDED_CASES, `only ${recordedCases.length} cases recorded`);
    assert.ok(corpus.length - recordedCases.length >= MIN_ADVERSARIAL_CASES, `only ${corpus.length - recordedCases.length} adversarial cases`);
    for (const entry of [GIT_GUARD, HANDOFF, MODEL_ASSIGN, REPORT_GATE, ENV_PREFLIGHT]) assert.ok(recordedCases.some((testCase) => testCase.script === entry), `no case recorded for ${entry}`);
  });

  it("has a golden outcome for every case", () => {
    assert.deepEqual(corpus.filter((testCase) => testCase.expected === undefined).map((testCase) => testCase.test), []);
  });

  it("samples only recorded cases whose source test a native test of the same name covers", () => {
    for (const testCase of corpus.filter((candidate) => samplingGroup(candidate) === "recorded")) {
      const method = testCase.test.slice(testCase.test.lastIndexOf(".") + 1).replace(/^test_/, "");
      assert.ok(nativeTests.includes(`"${RENAMED_NATIVE_TESTS[method] ?? method}"`), `${testCase.test} has no native test`);
    }
  });

  it("names the wrong-type group by the cases wrongTypeCases builds and no other", () => {
    const adversarial = buildAdversarialSet();
    try {
      const wrongType = new Set(wrongTypeCases(adversarial.sandbox, adversarial.sandbox.root).map((adversarialCase) => adversarialCase.name));
      assert.ok(wrongType.size >= MIN_WRONG_TYPE_CASES, `${wrongType.size} wrong-type payloads`);
      for (const adversarialCase of adversarial.cases) {
        assert.equal(samplingGroup({ test: adversarialCase.name, input: "digest" }) === "wrong-type", wrongType.has(adversarialCase.name), adversarialCase.name);
      }
      const jsonLimits = jsonLimitCases(adversarial.sandbox, adversarial.sandbox.root);
      assert.ok(jsonLimits.length > 0);
      for (const adversarialCase of jsonLimits) assert.equal(samplingGroup({ test: adversarialCase.name, input: "digest" }), null, adversarialCase.name);
    } finally {
      adversarial.sandbox.close();
    }
  });

  it("keeps every outcome class that the full corpus has in each sampled group, and fewer cases than the groups hold", () => {
    assert.deepEqual([...new Set(sampledGroups(sample).map(classOf))].sort(), [...new Set(sampledGroups(corpus).map(classOf))].sort());
    for (const group of ["recorded", "wrong-type"]) {
      const inGroup = (cases: SampleCandidate[]): SampleCandidate[] => cases.filter((testCase) => samplingGroup(testCase) === group);
      assert.ok(inGroup(sample).length > 0 && inGroup(sample).length < inGroup(corpus).length, group);
    }
  });

  it("keeps every case of the groups no native test covers", () => {
    const whole = corpus.filter((testCase) => samplingGroup(testCase) === null);
    assert.ok(whole.length > 0);
    for (const testCase of whole) assert.ok(sampleMembers.has(testCase), `${testCase.test} was dropped`);
  });

  it("keeps every outcome class that the full corpus has", () => {
    assert.deepEqual([...new Set(sample.map(classOf))].sort(), [...new Set(corpus.map(classOf))].sort());
  });

  it("keeps the first case of each class, once, in corpus order", () => {
    assert.deepEqual(sample, corpus.filter((testCase) => sampleMembers.has(testCase)));
    const firstOfClass = new Map<string, SampleCandidate>();
    for (const testCase of sampledGroups(corpus)) if (!firstOfClass.has(classOf(testCase))) firstOfClass.set(classOf(testCase), testCase);
    assert.deepEqual(sampledGroups(sample), [...firstOfClass.values()]);
  });
});
