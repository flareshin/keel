import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import { performance } from "node:perf_hooks"
import { readTraceEnv, readTracedPaths } from "../../lib/precheck/readtrace.ts"

describe("read trace", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "keel-readtrace-test-")))
  after(() => rmSync(scratch, { recursive: true, force: true }))
  const repo = (name: string, files: Record<string, string>): string => {
    const root = join(scratch, name)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return root
  }

  it("readTraceEnv_keepsTheInheritedNodeOptions", () => {
    assert.match(readTraceEnv("/log", "--max-old-space-size=512").NODE_OPTIONS ?? "", /^--max-old-space-size=512 --import=file:/u)
    assert.match(readTraceEnv("/log", "").NODE_OPTIONS ?? "", /^--import=file:/u)
  })

  it("readTracedPaths_isEmpty_whenNoProcessLoggedARead", () => {
    assert.deepEqual([...readTracedPaths(join(scratch, "absent.log"), repo("empty", { "a.js": "" }))], [])
  })

  it("readTracedPaths_expandsADirectoryRead_andLeavesOutPathsOutsideTheRepoAndGoneFiles", () => {
    const root = repo("expand", { "lib/a.js": "", "lib/deep/b.js": "", "other/c.js": "" })
    repo("expand-sibling", { "d.js": "" })
    writeFileSync(join(scratch, "outside.js"), "")
    const log = join(scratch, "expand.log")
    writeFileSync(log, [join(root, "lib"), join(root, "gone.js"), join(scratch, "outside.js"), join(root + "-sibling", "d.js")].join("\n") + "\n")

    assert.deepEqual([...readTracedPaths(log, root)].sort(), ["lib/a.js", "lib/deep/b.js"])
  })

  it("preload_logsAReadByADefaultImport_andKeepsItsResult", () => {
    const root = repo("default", { "a.js": "hello" })
    const log = join(scratch, "default.log")
    const script = "import fs from 'node:fs'\nprocess.stdout.write(fs.readFileSync('a.js', 'utf8'))\n"

    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", env: { ...process.env, ...readTraceEnv(log) } })

    assert.equal(output, "hello")
    assert.deepEqual([...readTracedPaths(log, root)], ["a.js"])
  })

  it("readTracedPaths_leavesOutAReadOfTheRepoRoot_soACopyOfTheWholeRepoSelectsNoMutant", () => {
    const root = repo("root", { "lib/a.js": "" })
    const log = join(scratch, "root.log")
    writeFileSync(log, root + "\n")

    assert.deepEqual([...readTracedPaths(log, root)], [])
  })

  it("readTracedPaths_listsADeepDirectoryOnce", () => {
    const depth = 20
    const nested = Array.from({ length: depth }, (_, level) => "d" + level).join("/")
    const root = repo("deep", { [nested + "/a.js"]: "" })
    const log = join(scratch, "deep.log")
    writeFileSync(log, join(root, "d0") + "\n")
    const started = performance.now()

    assert.deepEqual([...readTracedPaths(log, root)], [nested + "/a.js"])
    assert.ok(performance.now() - started < 5000)
  })

  it("preload_letsACallbackOpenCreateAMissingFile", () => {
    const root = repo("create", { "a.js": "" })
    const script = "require('node:fs').open('new.txt', 'w', (error) => process.stdout.write(String(error)))\n"

    const output = execFileSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", env: { ...process.env, ...readTraceEnv(join(scratch, "create.log")) } })

    assert.equal(output, "null")
  })

  it("preload_leavesASymlinkLoopErrorToTheRealRead", () => {
    const root = repo("loop", { "a.js": "" })
    symlinkSync("loop", join(root, "loop"))
    const script = "require('node:fs').promises.readFile('loop').then(() => {}, (error) => process.stdout.write(error.code))\n"

    const output = execFileSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", env: { ...process.env, ...readTraceEnv(join(scratch, "loop.log")) } })

    assert.equal(output, "ELOOP")
  })

  it("preload_leavesABadFileUrlErrorToTheRealRead", () => {
    const root = repo("bad-url", { "a.js": "" })
    const script = "require('node:fs').promises.readFile(new URL('file:///a%2Fb')).then(() => {}, (error) => process.stdout.write(error.code))\n"

    const output = execFileSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", env: { ...process.env, ...readTraceEnv(join(scratch, "bad-url.log")) } })

    assert.equal(output, "ERR_INVALID_FILE_URL_PATH")
  })

  it("preload_leavesReadsWorking_whenTheLogSettingIsGone", () => {
    const root = repo("nolog", { "a.js": "hello" })
    const script = "process.stdout.write(require('node:fs').readFileSync('a.js', 'utf8'))\n"

    const output = execFileSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", env: { PATH: process.env["PATH"], NODE_OPTIONS: readTraceEnv(join(scratch, "unused.log")).NODE_OPTIONS } })

    assert.equal(output, "hello")
  })
})
