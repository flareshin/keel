import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { CHECKOUT, MeasureSandbox, readText } from "./helpers.ts"
import type { Completed } from "./helpers.ts"
import type { SmokeItem } from "./smoke_helpers.ts"

const LINK_TOOL = path.join(CHECKOUT, "bin", "link")
const OVERLAY_KEY = "example/keel-overlay"
const CORE_FRAGMENT = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node {{KEEL}}/hooks/demo/demo.js" }] }] } }
const CLAUDE_MD_CAP_BYTES = 4608
const WORKTREE = "overlay-wt"

type SmokeResult = { assertions: SmokeItem[] }

describe("candidate smoke", () => {
  let box: MeasureSandbox
  let worktree: string

  beforeEach(() => {
    box = new MeasureSandbox()
    box.write("keel/settings/core.json", JSON.stringify(CORE_FRAGMENT))
    box.write("keel/settings/links.tsv", "source\ttarget\n{{KEEL}}/skills/demo\tskills/demo\n")
    box.seedCleanKeel()
    box.write("overlay/PERSONAL.md", "- [K1] Old personal rule.\n")
    box.write("overlay/settings/personal.json", JSON.stringify({ env: { EXAMPLE_MODE: "old" } }))
    box.write("overlay/commands/demo.md", "Demo command.\n")
    box.write("overlay/links.tsv", "source\ttarget\n{{OVERLAY}}/commands/demo.md\tcommands/demo.md\n")
    box.initRepo(box.overlay, "https://example.invalid/example/keel-overlay.git")
    box.commitAll(box.overlay)
    box.env["KEEL_LINK"] = LINK_TOOL
    fs.rmSync(path.join(box.data, "settings.json"))
    runLink("--write")
    worktree = path.join(box.root, WORKTREE)
    box.git(box.overlay, "worktree", "add", "-q", "-b", "candidate", worktree)
    box.env["KEEL_OVERLAY_DIR"] = worktree
    changeCandidate({
      "PERSONAL.md": "- [K1] New personal rule.\n",
      "settings/personal.json": JSON.stringify({ env: { EXAMPLE_MODE: "new" } }),
    })
  })
  afterEach(() => box.cleanup())

  function runLink(...args: string[]): void {
    const completed = spawnSync(LINK_TOOL, args, { encoding: "utf8", env: box.env })
    assert.equal(completed.status, 0, completed.stderr)
  }

  function changeCandidate(files: Record<string, string>): void {
    for (const [relativePath, content] of Object.entries(files)) box.write(path.join(WORKTREE, relativePath), content)
    box.commitAll(worktree, "Change the candidate")
  }

  function runSmoke(...flags: string[]): [Completed, SmokeResult] {
    const [completed, result] = box.runJson("smoke", ["--json-only", ...flags])
    assert.notEqual(result, null, completed.stderr)
    return [completed, result]
  }

  const linkIntegrity = (result: SmokeResult): SmokeItem => result.assertions.find((item) => item.check === "link-integrity") as SmokeItem

  function dataDirFiles(): Record<string, string> {
    const files: Record<string, string> = { "core.hooksPath": box.git(box.keel, "config", "--get", "core.hooksPath") }
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name)
        if (entryPath === path.join(box.data, "logs")) continue
        if (entry.isSymbolicLink()) files[entryPath] = "-> " + fs.readlinkSync(entryPath)
        else if (entry.isFile()) files[entryPath] = readText(entryPath)
        else {
          files[entryPath] = "dir"
          visit(entryPath)
        }
      }
    }
    visit(box.data)
    return files
  }

  it("candidateSmoke_passes_whenTheWorktreeFragmentAndPersonalDifferFromTheLiveDataDir", () => {
    const [completed, result] = runSmoke("--candidate")
    assert.equal(completed.status, 0, JSON.stringify(result.assertions.filter((item) => item.status !== "PASS")))
    assert.equal(linkIntegrity(result).status, "PASS")
    const line = box.lastLogLine("keel-smoke.jsonl") as any
    assert.equal(line.trees[OVERLAY_KEY], box.git(worktree, "rev-parse", "HEAD^{tree}").trim())
  })

  it("candidateSmoke_marksItsLogLine_asCandidate", () => {
    const [, result] = runSmoke("--candidate")
    const line = box.lastLogLine("keel-smoke.jsonl") as any
    assert.deepEqual([line.run_id, line.candidate], [(result as any).run_id, true])
  })

  it("liveSmoke_failsOnDriftAndKeepsItsLineShape_whenTheOverlayIsAWorktree", () => {
    const [completed, result] = runSmoke()
    assert.equal(completed.status, 1)
    const detail = linkIntegrity(result).detail
    for (const kind of ["link-wrong", "settings-drift", "claude-md-drift"]) assert.ok(detail.includes(kind), detail)
    assert.deepEqual(Object.keys(box.lastLogLine("keel-smoke.jsonl")).sort(), ["count", "failed", "ok", "run_id", "trees", "ts"])
  })

  it("candidateSmoke_leavesTheLiveDataDirAndHooksPathUnchanged", () => {
    const before = dataDirFiles()
    runSmoke("--candidate")
    assert.deepEqual(dataDirFiles(), before)
  })

  it("candidateSmoke_removesItsEmptyDataDir_afterTheRun", () => {
    const tempRoot = path.join(box.root, "tmp")
    fs.mkdirSync(tempRoot)
    box.env["TMPDIR"] = tempRoot
    runSmoke("--candidate")
    assert.deepEqual(fs.readdirSync(tempRoot), [])
  })

  it("candidateSmoke_fails_whenTheGeneratedClaudeMdWouldExceedTheCap", () => {
    changeCandidate({ "PERSONAL.md": "- [K1] " + "x".repeat(CLAUDE_MD_CAP_BYTES) + "\n" })
    const [completed, result] = runSmoke("--candidate")
    assert.equal(completed.status, 1)
    const item = linkIntegrity(result)
    assert.equal(item.status, "FAIL")
    assert.ok(item.detail.includes(`over the ${CLAUDE_MD_CAP_BYTES}-byte cap`), item.detail)
  })

  it("candidateSmoke_fails_whenADeclaredStackFragmentIsMissing", () => {
    changeCandidate({ "stacks.txt": "demo-stack\n" })
    const [completed, result] = runSmoke("--candidate")
    assert.equal(completed.status, 1)
    const item = linkIntegrity(result)
    assert.equal(item.status, "FAIL")
    assert.ok(item.detail.includes('active stack "demo-stack" has no'), item.detail)
  })

  it("candidateSmoke_passesLinkIntegrity_whenCandidateAddsAScheduledTask", () => {
    changeCandidate({
      "scheduled-tasks/demo/SKILL.md": "Run the demo.\n",
      "links.tsv": "source\ttarget\n{{OVERLAY}}/commands/demo.md\tcommands/demo.md\n" +
        "{{OVERLAY}}/scheduled-tasks/demo/SKILL.md\tscheduled-tasks/demo/SKILL.md\n",
    })
    const [, result] = runSmoke("--candidate")
    const item = linkIntegrity(result)
    assert.equal(item.status, "PASS", item.detail)
  })

  it("candidateSmoke_fails_whenAnOverlayLinkSourceIsMissing", () => {
    box.git(worktree, "rm", "-q", "commands/demo.md")
    box.git(worktree, "commit", "-q", "--no-verify", "-m", "Drop the demo command")
    const [completed, result] = runSmoke("--candidate")
    assert.equal(completed.status, 1)
    assert.ok(linkIntegrity(result).detail.includes("dangling: source does not exist"))
  })

  it("candidateSmoke_failsAndSetsNothing_whenKeelHooksPathIsUnset", () => {
    box.git(box.keel, "config", "--unset", "core.hooksPath")
    const [completed, result] = runSmoke("--candidate")
    assert.equal(completed.status, 1)
    assert.ok(linkIntegrity(result).detail.includes("hookspath-drift"))
    const unset = spawnSync("git", ["-C", box.keel, "config", "--get", "core.hooksPath"], { env: box.env })
    assert.equal(unset.status, 1)
  })

  const oddOutputs: [string, string][] = [
    ["not json", "planned"],
    ["no problems key", '{"actions":[]}'],
    ["problems not a list", '{"actions":[],"problems":"none"}'],
    ["problem not an object", '{"actions":[],"problems":["x"]}'],
  ]
  for (const [name, stdout] of oddOutputs) {
    it(`candidateSmoke_fails_whenADryRunThatExitsZeroPrintsNoProblemList: ${name}`, () => {
      box.env["KEEL_LINK"] = box.write("stubs/link-odd", `#!/bin/bash\necho '${stdout}'\n`, true)
      const [completed, result] = runSmoke("--candidate")
      assert.equal(completed.status, 1)
      assert.ok(linkIntegrity(result).detail.includes("link dry run exited 0"))
    })
  }
})
