import { pyInt, pyStrip } from "./pystr.ts"
import { pyRepr } from "./pyvalue.ts"

export class ArgumentTypeError extends Error {}

export class ConversionError extends Error {}

export class UsageExit extends Error {
  readonly code: number

  constructor(code: number) {
    super(`usage exit ${code}`)
    this.code = code
  }
}

export type ParsedValue = string | number | boolean | string[] | undefined

export interface ArgumentSpec {
  flags: string[]
  dest: string
  kind: "flag" | "value" | "values"
  help: string
  metavar?: string
  choices?: readonly string[]
  typeName?: string
  convert?: (text: string) => string | number
  defaultValue?: ParsedValue
}

export interface ParserSpec {
  prog: string
  description: string
  arguments: ArgumentSpec[]
  exclusive?: { dests: string[]; required: boolean }[]
}

export type ParsedArguments = Record<string, ParsedValue>

type Classified = { kind: "positional"; text: string } | { kind: "option"; spec: ArgumentSpec | "help" | null; text: string; explicit?: string }

const HELP_FLAGS = ["-h", "--help"]
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/

export class ArgumentParser {
  private readonly spec: ParserSpec
  private readonly positionals: ArgumentSpec[]
  private readonly options: ArgumentSpec[]

  constructor(spec: ParserSpec) {
    this.spec = spec
    this.positionals = spec.arguments.filter((argument) => argument.flags.length === 0)
    this.options = spec.arguments.filter((argument) => argument.flags.length > 0)
  }

