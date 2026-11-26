import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import { ruleCheckOutputLines, typecheck } from "../../lib/precheck/author.ts"
import { writeFiles } from "./fixture.ts"

const KEEL_ROOT = join(import.meta.dirname, "..", "..")
const TYPESCRIPT_PACKAGE = dirname(createRequire(import.meta.url).resolve("typescript/package.json"))

describe("typecheck", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "precheck-tsc-")))
  after(() => rmSync(scratch, { recursive: true, force: true }))

  it("runsTheTypescriptAParentFolderOfTheKeelCheckoutProvides_whenNeitherTheRepoNorTheCheckoutHasNodeModules", () => {
    const checkout = keelCheckoutWithTypescriptOnlyInAParentFolder(join(scratch, "worktrees"))
    const repo = join(scratch, "repo")
    writeFiles(repo, { "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [] }, include: ["*.ts"] }), "broken.ts": "export const broken: number = 'text'\n" })
    const program = `const { typecheck } = await import(${JSON.stringify(join(checkout, "lib", "precheck", "author.ts"))}); console.log(JSON.stringify(typecheck(${JSON.stringify(repo)})))`

    const completed = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" })

    assert.equal(completed.status, 0, completed.stderr)
    const result = JSON.parse(completed.stdout)
    assert.equal(result.ok, false)
    assert.match(result.head, /broken\.ts.*TS2322/)
  })

  it("runsTheRepositorysOwnTypescript_whenTheRepositoryHasItInNodeModules", () => {
    const repo = join(scratch, "repo-with-typescript")
    writeFiles(repo, { "tsconfig.json": "{}", "node_modules/typescript/bin/tsc": "console.log('the repository tsc ran'); process.exit(1)\n" })

    assert.deepEqual(typecheck(repo), { ok: false, head: "the repository tsc ran" })
  })
})

function keelCheckoutWithTypescriptOnlyInAParentFolder(parent: string): string {
  mkdirSync(join(parent, "node_modules"), { recursive: true })
  symlinkSync(TYPESCRIPT_PACKAGE, join(parent, "node_modules", "typescript"))
  const checkout = join(parent, "keel")
  cpSync(join(KEEL_ROOT, "lib"), join(checkout, "lib"), { recursive: true })
  cpSync(join(KEEL_ROOT, "measure", "lib"), join(checkout, "measure", "lib"), { recursive: true })
  return checkout
}

describe("ruleCheckOutputLines", () => {
  it("prefixesEveryLine_andAddsTheExitCodeAndEachStderrLine_whenRuleChecksExitsNonZero", () => {
    const completed = { returncode: 2, stdout: Buffer.from("summary repos=1 scanned_lines=0 signals=0 unscanned=none blocked=vendor/sub\n"), stderr: Buffer.from("Error: boom\n    at scan (rule-checks.ts:1)\n") }

    assert.deepEqual(ruleCheckOutputLines(completed), [
      "rule-checks totals repos=1 scanned_lines=0 signals=0 unscanned=none blocked=vendor/sub",
      "rule-checks exit 2",
      "rule-checks Error: boom",
      "rule-checks     at scan (rule-checks.ts:1)",
    ])
  })

  it("printsOnlyTheStdoutLines_withTheSummaryRenamedSoLensReviewDoesNotCountIt_whenRuleChecksExitsZero", () => {
    const completed = { returncode: 0, stdout: Buffer.from("summary repos=1 scanned_lines=2 signals=0 unscanned=none blocked=none\n"), stderr: Buffer.from("ignored\n") }

    assert.deepEqual(ruleCheckOutputLines(completed), ["rule-checks totals repos=1 scanned_lines=2 signals=0 unscanned=none blocked=none"])
  })
})
