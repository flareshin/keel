#!/usr/bin/env node
import * as env from "./lib/measurekit/env.ts"
import { ArgumentParser } from "./lib/measurekit/argparse.ts"
import type { ParsedArguments } from "./lib/measurekit/argparse.ts"
import { BoundaryUsageError, fileLines, loadRules, rangeLines, scan, stagedLines } from "./lib/measurekit/boundary.ts"
import type { ScanLine } from "./lib/measurekit/boundary.ts"
import { EXIT_NEGATIVE, EXIT_OK, EXIT_USAGE, printJson, runMain } from "./lib/measurekit/cli.ts"

function main(argv: string[]): number {
  const args = parseArgs(argv)
  let result
  try {
    const rules = loadRules(env.overlayDir(), args["generic_only"] === true)
    result = scan(selectLines(args), rules)
  } catch (error) {
    if (!(error instanceof BoundaryUsageError)) throw error
    process.stderr.write(`boundary: ${error.message}\n`)
    return EXIT_USAGE
  }
  printJson(result)
  for (const hit of result.hits) process.stderr.write(`boundary: ${hit.file}:${hit.line} matches ${hit.rule}\n`)
  return result.hits.length > 0 ? EXIT_NEGATIVE : EXIT_OK
}

function parseArgs(argv: string[]): ParsedArguments {
  const parser = new ArgumentParser({
    prog: "measure/boundary",
    description: "Public-boundary scan.",
    arguments: [
      { flags: ["--staged"], dest: "staged", kind: "flag", help: "lines added in the index of the current repo" },
      { flags: ["--range"], dest: "range", kind: "value", metavar: "A..B", help: "commits A..B (A all zeros: commits of B not on any remote)" },
      { flags: ["--paths"], dest: "paths", kind: "values", metavar: "PATH", help: "whole files, or directories (their tracked files inside a work tree)" },
      { flags: ["--generic-only"], dest: "generic_only", kind: "flag", help: "only keel's generic secret / private-IP rules" },
    ],
    exclusive: [{ dests: ["staged", "range", "paths"], required: true }],
  })
  return parser.parse(argv)
}

function selectLines(args: ParsedArguments): Iterable<ScanLine> {
  if (args["staged"] === true) return stagedLines(process.cwd())
  if (args["range"]) return rangeLines(process.cwd(), args["range"] as string)
  return fileLines(process.cwd(), args["paths"] as string[])
}

runMain(main)
