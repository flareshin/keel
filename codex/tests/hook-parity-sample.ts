import { firesTail, masked, stderrReasons } from "../../tests/recorded-sample.ts";
import type { HookCase, Observation } from "./hook-parity.ts";

export const HOOK_NAME = "pre-tool-use";
export const WRONG_TYPE_GROUP = "wrong-type";
export const STDIN_BYTES_GROUP = "stdin-bytes";
export const UNUSABLE_TEXT_GROUP = "surrogate-or-nul";
const WRONG_TYPE_NAME_PREFIX = "wrong-type ";
const STDIN_BYTES_NAME_PREFIX = "stdin ";
const UNPAIRED_SURROGATE_OR_NUL = /\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;
const FILE_ENTRY_PREFIX = /^file:[0-7]+:/;

export type SampleCandidate = Pick<HookCase, "name" | "stdin">;

export function samplingGroup(testCase: SampleCandidate): string | null {
  if (testCase.name.startsWith(WRONG_TYPE_NAME_PREFIX)) return WRONG_TYPE_GROUP;
  if (testCase.name.startsWith(STDIN_BYTES_NAME_PREFIX)) return STDIN_BYTES_GROUP;
  if (typeof testCase.stdin === "string" && UNPAIRED_SURROGATE_OR_NUL.test(testCase.stdin)) return UNUSABLE_TEXT_GROUP;
  return null;
}

export function sampleCases<T extends SampleCandidate>(cases: readonly T[], classesOf: (sampled: T[]) => string[]): T[] {
  const sampled = cases.filter((testCase) => samplingGroup(testCase) !== null);
  const classes = classesOf(sampled);
  const classKeys = new Map(sampled.map((testCase, position) => [testCase, `${samplingGroup(testCase)}\n${classes[position]}`]));
  const seenClasses = new Set<string>();
  return cases.filter((testCase) => {
    const classKey = classKeys.get(testCase);
    if (classKey === undefined) return true;
    const firstOfClass = !seenClasses.has(classKey);
    seenClasses.add(classKey);
    return firstOfClass;
  });
}

export function fineClass(hook: string, golden: Observation, baseline: Record<string, string>): string {
  const written = Object.entries(golden.files).filter(([path, entry]) => baseline[path] !== entry);
  const writtenContents = Object.fromEntries(written.map(([path, entry]) => [path, entry.replace(FILE_ENTRY_PREFIX, "")]));
  const removed = Object.keys(baseline).filter((path) => !(path in golden.files));
  return JSON.stringify([
    hook, golden.status, masked(golden.stdout), stderrReasons(golden.stderr), firesTail(writtenContents), written.map(([path]) => masked(path)).sort(), removed.map(masked).sort(),
  ]);
}
