import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { hookCases } from "./hook-parity-corpus.ts";
import { fineClass, HOOK_NAME, sampleCases, samplingGroup, STDIN_BYTES_GROUP, UNUSABLE_TEXT_GROUP, WRONG_TYPE_GROUP } from "./hook-parity-sample.ts";
import type { SampleCandidate } from "./hook-parity-sample.ts";
import type { HookCase, HookParityReport, Observation } from "./hook-parity.ts";
import { crashLine, differences, fullCorpusRequested, inWorkers, outcomeClasses, sandboxPaths, selectedCases, summary, withSyntaxMessageMasked } from "./hook-parity.ts";

const MIN_CASES = 150;
const MIN_SAMPLED_CASES = 400;
const DENIED = 2;
const FIRES = "data/logs/keel-fires.jsonl";
const CONFIG = "profile/config.toml";
const BASELINE: Record<string, string> = { [CONFIG]: "file:644:[features]\nhooks = true\n", data: "dir" };
const NATIVE_COVERAGE: Record<string, { file: string; markers: string[] }> = {
  [WRONG_TYPE_GROUP]: { file: "wrong-types.test.ts", markers: ["keel_partial", "replace_all", "cwd must be a string"] },
  [STDIN_BYTES_GROUP]: { file: "hook-stdin.test.ts", markers: ["INVALID_UTF8", "NOT_UTF8_REASON", "ByteOrderMark"] },
  [UNUSABLE_TEXT_GROUP]: { file: "paths.test.ts", markers: ["UNUSABLE", "\\u0000", "\\ud800"] },
};
const MIN_GROUP_CASES: Record<string, number> = { [WRONG_TYPE_GROUP]: 40, [STDIN_BYTES_GROUP]: 15, [UNUSABLE_TEXT_GROUP]: 80 };

function observed(status: number | null, stdout: string, stderr = "", files: Record<string, string> = {}): Observation {
  return { status, stdout, stderr, files };
}

