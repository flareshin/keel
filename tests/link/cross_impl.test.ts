import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { materialize, SnapshotPacker } from "../recorded-cases.ts"
import type { SnapshotStore } from "../recorded-cases.ts"
import { recordedAnswers } from "../recorded.ts"
import { LINK_ENTRY, LinkSandbox, PYTHON_LINK_ENTRY, listedDrops, maskDigests, normalizeStamps, scratchRoot, snapshotTree, writeFile } from "./helpers.ts"
import type { LinkResult } from "./helpers.ts"

type Run = (...args: string[]) => LinkResult
type Script = (run: Run, box: LinkSandbox) => void
type ScenarioOptions = { dataDirName?: string; tagV1?: boolean; plainSandbox?: boolean }
type Transcript = { commands: { args: string[]; status: number | null; stdout: string; stderr: string }[]; tree: unknown[] }

const PYTHON_COMMAND = [PYTHON_LINK_ENTRY]
const TYPESCRIPT_COMMAND = [process.execPath, LINK_ENTRY]
const SCRATCH_ROOT = scratchRoot()
const NON_BMP = "\u{1F600}"

const OVERLAY_LINKS =
  "source\ttarget\n" +
  "{{OVERLAY}}/commands/hello.md\tcommands/hello.md\n" +
  "{{OVERLAY}}/scheduled-tasks/demo/SKILL.md\tscheduled-tasks/demo/SKILL.md\n"
const EXTRA_FRAGMENT = `{
  "env": {"NOTE": "caf\\u00e9 \\ud83d\\ude00", "PLAIN": "x"},
  "permissions": {"allow": ["Read", "Bash(echo \\u00e9:*)"], "defaultMode": "plan", "limits": {"ratio": 0.1, "retries": 1E3, "big": 12345678901234567890, "whole": 2.0}},
  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "python3 {{KEEL}}/hooks/stop.py", "timeout": 10.0}]}]}
}`
const LEDGER_HEADER =
  "id\tscope\ttype\tstatement\tlayer\tenforced_at\twhy_not_stronger\tjustification\tincidents\tmetric\treview_by\tgrace_until\tstatus"
const LEDGER_ROW = ["F-demo", "core", "floor", "A demo rule.", "hook", "hook:demo", "-", "-", "-", "fires:F-demo", "-", "-", "active"].join("\t")
const LIVE_V1 =
  "{\n" +
  '    "model": "opus",\n' +
  '    "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "v1-stop.sh"}]}]},\n' +
  '    "theme": "d\u00e9j\u00e0 vu \\u00e9 ' + NON_BMP + '",\n' +
  '    "permissions": {"allow": ["Read"], "ask": ["Bash(v1-ask:*)"]},\n' +
  '    "env": {"V1_TOKEN": "v1-secret-value"},\n' +
  '    "enabledPlugins": [1,2,  3]\n' +
  "}\n"

function seedRichSandbox(box: LinkSandbox): void {
  box.writeOverlay("links.tsv", OVERLAY_LINKS)
  box.writeOverlay("scheduled-tasks/demo/SKILL.md", `---\nname: demo\n---\nRun the demo caf\u00e9 ${NON_BMP}.\n`)
  fs.chmodSync(path.join(box.overlay, "scheduled-tasks/demo/SKILL.md"), 0o640)
  box.writeOverlay("PERSONAL.md", `# personal caf\u00e9 ${NON_BMP}\r\n- no final newline`)
  box.writeOverlay("settings/70-extras.json", EXTRA_FRAGMENT)
  box.writeOverlay("stacks.txt", "# stacks\nalpha\n")
  box.writeKeel("stacks/alpha/settings.json", JSON.stringify({ permissions: { deny: ["alpha-rule"] }, env: { STACK: "alpha" } }))
  box.writeKeel("ledger.tsv", [LEDGER_HEADER, LEDGER_ROW].join("\n") + "\n")
  box.writeData("settings.json", LIVE_V1)
  box.writeData("CLAUDE.md", "# v1 rules\r\n- keep\r\n- this")
  box.writeData("skills/demo/SKILL.md", "v1 skill\n")
  box.writeData("scheduled-tasks/demo/SKILL.md", "stale copy\n")
  fs.mkdirSync(box.dataPath("bin"))
  fs.symlinkSync("/usr/bin/true", box.dataPath("bin/keel"))
}

