import { compilePythonRegex } from "../../../lib/measurekit/pyregex.ts"
import { pyInt, pyStrip } from "../../../lib/measurekit/pystr.ts"
import { isJsonObject, PyFloat, pyStr, pyTruthy, roundToFourDecimals } from "../../../lib/measurekit/pyvalue.ts"
import type { PyValue } from "../../../lib/measurekit/pyvalue.ts"
import { SPLITS } from "./cases.ts"
import type { Location, ReviewCase } from "./reviewcases.ts"

const LINE_TOLERANCE = 3
const PATH_LINE_REF = compilePythonRegex("([^\\s:`'\"(),\\[\\]]+):(\\d+)(?:-(\\d+))?", "g")
const BARE_LINE_REF = compilePythonRegex(":(\\d+)(?:-(\\d+))?", "g")

export class RunGrade {
  readonly case: ReviewCase
  readonly run: number
  readonly blocking: number
  readonly hit: boolean

  constructor(gradedCase: ReviewCase, run: number, blocking: number, hit: boolean) {
    this.case = gradedCase
    this.run = run
    this.blocking = blocking
    this.hit = hit
  }

  get passed(): boolean {
    return this.case.isClean ? this.blocking === 0 : this.hit
  }
}

export interface SplitNumbers {
  defect_runs: number
  hits: number
  recall: PyFloat | null
  clean_runs: number
  noisy_runs: number
  noise_rate: PyFloat | null
  blocking_per_clean_run: PyFloat | null
  recall_stdev: PyFloat | null
}

export interface SuiteNumbers {
  train: SplitNumbers
  holdout: SplitNumbers
  headroom: boolean
  case_agreement: PyFloat | null
}

type LineRange = [number, number]

export function gradeResult(gradedCase: ReviewCase, run: number, result: PyValue | undefined): RunGrade {
  const rawBlocking = isJsonObject(result) ? result["blocking"] : undefined
  const blocking = pyTruthy(rawBlocking) ? (rawBlocking as PyValue[]) : []
  const hit = !gradedCase.isClean && blocking.some((finding) => gradedCase.locations.some((location) => atLocation(finding, location)))
  return new RunGrade(gradedCase, run, blocking.length, hit)
}

function atLocation(finding: PyValue, location: Location): boolean {
  if (!isJsonObject(finding)) return false
  const low = location.line - LINE_TOLERANCE
  const high = location.line + LINE_TOLERANCE
  return quotedLines(finding, location.file).some(([start, end]) => start <= high && end >= low)
}

function quotedLines(finding: { [key: string]: PyValue }, expectedFile: string): LineRange[] {
  const quote = textOf(finding["quote"])
  const ranges: LineRange[] = []
  for (const match of quote.matchAll(PATH_LINE_REF)) {
    if (sameFile(match[1] as string, expectedFile)) ranges.push(toRange(match[2] as string, match[3]))
  }
  if (sameFile(textOf(finding["file"]), expectedFile)) {
    for (const match of quote.matchAll(BARE_LINE_REF)) ranges.push(toRange(match[1] as string, match[2]))
  }
  return ranges
}

function textOf(value: PyValue | undefined): string {
  return pyTruthy(value) ? pyStr(value) : ""
}

function sameFile(path: string, expectedFile: string): boolean {
  const normalized = pyStrip(path).replaceAll("\\", "/")
  return normalized !== "" && (normalized === expectedFile || normalized.endsWith("/" + expectedFile) || expectedFile.endsWith("/" + normalized))
}

function toRange(start: string, end: string | undefined): LineRange {
  return [pyInt(start), pyInt(end || start)]
}

export function suiteNumbers(grades: RunGrade[]): SuiteNumbers {
  const [trainSplit, holdoutSplit] = SPLITS as [string, string]
  const train = splitNumbers(grades.filter((grade) => grade.case.split === trainSplit))
  const holdout = splitNumbers(grades.filter((grade) => grade.case.split === holdoutSplit))
  const headroom = !(train.recall?.value === 1 && train.noise_rate?.value === 0)
  return { train, holdout, headroom, case_agreement: caseAgreement(grades) }
}

function splitNumbers(grades: RunGrade[]): SplitNumbers {
  const defect = grades.filter((grade) => !grade.case.isClean)
  const clean = grades.filter((grade) => grade.case.isClean)
  const hits = defect.filter((grade) => grade.hit).length
  const noisy = clean.filter((grade) => grade.blocking > 0).length
  const blockingTotal = clean.reduce((total, grade) => total + grade.blocking, 0)
  return {
    defect_runs: defect.length, hits, recall: ratio(hits, defect.length),
    clean_runs: clean.length, noisy_runs: noisy, noise_rate: ratio(noisy, clean.length),
    blocking_per_clean_run: ratio(blockingTotal, clean.length),
    recall_stdev: recallStdev(defect),
  }
}

function recallStdev(defect: RunGrade[]): PyFloat | null {
  const byRun = new Map<number, boolean[]>()
  for (const grade of defect) byRun.set(grade.run, [...(byRun.get(grade.run) ?? []), grade.hit])
  const recalls = [...byRun.values()].map((hits) => hits.filter(Boolean).length / hits.length)
  if (recalls.length <= 1) return null
  const mean = recalls.reduce((total, recall) => total + recall, 0) / recalls.length
  const variance = recalls.reduce((total, recall) => total + (recall - mean) ** 2, 0) / recalls.length
  return new PyFloat(roundToFourDecimals(Math.sqrt(variance)))
}

function caseAgreement(grades: RunGrade[]): PyFloat | null {
  const outcomes = new Map<string, Set<boolean>>()
  const counts = new Map<string, number>()
  for (const grade of grades) {
    outcomes.set(grade.case.id, (outcomes.get(grade.case.id) ?? new Set()).add(grade.passed))
    counts.set(grade.case.id, (counts.get(grade.case.id) ?? 0) + 1)
  }
  const repeated = [...counts].filter(([, count]) => count > 1).map(([caseId]) => caseId)
  return ratio(repeated.filter((caseId) => outcomes.get(caseId)?.size === 1).length, repeated.length)
}

function ratio(part: number, whole: number): PyFloat | null {
  return whole > 0 ? new PyFloat(roundToFourDecimals(part / whole)) : null
}
