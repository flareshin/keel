import type { ObservedDelta } from "../recorded-cases.ts";
import { firesTail, masked, stderrReasons } from "../recorded-sample.ts";

const RECORDED_GROUP = "recorded";
const WRONG_TYPE_GROUP = "wrong-type";
const WRONG_TYPE_NAME_MARKER = "wrong-type";

export interface SampleCandidate {
  test: string;
  script: string;
  input?: string;
  expected?: ObservedDelta;
}

export function sampleCases<T extends SampleCandidate>(cases: readonly T[]): T[] {
  const seenClasses = new Set<string>();
  return cases.filter((testCase) => {
    const group = samplingGroup(testCase);
    if (group === null || testCase.expected === undefined) return true;
    const classKey = `${group}\n${fineClass(testCase.script, testCase.expected)}`;
    const firstOfClass = !seenClasses.has(classKey);
    seenClasses.add(classKey);
    return firstOfClass;
  });
}

export function samplingGroup(testCase: Pick<SampleCandidate, "test" | "input">): string | null {
  if (testCase.input === undefined) return RECORDED_GROUP;
  return testCase.test.includes(WRONG_TYPE_NAME_MARKER) ? WRONG_TYPE_GROUP : null;
}

export function fineClass(script: string, expected: ObservedDelta): string {
  const writtenPaths = Object.keys(expected.set).map(masked).sort();
  return JSON.stringify([
    script, expected.code, masked(expected.stdout), stderrReasons(expected.stderr), firesTail(expected.set), writtenPaths, expected.removed.map(masked).sort(),
  ]);
}