describe("pre-tool-use hook against the golden snapshot of its own results", () => {
  it("decides, exits and writes as recorded for a sample of the payloads (all of them with CODEX_HOOK_PARITY_FULL=1)", async () => {
    const paths = sandboxPaths();
    const corpus = hookCases(paths);
    const selected = selectedCases(corpus, paths);
    const reports = await inWorkers<HookParityReport>("check");
    const sum = (field: "cases" | "mismatches" | "denied" | "passed"): number => reports.reduce((count, report) => count + report[field], 0);
    const [cases, mismatches] = [sum("cases"), sum("mismatches")];
    const full = fullCorpusRequested();
    console.log(summary({ cases, corpus: corpus.length, mismatches, sampled: !full }));
    assert.equal(cases, selected.length);
    assert.equal(cases < corpus.length, !full);
    assert.ok(cases >= (full ? MIN_CASES : MIN_SAMPLED_CASES), `${cases} cases`);
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

interface FireLine {
  hook?: string;
  outcome?: string;
  rule?: string;
  detail?: string;
  session?: string;
}

function firesEntry(...lines: FireLine[]): string {
  return `file:644:${lines.map((line) => (
    `{"ts": "<time>", "rule_id": "${line.rule ?? "K1"}", "hook": "${line.hook ?? "git-guard"}", "outcome": "${line.outcome ?? "deny"}", "session": "${line.session ?? "s"}", "detail": "${line.detail ?? "reason"}"}\n`
  )).join("")}`;
}

function denial(overrides: Partial<Observation> = {}): Observation {
  return { status: 0, stdout: '{"permissionDecision":"deny"}', stderr: "", files: { ...BASELINE }, ...overrides };
}

function withFiles(extra: Record<string, string>, remove: string[] = []): Observation {
  const files = { ...BASELINE, ...extra };
  for (const path of remove) delete files[path];
  return denial({ files });
}

function classOf(golden: Observation, hook = HOOK_NAME): string {
  return fineClass(hook, golden, BASELINE);
}

describe("hook parity outcome class", () => {
  const fired = (...lines: FireLine[]): Observation => withFiles({ [FIRES]: firesEntry(...lines) });

  it("tells outcomes apart by hook, exit code, stdout, stderr reason, written file and removed file", () => {
    const base = classOf(denial());
    const variants: Array<[string, string]> = [
      ["hook", classOf(denial(), "other-hook")],
      ["exit code", classOf(denial({ status: 1 }))],
      ["stdout", classOf(denial({ stdout: '{"permissionDecision":"allow"}' }))],
      ["stderr reason", classOf(denial({ stderr: "- a reason\n" }))],
      ["written file", classOf(withFiles({ "data/state/x.json": "file:644:{}" }))],
      ["changed file", classOf(withFiles({ [CONFIG]: "file:644:changed" }))],
      ["removed file", classOf(withFiles({}, [CONFIG]))],
    ];
    for (const [label, variant] of variants) assert.notEqual(variant, base, label);
  });

  it("compares the set of written files and not what they hold", () => {
    assert.equal(classOf(withFiles({ "data/state/x.json": "file:644:a" })), classOf(withFiles({ "data/state/x.json": "file:600:b" })));
  });

  it("leaves a retry hint out of the stderr reasons, however it reads, and keeps any other line", () => {
    const hinted = (hint: string): Observation => denial({ stderr: `- a reason\n${hint}` });
    assert.equal(classOf(denial({ stderr: "- a reason\n" })), classOf(hinted("Run it yourself in your terminal: cd /root/repo && git push\n")));
    assert.equal(classOf(hinted("Run it yourself: cd /root/other\n")), classOf(hinted("Run it yourself in your terminal: cd /root/repo && git push\n")));
    assert.notEqual(classOf(denial({ stderr: "- a reason\n" })), classOf(hinted("Retry it yourself: git push\n")));
  });

  it("tells fires lines apart by hook, outcome, rule and detail, and not by session", () => {
    const base = classOf(fired({}));
    const variants: Array<[string, FireLine]> = [["hook", { hook: "report-gate" }], ["outcome", { outcome: "warn" }], ["rule", { rule: "K2" }], ["detail", { detail: "another detail" }]];
    for (const [label, line] of variants) assert.notEqual(classOf(fired(line)), base, label);
    assert.equal(classOf(fired({ session: "another session" })), base);
  });

  it("looks only at the last two fires lines", () => {
    const tail: FireLine[] = [{ detail: "second to last" }, { detail: "last" }];
    assert.equal(classOf(fired({ detail: "first" }, ...tail)), classOf(fired({ detail: "second" }, ...tail)));
    assert.notEqual(classOf(fired(...tail)), classOf(fired({ detail: "last" })));
  });

  describe("masks", () => {
    const masks: Array<[string, string, string]> = [["compact timestamps", "20261023T060915Z", "20261023T060943Z"], ["hex hashes", "9b10b788", "ffc9aad2"]];
    const places: Array<[string, (mask: string) => string]> = [
      ["stdout", (mask) => classOf(denial({ stdout: `review-${mask}.json` }))],
      ["stderr", (mask) => classOf(denial({ stderr: `- expired review-${mask}.json\n` }))],
      ["fires detail", (mask) => classOf(fired({ detail: `review-${mask}.json` }))],
      ["written path", (mask) => classOf(withFiles({ [`data/review-${mask}.json`]: "file:644:x" }))],
      ["removed path", (mask) => fineClass(HOOK_NAME, denial(), { ...BASELINE, [`data/old-${mask}.json`]: "file:644:x" })],
    ];
    for (const [maskName, first, second] of masks) {
      for (const [place, classWith] of places) {
        it(`reads two ${maskName} in the ${place} as one value`, () => {
          assert.equal(classWith(first), classWith(second));
        });
      }
    }

    it("still tells apart short words that only look like a hash", () => {
      assert.notEqual(classOf(denial({ stderr: "- cafe\n" })), classOf(denial({ stderr: "- beef\n" })));
    });
  });
});

type Labeled = SampleCandidate & { label: string; outcome: string };

function candidate(label: string, name: string, outcome: string, stdin: HookCase["stdin"] = "{}"): Labeled {
  return { label, name, stdin, outcome };
}

function keptLabels(cases: Labeled[]): string[] {
  return sampleCases(cases, (sampled) => sampled.map((testCase) => testCase.outcome)).map((testCase) => testCase.label);
}

describe("hook parity sample over synthetic cases", () => {
  it("keeps the first case of each outcome class of each group, in corpus order", () => {
    const cases = [
      candidate("b", "wrong-type b", "deny"), candidate("a", "wrong-type a", "pass"), candidate("b again", "wrong-type c", "deny"),
      candidate("s", "stdin s", "deny"), candidate("s again", "stdin t", "deny"),
    ];
    assert.deepEqual(keptLabels(cases), ["b", "a", "s"]);
  });

  it("keeps the cases that belong to no group whole, and reads the classes of the others once", () => {
    const cases = [candidate("whole 1", "plain", "deny"), candidate("whole 2", "plain", "deny"), candidate("g 1", "wrong-type x", "deny"), candidate("g 2", "wrong-type y", "deny")];
    const asked: Labeled[][] = [];
    const kept = sampleCases(cases, (sampled) => {
      asked.push(sampled);
      return sampled.map((testCase) => testCase.outcome);
    });
    assert.deepEqual(kept.map((testCase) => testCase.label), ["whole 1", "whole 2", "g 1"]);
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]?.map((testCase) => testCase.label), ["g 1", "g 2"]);
  });

  it("samples each group from its own first of a class", () => {
    const cases = [candidate("wrong", "wrong-type x", "deny"), candidate("stdin", "stdin x", "deny"), candidate("nul", "nul", "deny", '{"a": "\\u0000"}')];
    assert.deepEqual(keptLabels(cases), ["wrong", "stdin", "nul"]);
  });

  it("puts a case in the wrong-type group, then the stdin group, then the group of text no path can hold", () => {
    assert.equal(samplingGroup({ name: "wrong-type cwd list", stdin: "{}" }), WRONG_TYPE_GROUP);
    assert.equal(samplingGroup({ name: "stdin ascii only with default", stdin: Buffer.from("{}") }), STDIN_BYTES_GROUP);
    assert.equal(samplingGroup({ name: "wrong-type with nul", stdin: '{"a": "\\u0000"}' }), WRONG_TYPE_GROUP);
    assert.equal(samplingGroup({ name: "stdin with nul", stdin: '{"a": "\\u0000"}' }), STDIN_BYTES_GROUP);
    assert.equal(samplingGroup({ name: "git status", stdin: '{"command": "git status"}' }), null);
  });

  it("reads a NUL or an unpaired surrogate escape as unusable text, and a paired surrogate or a raw byte as not", () => {
    const groupOfText = (text: string): string | null => samplingGroup({ name: "payload", stdin: text });
    const unusable = ['"\\u0000"', '"\\ud800"', '"\\udc80"', '"\\ud800x"', '"x\\udfff"', '"\\ud83d\\ude00 \\ud800"', '"\\ud800\\ud801"', '"\\udc80\\ud800"', '"\\uD800"', '"\\ud800\\u0041"'];
    for (const text of unusable) assert.equal(groupOfText(text), UNUSABLE_TEXT_GROUP, text);
    for (const text of ['"\\ud83d\\ude00"', '"\\u00e9"', '"\\u0001"', '"😀"']) assert.equal(groupOfText(text), null, text);
    assert.equal(samplingGroup({ name: "payload", stdin: Buffer.from([0xed, 0xa0, 0x80, 0x00]) }), null);
  });
});

describe("hook parity run selection and report", () => {
  it("replays the sample unless CODEX_HOOK_PARITY_FULL is 1", () => {
    assert.equal(fullCorpusRequested({}), false);
    assert.equal(fullCorpusRequested({ CODEX_HOOK_PARITY_FULL: "1" }), true);
    assert.equal(fullCorpusRequested({ CODEX_HOOK_PARITY_FULL: "0" }), false);
    assert.equal(fullCorpusRequested({ CODEX_HOOK_PARITY_FULL: "" }), false);
    assert.equal(fullCorpusRequested({ HOOK_PARITY_FULL: "1" }), false);
  });

  it("selects the whole corpus with the switch on and a sample of it with the switch off", () => {
    const paths = sandboxPaths();
    const corpus = hookCases(paths);
    assert.deepEqual(selectedCases(corpus, paths, true), corpus);
    const sample = selectedCases(corpus, paths, false);
    assert.ok(sample.length > 0 && sample.length < corpus.length);
    assert.ok(sample.every((testCase) => corpus.includes(testCase)));
  });

  it("reports a full run as N cases and a sampled run as N of M cases", () => {
    assert.equal(summary({ cases: 1, corpus: 1, mismatches: 0, sampled: false }), "golden: 1 cases, 0 mismatches");
    assert.equal(summary({ cases: 0, corpus: 1, mismatches: 0, sampled: true }), "golden: 0 of 1 cases (sample), 0 mismatches");
    assert.equal(summary({ cases: 3, corpus: 9, mismatches: 2, sampled: true }), "golden: 3 of 9 cases (sample), 2 mismatches");
  });
});

describe("hook parity sample over the recorded golden", () => {
  let corpus: HookCase[];
  let sample: HookCase[];
  let sampleMembers: Set<HookCase>;
  let classes: Map<HookCase, string>;
  const groupOf = (testCase: HookCase): string => samplingGroup(testCase) ?? "kept whole";
  const keyOf = (testCase: HookCase): string => `${groupOf(testCase)}\n${classes.get(testCase)}`;
  const sampledGroups = (cases: HookCase[]): HookCase[] => cases.filter((testCase) => samplingGroup(testCase) !== null);

  before(() => {
    const paths = sandboxPaths();
    corpus = hookCases(paths);
    const grouped = sampledGroups(corpus);
    const classList = outcomeClasses(grouped, paths);
    classes = new Map(grouped.map((testCase, position) => [testCase, classList[position] as string]));
    sample = selectedCases(corpus, paths, false);
    sampleMembers = new Set(sample);
  });

  it("holds enough cases in each sampled group", () => {
    assert.ok(corpus.length >= MIN_CASES, `${corpus.length} cases`);
    for (const [group, minimum] of Object.entries(MIN_GROUP_CASES)) {
      const size = corpus.filter((testCase) => samplingGroup(testCase) === group).length;
      assert.ok(size >= minimum, `${group} holds ${size} cases`);
    }
  });

  it("names a native test that covers each sampled group", () => {
    assert.deepEqual(Object.keys(NATIVE_COVERAGE).sort(), Object.keys(MIN_GROUP_CASES).sort());
    for (const [group, { file, markers }] of Object.entries(NATIVE_COVERAGE)) {
      const text = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const marker of markers) assert.ok(text.includes(marker), `${group}: ${file} does not mention ${marker}`);
    }
  });

  it("keeps every case of the groups no native test covers", () => {
    const whole = corpus.filter((testCase) => samplingGroup(testCase) === null);
    assert.ok(whole.length > 0);
    for (const testCase of whole) assert.ok(sampleMembers.has(testCase), `${testCase.name} was dropped`);
  });

  it("keeps every outcome class that the full corpus has in each sampled group, and fewer cases than the group holds", () => {
    for (const group of Object.keys(MIN_GROUP_CASES)) {
      const inGroup = (cases: HookCase[]): HookCase[] => cases.filter((testCase) => samplingGroup(testCase) === group);
      assert.deepEqual([...new Set(inGroup(sample).map(keyOf))].sort(), [...new Set(inGroup(corpus).map(keyOf))].sort(), group);
      assert.ok(inGroup(sample).length > 0 && inGroup(sample).length < inGroup(corpus).length, group);
    }
  });

  it("keeps the first case of each class, once, in corpus order", () => {
    assert.deepEqual(sample, corpus.filter((testCase) => sampleMembers.has(testCase)));
    const firstOfClass = new Map<string, HookCase>();
    for (const testCase of sampledGroups(corpus)) if (!firstOfClass.has(keyOf(testCase))) firstOfClass.set(keyOf(testCase), testCase);
    assert.deepEqual(sampledGroups(sample), [...firstOfClass.values()]);
  });
});
