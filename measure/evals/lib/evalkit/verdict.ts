import type { Case } from "./cases.ts"

export class CaseVerdict {
  readonly case: Case
  readonly runs: boolean[]

  constructor(verdictCase: Case, runs: boolean[]) {
    this.case = verdictCase
    this.runs = runs
  }

  get passed(): boolean {
    return countTrue(this.runs) >= passesNeeded(this.runs.length)
  }
}

export interface SplitVerdict {
  split: string
  cases: number
  passedCases: number
  passed: boolean
}

export function passesNeeded(total: number): number {
  return Math.trunc((2 * total + 2) / 3)
}

export function splitVerdict(split: string, verdicts: CaseVerdict[]): SplitVerdict {
  const inSplit = verdicts.filter((verdict) => verdict.case.split === split)
  const clear = inSplit.filter((verdict) => verdict.case.isClear)
  const ambiguous = inSplit.filter((verdict) => !verdict.case.isClear)
  const passed = clear.every((verdict) => verdict.passed) && countTrue(ambiguous.map((verdict) => verdict.passed)) >= passesNeeded(ambiguous.length)
  return { split, cases: inSplit.length, passedCases: countTrue(inSplit.map((verdict) => verdict.passed)), passed }
}

export function suitePasses(splits: SplitVerdict[]): boolean {
  return splits.every((split) => split.passed)
}

function countTrue(flags: boolean[]): number {
  return flags.filter(Boolean).length
}
