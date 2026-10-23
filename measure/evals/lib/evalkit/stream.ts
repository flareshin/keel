import { displayText, isJsonObject, parseJson } from "../../../lib/measurekit/json.ts"
import type { JsonObject, JsonValue } from "../../../lib/measurekit/json.ts"

export const ASK_TOOL = "AskUserQuestion"
export const SKILL_TOOL = "Skill"
export const EDIT_TOOLS = ["Edit", "Write"]
export const LOOKUP_TOOLS = ["Read", "Grep", "Glob"]
export const RESULT_SUCCESS = "success"
export const RESULT_MAX_TURNS = "error_max_turns"

export interface StreamSummary {
  init: JsonObject | null
  result: JsonObject | null
  askCalls: number
  skillCalls: string[]
  deniedTools: string[]
}

export function emptyStreamSummary(): StreamSummary {
  return { init: null, result: null, askCalls: 0, skillCalls: [], deniedTools: [] }
}

export interface RunFactsInit {
  stream: StreamSummary
  exitCode: number
  timedOut: boolean
  changed: boolean
  leftoverProjectDir: string | null
}

export class RunFacts {
  readonly stream: StreamSummary
  readonly exitCode: number
  readonly timedOut: boolean
  readonly changed: boolean
  readonly leftoverProjectDir: string | null

  constructor(init: RunFactsInit) {
    this.stream = init.stream
    this.exitCode = init.exitCode
    this.timedOut = init.timedOut
    this.changed = init.changed
    this.leftoverProjectDir = init.leftoverProjectDir
  }

  get result(): JsonObject | null {
    return this.stream.result
  }

  get askedTool(): boolean {
    return this.stream.askCalls > 0 || this.stream.deniedTools.includes(ASK_TOOL)
  }

  get triedToChange(): boolean {
    return this.stream.deniedTools.some((tool) => EDIT_TOOLS.includes(tool))
  }

  get finalText(): string | null {
    const result = this.stream.result
    if (result === null || result["subtype"] !== RESULT_SUCCESS || result["is_error"] === true) return null
    const text = result["result"]
    return typeof text === "string" ? text : null
  }

  fired(skill: string): boolean {
    return this.stream.skillCalls.includes(skill)
  }
}

export function summarizeStream(lines: Iterable<string>): StreamSummary {
  const summary = emptyStreamSummary()
  for (const event of jsonEvents(lines)) {
    const kind = event["type"]
    if (kind === "system" && event["subtype"] === "init") {
      summary.init = event
    } else if (kind === "assistant" && (event["parent_tool_use_id"] === undefined || event["parent_tool_use_id"] === null)) {
      countToolUses(event, summary)
    } else if (kind === "result") {
      summary.result = event
      const denials = event["permission_denials"]
      summary.deniedTools = Array.isArray(denials) ? denials.filter(isJsonObject).map((denial) => displayText(denial["tool_name"])) : []
    }
  }
  return summary
}

function* jsonEvents(lines: Iterable<string>): Generator<JsonObject> {
  for (const line of lines) {
    let event: JsonValue
    try {
      event = parseJson(line)
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
    if (isJsonObject(event)) yield event
  }
}

function countToolUses(event: JsonObject, summary: StreamSummary): void {
  const message = event["message"]
  const content = isJsonObject(message) ? message["content"] : undefined
  for (const block of Array.isArray(content) ? content : []) {
    if (!isJsonObject(block) || block["type"] !== "tool_use") continue
    if (block["name"] === ASK_TOOL) {
      summary.askCalls++
    } else if (block["name"] === SKILL_TOOL) {
      const input = block["input"]
      const skill = isJsonObject(input) ? input["skill"] : undefined
      if (typeof skill === "string") summary.skillCalls.push(skill.slice(skill.lastIndexOf(":") + 1))
    }
  }
}
