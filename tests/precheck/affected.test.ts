import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { affectedTests, changedSince, CORPUS_TESTS, FULL_SUITE_PATTERNS, fullSuitePaths } from "../../lib/precheck/affected.ts"
import { committedRepo, writeFiles } from "./fixture.ts"

const KEEL_ROOT = join(import.meta.dirname, "..", "..")
const KEEL = join(KEEL_ROOT, "bin", "keel")
const PASSING_TEST = (imported: string) => `import { it } from 'node:test'\nimport '${imported}'\nit('runs', () => {})\n`

const roots: string[] = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
const commitAll = (root: string, message: string): void => {
  git(root, "add", "-A")
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message)
}
const topicRepo = (base: Record<string, string>): string => {
  const root = committedRepo(base)
  roots.push(root)
  git(root, "branch", "-q", "trunk")
  git(root, "checkout", "-q", "-b", "topic")
  return root
}
const scratchDir = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  roots.push(directory)
  return directory
}

describe("affectedTests", () => {
  const [corpusTest] = CORPUS_TESTS

  it("affectedTests_dropsACorpusReplayReachedOnlyFromProductCode_andKeepsTheOtherReachedTests", () => {
    const root = topicRepo({
      "hooks/guard/guard.ts": "export const a = 1",
      "tests/hooks/guard.test.ts": "import '../../hooks/guard/guard.ts'",
      [corpusTest!]: "import '../../hooks/guard/guard.ts'",
    })

    assert.deepEqual(affectedTests(root, ["hooks/guard/guard.ts"]), ["tests/hooks/guard.test.ts"])
  })

  it("affectedTests_keepsACorpusReplayWhenAChangedTestFileReachesIt", () => {
    const root = topicRepo({
      "hooks/guard/guard.ts": "export const a = 1",
      "tests/hooks/replay.ts": "import '../../hooks/guard/guard.ts'",
      [corpusTest!]: "import './replay.ts'",
    })

    assert.deepEqual(affectedTests(root, ["hooks/guard/guard.ts", "tests/hooks/replay.ts"]), [corpusTest])
    assert.deepEqual(affectedTests(root, [corpusTest!]), [corpusTest])
  })

  it("corpusTests_nameReplayFilesThatExistInThisRepo", () => {
    assert.equal(CORPUS_TESTS.length, 11)
    for (const test of CORPUS_TESTS) assert.ok(existsSync(join(KEEL_ROOT, test)), `${test} is missing`)
  })
})

describe("changedSince", () => {
  it("changedSince_listsTheBranchCommits_theWorkingTree_untrackedFiles_andBothSidesOfARename_butNotTheBaseSide", () => {
    const root = topicRepo({ "lib/old.ts": "export const old = 1\n", "lib/kept.ts": "export const kept = 1\n" })
    git(root, "checkout", "-q", "trunk")
    writeFiles(root, { "lib/trunk-only.ts": "export {}\n" })
    commitAll(root, "trunk moved")
    git(root, "checkout", "-q", "topic")
    writeFiles(root, { "lib/committed.ts": "export {}\n" })
    commitAll(root, "topic")
    git(root, "mv", "lib/old.ts", "lib/renamed.ts")
    writeFiles(root, { "lib/kept.ts": "export const kept = 2\n", "lib/untracked.ts": "export {}\n" })

    assert.deepEqual(changedSince(root, git(root, "merge-base", "trunk", "HEAD")), ["lib/committed.ts", "lib/kept.ts", "lib/old.ts", "lib/renamed.ts", "lib/untracked.ts"])
  })
})

describe("fullSuitePaths", () => {
  it("fullSuitePaths_keepsCodeAHookRuns_andDropsDocsTestsAndOtherSettings", () => {
    const paths = ["docs/a.md", "lib/evidence/verify.ts", "measure/boundary_check.ts", "measure/smoke.ts", "settings/core.json", "settings/other.json", "tests/a.test.ts"]

    assert.deepEqual(fullSuitePaths(paths), ["lib/evidence/verify.ts", "measure/boundary_check.ts", "settings/core.json"])
  })

  it("fullSuitePatterns_areTheListTheReviewPolicyNames", () => {
    const policy = readFileSync(join(KEEL_ROOT, "docs", "review-policy.md"), "utf8")
    for (const pattern of FULL_SUITE_PATTERNS) assert.ok(policy.includes(`\`${pattern}\``), `review-policy.md does not name ${pattern}`)
  })
})

