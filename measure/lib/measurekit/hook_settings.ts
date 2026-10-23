import { memberEntries } from "./pydict.ts"
import { shlexSplit, ShlexError } from "./shlex.ts"
import { pyBasename, pySplitext } from "./pypath.ts"
import { isJsonObject } from "./pyvalue.ts"
import type { JsonObject, PyValue } from "./pyvalue.ts"

const SCRIPT_INTERPRETERS = new Set(["python3", "python", "bash", "sh", "node"])
const MATCH_ALL = new Set(["", "*"])

export class Registration {
  readonly event: string
  readonly matcher: string
  readonly hook: JsonObject

  constructor(event: string, matcher: string, hook: JsonObject) {
    this.event = event
    this.matcher = matcher
    this.hook = hook
  }

  get command(): string {
    return this.hook["command"] as string
  }

  get script(): string {
    let words: string[]
    try {
      words = shlexSplit(this.command)
    } catch (error) {
      if (error instanceof ShlexError) return this.command
      throw error
    }
    return words.find((word) => !SCRIPT_INTERPRETERS.has(pyBasename(word))) ?? this.command
  }

  get hookName(): string {
    return pySplitext(pyBasename(this.script))[0]
  }

  coversTool(toolName: string): boolean {
    return MATCH_ALL.has(this.matcher) || this.matcher.split("|").includes(toolName)
  }
}

export function iterRegistrations(hooks: PyValue | undefined): Registration[] {
  return iterHookEntries(hooks).filter((entry) => isCommandHook(entry.hook))
}

export function iterHookEntries(hooks: PyValue | undefined): Registration[] {
  const entries: Registration[] = []
  if (!isJsonObject(hooks)) return entries
  for (const [event, groups] of memberEntries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!isJsonObject(group)) continue
      const matcher = group["matcher"]
      const matcherText = typeof matcher === "string" ? matcher : ""
      const groupHooks = group["hooks"]
      for (const hook of Array.isArray(groupHooks) ? groupHooks : []) {
        if (isJsonObject(hook)) entries.push(new Registration(event, matcherText, hook))
      }
    }
  }
  return entries
}

export function isCommandHook(hook: JsonObject): boolean {
  return typeof hook["command"] === "string"
}
