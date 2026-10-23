import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { MEASURE_DIR, MeasureSandbox, ledgerRow } from "./helpers.ts"

const RUNNING_AS_ROOT = process.getuid?.() === 0
const NOT_UTF8 = Buffer.from([0x23, 0xff, 0xfe, 0x0a])
const CHUNK_BYTES = 8192
const BAD_LINE = Buffer.from([0x0a, 0xff, 0x0a])

const afterPadding = (head: string, padding: number): Buffer => Buffer.concat([Buffer.from(head), Buffer.alloc(padding, 0x61), BAD_LINE])

interface Outcome {
  status: number | null
  stdout: string
  lastStderrLine: string
}

type InternalErrorCase = [name: string, setup: (box: MeasureSandbox) => void, tool: string, args: string[], reason: RegExp]

const IS_A_DIRECTORY = /^internal error: Error: EISDIR: /
const PERMISSION_DENIED = /^internal error: Error: EACCES: .*ledger\.tsv/
const NOT_UTF8_LEDGER = /^internal error: InvalidUtf8Error: .*ledger\.tsv is not valid UTF-8$/

const CASES: InternalErrorCase[] = [
  ["ledgerIsADirectory", (box) => fs.mkdirSync(path.join(box.keel, "ledger.tsv")), "run", ["C-demo"], IS_A_DIRECTORY],
  ["ledgerIsUnreadable", (box) => { box.write("keel/ledger.tsv", "x"); fs.chmodSync(path.join(box.keel, "ledger.tsv"), 0) }, "run", ["C-demo"], PERMISSION_DENIED],
  ["ledgerIsNotUtf8", (box) => fs.writeFileSync(path.join(box.keel, "ledger.tsv"), NOT_UTF8), "run", ["C-demo"], NOT_UTF8_LEDGER],
  ["ledgerHasBadBytesPastTheFirstChunk", (box) => fs.writeFileSync(path.join(box.keel, "ledger.tsv"), afterPadding("id\tx\n", 9000)), "run", ["C-demo"], NOT_UTF8_LEDGER],
  ["ledgerHasBadBytesJustInsideTheFirstChunk", (box) => fs.writeFileSync(path.join(box.keel, "ledger.tsv"), afterPadding("id\tx\n", CHUNK_BYTES - 20)), "run", ["C-demo"], NOT_UTF8_LEDGER],
  ["ledgerHasBadBytesInTheThirdChunk", (box) => fs.writeFileSync(path.join(box.keel, "ledger.tsv"), afterPadding("id\tx\n", CHUNK_BYTES * 2 + 100)), "run", ["C-demo"], NOT_UTF8_LEDGER],
  ["ledgerHasATruncatedCharacterAtTheChunkEdge", (box) => fs.writeFileSync(path.join(box.keel, "ledger.tsv"), Buffer.concat([Buffer.from("id\tx\n#"), Buffer.alloc(CHUNK_BYTES - 7, 0x61), Buffer.from([0xed, 0xa0, 0x80, 0x0a])])), "run", ["C-demo"], NOT_UTF8_LEDGER],
  [
    "fireLogHasBadBytesPastTheFirstChunk",
    (box) => {
      box.writeLedger("keel/ledger.tsv", [ledgerRow("C-demo")])
      fs.mkdirSync(path.join(box.data, "logs"), { recursive: true })
      fs.writeFileSync(path.join(box.data, "logs", "keel-fires.jsonl"), afterPadding("", 9000))
    },
    "run",
    ["C-demo"],
    /^internal error: InvalidUtf8Error: .*keel-fires\.jsonl is not valid UTF-8$/,
  ],
  ["ledgerIsADirectoryForProposals", (box) => fs.mkdirSync(path.join(box.keel, "ledger.tsv")), "propose", [], IS_A_DIRECTORY],
  ["ledgerIsNotUtf8ForTheWeeklyReport", (box) => fs.writeFileSync(path.join(box.keel, "ledger.tsv"), NOT_UTF8), "weekly", [], NOT_UTF8_LEDGER],
]

function runEntry(box: MeasureSandbox, tool: string, args: string[]): Outcome {
  const completed = spawnSync(path.join(MEASURE_DIR, tool), args, { encoding: "utf8", env: box.env, cwd: box.root })
  const lines = completed.stderr.trimEnd().split("\n")
  return { status: completed.status, stdout: completed.stdout, lastStderrLine: lines[lines.length - 1] ?? "" }
}

describe("measure internal errors exit 70 with one internal error line", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
  })
  afterEach(() => {
    fs.chmodSync(path.join(box.keel, "ledger.tsv"), 0o600)
    box.cleanup()
  })

  for (const [name, setup, tool, args, reason] of CASES) {
    it(`${name}_exitsWith70AndAnInternalErrorLine`, { skip: RUNNING_AS_ROOT && name === "ledgerIsUnreadable" }, () => {
      fs.mkdirSync(box.keel, { recursive: true })
      setup(box)
      const outcome = runEntry(box, tool, args)
      assert.deepEqual([outcome.status, outcome.stdout], [70, ""])
      assert.match(outcome.lastStderrLine, reason)
    })
  }
})