describe("keel test --affected", () => {
  const { NODE_TEST_CONTEXT: _parentRunner, ...standaloneEnv } = process.env
  const keel = (root: string, args: string[], dataDir: string) =>
    spawnSync(KEEL, ["test", "--affected", ...args], { cwd: root, encoding: "utf8", env: { ...standaloneEnv, KEEL_DATA_DIR: dataDir } })
  const remoteRepo = (): string => {
    const root = topicRepo({
      "lib/a.ts": "export const a = 1\n",
      "lib/b.ts": "export const b = 1\n",
      "tests/a.test.ts": PASSING_TEST("../lib/a.ts"),
      "tests/b.test.ts": PASSING_TEST("../lib/b.ts"),
    })
    git(root, "remote", "add", "origin", "https://example.com/acme/app.git")
    return root
  }

  it("keelTestAffected_runsOnlyTheTestsTheChangedPathsReach_andWritesTestsEvidence", () => {
    const root = remoteRepo()
    writeFiles(root, { "lib/a.ts": "export const a = 2\n" })
    const dataDir = scratchDir("keel-data-")

    const completed = keel(root, ["--base", "trunk"], dataDir)

    assert.equal(completed.status, 0, completed.stderr)
    assert.match(completed.stderr, /^keel test --affected: 1 test file reaches 1 changed path\ntests\/a\.test\.ts\n/)
    assert.match(completed.stderr, /^KEEL-TEST \{"run_id":"[^"]+","count":1,"exit":0,"evidence_id":"[^"]+"/m)
    const evidenceFiles = readdirSync(join(dataDir, "state", "keel", "evidence", "tests"), { recursive: true }).filter((name) => String(name).endsWith(".json"))
    assert.equal(evidenceFiles.length, 1)
  })

  it("keelTestAffected_notesTheFullSuiteWhenAChangedPathIsCodeAHookRuns", () => {
    const root = remoteRepo()
    writeFiles(root, { "lib/a.ts": "export const a = 2\n" })

    const completed = keel(root, ["--base", "trunk"], scratchDir("keel-data-"))

    assert.match(completed.stderr, /^keel test --affected: code a hook runs changed \(lib\/a\.ts\); also run `keel test -- npm test` once before root review$/m)
  })

  it("keelTestAffected_exitsFourWithoutRunning_whenNoTestReachesTheChangedPaths", () => {
    const root = remoteRepo()
    writeFiles(root, { "docs/notes.md": "notes\n" })

    const completed = keel(root, ["--base", "trunk"], scratchDir("keel-data-"))

    assert.equal(completed.status, 4, completed.stderr)
    assert.match(completed.stderr, /^keel test --affected: no test file reaches the 1 changed path; run `keel test -- <command>` with a test that covers it$/m)
    assert.doesNotMatch(completed.stderr, /KEEL-TEST/)
  })

  it("keelTestAffected_defaultsTheBaseToOriginHead", () => {
    const root = remoteRepo()
    git(root, "update-ref", "refs/remotes/origin/trunk", "trunk")
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    writeFiles(root, { "lib/b.ts": "export const b = 2\n" })

    const completed = keel(root, [], scratchDir("keel-data-"))

    assert.equal(completed.status, 0, completed.stderr)
    assert.match(completed.stderr, /\ntests\/b\.test\.ts\n/)
  })

  it("keelTestAffected_rejectsAnUnknownOption_aDashedBase_andABaseWithoutAMergeBase", () => {
    const root = remoteRepo()
    const dataDir = scratchDir("keel-data-")

    assert.equal(keel(root, ["--only", "x"], dataDir).status, 2)
    assert.equal(keel(root, ["--base", "-x"], dataDir).status, 2)
    const unknownBase = keel(root, ["--base", "no-such-ref"], dataDir)
    assert.equal(unknownBase.status, 3)
    assert.match(unknownBase.stderr, /no-such-ref has no merge base with HEAD/)
  })
})
