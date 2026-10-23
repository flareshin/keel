import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { KEEL_ROOT, LinkSandbox, assertExit, problemKinds, readFile } from "./helpers.ts"

const LEDGER_HEADER =
  "id\tscope\ttype\tstatement\tlayer\tenforced_at\twhy_not_stronger\tjustification\t" +
  "incidents\tmetric\treview_by\tgrace_until\tstatus"
const GATE_HOOK: Record<string, unknown> = { type: "command", command: "node {{KEEL}}/hooks/git-guard/git-guard.ts", timeout: 10, onFailure: "block" }

function hookRow(rowId: string, hook: string, scope: string = "core", status: string = "active"): string {
  return [rowId, scope, "floor", "A demo rule.", "hook", "hook:" + hook, "-", "-", "-", "fires:" + rowId, "-", "-", status].join("\t")
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

describe("link core fragment", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
  })
  afterEach(() => box.remove())

  it("write_refusesAndKeepsSettings_whenCoreFragmentIsMissing", () => {
    fs.unlinkSync(path.join(box.keel, "settings", "core.json"))
    box.writeData("settings.json", '{"model": "m"}\n')
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("core.json"))
    assert.equal(box.readData("settings.json"), '{"model": "m"}\n')
  })

  it("check_refuses_whenCoreFragmentIsMissing", () => {
    fs.unlinkSync(path.join(box.keel, "settings", "core.json"))
    assertExit(box.runLink("--check"), 3)
  })
})

describe("link hook registration", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
  })
  afterEach(() => box.remove())

  const writeLedgers = (keelRows: string[], overlayRows: string[] = []) => {
    box.writeKeel("ledger.tsv", [LEDGER_HEADER, ...keelRows].join("\n") + "\n")
    if (overlayRows.length > 0) box.writeOverlay("ledger.tsv", [LEDGER_HEADER, ...overlayRows].join("\n") + "\n")
  }

  it("check_passes_whenEveryActiveHookRowIsRegistered", () => {
    writeLedgers([hookRow("F-demo", "demo")])
    assertExit(box.runLink("--write"), 0)
    assertExit(box.runLink("--check"), 0)
  })

  it("check_reportsHookUnregistered_whenAKeelHookRowNamesAnUnregisteredHook", () => {
    writeLedgers([hookRow("F-demo", "demo"), hookRow("F-ghost", "ghost-gate")])
    const result = box.runLink("--check")
    assertExit(result, 1)
    const unregistered = result.json.problems.filter((problem: { kind: string }) => problem.kind === "hook-unregistered")
    assert.equal(unregistered.length, 1)
    assert.ok(unregistered[0].detail.includes("F-ghost"))
    assert.ok(unregistered[0].detail.includes("ghost-gate"))
  })

  it("check_reportsHookUnregistered_whenAnOverlayHookRowNamesAnUnregisteredHook", () => {
    writeLedgers([], [hookRow("O-ghost", "ghost-gate", "overlay")])
    assert.ok(problemKinds(box.runLink("--check")).includes("hook-unregistered"))
  })

  it("write_refusesAndWritesNothing_whenAHookRowIsUnregistered", () => {
    writeLedgers([hookRow("F-ghost", "ghost-gate")])
    assertExit(box.runLink("--write"), 3)
    assert.equal(fs.existsSync(box.dataPath("settings.json")), false)
  })

  it("check_ignoresRetiredRowsAndRowsOfInactiveStacks", () => {
    writeLedgers([hookRow("F-old", "ghost-gate", "core", "retired"), hookRow("S-jdk", "ghost-preflight", "stack:inactive-stack")])
    assertExit(box.runLink("--write"), 0)
    assertExit(box.runLink("--check"), 0)
  })

  it("check_reportsHookUnregistered_whenARowOfAnActiveStackHasNoRegistration", () => {
    box.writeOverlay("stacks.txt", "demo-stack\n")
    box.writeKeel("stacks/demo-stack/settings.json", "{}")
    writeLedgers([hookRow("S-demo", "ghost-preflight", "stack:demo-stack")])
    assert.ok(problemKinds(box.runLink("--check")).includes("hook-unregistered"))
  })
})

describe("link gate on failure", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
  })
  afterEach(() => box.remove())

  const writeCoreHook = (matcher: string, hook: Record<string, unknown>) =>
    box.writeKeel("settings/core.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [hook] }] } }))

  it("check_passes_whenGateRegistrationsBlockOnFailureWithATimeout", () => {
    writeCoreHook("Bash|Edit|Write|NotebookEdit", GATE_HOOK)
    assertExit(box.runLink("--write"), 0)
    assertExit(box.runLink("--check"), 0)
  })

  it("check_reportsGateOnFailureMissing_whenAGateRegistrationLacksOnFailure", () => {
    writeCoreHook("Bash|Edit|Write|NotebookEdit", without(GATE_HOOK, "onFailure"))
    const result = box.runLink("--check")
    assertExit(result, 1)
    assert.ok(problemKinds(result).includes("gate-onfailure-missing"))
  })

  it("check_reportsGateOnFailureMissing_whenAGateRegistrationHasNoTimeout", () => {
    writeCoreHook("Edit", without(GATE_HOOK, "timeout"))
    assert.ok(problemKinds(box.runLink("--check")).includes("gate-onfailure-missing"))
  })

  it("check_acceptsAFloatTimeout_asANumericTimeout", () => {
    box.writeKeel("settings/core.json", `{"hooks": {"PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "node {{KEEL}}/hooks/git-guard/git-guard.ts", "timeout": 10.5, "onFailure": "block"}]}]}}`)
    assert.ok(!problemKinds(box.runLink("--check")).includes("gate-onfailure-missing"))
  })

  it("check_acceptsATimeoutAbove2To53_asANumericTimeout", () => {
    box.writeKeel("settings/core.json", `{"hooks": {"PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "node {{KEEL}}/hooks/git-guard/git-guard.ts", "timeout": 9007199254740993, "onFailure": "block"}]}]}}`)
    assert.ok(!problemKinds(box.runLink("--check")).includes("gate-onfailure-missing"))
  })

  it("check_skipsGateHookOnAToolItDoesNotGate", () => {
    writeCoreHook("Skill", { type: "command", command: "node {{KEEL}}/hooks/ship-gate/ship-gate.ts", timeout: 30 })
    assertExit(box.runLink("--write"), 0)
    assertExit(box.runLink("--check"), 0)
  })
})

