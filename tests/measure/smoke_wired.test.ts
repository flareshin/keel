import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { CHECKOUT, DEMO_HOOK, HOOK_PRELUDE, charterRow, ledgerRow, readText } from "./helpers.ts"
import { SmokeHarness } from "./smoke_helpers.ts"
import type { SmokeItem } from "./smoke_helpers.ts"

const SHIPPED_FRAGMENTS = ["settings/core.json", "stacks/spring-maven/settings.json"]
const DEMO_HOOK_LINES = [
  "const command = payload.tool_input.command",
  "const logs = path.join(process.env.KEEL_DATA_DIR, 'logs')",
  "fs.mkdirSync(logs, { recursive: true })",
  "fs.appendFileSync(path.join(logs, 'keel-fires.jsonl'), JSON.stringify({ rule_id: command.split(' ')[1], outcome: 'deny' }) + '\\n')",
  "process.exit(2)",
]

function shippedHooks(): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {}
  for (const fragment of SHIPPED_FRAGMENTS) {
    const text = readText(path.join(CHECKOUT, fragment)).replaceAll("{{KEEL}}", CHECKOUT)
    for (const [event, groups] of Object.entries(JSON.parse(text).hooks as Record<string, unknown[]>)) (merged[event] ??= []).push(...groups)
  }
  return merged
}

