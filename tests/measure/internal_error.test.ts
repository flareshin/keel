import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { MEASURE_DIR, MeasureSandbox } from "./helpers.ts"

const RUNNING_AS_ROOT = process.getuid?.() === 0
const NOT_UTF8 = Buffer.from([0x23, 0xff, 0xfe, 0x0a])

interface Outcome {
  status: number | null
  stdout: string
  lastStderrLine: string
}

type InternalErrorCase = [name: string, setup: (box: MeasureSandbox) => void, tool: string, args: string[]]

const CASES: InternalErrorCase[] = [
  ["ledgerIsADirectory", (box) => fs.mkdirSync(path.join(box.keel, "ledger.tsv")), "run", ["C-demo"]],
  ["ledgerIsUnreadable", (box) => { box.write("keel/ledger.tsv", "x"); fs.chmodSync(path.join(box.keel, "ledger.tsv"), 0) }, "run", ["C-demo"]],
  ["ledgerIsNotUtf8", (box) => fs.writeFileSync(path.join(box.keel, "ledger.tsv"), NOT_UTF8), "run", ["C-demo"]],
  ["ledgerIsADirectoryForProposals", (box) => fs.mkdirSync(path.join(box.keel, "ledger.tsv")), "propose", []],
  ["ledgerIsNotUtf8ForTheWeeklyReport", (box) => fs.writeFileSync(path.join(box.keel, "ledger.tsv"), NOT_UTF8), "weekly", []],
]

function runEntry(box: MeasureSandbox, command: string[], args: string[]): Outcome {
  const [program = "", ...leading] = command
  const completed = spawnSync(program, [...leading, ...args], { encoding: "utf8", env: box.env, cwd: box.root })
  const lines = completed.stderr.trimEnd().split("\n")
  return { status: completed.status, stdout: completed.stdout, lastStderrLine: lines[lines.length - 1] ?? "" }
}

describe("measure internal errors print python's class name and message", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
  })
  afterEach(() => {
    fs.chmodSync(path.join(box.keel, "ledger.tsv"), 0o600)
    box.cleanup()
  })

  for (const [name, setup, tool, args] of CASES) {
    it(`${name}_exitsWith70AndTheSameInternalErrorLineAsPython`, { skip: RUNNING_AS_ROOT && name === "ledgerIsUnreadable" }, () => {
      fs.mkdirSync(box.keel, { recursive: true })
      setup(box)
      const python = runEntry(box, [path.join(MEASURE_DIR, tool)], args)
      const typescript = runEntry(box, [process.execPath, path.join(MEASURE_DIR, `${tool}.ts`)], args)
      assert.equal(python.status, 70)
      assert.match(python.lastStderrLine, /^internal error: (IsADirectoryError|PermissionError|UnicodeDecodeError): /)
      assert.deepEqual(typescript, python)
    })
  }
})
