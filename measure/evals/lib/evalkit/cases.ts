import { readTsvRecords, TsvError } from "../../../lib/measurekit/datafiles.ts"
import { isFile, pyJoin } from "../../../lib/measurekit/pypath.ts"
import { pyRepr } from "../../../lib/measurekit/pyvalue.ts"

export const COLUMNS = ["id", "kind", "expect", "prompt"]
export const TRAIN = "train"
export const HOLDOUT = "holdout"
export const SPLITS = [TRAIN, HOLDOUT]
export const AMBIGUOUS = "ambiguous"
export const CLEAR_CHANGE = "clear-change"
export const CLEAR_ANSWER = "clear-answer"
const KINDS = [AMBIGUOUS, CLEAR_CHANGE, CLEAR_ANSWER]
const NO_EXPECT = "-"

export class CaseError extends Error {}

export class Case {
  readonly id: string
  readonly split: string
  readonly kind: string
  readonly expect: string
  readonly prompt: string

  constructor(id: string, split: string, kind: string, expect: string, prompt: string) {
    this.id = id
    this.split = split
    this.kind = kind
    this.expect = expect
    this.prompt = prompt
  }

  get isClear(): boolean {
    return this.kind !== AMBIGUOUS
  }
}

export function loadCases(evalId: string, checkouts: string[]): Case[] {
  const cases: Case[] = []
  const firstFileOf = new Map<string, string>()
  for (const checkout of checkouts) {
    for (const split of SPLITS) {
      const path = pyJoin(checkout, "measure", "evals", evalId, split + ".tsv")
      if (!isFile(path)) continue
      for (const loaded of readCases(path, split)) {
        const first = firstFileOf.get(loaded.id)
        if (first !== undefined) throw new CaseError(`${path}: duplicate case id ${pyRepr(loaded.id)} (first in ${first})`)
        firstFileOf.set(loaded.id, path)
        cases.push(loaded)
      }
    }
  }
  return cases
}

function readCases(path: string, split: string): Case[] {
  let records: Record<string, string>[]
  try {
    records = readTsvRecords(path, COLUMNS)
  } catch (error) {
    if (error instanceof TsvError) throw new CaseError(error.message)
    throw error
  }
  return records.map((record) => {
    const { id, kind, expect, prompt } = record as Record<string, string>
    if (!KINDS.includes(kind as string)) {
      throw new CaseError(`${path}: case ${id} has unknown kind ${pyRepr(kind as string)} (want one of ${KINDS.join(", ")})`)
    }
    if (kind === CLEAR_ANSWER && expect === NO_EXPECT) throw new CaseError(`${path}: clear-answer case ${id} needs an expect token`)
    return new Case(id as string, split, kind as string, expect as string, prompt as string)
  })
}

export function selectCases(cases: Case[], split: string | undefined, caseId: string | undefined): Case[] {
  return cases.filter((candidate) => (split === undefined || candidate.split === split) && (caseId === undefined || candidate.id === caseId))
}

export function splitGaps(cases: Case[]): string[] {
  const gaps: string[] = []
  for (const split of SPLITS) {
    const inSplit = cases.filter((candidate) => candidate.split === split)
    if (!inSplit.some((candidate) => !candidate.isClear)) gaps.push(`${split} has no ambiguous case`)
    if (!inSplit.some((candidate) => candidate.isClear)) gaps.push(`${split} has no clear case`)
  }
  return gaps
}