function tagDataRepoAsV1(box: LinkSandbox): void {
  box.git(box.data, "init", "-q")
  box.git(box.data, "add", "-A")
  box.git(box.data, "commit", "-q", "-m", "v1")
  box.git(box.data, "tag", "v1-final")
}

type Resume = { from: number; commands: Transcript["commands"] }
type PythonRecording = { transcript: Transcript; store: SnapshotStore; snapshots: Record<string, string> }

function resultOf(command: Transcript["commands"][number]): LinkResult {
  return { status: command.status, stdout: command.stdout, stderr: command.stderr, json: command.stdout.trim() ? JSON.parse(command.stdout) : null }
}

function execute(script: Script, options: ScenarioOptions, command: string[] = TYPESCRIPT_COMMAND, resume?: Resume, beforeStep?: (step: number, box: LinkSandbox) => void): Transcript {
  const box = new LinkSandbox({ root: SCRATCH_ROOT, dataDirName: options.dataDirName, attach: resume !== undefined })
  const commands: Transcript["commands"] = []
  let step = 0
  const run: Run = (...args) => {
    const index = step++
    beforeStep?.(index, box)
    const replayed = resume !== undefined && index < resume.from ? resume.commands[index] : undefined
    if (replayed !== undefined) {
      commands.push(replayed)
      return resultOf(replayed)
    }
    const result = box.runLinkWith(command, ...args)
    commands.push({ args, status: result.status, stdout: normalizeStamps(result.stdout), stderr: normalizeStamps(result.stderr) })
    return result
  }
  try {
    if (resume === undefined && !options.plainSandbox) seedRichSandbox(box)
    if (resume === undefined && options.tagV1) tagDataRepoAsV1(box)
    script(run, box)
    commands.push({ args: ["git config core.hooksPath"], status: 0, stdout: box.gitConfigValue(box.keel, "core.hooksPath"), stderr: "" })
    return maskDigests({ commands, tree: snapshotTree(box.data) })
  } finally {
    box.remove()
  }
}

function recordPython(script: Script, options: ScenarioOptions, switchPoints: number[]): PythonRecording {
  const packer = new SnapshotPacker()
  const snapshots: Record<string, string> = {}
  const transcript = execute(script, options, PYTHON_COMMAND, undefined, (step, box) => {
    if (switchPoints.includes(step)) snapshots[String(step)] = packer.addTree(box.root, SCRATCH_ROOT)
  })
  return { transcript, store: packer.store, snapshots }
}

function recordedPython(name: string, script: Script, options: ScenarioOptions, switchPoints: number[]): PythonRecording {
  const askPython = () => [recordPython(script, options, switchPoints)]
  return recordedAnswers("link-cross-impl", [{ scenario: name, switchPoints }], askPython, { "{{ROOT}}": SCRATCH_ROOT })[0] as PythonRecording
}

function executeAfterPython(script: Script, options: ScenarioOptions, recording: PythonRecording, step: number): Transcript {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true })
  materialize(recording.store, recording.snapshots[String(step)] as string, SCRATCH_ROOT)
  return execute(script, options, TYPESCRIPT_COMMAND, { from: step, commands: recording.transcript.commands })
}

function acceptEveryDrop(run: Run, box: LinkSandbox): string {
  const accepted = path.join(box.root, "accepted-drops.txt")
  fs.writeFileSync(accepted, listedDrops(run("--write", "--adopt")).map((drop) => drop + "\n").join(""))
  return accepted
}

