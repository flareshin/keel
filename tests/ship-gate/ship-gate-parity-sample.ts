import { isJsonObject } from "../../measure/lib/measurekit/json.ts";
import { textOfBlob } from "../recorded-cases.ts";
import type { ObservedDelta } from "../recorded-cases.ts";
import { firesTail, masked, stderrReasons } from "../recorded-sample.ts";
import type { RecordedCase, RecordedStore } from "./ship-gate-parity.ts";

const SPELLINGS_TEST = "test_everySpelling_getsItsExpectedVerdict";
const BUNDLE_TEST = "test_gateSpellings_pass_whenABundleCoversTheBranch";
const MERGE_SPELLINGS_TEST = "merge_spellings";
const GH_ANSWER_FILE = "gh.json";
const GH_STUB_DIRECTORY = "responses/";
const GH_ANSWER_FIELDS = ["state", "isDraft", "mergeable", "mergeStateStatus", "statusCheckRollup", "baseRefName", "headRefOid"];

export function sampleCorpus(cases: readonly RecordedCase[], store: RecordedStore): RecordedCase[] {
  const diverging = divergingCases(cases);
  const seenClasses = new Set<string>();
  return cases.filter((testCase) => {
    if (testCase.suite === "python-keel") return diverging.has(testCase);
    const group = samplingGroup(testCase, store);
    if (group === null) return true;
    const classKey = `${group}\n${fineClass(testCase.expected)}`;
    const firstOfClass = !seenClasses.has(classKey);
    seenClasses.add(classKey);
    return firstOfClass || diverging.has(testCase);
  });
}

export function fineClass(expected: ObservedDelta): string {
  const writtenPaths = Object.keys(expected.set).map(masked).sort();
  return JSON.stringify([expected.code, stderrReasons(expected.stderr), firesTail(expected.set), writtenPaths, expected.removed.map(masked).sort()]);
}

export function maskedOutcome(expected: ObservedDelta): string {
  const written = Object.entries(expected.set).map(([path, content]) => [masked(path), masked(content)]);
  return JSON.stringify([expected.code, masked(expected.stdout), masked(expected.stderr), written, expected.removed.map(masked)]);
}

export function samplingGroup(testCase: RecordedCase, store: RecordedStore): string | null {
  if (testCase.suite === "ts-keel") return `ts-keel:${nativeTestKind(testCase.test)}`;
  if (testCase.suite === "extra" && testCase.test === MERGE_SPELLINGS_TEST && answersWithGhShape(store, testCase.snapshot)) return "extra:gh-answer-shapes";
  return null;
}

function nativeTestKind(test: string): string {
  const method = test.slice(test.lastIndexOf(".") + 1);
  if (method === SPELLINGS_TEST) return "spellings";
  return method === BUNDLE_TEST ? "bundle" : "scenarios";
}

function answersWithGhShape(store: RecordedStore, snapshot: string): boolean {
  const entries = store.trees[snapshot] ?? [];
  if (entries.some(([path]) => path.startsWith(GH_STUB_DIRECTORY))) return false;
  const answer = entries.find(([path]) => path === GH_ANSWER_FILE);
  const blob = answer === undefined ? undefined : store.blobs[answer[3]];
  const text = blob === undefined ? undefined : textOfBlob(blob);
  if (text === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return false;
  }
  return isJsonObject(parsed) && Object.keys(parsed).length === GH_ANSWER_FIELDS.length && GH_ANSWER_FIELDS.every((field) => field in parsed);
}

function divergingCases(cases: readonly RecordedCase[]): Set<RecordedCase> {
  const python = byOccurrence(cases, "python-keel");
  const ts = byOccurrence(cases, "ts-keel");
  const diverging = new Set<RecordedCase>();
  for (const [key, pythonCase] of python) {
    const tsCase = ts.get(key);
    if (tsCase !== undefined && maskedOutcome(pythonCase.expected) === maskedOutcome(tsCase.expected)) continue;
    diverging.add(pythonCase);
    if (tsCase !== undefined) diverging.add(tsCase);
  }
  return diverging;
}

function byOccurrence(cases: readonly RecordedCase[], suite: RecordedCase["suite"]): Map<string, RecordedCase> {
  const ordinals = new Map<string, number>();
  const result = new Map<string, RecordedCase>();
  for (const testCase of cases.filter((candidate) => candidate.suite === suite)) {
    const ordinal = (ordinals.get(testCase.test) ?? 0) + 1;
    ordinals.set(testCase.test, ordinal);
    result.set(`${testCase.test}#${ordinal}`, testCase);
  }
  return result;
}
