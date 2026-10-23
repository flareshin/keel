import fs from "node:fs"
import path from "node:path"

import { InvalidUtf8Error, isDir, isFile, isSystemError, readUtf8 } from "../../../lib/measurekit/files.ts"
import { isJsonObject, parseJson } from "../../../lib/measurekit/json.ts"
import type { JsonObject, JsonValue } from "../../../lib/measurekit/json.ts"
import { CaseError, SPLITS } from "./cases.ts"

const CASES_PATH = path.join("measure", "evals", "review", "cases")
const EXPECT_FILE = "expect.json"
const CHANGE_FILE = "change.diff"
const BASE_DIR = "base"
const CLEAN_LENS = "control"
const REQUIRED_KEYS = ["lens", "must_find", "source", "split", "locations"]
const OPTIONAL_KEYS = ["caller_skill", "requirement"]
const CASE_ID = /^[a-z0-9-]+-\d+$/

export interface Location {
  file: string
  line: number
}

export function describeLocation(location: Location): string {
  return `${location.file}:${location.line}`
}

export class ReviewCase {
  readonly id: string
  readonly split: string
  readonly lens: string
  readonly locations: readonly Location[]
  readonly directory: string
  readonly callerSkill: string | null
  readonly requirement: string | null

  constructor(fields: { id: string; split: string; lens: string; locations: Location[]; directory: string; callerSkill: string | null; requirement: string | null }) {
    this.id = fields.id
    this.split = fields.split
    this.lens = fields.lens
    this.locations = fields.locations
    this.directory = fields.directory
    this.callerSkill = fields.callerSkill
    this.requirement = fields.requirement
  }

  get isClean(): boolean {
    return this.lens === CLEAN_LENS
  }

  get changePath(): string {
    return path.join(this.directory, CHANGE_FILE)
  }

  get baseDir(): string {
    return path.join(this.directory, BASE_DIR)
  }
}

export function loadReviewCases(checkouts: string[]): ReviewCase[] {
  const cases: ReviewCase[] = []
  const seen = new Map<string, string>()
  for (const checkout of checkouts) {
    const root = path.resolve(checkout, CASES_PATH)
    if (!isDir(root)) continue
    for (const name of fs.readdirSync(root).sort()) {
      const directory = path.join(root, name)
      if (!isDir(directory)) continue
      const earlier = seen.get(name)
      if (earlier !== undefined) throw new CaseError(`case ${name} is in both ${earlier} and ${directory}`)
      seen.set(name, directory)
      cases.push(readCase(name, directory))
    }
  }
  return cases
}

export function selectReviewCases(cases: ReviewCase[], split: string | undefined, caseId: string | undefined): ReviewCase[] {
  return cases.filter((candidate) => (split === undefined || candidate.split === split) && (caseId === undefined || candidate.id === caseId))
}

function readCase(name: string, directory: string): ReviewCase {
  if (!CASE_ID.test(name)) throw new CaseError(`${directory}: a case directory is named <words>-<n>, lowercase`)
  const expect = readExpect(path.join(directory, EXPECT_FILE))
  if (!isFile(path.join(directory, CHANGE_FILE))) throw new CaseError(`${directory}: no ${CHANGE_FILE}`)
  const split = expect["split"]
  if (typeof split !== "string" || !SPLITS.includes(split)) throw new CaseError(`${directory}: split must be one of ${SPLITS.join(", ")}`)
  const locations = (expect["locations"] as JsonValue[]).map((item) => toLocation(directory, item))
  if ((expect["lens"] === CLEAN_LENS) !== (locations.length === 0)) {
    throw new CaseError(`${directory}: a ${CLEAN_LENS} case has no locations and every other case has at least one`)
  }
  return new ReviewCase({
    id: name, split, lens: expect["lens"] as string, locations, directory,
    callerSkill: (expect["caller_skill"] as string | undefined) ?? null,
    requirement: (expect["requirement"] as string | undefined) ?? null,
  })
}

function readExpect(expectPath: string): JsonObject {
  let expect: JsonValue
  try {
    expect = parseJson(readUtf8(expectPath))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidUtf8Error || isSystemError(error)) throw new CaseError(`cannot read ${expectPath}: ${(error as Error).message}`)
    throw error
  }
  if (!isJsonObject(expect)) throw new CaseError(`${expectPath} is not a JSON object`)
  const missing = REQUIRED_KEYS.filter((key) => !(key in expect))
  const unknown = Object.keys(expect).filter((key) => !REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)).sort()
  if (missing.length > 0 || unknown.length > 0) throw new CaseError(`${expectPath}: missing ${JSON.stringify(missing)}, unknown ${JSON.stringify(unknown)}`)
  if (!Array.isArray(expect["locations"])) throw new CaseError(`${expectPath}: locations is a list`)
  for (const key of OPTIONAL_KEYS) {
    const value = expect[key]
    if (key in expect && !(typeof value === "string" && value.trim() !== "")) throw new CaseError(`${expectPath}: ${key} is a non-empty string when given`)
  }
  return expect
}

function toLocation(directory: string, item: JsonValue): Location {
  const isShapeValid =
    isJsonObject(item) && Object.keys(item).length === 2 && "file" in item && "line" in item &&
    typeof item["file"] === "string" && Number.isInteger(item["line"]) && Number(item["line"]) > 0
  if (!isShapeValid) {
    throw new CaseError(`${directory}: each location is {"file": relative path, "line": positive int}, got ${JSON.stringify(item)}`)
  }
  const file = (item as JsonObject)["file"] as string
  if (file.startsWith("/") || file.split("/").includes("..")) throw new CaseError(`${directory}: location file ${JSON.stringify(file)} must be relative to the repo root`)
  return { file, line: Number((item as JsonObject)["line"]) }
}
