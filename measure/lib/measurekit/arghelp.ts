import { decolor } from "./argcolor.ts"
import type { ArgparseTheme } from "./argcolor.ts"
import type { ArgumentSpec, ParserSpec } from "./argparse.ts"
import { codePointLength, pyIntOrNull, pyStrip } from "./pystr.ts"
import { fillText, wrapText } from "./pytextwrap.ts"

const USAGE_PREFIX = "usage: "
const INDENT_INCREMENT = 2
const MAX_HELP_POSITION = 24
const MIN_TEXT_WIDTH = 11
const FALLBACK_COLUMNS = 80
const SHORT_PROG_SHARE = 0.75
const HELP_ACTION_TEXT = "show this help message and exit"
const ASCII_WHITESPACE_RUN = /[\t\n\v\f\r ]+/g
const THREE_OR_MORE_NEWLINES = /\n\n\n+/g

interface HelpAction {
  readonly optionStrings: readonly string[]
  readonly dest: string
  readonly kind: ArgumentSpec["kind"]
  readonly metavar: string | undefined
  readonly choices: readonly string[] | undefined
  readonly help: string
}

type UsageGroup = readonly [required: boolean, members: HelpAction[]]

export function terminalWidth(): number {
  return terminalColumns() - 2
}

function terminalColumns(): number {
  const fromEnvironment = pyIntOrNull(process.env["COLUMNS"] ?? "")
  if (fromEnvironment !== null && fromEnvironment > 0) return fromEnvironment
  const fromTerminal = process.stdout.isTTY ? process.stdout.columns : 0
  return fromTerminal > 0 ? fromTerminal : FALLBACK_COLUMNS
}

export function formatUsage(spec: ParserSpec, width: number, theme: ArgparseTheme): string {
  return formatUsageBody(spec, actionsOf(spec), width, theme)
}

export function formatHelp(spec: ParserSpec, width: number, theme: ArgparseTheme): string {
  const actions = actionsOf(spec)
  const positionals = actions.filter((action) => action.optionStrings.length === 0)
  const optionals = actions.filter((action) => action.optionStrings.length > 0)
  const longestInvocation = Math.max(...actions.map((action) => plainLength(invocationOf(action, theme), theme) + INDENT_INCREMENT))
  const maxHelpPosition = Math.min(MAX_HELP_POSITION, Math.max(width - 20, INDENT_INCREMENT * 2))
  const helpPosition = Math.min(longestInvocation + 2, maxHelpPosition)
  const sections = [
    `${formatUsageBody(spec, actions, width, theme)}\n\n`,
    `${fillText(normalizeSpaces(spec.description), Math.max(width, MIN_TEXT_WIDTH), "")}\n\n`,
    formatSection("positional arguments", positionals, helpPosition, width, theme),
    formatSection("options", optionals, helpPosition, width, theme),
  ]
  return sections.join("").replace(THREE_OR_MORE_NEWLINES, "\n\n").replace(/^\n+|\n+$/g, "") + "\n"
}

function actionsOf(spec: ParserSpec): HelpAction[] {
  const helpAction: HelpAction = { optionStrings: ["-h", "--help"], dest: "help", kind: "flag", metavar: undefined, choices: undefined, help: HELP_ACTION_TEXT }
  const declared = spec.arguments.map((argument): HelpAction => ({
    optionStrings: argument.flags,
    dest: argument.dest,
    kind: argument.kind,
    metavar: argument.metavar,
    choices: argument.choices,
    help: argument.help,
  }))
  return [helpAction, ...declared]
}

function formatUsageBody(spec: ParserSpec, actions: HelpAction[], width: number, theme: ArgparseTheme): string {
  const { parts, positionalStart } = usageParts(spec, actions, theme)
  const usage = [spec.prog, ...parts].join(" ")
  const fitted = USAGE_PREFIX.length + plainLength(usage, theme) <= width
    ? usage
    : wrapUsage(spec.prog, parts.slice(0, positionalStart), parts.slice(positionalStart), width, theme)
  return `${theme.usage}${USAGE_PREFIX}${theme.reset}${theme.prog}${spec.prog}${theme.reset}${fitted.slice(spec.prog.length)}`
}

function plainLength(text: string, theme: ArgparseTheme): number {
  return codePointLength(decolor(text, theme))
}

function wrapUsage(prog: string, optionalParts: string[], positionalParts: string[], textWidth: number, theme: ArgparseTheme): string {
  const progLength = codePointLength(prog)
  let lines: string[]
  if (USAGE_PREFIX.length + progLength <= SHORT_PROG_SHARE * textWidth) {
    const indent = " ".repeat(USAGE_PREFIX.length + progLength + 1)
    if (optionalParts.length > 0) {
      lines = [...usageLines([prog, ...optionalParts], indent, textWidth, theme, USAGE_PREFIX), ...usageLines(positionalParts, indent, textWidth, theme)]
    } else if (positionalParts.length > 0) {
      lines = usageLines([prog, ...positionalParts], indent, textWidth, theme, USAGE_PREFIX)
    } else {
      lines = [prog]
    }
  } else {
    const indent = " ".repeat(USAGE_PREFIX.length)
    lines = usageLines([...optionalParts, ...positionalParts], indent, textWidth, theme)
    if (lines.length > 1) lines = [...usageLines(optionalParts, indent, textWidth, theme), ...usageLines(positionalParts, indent, textWidth, theme)]
    lines = [prog, ...lines]
  }
  return lines.join("\n")
}