  parse(argv: string[]): ParsedArguments {
    const parsed: ParsedArguments = {}
    for (const argument of this.spec.arguments) parsed[argument.dest] = argument.defaultValue ?? (argument.kind === "flag" ? false : undefined)
    const seen = new Map<string, ArgumentSpec>()
    const unrecognized: string[] = []
    const queue = this.classify(argv)
    let nextPositional = 0
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index] as Classified
      if (item.kind === "positional") {
        const target = this.positionals[nextPositional++]
        if (target) this.store(parsed, seen, target, target.dest, [item.text])
        else unrecognized.push(item.text)
        continue
      }
      if (item.spec === "help") this.printHelp()
      if (item.spec === null) {
        unrecognized.push(item.text)
        continue
      }
      index = this.consumeOption(item, item.spec, queue, index, parsed, seen)
    }
    this.checkRequired(seen)
    if (unrecognized.length > 0) this.error(`unrecognized arguments: ${unrecognized.join(" ")}`)
    return parsed
  }

  error(message: string): never {
    process.stderr.write(`${this.usage()}\n${this.spec.prog}: error: ${message}\n`)
    throw new UsageExit(2)
  }

  private classify(argv: string[]): Classified[] {
    const items: Classified[] = []
    let onlyPositional = false
    for (const text of argv) {
      if (onlyPositional) items.push({ kind: "positional", text })
      else if (text === "--") onlyPositional = true
      else items.push(this.classifyOne(text))
    }
    return items
  }

  private classifyOne(text: string): Classified {
    if (!text.startsWith("-") || text.length === 1) return { kind: "positional", text }
    const exact = this.lookup(text)
    if (exact) return { kind: "option", spec: exact, text }
    const equals = text.indexOf("=")
    if (equals > 0) {
      const named = this.lookup(text.slice(0, equals))
      if (named) return { kind: "option", spec: named, text: text.slice(0, equals), explicit: text.slice(equals + 1) }
    }
    const abbreviated = this.abbreviations(equals > 0 ? text.slice(0, equals) : text)
    if (abbreviated.length > 1) this.error(`ambiguous option: ${text} could match ${abbreviated.map((entry) => entry.flag).join(", ")}`)
    const [only] = abbreviated
    if (only) return { kind: "option", spec: only.spec, text: only.flag, explicit: equals > 0 ? text.slice(equals + 1) : undefined }
    if (NEGATIVE_NUMBER.test(text) || text.includes(" ")) return { kind: "positional", text }
    return { kind: "option", spec: null, text }
  }

  private lookup(flag: string): ArgumentSpec | "help" | undefined {
    if (HELP_FLAGS.includes(flag)) return "help"
    return this.options.find((argument) => argument.flags.includes(flag))
  }

  private abbreviations(prefix: string): { flag: string; spec: ArgumentSpec | "help" }[] {
    if (!prefix.startsWith("--")) return []
    const candidates: { flag: string; spec: ArgumentSpec | "help" }[] = [{ flag: "--help", spec: "help" }]
    for (const argument of this.options) for (const flag of argument.flags) candidates.push({ flag, spec: argument })
    return candidates.filter((candidate) => candidate.flag.startsWith(prefix))
  }

  private consumeOption(item: Classified & { kind: "option" }, spec: ArgumentSpec, queue: Classified[], index: number, parsed: ParsedArguments, seen: Map<string, ArgumentSpec>): number {
    const name = spec.flags.join("/")
    if (spec.kind === "flag") {
      if (item.explicit !== undefined) this.error(`argument ${name}: ignored explicit argument ${pyRepr(item.explicit)}`)
      this.store(parsed, seen, spec, name, [])
      return index
    }
    if (item.explicit !== undefined) {
      this.store(parsed, seen, spec, name, [item.explicit])
      return index
    }
    const values: string[] = []
    let next = index + 1
    while (next < queue.length && (queue[next] as Classified).kind === "positional" && (spec.kind === "values" || values.length < 1)) {
      values.push((queue[next] as Classified).text)
      next++
    }
    if (values.length === 0) this.error(`argument ${name}: expected ${spec.kind === "values" ? "at least one" : "one"} argument`)
    this.store(parsed, seen, spec, name, values)
    return next - 1
  }

  private store(parsed: ParsedArguments, seen: Map<string, ArgumentSpec>, spec: ArgumentSpec, name: string, values: string[]): void {
    this.rejectConflict(spec, name, seen)
    seen.set(spec.dest, spec)
    if (spec.kind === "flag") {
      parsed[spec.dest] = true
      return
    }
    const converted = values.map((text) => this.convertOne(spec, name, text))
    parsed[spec.dest] = spec.kind === "values" ? converted.map(String) : converted[0]
  }

  private convertOne(spec: ArgumentSpec, name: string, text: string): string | number {
    let value: string | number = text
    try {
      value = spec.convert ? spec.convert(text) : text
    } catch (error) {
      if (error instanceof ArgumentTypeError) this.error(`argument ${name}: ${error.message}`)
      if (error instanceof ConversionError) this.error(`argument ${name}: invalid ${spec.typeName ?? "value"} value: ${pyRepr(text)}`)
      throw error
    }
    if (spec.choices && !spec.choices.includes(String(value))) {
      this.error(`argument ${name}: invalid choice: ${pyRepr(String(value))} (choose from ${spec.choices.map(pyRepr).join(", ")})`)
    }
    return value
  }

  private rejectConflict(spec: ArgumentSpec, name: string, seen: Map<string, ArgumentSpec>): void {
    for (const group of this.spec.exclusive ?? []) {
      if (!group.dests.includes(spec.dest)) continue
      const earlier = group.dests.find((dest) => dest !== spec.dest && seen.has(dest))
      if (earlier) this.error(`argument ${name}: not allowed with argument ${(seen.get(earlier) as ArgumentSpec).flags.join("/")}`)
    }
  }

  private checkRequired(seen: Map<string, ArgumentSpec>): void {
    const missing = this.positionals.filter((argument) => !seen.has(argument.dest)).map((argument) => argument.metavar ?? argument.dest)
    if (missing.length > 0) this.error(`the following arguments are required: ${missing.join(", ")}`)
    for (const group of this.spec.exclusive ?? []) {
      if (group.required && !group.dests.some((dest) => seen.has(dest))) {
        const names = group.dests.map((dest) => this.spec.arguments.find((argument) => argument.dest === dest)?.flags.join("/"))
        this.error(`one of the arguments ${names.join(" ")} is required`)
      }
    }
  }

  private usage(): string {
    const grouped = new Set((this.spec.exclusive ?? []).flatMap((group) => group.dests))
    const parts = ["[-h]"]
    for (const group of this.spec.exclusive ?? []) {
      const members = group.dests.map((dest) => this.formatOption(this.spec.arguments.find((argument) => argument.dest === dest) as ArgumentSpec))
      parts.push(group.required ? `(${members.join(" | ")})` : `[${members.join(" | ")}]`)
    }
    for (const argument of this.options) if (!grouped.has(argument.dest)) parts.push(`[${this.formatOption(argument)}]`)
    for (const argument of this.positionals) parts.push(argument.metavar ?? argument.dest)
    return `usage: ${this.spec.prog} ${parts.join(" ")}`
  }

  private formatOption(argument: ArgumentSpec): string {
    const flag = argument.flags[0] as string
    const metavar = argument.metavar ?? (argument.choices ? `{${argument.choices.join(",")}}` : argument.dest.toUpperCase())
    if (argument.kind === "flag") return flag
    return argument.kind === "values" ? `${flag} ${metavar} [${metavar} ...]` : `${flag} ${metavar}`
  }

  private printHelp(): never {
    const lines = [this.usage(), "", this.spec.description, ""]
    if (this.positionals.length > 0) {
      lines.push("positional arguments:")
      for (const argument of this.positionals) lines.push(`  ${argument.metavar ?? argument.dest}  ${argument.help}`)
      lines.push("")
    }
    lines.push("options:", "  -h, --help  show this help message and exit")
    for (const argument of this.options) lines.push(`  ${argument.flags.join(", ")}  ${argument.help}`)
    process.stdout.write(lines.join("\n") + "\n")
    throw new UsageExit(0)
  }
}

const INTEGER_TEXT = /^[+-]?\p{Nd}+(?:_\p{Nd}+)*$/u

export function positiveInt(text: string): number {
  const stripped = pyStrip(text)
  if (!INTEGER_TEXT.test(stripped)) throw new ConversionError(text)
  const number = pyInt(stripped.replace(/^[+-]/, "").replaceAll("_", "")) * (stripped.startsWith("-") ? -1 : 1)
  if (number < 1) throw new ArgumentTypeError(`expected a positive integer, got ${pyRepr(text)}`)
  return number
}
