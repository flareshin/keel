import { parseArgs } from "node:util"
import type { ParseArgsOptionsConfig } from "node:util"

import { parseIsoDate } from "./dates.ts"
import { stringifySorted } from "./json.ts"

export const EXIT_OK = 0
export const EXIT_NEGATIVE = 1
export const EXIT_USAGE = 2
export const EXIT_INTERNAL = 70

const HELP_FLAGS = ["-h", "--help"]
const END_OF_OPTIONS = "--"
const DIGITS = /^\d+$/

export class UsageExit extends Error {
  readonly code: number

  constructor(code: number) {
    super(`usage exit ${code}`)
    this.code = code
  }
}

export interface CommandSpec {
  readonly prog: string
  readonly usage: string
  readonly description: string
  readonly argumentHelp: readonly (readonly [name: string, help: string])[]
  readonly options: ParseArgsOptionsConfig
}

export type ParsedCommandLine = ReturnType<typeof parseArgsWithTokens>

export function runMain(main: (argv: string[]) => number): void {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageExit) {
      process.exitCode = error.code
      return
    }
    process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n")
    process.stderr.write(`internal error: ${errorName(error)}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = EXIT_INTERNAL
  }
}

export function parseCommandLine(spec: CommandSpec, argv: string[]): ParsedCommandLine {
  if (asksForHelp(argv, spec.options)) {
    process.stdout.write(helpText(spec))
    throw new UsageExit(EXIT_OK)
  }
  try {
    return parseArgsWithTokens(spec.options, argv)
  } catch (error) {
    if (isParseArgsError(error)) usageError(spec, error.message)
    throw error
  }
}

export function usageError(spec: CommandSpec, message: string): never {
  process.stderr.write(`usage: ${spec.usage}\n${spec.prog}: error: ${message}\n`)
  throw new UsageExit(EXIT_USAGE)
}

export function exactlyOnePositional(spec: CommandSpec, parsed: ParsedCommandLine, name: string): string {
  const [first, ...extra] = parsed.positionals
  if (first === undefined) usageError(spec, `the argument ${name} is required`)
  if (extra.length > 0) usageError(spec, `unrecognized arguments: ${extra.join(" ")}`)
  return first
}

export function noPositionals(spec: CommandSpec, parsed: ParsedCommandLine): void {
  if (parsed.positionals.length > 0) usageError(spec, `unrecognized arguments: ${parsed.positionals.join(" ")}`)
}

export function stringOption(parsed: ParsedCommandLine, name: string): string | undefined {
  const value = parsed.values[name]
  return typeof value === "string" ? value : undefined
}

export function flagOption(parsed: ParsedCommandLine, name: string): boolean {
  return parsed.values[name] === true
}

export function dateOption(spec: CommandSpec, flag: string, text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const parsed = parseIsoDate(text)
  if (parsed === null) usageError(spec, `${flag}: expected YYYY-MM-DD, got ${JSON.stringify(text)}`)
  return parsed
}

export function positiveIntOption(spec: CommandSpec, flag: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  if (!DIGITS.test(text) || Number(text) === 0) usageError(spec, `${flag}: expected a positive integer, got ${JSON.stringify(text)}`)
  return Number(text)
}

export function choiceOption(spec: CommandSpec, flag: string, text: string | undefined, choices: readonly string[]): string | undefined {
  if (text !== undefined && !choices.includes(text)) usageError(spec, `${flag}: invalid choice ${JSON.stringify(text)} (choose from ${choices.join(", ")})`)
  return text
}

export function printJson(payload: object): void {
  process.stdout.write(stringifySorted(payload) + "\n")
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error
}

function parseArgsWithTokens(options: ParseArgsOptionsConfig, argv: string[]) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true })
}

function asksForHelp(argv: string[], options: ParseArgsOptionsConfig): boolean {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (arg === END_OF_OPTIONS) return false
    if (HELP_FLAGS.includes(arg)) return true
    if (takesSeparateValue(arg, options)) index++
  }
  return false
}

function takesSeparateValue(arg: string, options: ParseArgsOptionsConfig): boolean {
  if (!arg.startsWith("--") || arg.includes("=")) return false
  return options[arg.slice(2)]?.type === "string"
}

function isParseArgsError(error: unknown): error is TypeError {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return error instanceof TypeError && typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_")
}

function helpText(spec: CommandSpec): string {
  const width = Math.max(0, ...spec.argumentHelp.map(([name]) => name.length))
  const lines = spec.argumentHelp.map(([name, help]) => `  ${name.padEnd(width)}  ${help}`)
  return [`usage: ${spec.usage}`, "", spec.description, ...(lines.length > 0 ? ["", ...lines] : []), ""].join("\n")
}