describe("link hooks path", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
  })
  afterEach(() => box.remove())

  it("write_setsCoreHooksPathToGithooks_inKeelHome", () => {
    assertExit(box.runLink("--write"), 0)
    assert.equal(box.git(box.keel, "config", "--get", "core.hooksPath").trim(), "githooks")
  })

  it("check_reportsHooksPathDrift_whenCoreHooksPathWasChanged", () => {
    assertExit(box.runLink("--write"), 0)
    box.git(box.keel, "config", "core.hooksPath", "/elsewhere")
    const result = box.runLink("--check")
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["hookspath-drift"])
  })

  it("write_refuses_whenKeelHomeIsNotAGitCheckout", () => {
    fs.rmSync(path.join(box.keel, ".git"), { recursive: true })
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(problemKinds(result).includes("hookspath-drift"))
  })

  it("write_refusesAndLeavesParentHooksPathUnset_whenKeelHomeIsASubdirectoryOfAnotherRepo", () => {
    fs.rmSync(path.join(box.keel, ".git"), { recursive: true })
    box.git(box.root, "init", "-q")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(problemKinds(result).includes("hookspath-drift"))
    assert.ok(!box.git(box.root, "config", "--local", "--list").includes("core.hookspath"))
  })
})

describe("shipped settings", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
    for (const relative of ["ledger.tsv", "settings/core.json", "stacks/spring-maven/settings.json"]) {
      box.writeKeel(relative, readFile(path.join(KEEL_ROOT, relative)))
    }
    box.writeOverlay("stacks.txt", "spring-maven\n")
  })
  afterEach(() => box.remove())

  const shippedPreToolUse = () => JSON.parse(readFile(path.join(KEEL_ROOT, "settings", "core.json"))).hooks.PreToolUse

  it("shippedCore_registersEveryHookRowAndFailsClosedOnGates", () => {
    const result = box.runLink("--check")
    const kinds = problemKinds(result)
    assert.ok(!kinds.includes("hook-unregistered"), JSON.stringify(result.json))
    assert.ok(!kinds.includes("gate-onfailure-missing"), JSON.stringify(result.json))
  })

  it("shippedLedger_reportsCDispatch_whenModelAssignIsDroppedFromCore", () => {
    const core = JSON.parse(readFile(path.join(KEEL_ROOT, "settings", "core.json")))
    core.hooks.PreToolUse = core.hooks.PreToolUse.filter((entry: { hooks: { command: string }[] }) => !entry.hooks[0]?.command.includes("model-assign"))
    box.writeKeel("settings/core.json", JSON.stringify(core))
    const result = box.runLink("--check")
    const details = result.json.problems.filter((problem: { kind: string }) => problem.kind === "hook-unregistered").map((problem: { detail: string }) => problem.detail)
    assert.equal(details.length, 1, details.join("\n"))
    assert.ok(details[0].startsWith("C-dispatch (keel ledger): hook model-assign"), details[0])
  })

  it("shippedCore_blocksOnFailureOnlyOnShipGateBashAndGitGuard", () => {
    const blocking = shippedPreToolUse()
      .flatMap((entry: { matcher: string; hooks: { command: string; onFailure?: string }[] }) =>
        entry.hooks.filter((hook) => hook.onFailure === "block").map((hook) => [entry.matcher, hook.command.slice(hook.command.lastIndexOf("/") + 1)]),
      )
      .sort()
    assert.deepEqual(blocking, [["Bash", "ship-gate.ts"], ["Bash|Edit|Write|NotebookEdit", "git-guard.ts"]])
  })

  it("shippedCore_registersShipGateOnlyOnPreToolUseBash", () => {
    const hooks: Record<string, { matcher?: string; hooks: { command?: string }[] }[]> = JSON.parse(readFile(path.join(KEEL_ROOT, "settings", "core.json"))).hooks
    const shipGate = Object.entries(hooks).flatMap(([event, entries]) =>
      entries.flatMap((entry) => entry.hooks.filter((hook) => (hook.command ?? "").includes("ship-gate")).map(() => [event, entry.matcher ?? ""])),
    )
    assert.deepEqual(shipGate, [["PreToolUse", "Bash"]])
  })
})
