#!/usr/bin/env node
import * as env from "./lib/measurekit/env.ts"
import { BoundaryUsageError, fileLines, loadRules, rangeLines, scan, stagedLines } from "./lib/measurekit/boundary.ts"
import type { ScanLine } from "./lib/measurekit/boundary.ts"
import { EXIT_NEGATIVE, EXIT_OK, EXIT_USAGE, flagOption, parseCommandLine, printJson, runMain, stringOption, usageError } from "./lib/measurekit/cli.ts"
import type { CommandSpec, ParsedCommandLine } from "./lib/measurekit/cli.ts"

const COMMAND: CommandSpec = {
  prog: "measure/boundary",
  usage: "measure/boundary [-h] (--staged | --range A..B | --paths PATH [PATH ...]) [--generic-only]",
  description: "Public-boundary scan.",
  argumentHelp: [
    ["--staged", "lines added in the index of the current repo"],
    ["--range A..B", "commits A..B (A all zeros: commits of B not on any remote)"],
    ["--paths PATH [PATH ...]", "whole files, or directories (their tracked files inside a work tree)"],
    ["--generic-only", "only keel's generic secret / private-IP rules"],
  ],
  options: { staged: { type: "boolean" }, range: { type: "string" }, paths: { type: "string" }, "generic-only": { type: "boolean" } },
}
const SOURCES = ["staged", "range", "paths"]

type Source = { kind: "staged" } | { kind: "range"; range: string } | { kind: "paths"; paths: string[] }

function main(argv: string[]): number {
  const parsed = parseCommandLine(COMMAND, argv)
  const source = selectedSource(parsed)
  let result
  try {
    const rules = loadRules(env.overlayDir(), flagOption(parsed, "generic-only"))
    result = scan(linesOf(source), rules)
  } catch (error) {
    if (!(error instanceof BoundaryUsageError)) throw error
    process.stderr.write(`boundary: ${error.message}\n`)
    return EXIT_USAGE
  }
  printJson(result)
  for (const hit of result.hits) process.stderr.write(`boundary: ${hit.file}:${hit.line} matches ${hit.rule}\n`)
  return result.hits.length > 0 ? EXIT_NEGATIVE : EXIT_OK
}

function selectedSource(parsed: ParsedCommandLine): Source {
  const given = SOURCES.filter((name) => parsed.values[name] !== undefined)
  if (given.length !== 1) usageError(COMMAND, "give exactly one of --staged, --range, --paths")
  const paths = pathsArgument(parsed)
  if (given[0] === "staged") return { kind: "staged" }
  if (given[0] === "range") return { kind: "range", range: stringOption(parsed, "range") as string }
  return { kind: "paths", paths }
}

function pathsArgument(parsed: ParsedCommandLine): string[] {
  let paths: string[] = []
  let collecting = false
  const unrecognized: string[] = []
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      collecting = token.name === "paths"
      if (collecting) paths = [token.value as string]
    } else if (token.kind === "positional") {
      if (collecting) paths.push(token.value)
      else unrecognized.push(token.value)
    }
  }
  if (unrecognized.length > 0) usageError(COMMAND, `unrecognized arguments: ${unrecognized.join(" ")}`)
  return paths
}

function linesOf(source: Source): Iterable<ScanLine> {
  if (source.kind === "staged") return stagedLines(process.cwd())
  if (source.kind === "range") return rangeLines(process.cwd(), source.range)
  return fileLines(process.cwd(), source.paths)
}

runMain(main)
