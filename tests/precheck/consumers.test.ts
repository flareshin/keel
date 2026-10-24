import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { findConsumers } from "../../lib/precheck/consumers.ts"

describe("findConsumers", () => {
  let repo: string

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-consumers-")))
    execFileSync("git", ["init", "-q", repo])
  })
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

  const write = (relative: string, lines: string[]): void => {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true })
    fs.writeFileSync(path.join(repo, relative), lines.join("\n") + "\n")
  }
  const snapshot = (): string => {
    execFileSync("git", ["-C", repo, "add", "-A"])
    return execFileSync("git", ["-C", repo, "write-tree"], { encoding: "utf8" }).trim()
  }
  const consumersOf = (base: string, kind: string, name: string): string[] | undefined => {
    const found = findConsumers(repo, base, snapshot()).find((entry) => entry.kind === kind && entry.name === name)
    return found?.consumers.map((consumer) => `${consumer.path}:${consumer.line}`)
  }
  const namesOf = (base: string): string[] => findConsumers(repo, base, snapshot()).map((entry) => `${entry.kind} ${entry.name}`)

  it("findConsumers_listsEveryRemainingUseOfARemovedExport", () => {
    write("src/lib.ts", ["export function oldName(): number {", "  return 1", "}"])
    write("src/use.ts", ["import { oldName } from './lib.ts'", "oldName()"])
    const base = snapshot()
    write("src/lib.ts", ["export const other = 2"])

    assert.deepEqual(consumersOf(base, "export", "oldName"), ["src/use.ts:1", "src/use.ts:2"])
  })

  it("findConsumers_namesAnExportWhoseBodyChanged_andLeavesItsOwnDeclarationLineOut", () => {
    write("src/lib.ts", ["export function total(a: number): number {", "  return a", "}"])
    write("src/use.ts", ["import { total } from './lib.ts'", "total(1)"])
    const base = snapshot()
    write("src/lib.ts", ["export function total(a: number): number {", "  return a + 1", "}"])

    assert.deepEqual(consumersOf(base, "export", "total"), ["src/use.ts:1", "src/use.ts:2"])
  })

  it("findConsumers_namesAnExportWhoseBodyLostItsLastLine", () => {
    write("src/lib.ts", ["export function steps(): number[] {", "  const out = [1]", "  out.push(2)", "  return out", "}"])
    write("src/use.ts", ["steps()"])
    const base = snapshot()
    write("src/lib.ts", ["export function steps(): number[] {", "  const out = [1]", "  return out", "}"])

    assert.deepEqual(consumersOf(base, "export", "steps"), ["src/use.ts:1"])
  })

  it("findConsumers_ignoresABodyChangeInAFunctionThatIsNotExported", () => {
    write("src/lib.ts", ["function hidden(): number {", "  return 1", "}", "export const shown = hidden()"])
    const base = snapshot()
    write("src/lib.ts", ["function hidden(): number {", "  return 2", "}", "export const shown = hidden()"])

    assert.deepEqual(namesOf(base), [])
  })

  it("findConsumers_looksForEnclosingExportsOnlyInScriptFiles", () => {
    write("docs/guide.md", ["export function sample() {}", "  first", "  second"])
    const base = snapshot()
    write("docs/guide.md", ["export function sample() {}", "  first", "  changed"])

    assert.deepEqual(namesOf(base), [])
  })

  it("findConsumers_reportsANewExportWithNoConsumers_becauseItsOnlyHitIsInsideTheDiff", () => {
    write("src/lib.ts", ["export const kept = 1"])
    const base = snapshot()
    write("src/lib.ts", ["export const kept = 1", "export const fresh = 2"])

    assert.deepEqual(consumersOf(base, "export", "fresh"), [])
  })

  it("findConsumers_dropsAUseAddedByTheDiff_butKeepsAnUnchangedUseInAChangedFile", () => {
    write("src/lib.ts", ["export function total(): number {", "  return 1", "}"])
    write("src/use.ts", ["total()", "const unrelated = 1"])
    const base = snapshot()
    write("src/lib.ts", ["export function total(): number {", "  return 2", "}"])
    write("src/use.ts", ["total()", "const unrelated = 2", "total()"])

    assert.deepEqual(consumersOf(base, "export", "total"), ["src/use.ts:1"])
  })

  it("findConsumers_listsUsesOfAnExportFromADeletedFile", () => {
    write("src/gone.ts", ["export function gone(): void {}"])
    write("tests/gone.test.ts", ["gone()"])
    const base = snapshot()
    fs.rmSync(path.join(repo, "src/gone.ts"))

    assert.deepEqual(consumersOf(base, "export", "gone"), ["tests/gone.test.ts:1"])
  })

  it("findConsumers_readsTheExportedNameOfAnAliasedExportList", () => {
    write("src/lib.ts", ["const inner = 1", "export { inner as outer }"])
    write("src/use.ts", ["outer"])
    const base = snapshot()
    write("src/lib.ts", ["const inner = 1"])

    assert.deepEqual(consumersOf(base, "export", "outer"), ["src/use.ts:1"])
  })

  it("findConsumers_namesOnlyTheEntryAShrinkingExportListDropped", () => {
    write("src/lib.ts", ["const a = 1", "const b = 2", "export { a, b }"])
    write("src/use.ts", ["a", "b"])
    const base = snapshot()
    write("src/lib.ts", ["const a = 1", "const b = 2", "export { a }"])

    assert.deepEqual(namesOf(base), ["export b"])
  })

  it("findConsumers_readsANonAsciiPathAsWritten", () => {
    write("src/café.ts", ["export function compute(): void {}"])
    write("src/naïve.ts", ["compute()"])
    const base = snapshot()
    fs.rmSync(path.join(repo, "src/café.ts"))

    assert.deepEqual(consumersOf(base, "export", "compute"), ["src/naïve.ts:1"])
  })

  it("findConsumers_keepsAUseOnTheUnchangedDeclarationLineOfAnotherChangedExport", () => {
    write("src/lib.ts", ["export const LIMIT = 1", "export function total(n = LIMIT): number {", "  return n", "}"])
    write("src/use.ts", ["LIMIT"])
    const base = snapshot()
    write("src/lib.ts", ["export const LIMIT = 2", "export function total(n = LIMIT): number {", "  return n + 1", "}"])

    assert.deepEqual(consumersOf(base, "export", "LIMIT"), ["src/lib.ts:2", "src/use.ts:1"])
  })

  it("findConsumers_readsAChangedPathThatContainsASpace", () => {
    write("src/my lib.ts", ["export function total(): number {", "  return 1", "}"])
    write("src/use.ts", ["total()"])
    const base = snapshot()
    write("src/my lib.ts", ["export function total(): number {", "  return 2", "}"])

    assert.deepEqual(consumersOf(base, "export", "total"), ["src/use.ts:1"])
  })

  it("findConsumers_namesAnEntryDroppedFromAMultiLineExportList", () => {
    write("src/lib.ts", ["const a = 1", "const b = 2", "export {", "  a,", "  b,", "}"])
    write("src/use.ts", ["b"])
    const base = snapshot()
    write("src/lib.ts", ["const a = 1", "const b = 2", "export {", "  a,", "}"])

    assert.deepEqual(namesOf(base), ["export b"])
    assert.deepEqual(consumersOf(base, "export", "b"), ["src/lib.ts:2", "src/use.ts:1"])
  })

  it("findConsumers_readsANewScriptFileThatTheBaseDoesNotHave", () => {
    write("src/kept.ts", ["export const kept = 1"])
    const base = snapshot()
    write("src/added.ts", ["export const added = 1"])

    assert.deepEqual(consumersOf(base, "export", "added"), [])
  })

  it("findConsumers_namesATypeOnlyEntryByItsTypeName", () => {
    write("src/lib.ts", ["interface Shape {}", "const other = 1", "export { type Shape, other }"])
    write("src/use.ts", ["let s: Shape"])
    const base = snapshot()
    write("src/lib.ts", ["interface Shape {}", "const other = 1", "export { other }"])

    assert.deepEqual(consumersOf(base, "export", "Shape"), ["src/lib.ts:1", "src/use.ts:1"])
  })

  it("findConsumers_readsTheNameOfAConstEnum", () => {
    write("src/lib.ts", ["export const enum Color { Red }"])
    write("src/use.ts", ["Color.Red"])
    const base = snapshot()
    write("src/lib.ts", ["export const other = 1"])

    assert.deepEqual(consumersOf(base, "export", "Color"), ["src/use.ts:1"])
  })

  it("findConsumers_ignoresAnExportLineRemovedFromANonScriptFile", () => {
    write("docs/guide.md", ["export function sample() {}", "text"])
    const base = snapshot()
    write("docs/guide.md", ["text"])

    assert.deepEqual(namesOf(base), [])
  })

  it("findConsumers_listsAFlagRenamedInsideAShellScript", () => {
    write("bin/run.sh", ["keel diff --old-flag"])
    write("docs/usage.md", ["Run keel diff --old-flag first."])
    const base = snapshot()
    write("bin/run.sh", ["keel diff --new-flag"])

    assert.deepEqual(consumersOf(base, "flag", "--old-flag"), ["docs/usage.md:1"])
  })

  it("findConsumers_matchesARenamedFlagExactly_andSkipsAFlagThatOnlyExtendsIt", () => {
    write("bin/cli.ts", ["const FLAG = '--since'", "const OTHER = '--quiet' // was"])
    write("bin/run.sh", ["keel diff --since x", "keel diff --since-tree y"])
    const base = snapshot()
    write("bin/cli.ts", ["const FLAG = '--from'", "const OTHER = '--quiet' // now"])

    assert.deepEqual(consumersOf(base, "flag", "--since"), ["bin/run.sh:1"])
    assert.deepEqual(consumersOf(base, "flag", "--from"), [])
    assert.equal(consumersOf(base, "flag", "--quiet"), undefined)
  })

  it("findConsumers_keepsTheWholeNameOfAHyphenatedFlag", () => {
    write("bin/cli.ts", ["const FLAG = '--dry-run'"])
    write("bin/run.sh", ["keel ship --dry-run", "keel ship --dry"])
    const base = snapshot()
    write("bin/cli.ts", ["const FLAG = '--preview'"])

    assert.deepEqual(consumersOf(base, "flag", "--dry-run"), ["bin/run.sh:1"])
    assert.equal(consumersOf(base, "flag", "--dry"), undefined)
  })

  it("findConsumers_listsARenamedJsonKey_butNotAKeyWhoseValueAloneChanged", () => {
    write("config.json", ["{", '  "limit": 1,', '  "label": "a"', "}"])
    write("src/read.ts", ["config.limit", "config.label"])
    const base = snapshot()
    write("config.json", ["{", '  "max": 1,', '  "label": "b"', "}"])

    assert.deepEqual(consumersOf(base, "key", "limit"), ["src/read.ts:1"])
    assert.equal(consumersOf(base, "key", "label"), undefined)
  })

  it("findConsumers_ordersNamesByKindThenName", () => {
    write("config.json", ["{", '  "zeta": 1', "}"])
    write("src/lib.ts", ["export const beta = 1", "export const alpha = 1", "const FLAG = '--old'"])
    const base = snapshot()
    write("config.json", ["{}"])
    write("src/lib.ts", ["const FLAG = '--new'"])

    assert.deepEqual(namesOf(base), ["export alpha", "export beta", "flag --new", "flag --old", "key zeta"])
  })
})