const FULL_LIFECYCLE: Script = (run, box) => {
  run()
  run("--write")
  const accepted = acceptEveryDrop(run, box)
  run("--write", "--adopt", "--force", "--accept-drops", accepted)
  run("--check")
  run("--write")
  box.writeOverlay("PERSONAL.md", "# changed personal\n")
  box.writeOverlay("settings/80-more.json", JSON.stringify({ permissions: { allow: ["Glob"] }, env: { PLAIN: "later" } }))
  run("--check")
  run("--write")
  writeFile(box.dataPath("settings.json"), box.readData("settings.json").replace('"model": "opus"', '"model": "sonnet"'))
  run("--check")
  run("--unlink")
  run("--unlink")
}
const FULL_LIFECYCLE_STATUSES = [0, 3, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0]
const FULL_LIFECYCLE_AFTER_FIRST_WRITE = 4
const FULL_LIFECYCLE_AFTER_SECOND_WRITE = 8
const FULL_LIFECYCLE_AT_FIRST_UNLINK = 9

const QUOTED_DATA_DIR: Script = (run, box) => {
  const accepted = acceptEveryDrop(run, box)
  run("--write", "--adopt", "--force", "--accept-drops", accepted)
  run("--check")
  run("--unlink")
}
const QUOTED_DATA_DIR_STATUSES = [3, 0, 0, 0, 0]
const QUOTED_DATA_DIR_AFTER_WRITE = 2
const QUOTED_DATA_DIR_AT_UNLINK = 3

const INTEGER_LIKE_KEYS_FRAGMENT: Script = (run, box) => {
  box.writeOverlay(
    "settings/70-numeric.json",
    '{"env": {"Z": "1", "10": "a", "2": "b"}, "permissions": {"extra": {"b": 1, "3": 2, "1": 3}}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x", "9": 1, "a": 2, "0": 3}]}], "10": [], "2": []}}',
  )
  box.writeOverlay("settings/80-numeric.json", '{"env": {"10": "later", "7": "c", "Z": "2"}}')
  run("--check")
  run("--write")
  run("--check")
  run("--unlink")
}
const INTEGER_LIKE_KEYS_FRAGMENT_STATUSES = [1, 0, 0, 0, 0]

const LONE_SURROGATE_ESCAPE = "\\ud800"

const LONE_SURROGATE_FRAGMENT: Script = (run, box) => {
  box.writeOverlay("settings/90-lone.json", `{"env": {"X": "${LONE_SURROGATE_ESCAPE}"}}`)
  run("--check")
  run("--write")
  run("--check")
}
const LONE_SURROGATE_FRAGMENT_STATUSES = [1, 70, 1, 0]

const LONE_SURROGATE_CONFLICTING_KEYS: Script = (run, box) => {
  box.writeOverlay("settings/90-lone.json", `{"env": {"${LONE_SURROGATE_ESCAPE}": "a"}}`)
  box.writeOverlay("settings/91-lone.json", `{"env": {"${LONE_SURROGATE_ESCAPE}": "b"}}`)
  run("--check")
  run("--write")
  run("--check")
}
const LONE_SURROGATE_CONFLICTING_KEYS_STATUSES = [1, 70, 1, 0]

const LONE_SURROGATE_LIVE_UNOWNED_VALUE: Script = (run, box) => {
  box.writeData("settings.json", `{"model": "${LONE_SURROGATE_ESCAPE}"}`)
  run("--check")
  run("--write", "--adopt")
  run("--check")
}
const LONE_SURROGATE_LIVE_UNOWNED_VALUE_STATUSES = [1, 0, 0, 0]

const LONE_SURROGATE_LIVE_OWNED_VALUE_AFTER_WRITE: Script = (run, box) => {
  run("--write")
  box.writeData("settings.json", `{"env": {"A": "${LONE_SURROGATE_ESCAPE}"}}`)
  run("--check")
  run("--write")
}
const LONE_SURROGATE_LIVE_OWNED_VALUE_AFTER_WRITE_STATUSES = [0, 70, 70, 0]

