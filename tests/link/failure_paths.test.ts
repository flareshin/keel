import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { LINK_ENTRY, LinkSandbox, PYTHON_LINK_ENTRY } from "./helpers.ts"
import type { LinkResult } from "./helpers.ts"

const SCRATCH_ROOT = path.join(os.tmpdir(), `keel-link-failure-${process.pid}`)
const NOT_UTF8 = Buffer.from([0x23, 0xff, 0xfe, 0x0a])
const OWNED_ENV_SETTINGS = '{"env":{"a":"b"}}'

const BYTE_ORDER_MARK = String.fromCharCode(65279)
const RUNNING_AS_ROOT = process.getuid?.() === 0
const mask = (text: string) => text.replace(/UnicodeDecodeError: .*/g, "UnicodeDecodeError: <detail>")

let compared = 0
let mismatches = 0

after(() => {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true })
  console.log(`parity: ${compared} cases, ${mismatches} mismatches`)
})

const FAILURE_CASES: [string, (box: LinkSandbox) => void, string[], number][] = [
  ["linkStateIsInvalidJson", (box) => box.writeData("state/keel/link-state.json", "{oops"), ["--write"], 3],
  ["linkStateIsAList", (box) => box.writeData("state/keel/link-state.json", "[]"), ["--write"], 70],
  ["linkStateIsAListOnUnlink", (box) => box.writeData("state/keel/link-state.json", "[]"), ["--unlink"], 70],
  ["linkStateDigestsAreAString", (box) => box.writeData("state/keel/link-state.json", '{"settings_owned_sha256": "x"}'), ["--write"], 70],
  [
    "linkStateDigestsAreNull",
    (box) => {
      box.writeData("settings.json", OWNED_ENV_SETTINGS)
      box.writeData("state/keel/link-state.json", '{"settings_owned_sha256": null}')
    },
    ["--write"],
    70,
  ],
  ["principlesIsNotUtf8", (box) => fs.writeFileSync(path.join(box.keel, "PRINCIPLES.md"), NOT_UTF8), ["--write"], 70],
  ["settingsIsNotUtf8", (box) => fs.writeFileSync(box.dataPath("settings.json"), NOT_UTF8), ["--write"], 70],
  ["claudeMdIsNotUtf8", (box) => fs.writeFileSync(box.dataPath("CLAUDE.md"), NOT_UTF8), ["--write"], 70],
  ["manifestIsNotUtf8", (box) => fs.writeFileSync(path.join(box.keel, "settings/links.tsv"), NOT_UTF8), ["--check"], 70],
  ["settingsIsADirectory", (box) => fs.mkdirSync(box.dataPath("settings.json")), ["--write"], 70],
  ["dataDirIsAFile", (box) => { fs.rmSync(box.data, { recursive: true }); fs.writeFileSync(box.data, "x") }, ["--write"], 70],
  ["dataDirIsReadOnly", (box) => fs.chmodSync(box.data, 0o500), ["--write"], 70],
  ["acceptDropsFileIsMissing", (box) => box.writeData("settings.json", OWNED_ENV_SETTINGS), ["--write", "--adopt", "--accept-drops", "/nonexistent/x"], 3],
  ["acceptDropsIsADirectory", (box) => box.writeData("settings.json", OWNED_ENV_SETTINGS), ["--write", "--adopt", "--accept-drops", os.tmpdir()], 3],
  ["acceptDropsIsEmpty", (box) => box.writeData("settings.json", OWNED_ENV_SETTINGS), ["--write", "--adopt", "--accept-drops", ""], 3],
  ["fragmentIsInvalidJson", (box) => box.writeOverlay("settings/90-x.json", "{oops"), ["--check"], 3],
  ["fragmentStartsWithByteOrderMark", (box) => box.writeOverlay("settings/90-x.json", BYTE_ORDER_MARK + "{}"), ["--check"], 3],
  ["fragmentIsAList", (box) => box.writeOverlay("settings/90-x.json", "[]"), ["--check"], 3],
  ["fragmentHooksIsAList", (box) => box.writeOverlay("settings/90-x.json", '{"hooks": []}'), ["--check"], 3],
  ["fragmentHooksEventIsNotAList", (box) => box.writeOverlay("settings/90-x.json", '{"hooks": {"Stop": 1}}'), ["--check"], 3],
  ["fragmentPermissionIsNotAList", (box) => box.writeOverlay("settings/90-x.json", '{"permissions": {"allow": "x"}}'), ["--check"], 3],
  ["fragmentEnvValueIsNotAString", (box) => box.writeOverlay("settings/90-x.json", '{"env": {"A": 1}}'), ["--check"], 3],
  ["manifestRowHasOneColumn", (box) => box.writeKeel("settings/links.tsv", "source\ttarget\nonly-one\n"), ["--check"], 3],
  [
    "manifestHasCrlfBlankAndCommentLines",
    (box) => box.writeKeel("settings/links.tsv", "# c\r\n\r\nsource\ttarget\r\n{{KEEL}}/bin/keel\tbin/keel\r\n   \r\n"),
    ["--check"],
    1,
  ],
  ["manifestSourceIsRelative", (box) => box.writeKeel("settings/links.tsv", "source\ttarget\nrel/x\tx\n"), ["--check"], 3],
  ["settingsIsAList", (box) => box.writeData("settings.json", "[]"), ["--check"], 3],
  ["settingsStartsWithByteOrderMark", (box) => box.writeData("settings.json", BYTE_ORDER_MARK + "{}"), ["--check"], 3],
  ["settingsHoldsNaN", (box) => box.writeData("settings.json", '{"env": NaN}'), ["--check"], 1],
  ["settingsPermissionIsAString", (box) => box.writeData("settings.json", '{"permissions": {"allow": "Read"}}'), ["--check"], 1],
  ["unlinkFindsADirectoryAtClaudeMd", (box) => fs.mkdirSync(box.dataPath("CLAUDE.md")), ["--unlink"], 0],
  ["stacksNameIsInvalid", (box) => box.writeOverlay("stacks.txt", "BAD NAME\n"), ["--check"], 3],
  ["ledgerIsMalformed", (box) => box.writeKeel("ledger.tsv", "garbage\n"), ["--check"], 1],
  ["keelHomeIsNotARepo", (box) => fs.rmSync(path.join(box.keel, ".git"), { recursive: true }), ["--check"], 1],
]

function runBoth(setup: (box: LinkSandbox) => void, args: string[]): [LinkResult, LinkResult] {
  const [python, typescript] = [[PYTHON_LINK_ENTRY], [process.execPath, LINK_ENTRY]].map((command) => {
    const box = new LinkSandbox({ root: SCRATCH_ROOT })
    try {
      setup(box)
      return box.runLinkWith(command, ...args)
    } finally {
      fs.chmodSync(box.data, 0o700)
      box.remove()
    }
  })
  return [python as LinkResult, typescript as LinkResult]
}

describe("link failure paths match the python entry", () => {
  for (const [name, setup, args, status] of FAILURE_CASES) {
    it(`${name}_exitsWith${status}AndPrintsTheSameStreams`, { skip: RUNNING_AS_ROOT && name === "dataDirIsReadOnly" }, () => {
      const [python, typescript] = runBoth(setup, args)
      compared++
      try {
        assert.equal(python.status, status)
        assert.deepEqual([typescript.status, mask(typescript.stdout), mask(typescript.stderr)], [python.status, mask(python.stdout), mask(python.stderr)])
      } catch (error) {
        mismatches++
        throw error
      }
    })
  }
})
