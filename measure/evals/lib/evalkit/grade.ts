import path from "node:path"

import { runGit } from "../../../lib/measurekit/gitutil.ts"
import { displayText, isJsonObject } from "../../../lib/measurekit/json.ts"
import type { JsonValue } from "../../../lib/measurekit/json.ts"
import { AMBIGUOUS, CLEAR_CHANGE } from "./cases.ts"
import type { Case } from "./cases.ts"
import { ASK_TOOL, EDIT_TOOLS, LOOKUP_TOOLS, RESULT_MAX_TURNS, RESULT_SUCCESS, SKILL_TOOL } from "./stream.ts"
import type { RunFacts } from "./stream.ts"

export const QUESTION_MARKER = "QUESTION:"
const QUESTION_LABEL = QUESTION_MARKER.slice(0, -1)
const QUESTION_LINE = new RegExp(
  "^[ \\t]*(?:(?:[-*+>#]|\\d+[.)])[ \\t]*)*(?:\\*\\*|__)?" + QUESTION_LABEL + "(?::|\\*\\*:|__:)",
  "m",
)
export const REFINED_REQUEST_HEADER = "Refined request"
const REFINED_REQUEST_HEADING = new RegExp("^#+[ \\t]*" + REFINED_REQUEST_HEADER, "m")
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g
export const LEFTOVER_FAULT = "session left a project directory behind: "
const GRADED_DENIALS = [...EDIT_TOOLS, ASK_TOOL, ...LOOKUP_TOOLS, SKILL_TOOL]

export function runPasses(runCase: Case, facts: RunFacts): boolean {
  if (runCase.kind === AMBIGUOUS) return !facts.changed && !facts.triedToChange && (facts.askedTool || textAsks(facts.finalText))
  if (runCase.kind === CLEAR_CHANGE) return facts.changed && !facts.askedTool
  return !facts.changed && !facts.triedToChange && !facts.askedTool && textAnswers(facts.finalText, runCase.expect)
}

export function textAsks(finalText: string | null): boolean {
  if (finalText === null) return false
  const prose = finalText.replace(FENCED_CODE, "")
  return QUESTION_LINE.test(prose) || REFINED_REQUEST_HEADING.test(prose)
}

export function textAnswers(finalText: string | null, expect: string): boolean {
  if (finalText === null) return false
  const prose = finalText.replace(FENCED_CODE, "")
  const firstQuestion = QUESTION_LINE.exec(prose)
  const answered = firstQuestion ? prose.slice(0, firstQuestion.index) : prose
  return answered.replaceAll("`", "").toLowerCase().includes(expect.toLowerCase())
}

export function faultReason(facts: RunFacts, timeoutSeconds: number): string | null {
  const result = facts.result
  if (facts.timedOut) return `timed out after ${timeoutSeconds}s`
  if (result === null) return "no result event"
  if (result["subtype"] === RESULT_SUCCESS && result["is_error"] === true) return "result has is_error with subtype success (logged out?)"
  if (!hasModelUsage(result["modelUsage"])) return "empty modelUsage (logged out?)"
  if (facts.exitCode !== 0 && result["subtype"] !== RESULT_MAX_TURNS) return `exit ${facts.exitCode} with result subtype ${displayText(result["subtype"])}`
  const unexpected = [...new Set(facts.stream.deniedTools.filter((tool) => !GRADED_DENIALS.includes(tool)))].sort()
  if (unexpected.length > 0) return `permission denied for ${unexpected.join(", ")}`
  if (facts.leftoverProjectDir) return LEFTOVER_FAULT + facts.leftoverProjectDir
  return null
}

function hasModelUsage(modelUsage: JsonValue | undefined): boolean {
  return isJsonObject(modelUsage) && Object.keys(modelUsage).length > 0
}

export function graderCommit(checkout: string): string {
  const commit = runGit(checkout, ["rev-parse", "HEAD"]).trim()
  const dirty = runGit(checkout, ["status", "--porcelain", "--", path.join("measure", "evals")]).trim()
  return dirty ? commit + "-dirty" : commit
}