const LONE_SURROGATE_LIVE_OWNED_KEY: Script = (run, box) => {
  box.writeData("settings.json", `{"env": {"${LONE_SURROGATE_ESCAPE}": "a"}}`)
  run("--write")
  run("--check")
}
const LONE_SURROGATE_LIVE_OWNED_KEY_STATUSES = [3, 1, 0]

type Scenario = { name: string; script: Script; statuses: number[]; switchPoints: number[]; options: ScenarioOptions }

const loneSurrogateScenario = (name: string, script: Script, statuses: number[]): Scenario => ({ name, script, statuses, switchPoints: [1], options: { plainSandbox: true } })

let compared = 0
let mismatches = 0

function assertSameAsPython(actual: Transcript, python: Transcript): void {
  compared++
  try {
    assert.deepEqual(actual, python)
  } catch (error) {
    mismatches++
    throw error
  }
}

after(() => {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true })
  console.log(`parity: ${compared} cases, ${mismatches} mismatches`)
})

describe("link cross implementation", () => {
  const scenarios: Scenario[] = [
    {
      name: "fullLifecycle",
      script: FULL_LIFECYCLE,
      statuses: FULL_LIFECYCLE_STATUSES,
      switchPoints: [FULL_LIFECYCLE_AFTER_FIRST_WRITE, FULL_LIFECYCLE_AFTER_SECOND_WRITE, FULL_LIFECYCLE_AT_FIRST_UNLINK],
      options: {},
    },
    {
      name: "quotedDataDirWithV1Tag",
      script: QUOTED_DATA_DIR,
      statuses: QUOTED_DATA_DIR_STATUSES,
      switchPoints: [QUOTED_DATA_DIR_AFTER_WRITE, QUOTED_DATA_DIR_AT_UNLINK],
      options: { dataDirName: `da ta's \u00e9 ${NON_BMP}`, tagV1: true },
    },
    { name: "integerLikeKeysKeepTheirSourceOrder", script: INTEGER_LIKE_KEYS_FRAGMENT, statuses: INTEGER_LIKE_KEYS_FRAGMENT_STATUSES, switchPoints: [1, 2], options: { plainSandbox: true } },
    loneSurrogateScenario("loneSurrogateInFragment", LONE_SURROGATE_FRAGMENT, LONE_SURROGATE_FRAGMENT_STATUSES),
    loneSurrogateScenario("loneSurrogateInConflictingFragmentKeys", LONE_SURROGATE_CONFLICTING_KEYS, LONE_SURROGATE_CONFLICTING_KEYS_STATUSES),
    loneSurrogateScenario("loneSurrogateInLiveUnownedValue", LONE_SURROGATE_LIVE_UNOWNED_VALUE, LONE_SURROGATE_LIVE_UNOWNED_VALUE_STATUSES),
    loneSurrogateScenario("loneSurrogateInLiveOwnedValueAfterWrite", LONE_SURROGATE_LIVE_OWNED_VALUE_AFTER_WRITE, LONE_SURROGATE_LIVE_OWNED_VALUE_AFTER_WRITE_STATUSES),
    loneSurrogateScenario("loneSurrogateInLiveOwnedKey", LONE_SURROGATE_LIVE_OWNED_KEY, LONE_SURROGATE_LIVE_OWNED_KEY_STATUSES),
  ]

  for (const { name, script, statuses, switchPoints, options } of scenarios) {
    it(`${name}_writesIdenticalBytesModesAndOutput_whenTypeScriptReplacesPython`, () => {
      const python = recordedPython(name, script, options, switchPoints)
      const typescript = execute(script, options)
      assert.deepEqual(python.transcript.commands.map((command) => command.status), statuses)
      assertSameAsPython(typescript, python.transcript)
    })

    for (const step of switchPoints) {
      it(`${name}_matchesPythonOnly_whenPythonRunsBeforeStep${step}AndTypeScriptRunsTheRest`, () => {
        const python = recordedPython(name, script, options, switchPoints)
        assertSameAsPython(executeAfterPython(script, options, python, step), python.transcript)
      })
    }
  }
})
