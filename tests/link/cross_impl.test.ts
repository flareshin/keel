import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { LINK_ENTRY, LinkSandbox, PYTHON_LINK_ENTRY, listedDrops, writeFile } from "./helpers.ts"
import type { LinkResult } from "./helpers.ts"

type Implementation = "python" | "typescript"
type Run = (...args: string[]) => LinkResult
type Script = (run: Run, box: LinkSandbox) => void
type Transcript = { commands: { args: string[]; status: number | null; stdout: string; stderr: string }[]; tree: unknown[] }

const COMMANDS: Record<Implementation, string[]> = { python: [PYTHON_LINK_ENTRY], typescript: [process.execPath, LINK_ENTRY] }
const STAMP = /\d{8}T\d{6}Z-\d+/g
const SCRATCH_ROOT = path.join(os.tmpdir(), `keel-link-cross-${process.pid}`)
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

function snapshotTree(root: string): unknown[] {
  const entries: unknown[] = []
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entryPath === path.join(root, ".git")) continue
      const mode = fs.lstatSync(entryPath).mode & 0o7777
      const relative = normalize(path.relative(root, entryPath))
      if (entry.isSymbolicLink()) {
        entries.push({ path: relative, type: "link", mode, target: fs.readlinkSync(entryPath) })
      } else if (entry.isDirectory()) {
        entries.push({ path: relative, type: "dir", mode })
        visit(entryPath)
      } else {
        entries.push({ path: relative, type: "file", mode, bytes: normalize(fs.readFileSync(entryPath).toString("latin1")) })
      }
    }
  }
  visit(root)
  return entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function normalize(text: string): string {
  return text.replace(STAMP, "STAMP")
}

function execute(script: Script, implementationAt: (step: number) => Implementation, options: { dataDirName?: string; tagV1?: boolean }): Transcript {
  const box = new LinkSandbox({ root: SCRATCH_ROOT, dataDirName: options.dataDirName })
  const commands: Transcript["commands"] = []
  let step = 0
  const run: Run = (...args) => {
    const result = box.runLinkWith(COMMANDS[implementationAt(step++)] as string[], ...args)
    commands.push({ args, status: result.status, stdout: normalize(result.stdout), stderr: normalize(result.stderr) })
    return result
  }
  try {
    seedRichSandbox(box)
    if (options.tagV1) tagDataRepoAsV1(box)
    script(run, box)
    commands.push({ args: ["git config core.hooksPath"], status: 0, stdout: box.git(box.keel, "config", "--get", "core.hooksPath"), stderr: "" })
    return { commands, tree: snapshotTree(box.data) }
  } finally {
    box.remove()
  }
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

const alwaysUse = (implementation: Implementation) => () => implementation
const switchAt = (first: Implementation, second: Implementation, step: number) => (current: number) => (current < step ? first : second)

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
  const scenarios: { name: string; script: Script; statuses: number[]; switchPoints: number[]; options: { dataDirName?: string; tagV1?: boolean } }[] = [
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
  ]

  for (const { name, script, statuses, switchPoints, options } of scenarios) {
    const reference = () => execute(script, alwaysUse("python"), options)

    it(`${name}_writesIdenticalBytesModesAndOutput_whenTypeScriptReplacesPython`, () => {
      const python = reference()
      const typescript = execute(script, alwaysUse("typescript"), options)
      assert.deepEqual(python.commands.map((command) => command.status), statuses)
      assertSameAsPython(typescript, python)
    })

    for (const [first, second] of [["python", "typescript"], ["typescript", "python"]] as [Implementation, Implementation][]) {
      for (const step of switchPoints) {
        it(`${name}_matchesPythonOnly_when${first}RunsBeforeStep${step}And${second}RunsTheRest`, () => {
          assertSameAsPython(execute(script, switchAt(first, second, step), options), reference())
        })
      }
    }
  }
})
