import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { GitError, snapshotTree } from "../../lib/evidence/gitcmd.ts"
import { baselineTimeoutSeconds, materializeTree, runBaseline } from "../../lib/precheck/baseline.ts"
import { committedRepo, executedLineNumbers, writeFiles as write } from "./fixture.ts"

const EXECUTABLE_BITS = 0o111
const TIMEOUT_SECONDS = 60
const MISSING_TREE = "0".repeat(40)
const git = (directory: string, ...args: string[]): string => execFileSync("git", ["-C", directory, ...args]).toString().trim()

describe("precheck baseline", () => {
  const directories: string[] = []
  after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })))
  const repo = (committed: Record<string, string>): string => {
    const root = committedRepo(committed)
    directories.push(root)
    return root
  }
  const materialized = (files: Record<string, string>): string => {
    const root = repo(files)
    const directory = materializeTree(root, snapshotTree(root))
    directories.push(directory)
    return directory
  }
  const passing = (name: string, body = "") => `import { it } from "node:test"\n${body}\nit("${name}", () => {})\n`

  it("materializeTree_checksOutTheSnapshotWithUncommittedEdits_andKeepsTheExecutableBit", () => {
    const root = repo({ "lib/a.ts": "export const a = 1\n", "bin/run": "#!/bin/bash\necho run\n" })
    chmodSync(join(root, "bin", "run"), 0o755)
    write(root, { "lib/a.ts": "export const a = 2\n", "lib/new.ts": "export const fresh = true\n" })
    const statusBefore = execFileSync("git", ["-C", root, "status", "--porcelain"]).toString()

    const directory = materializeTree(root, snapshotTree(root))
    directories.push(directory)

    assert.equal(readFileSync(join(directory, "lib", "a.ts"), "utf8"), "export const a = 2\n")
    assert.equal(readFileSync(join(directory, "lib", "new.ts"), "utf8"), "export const fresh = true\n")
    assert.notEqual(statSync(join(directory, "bin", "run")).mode & EXECUTABLE_BITS, 0)
    assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"]).toString(), statusBefore)
  })

  it("materializeTree_linksTheRepoDependencies_onlyWhenTheRepoHasThem", () => {
    const withDependencies = repo({ ".gitignore": "node_modules/\n", "node_modules/pkg/index.js": "export default 1\n" })
    const withoutDependencies = repo({ "lib/a.ts": "export const a = 1\n" })

    const linked = materializeTree(withDependencies, snapshotTree(withDependencies))
    const bare = materializeTree(withoutDependencies, snapshotTree(withoutDependencies))
    directories.push(linked, bare)

    assert.ok(lstatSync(join(linked, "node_modules")).isSymbolicLink())
    assert.equal(readlinkSync(join(linked, "node_modules")), join(withDependencies, "node_modules"))
    assert.equal(readdirSync(bare).includes("node_modules"), false)
  })

  it("materializeTree_makesACleanGitCheckoutOfTheSnapshotOnTopOfTheRepoHead", async () => {
    const root = repo({ ".gitignore": "node_modules/\n", "node_modules/pkg/index.js": "export default 1\n", "lib/a.ts": "export const a = 1\n" })
    write(root, { "lib/a.ts": "export const a = 2\n" })

    const directory = materializeTree(root, snapshotTree(root))
    directories.push(directory)
    write(directory, {
      "tests/top.test.ts": passing("top", "import assert from 'node:assert/strict'\nimport { execFileSync } from 'node:child_process'\nassert.equal(execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim(), process.cwd())"),
    })
    const baseline = await runBaseline(directory, ["tests/top.test.ts"], TIMEOUT_SECONDS)

    assert.equal(baseline.outcome, "green")
    assert.equal(git(directory, "rev-parse", "HEAD^"), git(root, "rev-parse", "HEAD"))
    assert.equal(git(directory, "show", "HEAD:lib/a.ts"), "export const a = 2")
    assert.equal(git(directory, "status", "--porcelain", "--", ".", ":!tests/top.test.ts"), "")
  })

  it("materializeTree_ignoresTheUsersInitTemplate_andStillLeavesACleanCheckout", () => {
    const root = repo({ ".gitignore": "node_modules/\n", "node_modules/pkg/index.js": "export default 1\n" })
    const template = mkdtempSync(join(tmpdir(), "precheck-template-"))
    directories.push(template)
    write(template, { "hooks/post-checkout": "#!/bin/sh\ntouch hook-ran\n" })
    chmodSync(join(template, "hooks", "post-checkout"), 0o755)
    const config = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "init.templateDir", GIT_CONFIG_VALUE_0: template }
    Object.assign(process.env, config)
    try {
      const directory = materializeTree(root, snapshotTree(root))
      directories.push(directory)

      assert.equal(existsSync(join(directory, ".git", "hooks", "post-checkout")), false)
      assert.equal(git(directory, "status", "--porcelain"), "")
    } finally {
      Object.keys(config).forEach((key) => delete process.env[key])
    }
  })

  it("materializeTree_removesItsDirectoryWhenTheCheckoutFails", () => {
    const root = repo({ "lib/a.ts": "export const a = 1\n" })
    const temporary = mkdtempSync(join(tmpdir(), "precheck-tmpdir-"))
    directories.push(temporary)
    const previous = process.env.TMPDIR
    process.env.TMPDIR = temporary
    try {
      assert.throws(() => materializeTree(root, MISSING_TREE), GitError)
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }

    assert.deepEqual(readdirSync(temporary), [])
  })

  it("runBaseline_recordsPassesDurationAndTheLinesEachTestFileRan", async () => {
    const directory = materialized({
      "lib/a.ts": "export function pick(flag: boolean): number {\n  if (flag) return 1\n  return 2\n}\n",
      "tests/a.test.ts": passing("picks", "import { pick } from '../lib/a.ts'\npick(true)"),
    })

    const baseline = await runBaseline(directory, ["tests/a.test.ts"], TIMEOUT_SECONDS)

    assert.equal(baseline.outcome, "green")
    const [file] = baseline.files
    assert.equal(file?.test, "tests/a.test.ts")
    assert.equal(file?.passed, 1)
    assert.ok((file?.durationMs ?? 0) > 0)
    assert.ok(file?.coverage.seen.has("lib/a.ts"))
    assert.deepEqual(executedLineNumbers(join(directory, "lib", "a.ts"), file?.coverage.executedSpans.get("lib/a.ts") ?? []), [1, 2, 4])
  })

  it("runBaseline_keepsEachTestFilesCoverageApart", async () => {
    const directory = materialized({
      "lib/a.ts": "export const a = () => 1\n",
      "lib/b.ts": "export const b = () => 2\n",
      "tests/a.test.ts": passing("a", "import { a } from '../lib/a.ts'\na()"),
      "tests/b.test.ts": passing("b", "import { b } from '../lib/b.ts'\nb()"),
    })

    const baseline = await runBaseline(directory, ["tests/a.test.ts", "tests/b.test.ts"], TIMEOUT_SECONDS)

    assert.equal(baseline.outcome, "green")
    assert.deepEqual(baseline.files.map((file) => [file.test, file.coverage.seen.has("lib/a.ts"), file.coverage.seen.has("lib/b.ts")]), [
      ["tests/a.test.ts", true, false],
      ["tests/b.test.ts", false, true],
    ])
  })

  it("runBaseline_seesLinesRunInsideAChildProcessTheTestSpawns", async () => {
    const directory = materialized({
      "hooks/guard.ts": "console.log('guarded')\n",
      "tests/guard.test.ts": passing("spawns", "import { execFileSync } from 'node:child_process'\nexecFileSync(process.execPath, ['hooks/guard.ts'])"),
    })

    const baseline = await runBaseline(directory, ["tests/guard.test.ts"], TIMEOUT_SECONDS)

    assert.equal(baseline.outcome, "green")
    assert.ok(baseline.files[0]?.coverage.seen.has("hooks/guard.ts"))
  })

  it("runBaseline_countsPassesButNotSkips", async () => {
    const directory = materialized({
      "tests/a.test.ts": "import { it } from 'node:test'\nit('one', () => {})\nit('two', () => {})\nit('later', { skip: true }, () => {})\nconsole.log('# pass 9')\n",
    })

    const baseline = await runBaseline(directory, ["tests/a.test.ts"], TIMEOUT_SECONDS)

    assert.equal(baseline.outcome, "green")
    assert.equal(baseline.files[0]?.passed, 2)
  })

  it("runBaseline_stopsAtTheFirstRedFile", async () => {
    const directory = materialized({
      "tests/a.test.ts": "import { it } from 'node:test'\nit('breaks', () => { throw new Error('red baseline') })\n",
      "tests/b.test.ts": passing("fine"),
      "tests/c.test.ts": passing("after", "import { writeFileSync } from 'node:fs'\nwriteFileSync('ran-after-red', '')"),
    })

    const baseline = await runBaseline(directory, ["tests/b.test.ts", "tests/a.test.ts", "tests/c.test.ts"], TIMEOUT_SECONDS)

    assert.equal(baseline.outcome, "red")
    assert.equal(baseline.test, "tests/a.test.ts")
    assert.match(baseline.output, /red baseline/u)
    assert.equal(existsSync(join(directory, "ran-after-red")), false)
  })

  it("runBaseline_setsAsideAFileWithNoPasses_andIsEmptyWhenNoFilePasses", async () => {
    const skipping = "import { describe, it } from 'node:test'\ndescribe('needs typescript', { skip: 'absent' }, () => { it('x', () => {}) })\n"
    const directory = materialized({ "tests/skip.test.ts": skipping, "tests/a.test.ts": passing("fine") })

    const mixed = await runBaseline(directory, ["tests/skip.test.ts", "tests/a.test.ts"], TIMEOUT_SECONDS)
    const onlySkipping = await runBaseline(directory, ["tests/skip.test.ts"], TIMEOUT_SECONDS)

    assert.equal(mixed.outcome, "green")
    assert.deepEqual(mixed.files.map((file) => file.test), ["tests/a.test.ts"])
    assert.deepEqual(mixed.withoutPasses, ["tests/skip.test.ts"])
    assert.deepEqual(onlySkipping, { outcome: "empty" })
  })

  it("runBaseline_reportsATimeoutForAFileThatOutrunsTheLimit", async () => {
    const directory = materialized({
      "tests/slow.test.ts": "import { writeFileSync } from 'node:fs'\nimport { it } from 'node:test'\nit('waits', () => new Promise((resolve) => setTimeout(() => { writeFileSync('marker', ''); resolve() }, 2500)))\n",
    })

    const baseline = await runBaseline(directory, ["tests/slow.test.ts"], 1)
    await new Promise((resolve) => setTimeout(resolve, 3500))

    assert.equal(baseline.outcome, "timeout")
    assert.equal(baseline.test, "tests/slow.test.ts")
    assert.equal(baseline.timeoutSeconds, 1)
    assert.equal(existsSync(join(directory, "marker")), false)
  })

  it("baselineTimeoutSeconds_keeps300sOnAnIdleHost_scalesWithLoadPerCpu_andCapsAt2400s", () => {
    assert.equal(baselineTimeoutSeconds(0.5, 12), 300)
    assert.equal(baselineTimeoutSeconds(12, 12), 300)
    assert.equal(baselineTimeoutSeconds(13, 12), 325)
    assert.equal(baselineTimeoutSeconds(24, 12), 600)
    assert.equal(baselineTimeoutSeconds(96, 12), 2400)
    assert.equal(baselineTimeoutSeconds(147, 12), 2400)
  })
})