describe("wired-fires", () => {
  let harness: SmokeHarness
  let fixtures: string

  beforeEach(() => {
    harness = new SmokeHarness()
    fixtures = path.join(harness.box.keel, "tests", "hooks", "fixtures")
  })
  afterEach(() => harness.cleanup())

  function wiredFires(): SmokeItem {
    const [, result] = harness.runSmoke()
    const items = result.assertions.filter((item) => item.check === "wired-fires")
    assert.equal(items.length, 1)
    return items[0] as SmokeItem
  }

  const registerBash = (script: string) =>
    harness.box.registerHooks({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node " + script }] }] })

  const hookSource = (guard: string[]): string => [...HOOK_PRELUDE, ...guard, ...DEMO_HOOK_LINES].join("\n")

  it("wiredFires_passes_whenEveryHookRowFiresOnItsBadFixtureAndStaysQuietOnTheGoodOne", () => {
    const item = wiredFires()
    assert.deepEqual([item.scope, item.status], ["all", "PASS"], JSON.stringify(item))
    assert.ok(item.detail.includes("2 rows"))
  })

  it("wiredFires_fails_whenNoHookLayerRowIsRecognized", () => {
    harness.box.writeLedger("keel/ledger.tsv", [charterRow("K1", { layer: "skill", enforced_at: "skill:demo", why_not_stronger: "Judgment." })])
    const item = wiredFires()
    assert.equal(item.status, "FAIL")
    assert.ok(item.detail.includes("0 hook-layer rows"))
  })

  it("wiredFires_fails_whenABadFixtureIsMissing", () => {
    fs.rmSync(path.join(fixtures, "C-demo.bad.json"))
    const item = wiredFires()
    assert.equal(item.status, "FAIL")
    assert.ok(item.detail.includes("C-demo: missing fixture"))
  })

  it("wiredFires_fails_whenTheGoodFixtureIsMissing", () => {
    fs.rmSync(path.join(fixtures, "demo.good.json"))
    assert.ok(wiredFires().detail.includes("demo: missing fixture"))
  })

  it("wiredFires_fails_whenTheHookIsNotRegisteredForTheFixtureEvent", () => {
    harness.box.registerHooks({})
    const item = wiredFires()
    assert.equal(item.status, "FAIL")
    assert.ok(item.detail.includes("C-demo: no PreToolUse[Bash] registration of hook demo"))
  })

  it("wiredFires_fails_whenTheMatcherDoesNotCoverTheFixtureTool", () => {
    const script = path.join(harness.box.keel, "hooks", "demo", "demo.js")
    harness.box.registerHooks({ PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "node " + script }] }] })
    assert.ok(wiredFires().detail.includes("no PreToolUse[Bash] registration"))
  })

  it("wiredFires_fails_whenTheRegisteredScriptDoesNotExist", () => {
    fs.rmSync(path.join(harness.box.keel, "hooks", "demo", "demo.js"))
    assert.ok(wiredFires().detail.includes("script missing"))
  })

  it("wiredFires_fails_whenTheBadFixtureFiresAnotherRule", () => {
    harness.box.write("keel/tests/hooks/fixtures/C-demo.bad.json", harness.box.bashFixture("bad K1", "deny"))
    const item = wiredFires()
    assert.equal(item.status, "FAIL")
    assert.ok(item.detail.includes("C-demo: bad fixture logged no deny fires line for C-demo"))
  })

  it("wiredFires_fails_whenTheHookFiresOnTheGoodFixture", () => {
    harness.box.write("keel/tests/hooks/fixtures/demo.good.json", harness.box.bashFixture("bad K1"))
    assert.ok(wiredFires().detail.includes("demo: good fixture fired K1"))
  })

  it("wiredFires_fails_whenTheHookWritesTheRealFiresLog", () => {
    const realLog = path.join(harness.box.data, "logs", "keel-fires.jsonl")
    const script = harness.box.write("keel/hooks/demo/demo.js", [
      ...HOOK_PRELUDE,
      "const command = payload.tool_input.command",
      "if (command.startsWith('bad ')) {",
      `  fs.appendFileSync(${JSON.stringify(realLog)}, JSON.stringify({ rule_id: command.split(' ')[1], outcome: 'deny' }) + '\\n')`,
      "}",
      "",
    ].join("\n"))
    registerBash(script)
    assert.ok(wiredFires().detail.includes("the real keel-fires.jsonl changed during the run"))
  })

  it("wiredFires_runsSetupCommandsInTheTempDir_beforeFeedingThePayload", () => {
    for (const ruleId of ["K1", "C-demo"]) {
      const fixture = JSON.parse(harness.box.bashFixture("bad " + ruleId, "deny"))
      fixture.setup = ["mkdir repo"]
      harness.box.write(`keel/tests/hooks/fixtures/${ruleId}.bad.json`, JSON.stringify(fixture))
    }
    registerBash(harness.box.write("keel/hooks/demo/demo.js", hookSource([
      "if (!fs.existsSync(path.join(payload.cwd, 'repo'))) process.exit(0)",
    ])))
    assert.equal(wiredFires().status, "PASS")
  })

  it("wiredFires_givesHooksTheOverlayTheFixtureSetupBuilds_notTheLiveOverlay", () => {
    for (const ruleId of ["K1", "C-demo"]) {
      const fixture = JSON.parse(harness.box.bashFixture("bad " + ruleId, "deny"))
      fixture.setup = ["mkdir -p overlay && touch overlay/fire-on-me"]
      harness.box.write(`keel/tests/hooks/fixtures/${ruleId}.bad.json`, JSON.stringify(fixture))
    }
    registerBash(harness.box.write("keel/hooks/demo/demo.js", hookSource([
      "if (!fs.existsSync(path.join(process.env.KEEL_OVERLAY_DIR, 'fire-on-me'))) process.exit(0)",
    ])))
    const item = wiredFires()
    assert.equal(item.status, "PASS", JSON.stringify(item))
  })

  it("wiredFires_neverShowsHooksTheLiveOverlay_whenTheSetupBuildsNone", () => {
    harness.box.write("overlay/fire-on-me", "")
    registerBash(harness.box.write("keel/hooks/demo/demo.js", hookSource([
      "if (fs.existsSync(path.join(process.env.KEEL_OVERLAY_DIR, 'fire-on-me'))) payload.tool_input.command = 'bad K1'",
      "if (!payload.tool_input.command.startsWith('bad ')) process.exit(0)",
    ])))
    const item = wiredFires()
    assert.equal(item.status, "PASS", JSON.stringify(item))
  })

  it("wiredFires_skipsRowsOfStacksTheOverlayHasNotActivated", () => {
    harness.box.writeLedger("keel/ledger.tsv", [charterRow("K1"), ledgerRow("C-demo"), ledgerRow("S-jdk", { scope: "stack:inactive-stack" })])
    assert.equal(wiredFires().status, "PASS")
  })

  it("wiredFires_checksRowsOfActiveStacks", () => {
    harness.box.write("overlay/stacks.txt", "demo-stack\n")
    harness.box.writeLedger("keel/ledger.tsv", [charterRow("K1"), ledgerRow("C-demo"), ledgerRow("S-jdk", { scope: "stack:demo-stack" })])
    assert.ok(wiredFires().detail.includes("S-jdk: missing fixture"))
  })

  it("wiredFires_looksForOverlayRowFixturesInTheOverlay", () => {
    harness.box.writeLedger("overlay/ledger.tsv", [ledgerRow("O-demo", { scope: "overlay" })])
    harness.box.write("overlay/tests/hooks/fixtures/O-demo.bad.json", harness.box.bashFixture("bad O-demo", "deny"))
    const item = wiredFires()
    assert.equal(item.status, "PASS", JSON.stringify(item))
  })

  function seedOverlayHook(): void {
    const script = harness.box.write("overlay/hooks/odemo/odemo.js", DEMO_HOOK)
    harness.box.registerHooks({
      PreToolUse: [{
        matcher: "Bash",
        hooks: [
          { type: "command", command: "node " + path.join(harness.box.keel, "hooks", "demo", "demo.js") },
          { type: "command", command: "node " + script },
        ],
      }],
    })
    harness.box.writeLedger("overlay/ledger.tsv", [ledgerRow("O-demo", { scope: "overlay", enforced_at: "hook:odemo" })])
    harness.box.write("overlay/tests/hooks/fixtures/O-demo.bad.json", harness.box.bashFixture("bad O-demo", "deny"))
    harness.box.write("overlay/tests/hooks/fixtures/odemo.good.json", harness.box.bashFixture("ls"))
  }

  it("wiredFires_looksForTheGoodFixtureOfAnOverlayHookInTheOverlay", () => {
    seedOverlayHook()
    const passing = wiredFires()
    assert.equal(passing.status, "PASS", JSON.stringify(passing))
    const good = path.join(harness.box.overlay, "tests", "hooks", "fixtures", "odemo.good.json")
    fs.rmSync(good)
    assert.ok(wiredFires().detail.includes("odemo: missing fixture " + good))
  })

  it("wiredFires_looksForTheGoodFixtureInTheLinkedOverlayWorktree_whenTheHookIsRegisteredFromTheMainOverlay", () => {
    seedOverlayHook()
    harness.box.initRepo(harness.box.overlay, "https://example.invalid/example/keel-overlay.git")
    harness.box.commitAll(harness.box.overlay)
    const worktree = path.join(harness.box.root, "overlay-wt")
    harness.box.git(harness.box.overlay, "worktree", "add", "-q", "--detach", worktree)
    harness.box.env["KEEL_OVERLAY_DIR"] = worktree
    const passing = wiredFires()
    assert.equal(passing.status, "PASS", JSON.stringify(passing))
    const good = path.join(worktree, "tests", "hooks", "fixtures", "odemo.good.json")
    fs.rmSync(good)
    assert.ok(wiredFires().detail.includes("odemo: missing fixture " + good))
  })

  it("wiredFires_passesForEveryShippedHookRow_withTheShippedSettingsAndFixtures", () => {
    harness.box.env["KEEL_HOME"] = CHECKOUT
    harness.box.write("overlay/stacks.txt", "spring-maven\n")
    harness.box.registerHooks(shippedHooks())
    const item = wiredFires()
    assert.equal(item.status, "PASS", JSON.stringify(item))
    assert.ok(item.detail.includes("13 rows fired on bad fixtures, 6 hooks quiet"), item.detail)
  })

  it("wiredFires_passes_whenTheOverlayIsAssembledFromTheShippedExamples", () => {
    harness.box.env["KEEL_HOME"] = CHECKOUT
    for (const track of fs.readdirSync(path.join(CHECKOUT, "examples"))) {
      fs.cpSync(path.join(CHECKOUT, "examples", track), harness.box.overlay, { recursive: true, dereference: true, force: true })
    }
    harness.box.write("overlay/stacks.txt", "spring-maven\n")
    harness.box.registerHooks(shippedHooks())
    const item = wiredFires()
    assert.equal(item.status, "PASS", JSON.stringify(item))
    assert.ok(item.detail.includes("14 rows fired on bad fixtures, 6 hooks quiet"), item.detail)
  })
})
