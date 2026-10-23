import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { describe, it } from "node:test"
import path from "node:path"

import { recordedAnswers } from "../recorded.ts"
import { CHECKOUT } from "./helpers.ts"

const COLOR_VARIABLES = ["FORCE_COLOR", "NO_COLOR", "PYTHON_COLORS"]
const USAGE_PREFIX_COLOURED = "\u001b[1;34musage: \u001b[0m"
const HAS_PSEUDO_TERMINAL = process.platform === "darwin" && spawnSync("script", ["-q", "/dev/null", "true"], { stdio: ["ignore", "pipe", "pipe"] }).status === 0

const ENTRIES: [string, string][] = [
  ["link", path.join("bin", "link")],
  ["boundary", path.join("measure", "boundary")],
]

const INVOCATIONS: [string, string[]][] = [
  ["help", ["-h"]],
  ["unknown option", ["--bogus"]],
]

const TERMINALS: [string, Record<string, string>, boolean][] = [
  ["a plain terminal", { TERM: "xterm" }, true],
  ["a dumb terminal", { TERM: "dumb" }, false],
  ["a terminal with NO_COLOR", { TERM: "xterm", NO_COLOR: "1" }, false],
  ["a terminal with PYTHON_COLORS=0", { TERM: "xterm", PYTHON_COLORS: "0" }, false],
]

function onPseudoTerminal(program: string, entry: string, args: string[], variables: Record<string, string>) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !COLOR_VARIABLES.includes(key)))
  const env = { ...inherited, COLUMNS: "100", ...variables }
  const completed = spawnSync("script", ["-q", "/dev/null", program, entry, ...args], { cwd: CHECKOUT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  return { status: completed.status, stdout: completed.stdout, stderr: completed.stderr }
}

describe("python and typescript entries colour alike on a pseudo terminal", { skip: !HAS_PSEUDO_TERMINAL }, () => {
  for (const [entryName, entry] of ENTRIES) {
    for (const [invocationName, args] of INVOCATIONS) {
      for (const [terminalName, variables, coloured] of TERMINALS) {
        it(`${entryName} ${invocationName} on ${terminalName}`, () => {
          const python = recordedAnswers<unknown, ReturnType<typeof onPseudoTerminal>>("measure-pty", [{ entry, args, variables }], { "{{CHECKOUT}}": CHECKOUT })[0] as ReturnType<typeof onPseudoTerminal>
          const typescript = onPseudoTerminal(process.execPath, `${entry}.ts`, args, variables)
          assert.equal(python.stdout.includes(USAGE_PREFIX_COLOURED), coloured)
          assert.deepEqual(typescript, python)
        })
      }
    }
  }
})