function usageLines(parts: string[], indent: string, textWidth: number, theme: ArgparseTheme, prefix?: string): string[] {
  const lines: string[] = []
  let line: string[] = []
  const indentLength = indent.length
  let lineLength = (prefix === undefined ? indentLength : prefix.length) - 1
  for (const part of parts) {
    const partLength = plainLength(part, theme)
    if (lineLength + 1 + partLength > textWidth && line.length > 0) {
      lines.push(indent + line.join(" "))
      line = []
      lineLength = indentLength - 1
    }
    line.push(part)
    lineLength += partLength + 1
  }
  if (line.length > 0) lines.push(indent + line.join(" "))
  if (prefix !== undefined && lines[0] !== undefined) lines[0] = lines[0].slice(indentLength)
  return lines
}

function usageParts(spec: ParserSpec, actions: HelpAction[], theme: ArgparseTheme): { parts: string[]; positionalStart: number } {
  const { groups, optionalCount } = usageGroups(spec, actions)
  const parts: string[] = []
  let positionalStart = -1
  groups.forEach(([required, members], index) => {
    if (index === optionalCount) positionalStart = parts.length
    const start = parts.length
    const inGroup = members.length > 1
    for (const action of members) parts.push(usagePartOf(action, required || inGroup, theme))
    if (inGroup) {
      parts[start] = (required ? "(" : "[") + parts[start]
      for (let position = start; position < parts.length - 1; position++) parts[position] += " |"
      parts[parts.length - 1] += required ? ")" : "]"
    }
  })
  return { parts, positionalStart: positionalStart < 0 ? parts.length : positionalStart }
}

function usageGroups(spec: ParserSpec, actions: HelpAction[]): { groups: UsageGroup[]; optionalCount: number } {
  const remaining = new Set(actions)
  const groupOf = new Map<HelpAction, { required: boolean; members: HelpAction[] }>()
  for (const group of spec.exclusive ?? []) {
    const members = group.dests.flatMap((dest) => actions.filter((action) => action.dest === dest))
    for (const member of members) groupOf.set(member, { required: group.required, members })
  }
  const positionals: UsageGroup[] = actions.filter((action) => action.optionStrings.length === 0).map((action): UsageGroup => [false, [action]])
  const optionals: UsageGroup[] = []
  for (const action of actions) {
    if (action.optionStrings.length === 0 || !remaining.has(action)) continue
    remaining.delete(action)
    const group = groupOf.get(action)
    if (group === undefined) {
      optionals.push([false, [action]])
      continue
    }
    const others = group.members.filter((member) => member !== action && remaining.has(member))
    for (const other of others) remaining.delete(other)
    optionals.push([group.required, [action, ...others]])
  }
  return { groups: [...optionals, ...positionals], optionalCount: optionals.length }
}

function usagePartOf(action: HelpAction, bare: boolean, theme: ArgparseTheme): string {
  if (action.optionStrings.length === 0) return `${theme.summaryAction}${argumentsOf(action)}${theme.reset}`
  const first = action.optionStrings[0] as string
  const optionColor = isLongOption(first) ? theme.summaryLongOption : theme.summaryShortOption
  const part = action.kind === "flag"
    ? `${optionColor}${first}${theme.reset}`
    : `${optionColor}${first} ${theme.summaryLabel}${argumentsOf(action)}${theme.reset}`
  return bare ? part : `[${part}]`
}

function isLongOption(optionString: string): boolean {
  return optionString.length > 2
}

function metavarOf(action: HelpAction): string {
  if (action.metavar !== undefined) return action.metavar
  if (action.choices !== undefined) return `{${action.choices.join(",")}}`
  return action.optionStrings.length > 0 ? action.dest.toUpperCase() : action.dest
}

function argumentsOf(action: HelpAction): string {
  const metavar = metavarOf(action)
  return action.kind === "values" ? `${metavar} [${metavar} ...]` : metavar
}

function invocationOf(action: HelpAction, theme: ArgparseTheme): string {
  if (action.optionStrings.length === 0) return `${theme.action}${metavarOf(action)}${theme.reset}`
  const names = action.optionStrings
    .map((name) => (isLongOption(name) ? `${theme.longOption}${name}${theme.reset}` : `${theme.shortOption}${name}${theme.reset}`))
    .join(", ")
  return action.kind === "flag" ? names : `${names} ${theme.label}${argumentsOf(action)}${theme.reset}`
}

function formatSection(heading: string, actions: HelpAction[], helpPosition: number, width: number, theme: ArgparseTheme): string {
  if (actions.length === 0) return ""
  const items = actions.map((action) => formatAction(action, helpPosition, width, theme)).join("")
  return `\n${theme.heading}${heading}:${theme.reset}\n${items}\n`
}

function formatAction(action: HelpAction, helpPosition: number, width: number, theme: ArgparseTheme): string {
  const helpWidth = Math.max(width - helpPosition, MIN_TEXT_WIDTH)
  const actionWidth = helpPosition - INDENT_INCREMENT - 2
  const header = invocationOf(action, theme)
  const headerLength = plainLength(header, theme)
  const indent = " ".repeat(INDENT_INCREMENT)
  if (action.help === "") return `${indent}${header}\n`
  const fitsBesideHelp = headerLength <= actionWidth
  const lead = fitsBesideHelp ? `${indent}${header}${" ".repeat(actionWidth - headerLength)}  ` : `${indent}${header}\n`
  const helpLines = wrapText(normalizeSpaces(action.help), helpWidth)
  const margin = " ".repeat(helpPosition)
  const [first = "", ...rest] = helpLines
  const firstLine = fitsBesideHelp ? `${first}\n` : `${margin}${first}\n`
  return lead + firstLine + rest.map((line) => `${margin}${line}\n`).join("")
}

function normalizeSpaces(text: string): string {
  return pyStrip(text.replace(ASCII_WHITESPACE_RUN, " "))
}
