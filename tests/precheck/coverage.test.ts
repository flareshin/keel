import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, it } from "node:test"

import { CoverageFormatError, readCoverage } from "../../lib/precheck/coverage.ts"

type RangeJson = { startOffset: number, endOffset: number, count: number }

describe("readCoverage", () => {
  let root: string
  let repo: string
  let coverageDir: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-coverage-")))
    repo = path.join(root, "repo")
    coverageDir = path.join(root, "coverage")
    fs.mkdirSync(path.join(repo, "src"), { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const write = (relative: string, lines: string[]): void => {
    fs.writeFileSync(path.join(repo, relative), lines.join("\n") + "\n")
  }
  const runWithCoverage = (relative: string): void => {
    const result = spawnSync(process.execPath, [path.join(repo, relative)], {
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir }, encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
  }
  const executed = (relative: string): number[] => [...readCoverage(coverageDir, repo).executedLines.get(relative) ?? []].sort((a, b) => a - b)

  it("readCoverage_marksTheTakenBranchExecuted_andLeavesTheUntakenElseBodyOut", () => {
    write("src/branch.js", [
      "function pick(flag) {",
      "  if (flag) {",
      "    return 'yes'",
      "  } else {",
      "    return 'no'",
      "  }",
      "}",
      "pick(true)",
    ])
    runWithCoverage("src/branch.js")

    const lines = executed("src/branch.js")
    assert.ok(lines.includes(3), `line 3 should run: ${lines}`)
    assert.ok(!lines.includes(5), `line 5 never runs: ${lines}`)
    assert.ok(lines.includes(8), `line 8 should run: ${lines}`)
  })

  it("readCoverage_keepsLineNumbersOfATypeScriptFile_afterNodeStripsItsTypes", () => {
    write("src/typed.ts", [
      "type Flag = boolean",
      "interface Box {",
      "  value: number",
      "}",
      "function pick(flag: Flag, box: Box): number {",
      "  if (flag) {",
      "    return box.value",
      "  }",
      "  return -1",
      "}",
      "pick(true, { value: 1 })",
    ])
    runWithCoverage("src/typed.ts")

    const lines = executed("src/typed.ts")
    assert.ok(lines.includes(7), `line 7 should run: ${lines}`)
    assert.ok(!lines.includes(9), `line 9 never runs: ${lines}`)
  })

  it("readCoverage_includesLinesRunInASpawnedNodeChild_becauseTheChildInheritsTheCoverageDirectory", () => {
    write("src/child.js", [
      "const unused = () => 'never'",
      "console.log('child ran')",
    ])
    write("src/parent.js", [
      "const { spawnSync } = require('node:child_process')",
      "const result = spawnSync(process.execPath, [__dirname + '/child.js'])",
      "if (result.status !== 0) process.exit(1)",
    ])
    runWithCoverage("src/parent.js")

    assert.deepEqual(executed("src/child.js"), [1, 2])
  })

  it("readCoverage_seesALoadedFileWithNoExecutedLines_butLeavesANeverLoadedFileOutOfSeen", () => {
    write("src/loaded.js", ["function unreached() {", "  return 1", "}"])
    write("src/never.js", ["module.exports = 1"])
    runWithCoverage("src/loaded.js")

    const coverage = readCoverage(coverageDir, repo)
    assert.ok(coverage.seen.has("src/loaded.js"))
    assert.ok(!coverage.seen.has("src/never.js"))
    assert.deepEqual(executed("src/loaded.js"), [])
  })

  it("readCoverage_reportsOnlyFilesInsideTheRepository", () => {
    fs.writeFileSync(path.join(root, "outside.js"), "require('./repo/src/inside.js')\n")
    write("src/inside.js", ["module.exports = 1"])
    const result = spawnSync(process.execPath, [path.join(root, "outside.js")], { env: { ...process.env, NODE_V8_COVERAGE: coverageDir } })
    assert.equal(result.status, 0)

    assert.deepEqual([...readCoverage(coverageDir, repo).seen], ["src/inside.js"])
  })

  const NESTED = [
    "function outer() {",
    "  function inner() {",
    "    return 1",
    "  }",
    "  return 2",
    "}",
    "outer()",
  ]
  const writeCoverage = (contents: string): string => {
    fs.mkdirSync(coverageDir, { recursive: true })
    const file = path.join(coverageDir, "coverage-1.json")
    fs.writeFileSync(file, contents)
    return file
  }
  const nestedRanges = (): { script: RangeJson, inner: RangeJson } => {
    const source = NESTED.join("\n") + "\n"
    const innerStart = source.indexOf("function inner")
    const innerEnd = source.indexOf("}", innerStart) + 1
    return {
      script: { startOffset: 0, endOffset: source.length, count: 1 },
      inner: { startOffset: innerStart, endOffset: innerEnd, count: 0 },
    }
  }
  const writeNestedCoverage = (ranges: RangeJson[]): void => {
    write("src/nested.js", NESTED)
    const url = pathToFileURL(path.join(repo, "src/nested.js")).href
    writeCoverage(JSON.stringify({ result: [{ url, functions: ranges.map((range) => ({ ranges: [range] })) }] }))
  }

  it("readCoverage_leavesOutALineWhoseOnlyExecutedCharactersAreItsIndentation", () => {
    const { script, inner } = nestedRanges()
    writeNestedCoverage([script, inner])

    assert.deepEqual(executed("src/nested.js"), [1, 5, 6, 7])
  })

  it("readCoverage_letsTheInnerRangeWin_evenWhenTheCoverageFileListsItBeforeTheOuterOne", () => {
    const { script, inner } = nestedRanges()
    writeNestedCoverage([inner, script])

    assert.deepEqual(executed("src/nested.js"), [1, 5, 6, 7])
  })

  it("readCoverage_subtractsTheKeelPrefixNamedInTheUrl_beforeMappingOffsetsToLines", () => {
    const prefix = 40
    const { script, inner } = nestedRanges()
    write("src/nested.js", NESTED)
    const url = `${pathToFileURL(path.join(repo, "src/nested.js")).href}#keel-prefix=${prefix}`
    writeCoverage(JSON.stringify({ result: [{ url, functions: [
      { ranges: [{ startOffset: 0, endOffset: script.endOffset + prefix + 3, count: 1 }] },
      { ranges: [{ ...inner, startOffset: inner.startOffset + prefix, endOffset: inner.endOffset + prefix }] },
    ] }] }))

    assert.deepEqual(executed("src/nested.js"), [1, 5, 6, 7])
  })

  it("readCoverage_ignoresARangeLyingWhollyInsideTheKeelPrefix", () => {
    const prefix = 40
    write("src/nested.js", NESTED)
    const url = `${pathToFileURL(path.join(repo, "src/nested.js")).href}#keel-prefix=${prefix}`
    writeCoverage(JSON.stringify({ result: [{ url, functions: [
      { ranges: [{ startOffset: 0, endOffset: prefix + 200, count: 0 }] },
      { ranges: [{ startOffset: 0, endOffset: prefix - 30, count: 1 }] },
    ] }] }))

    assert.deepEqual(executed("src/nested.js"), [])
  })

  for (const malformed of ["-3", "abc", "1.5", ""]) {
    it(`readCoverage_treatsAMalformedKeelPrefixAsUnknown: "${malformed}"`, () => {
      write("src/nested.js", NESTED)
      const url = `${pathToFileURL(path.join(repo, "src/nested.js")).href}#keel-prefix=${malformed}`
      writeCoverage(JSON.stringify({ result: [{ url, functions: [{ ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }] }] }))

      assert.deepEqual([...readCoverage(coverageDir, repo).seen], [])
    })
  }

  it("readCoverage_leavesAFileDeletedAfterItRanOutOfSeen_soItCountsAsUnknown", () => {
    write("src/gone.js", ["module.exports = 1"])
    runWithCoverage("src/gone.js")
    fs.rmSync(path.join(repo, "src/gone.js"))

    assert.deepEqual([...readCoverage(coverageDir, repo).seen], [])
  })

  it("readCoverage_passesAReadFailureThrough_insteadOfCallingItMalformedCoverage", () => {
    fs.mkdirSync(path.join(coverageDir, "coverage-1.json"), { recursive: true })

    assert.throws(() => readCoverage(coverageDir, repo), (error) => (error as NodeJS.ErrnoException).code === "EISDIR")
  })

  for (const [name, contents] of [
    ["a url that is not a string", JSON.stringify({ result: [{ url: 1, functions: [] }] })],
    ["a range without an integer count", JSON.stringify({ result: [{ url: "file:///x.js", functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: "1" }] }] }] })],
    ["truncated JSON", '{"result":['],
  ] as const) {
    it(`readCoverage_namesTheFile_whenACoverageFileHas ${name}`, () => {
      const bad = writeCoverage(contents)

      assert.throws(() => readCoverage(coverageDir, repo),
        (error) => error instanceof CoverageFormatError && error.message === `${bad} is not V8 coverage output`)
    })
  }
})
