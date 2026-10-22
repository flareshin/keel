import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { NEUTRAL_PROJECT_NAME, runOnce } from "../../measure/evals/lib/evalkit/runner.ts"
import { CHECKOUT } from "./helpers.ts"

const K4_FIXTURE = path.join(CHECKOUT, "measure", "evals", "K4", "repo")
const META_WORDS = ["eval", "test", "judge", "fixture", "keel", "candidate"]
const TIMEOUT = 30
const RECORDER = [
  'const { spawnSync } = require("node:child_process")',
  'const fs = require("node:fs")',
  'const identity = spawnSync("git", ["log", "-1", "--format=%an%n%ae%n%cn%n%ce"], { encoding: "utf8" }).stdout.split(/\\s+/).filter(Boolean)',
  "fs.writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), identity }))",
].join("\n")

describe("runOnce blinding", () => {
  let root: string
  let seenPath: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-runner-test-")))
    seenPath = path.join(root, "seen.json")
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  function runRecorder(fixture: string): { cwd: string; identity: string[] } {
    runOnce("prompt", fixture, [process.execPath, "-e", RECORDER, seenPath], root, TIMEOUT)
    return JSON.parse(fs.readFileSync(seenPath, "utf8"))
  }

  function fixtureWithReadme(readme: string | Buffer | null): string {
    const fixture = fs.mkdtempSync(path.join(root, "fixture-"))
    fs.writeFileSync(path.join(fixture, "notes.txt"), "port 4317\n")
    if (readme !== null) fs.writeFileSync(path.join(fixture, "README.md"), readme)
    return fixture
  }

  function assertNoMetaWord(text: string): void {
    assert.deepEqual(META_WORDS.filter((word) => text.toLowerCase().includes(word)), [], text)
  }

  function withEnv(values: Record<string, string>, body: () => void): void {
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    try {
      body()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it("runOnce_namesWorkDirAfterReadmeTitle_forTheK4Fixture", () => {
    assert.equal(path.basename(runRecorder(K4_FIXTURE).cwd), "shop-admin")
  })

  it("runOnce_workDirPathCarriesNoMetaWord_belowTheTempDir", () => {
    const seen = runRecorder(K4_FIXTURE)
    const belowTemp = path.relative(fs.realpathSync(os.tmpdir()), seen.cwd)
    assert.ok(!belowTemp.startsWith(".."), belowTemp)
    assertNoMetaWord(belowTemp)
  })

  it("runOnce_removesTheTempParent_afterTheRun", () => {
    const seen = runRecorder(K4_FIXTURE)
    assert.equal(fs.existsSync(path.dirname(seen.cwd)), false, seen.cwd)
  })

  it("runOnce_commitAuthorAndCommitterCarryNoMetaWord", () => {
    const seen = runRecorder(K4_FIXTURE)
    assert.equal(seen.identity.length, 4, String(seen.identity))
    for (const value of seen.identity) assertNoMetaWord(value)
  })

  it("runOnce_commitIdentityIgnoresHostGitIdentityEnv", () => {
    const hostIdentity = { GIT_AUTHOR_NAME: "keel-fixture", GIT_AUTHOR_EMAIL: "fixture@eval.test", GIT_COMMITTER_NAME: "keel-fixture", GIT_COMMITTER_EMAIL: "fixture@eval.test" }
    withEnv(hostIdentity, () => {
      for (const value of runRecorder(K4_FIXTURE).identity) assertNoMetaWord(value)
    })
  })

  it("runOnce_commitsUnsigned_whenHostConfigSignsCommits", () => {
    const hostSigning = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_KEY_1: "gpg.program", GIT_CONFIG_VALUE_1: "false" }
    withEnv(hostSigning, () => {
      assert.equal(path.basename(runRecorder(K4_FIXTURE).cwd), "shop-admin")
    })
  })

  it("runOnce_slugsTheReadmeTitle_intoAFolderName", () => {
    assert.equal(path.basename(runRecorder(fixtureWithReadme("Intro line\n\n# My Shop: Admin!\n")).cwd), "my-shop-admin")
  })

  it("runOnce_usesTheNeutralName_whenTheFixtureHasNoReadme", () => {
    assert.equal(path.basename(runRecorder(fixtureWithReadme(null)).cwd), NEUTRAL_PROJECT_NAME)
    assertNoMetaWord(NEUTRAL_PROJECT_NAME)
  })

  it("runOnce_usesTheNeutralName_whenTheReadmeTitleHasNoLetterOrDigit", () => {
    assert.equal(path.basename(runRecorder(fixtureWithReadme("# !!!\n")).cwd), NEUTRAL_PROJECT_NAME)
  })

  it("runOnce_usesTheNeutralName_whenTheReadmeHasNoTitle", () => {
    assert.equal(path.basename(runRecorder(fixtureWithReadme("Just notes, no heading\n")).cwd), NEUTRAL_PROJECT_NAME)
  })

  it("runOnce_usesTheNeutralName_whenTheOnlyHashLineHasNoTitleOnIt", () => {
    assert.equal(path.basename(runRecorder(fixtureWithReadme("#\nshop\n")).cwd), NEUTRAL_PROJECT_NAME)
  })

  for (const word of META_WORDS) {
    it(`runOnce_usesTheNeutralName_whenTheTitleHolds_${word}`, () => {
      const seen = runRecorder(fixtureWithReadme(`# Shop ${word.charAt(0).toUpperCase() + word.slice(1)} Admin\n`))
      assert.equal(path.basename(seen.cwd), NEUTRAL_PROJECT_NAME)
      for (const value of seen.identity) assertNoMetaWord(value)
    })
  }

  it("runOnce_usesTheNeutralName_whenTheReadmeIsNotUtf8", () => {
    assert.equal(path.basename(runRecorder(fixtureWithReadme(Buffer.from("# Caf\xe9 Admin\n", "latin1"))).cwd), NEUTRAL_PROJECT_NAME)
  })

  it("runOnce_usesTheNeutralName_whenTheReadmeCannotBeOpened", () => {
    const fixture = fixtureWithReadme(null)
    fs.mkdirSync(path.join(fixture, "README.md"))
    assert.equal(path.basename(runRecorder(fixture).cwd), NEUTRAL_PROJECT_NAME)
  })
})
