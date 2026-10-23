import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { after, before, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { describeInternalError } from "../../lib/link/internal_error.ts"
import { knownErrnoCodes } from "../../measure/lib/measurekit/pyerrno.ts"
import { OsError } from "../../measure/lib/measurekit/pyerrors.ts"
import { readBytes } from "../../measure/lib/measurekit/pyio.ts"
import { runProcess } from "../../measure/lib/measurekit/subprocess.ts"
import { recordedAnswers, recordedPlatformMatches } from "../recorded.ts"

const PYTHON_ORACLE = String.raw`
import json, os, sys

def fail(operation):
    root = sys.argv[1]
    at = lambda name: os.path.join(root, name)
    operations = {
        "readMissing": lambda: open(at("missing")).close(),
        "mkdirExisting": lambda: os.mkdir(at("dir")),
        "rmdirNonEmpty": lambda: os.rmdir(at("full")),
        "openSymlinkLoop": lambda: open(at("loop")).close(),
        "openTooLongName": lambda: open(at("x" * 300)).close(),
        "openBelowAFile": lambda: open(at("file/child")).close(),
        "openDirectoryForWriting": lambda: open(at("dir"), "w").close(),
        "renameMissing": lambda: os.rename(at("missing"), at("other")),
        "symlinkOverExisting": lambda: os.symlink(at("src"), at("file")),
        "hardLinkToDirectory": lambda: os.link(at("dir"), at("hardlink")),
        "unlinkMissing": lambda: os.unlink(at("missing")),
        "chmodMissing": lambda: os.chmod(at("missing"), 0o600),
    }
    try:
        operations[operation]()
    except OSError as error:
        return type(error).__name__ + ": " + str(error)
    return "no error"

request = json.load(sys.stdin)
json.dump({
    "errnos": {name: [type(OSError(number, "")).__name__, os.strerror(number)] for name, number in request["errnos"].items()},
    "operations": {name: fail(name) for name in request["operations"]},
}, sys.stdout)
`

const OPERATIONS: Record<string, (at: (name: string) => string) => void> = {
  readMissing: (at) => fs.readFileSync(at("missing")),
  mkdirExisting: (at) => fs.mkdirSync(at("dir")),
  rmdirNonEmpty: (at) => fs.rmdirSync(at("full")),
  openSymlinkLoop: (at) => fs.openSync(at("loop"), "r"),
  openTooLongName: (at) => fs.openSync(at("x".repeat(300)), "r"),
  openBelowAFile: (at) => fs.openSync(at("file/child"), "r"),
  openDirectoryForWriting: (at) => fs.openSync(at("dir"), "w"),
  renameMissing: (at) => fs.renameSync(at("missing"), at("other")),
  symlinkOverExisting: (at) => fs.symlinkSync(at("src"), at("file")),
  hardLinkToDirectory: (at) => fs.linkSync(at("dir"), at("hardlink")),
  unlinkMissing: (at) => fs.unlinkSync(at("missing")),
  chmodMissing: (at) => fs.chmodSync(at("missing"), 0o600),
}

let root = ""
const at = (name: string) => path.join(root, name)

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-pyerrno-")))
  fs.mkdirSync(at("dir"))
  fs.mkdirSync(at("full"))
  fs.writeFileSync(at("full/inside"), "x")
  fs.writeFileSync(at("file"), "x")
  fs.symlinkSync(at("loop"), at("loop"))
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

type PythonAnswers = { errnos: Record<string, [string, string]>; operations: Record<string, string> }

function pythonAnswers(): PythonAnswers {
  const request = { errnos: Object.fromEntries(knownErrnoCodes().map((code) => [code, os.constants.errno[code as keyof typeof os.constants.errno]])), operations: Object.keys(OPERATIONS) }
  const askPython = ([question]: (typeof request)[]): PythonAnswers[] => {
    const completed = spawnSync("python3", ["-I", "-c", PYTHON_ORACLE, root], { input: JSON.stringify(question), encoding: "utf8" })
    assert.equal(completed.status, 0, completed.stderr)
    return [JSON.parse(completed.stdout)]
  }
  return recordedAnswers("measure-pyerrno", [request], askPython, { "{{ROOT}}": root })[0] as PythonAnswers
}

function internalErrorOf(operation: () => void): string {
  try {
    operation()
  } catch (error) {
    return describeInternalError(error)
  }
  return "no error"
}

describe("errno text matches python", { skip: recordedPlatformMatches() ? false : "errno wording was recorded on darwin" }, () => {
  it("everyKnownErrnoCode_hasPythonsClassAndStrerror", () => {
    const answers = pythonAnswers().errnos
    for (const code of knownErrnoCodes()) {
      const [pythonClass, strerror] = answers[code] as [string, string]
      const failure = Object.assign(new Error("node text"), { code, path: "/p" })
      assert.equal(describeInternalError(failure), `${pythonClass}: [Errno ${os.constants.errno[code as keyof typeof os.constants.errno]}] ${strerror}: '/p'`, code)
    }
  })

  for (const [name, operation] of Object.entries(OPERATIONS)) {
    it(`${name}_reportsTheSameClassAndMessageAsPython`, () => {
      assert.equal(internalErrorOf(() => operation(at)), (pythonAnswers().operations as Record<string, string>)[name])
    })
  }

  it("unreadableFile_readBytesThrowsOsErrorCarryingPythonsClass", () => {
    assert.throws(
      () => readBytes(at("missing")),
      (error: unknown) => error instanceof OsError && error.pythonClass === "FileNotFoundError" && error.message === `[Errno 2] No such file or directory: '${at("missing")}'`,
    )
  })

  it("missingProgram_runProcessThrowsOsErrorWithPythonsMessage", () => {
    assert.throws(
      () => runProcess(["/nonexistent/program"]),
      (error: unknown) => error instanceof OsError && error.pythonClass === "FileNotFoundError" && error.message === "[Errno 2] No such file or directory: '/nonexistent/program'",
    )
  })
})
