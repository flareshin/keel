import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { lexists } from "../../measure/lib/measurekit/pypath.ts"

export const KEEL_ROOT = path.dirname(path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)))))
export const LINK_ENTRY = path.join(KEEL_ROOT, "bin", "link.ts")
export const PYTHON_LINK_ENTRY = path.join(KEEL_ROOT, "bin", "link")
export const EXAMPLES = path.join(KEEL_ROOT, "examples", "link")
export const PRINCIPLES = "# Principles\n\n- [K1] Review before shipping.\n"
export const CORE_LINKS = "source\ttarget\n{{KEEL}}/skills/demo\tskills/demo\n{{KEEL}}/bin/keel\tbin/keel\n"

const CORE_SETTINGS = {
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 {{KEEL}}/hooks/demo.py" }] }] },
  permissions: { deny: ["Bash(git push --force:*)"] },
}

export type LinkResult = {
  status: number | null
  stdout: string
  stderr: string
  json: any
}

const BACKUP_STAMP = /\d{8}T\d{6}Z-\d+/g

export function normalizeStamps(text: string): string {
  return text.replace(BACKUP_STAMP, "STAMP")
}

export function snapshotTree(root: string): unknown[] {
  const entries: unknown[] = []
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entryPath === path.join(root, ".git")) continue
      const mode = fs.lstatSync(entryPath).mode & 0o7777
      const relative = normalizeStamps(path.relative(root, entryPath))
      if (entry.isSymbolicLink()) {
        entries.push({ path: relative, type: "link", mode, target: fs.readlinkSync(entryPath) })
      } else if (entry.isDirectory()) {
        entries.push({ path: relative, type: "dir", mode })
        visit(entryPath)
      } else {
        entries.push({ path: relative, type: "file", mode, bytes: normalizeStamps(fs.readFileSync(entryPath).toString("latin1")) })
      }
    }
  }
  visit(root)
  return entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

export function readFile(file: string): string {
  return fs.readFileSync(file, "utf8")
}

export function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

export class LinkSandbox {
  readonly root: string
  keel: string
  readonly overlay: string
  readonly data: string
  readonly home: string
  readonly extraEnv: Record<string, string> = {}

  constructor(options: { root?: string; dataDirName?: string } = {}) {
    if (options.root === undefined) {
      this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-link-test-")))
    } else {
      fs.rmSync(options.root, { recursive: true, force: true })
      fs.mkdirSync(options.root)
      this.root = fs.realpathSync(options.root)
    }
    this.keel = path.join(this.root, "keel")
    this.overlay = path.join(this.root, "overlay")
    this.data = path.join(this.root, options.dataDirName ?? "data")
    this.home = path.join(this.root, "home")
    fs.mkdirSync(this.data)
    fs.mkdirSync(this.home)
    fs.cpSync(EXAMPLES, this.overlay, { recursive: true })
    this.writeKeel("PRINCIPLES.md", PRINCIPLES)
    this.writeKeel("settings/links.tsv", CORE_LINKS)
    this.writeKeel("settings/core.json", JSON.stringify(CORE_SETTINGS))
    this.writeKeel("skills/demo/SKILL.md", "# demo\n")
    this.writeKeel("bin/keel", "#!/bin/sh\n")
    fs.writeFileSync(path.join(this.root, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n")
    this.git(this.keel, "init", "-q")
  }

  env(): NodeJS.ProcessEnv {
    const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("KEEL_") && !key.startsWith("GIT_"))
    const env = {
      ...Object.fromEntries(inherited),
      KEEL_HOME: this.keel,
      KEEL_OVERLAY_DIR: this.overlay,
      KEEL_DATA_DIR: this.data,
      HOME: this.home,
      GIT_CONFIG_GLOBAL: path.join(this.root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      ...this.extraEnv,
    }
    assert.ok(env.KEEL_DATA_DIR.startsWith(this.root + path.sep), "KEEL_DATA_DIR must stay inside the temp dir")
    return env
  }

  runLink(...args: string[]): LinkResult {
    return this.runLinkWith([process.execPath, LINK_ENTRY], ...args)
  }

  runLinkWith(command: string[], ...args: string[]): LinkResult {
    const completed = this.runLinkRaw(command, ...args)
    return { ...completed, json: completed.stdout.trim() ? JSON.parse(completed.stdout) : null }
  }

  runLinkRaw(command: string[], ...args: string[]): Omit<LinkResult, "json"> {
    const [program = "", ...leading] = command
    const completed = spawnSync(program, [...leading, ...args], { env: this.env(), encoding: "utf8" })
    return { status: completed.status, stdout: completed.stdout, stderr: completed.stderr }
  }

  git(cwd: string, ...args: string[]): string {
    const completed = spawnSync("git", ["-C", cwd, ...args], { env: this.env(), encoding: "utf8" })
    assert.equal(completed.status, 0, completed.stderr)
    return completed.stdout
  }

  gitConfigValue(cwd: string, key: string): string {
    const completed = spawnSync("git", ["-C", cwd, "config", "--get", key], { env: this.env(), encoding: "utf8" })
    return completed.status === 0 ? completed.stdout : "<unset>"
  }

  writeKeel(relative: string, text: string): void {
    writeFile(path.join(this.keel, relative), text)
  }

  writeOverlay(relative: string, text: string): void {
    writeFile(path.join(this.overlay, relative), text)
  }

  writeData(relative: string, text: string): void {
    writeFile(path.join(this.data, relative), text)
  }

  dataPath(relative: string): string {
    return path.join(this.data, relative)
  }

  readData(relative: string): string {
    return readFile(this.dataPath(relative))
  }

  remove(): void {
    fs.rmSync(this.root, { recursive: true, force: true })
  }
}

export function assertExit(result: LinkResult, code: number): void {
  assert.equal(result.status, code, `stdout=${result.stdout}\nstderr=${result.stderr}`)
}

export function problemKinds(result: LinkResult): string[] {
  return result.json.problems.map((problem: { kind: string }) => problem.kind).sort()
}

export function ops(result: LinkResult): string[] {
  return result.json.actions.map((action: { op: string }) => action.op).sort()
}

export function listedDrops(result: LinkResult): string[] {
  const prefix = "link: adopt drops: "
  return result.stderr.split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length)).sort()
}

export function writeAdoptingEveryDrop(box: LinkSandbox): LinkResult {
  const drops = listedDrops(box.runLink("--write", "--adopt"))
  const accepted = path.join(box.root, "accept-all.txt")
  fs.writeFileSync(accepted, drops.map((drop) => drop + "\n").join(""))
  return box.runLink("--write", "--adopt", "--accept-drops", accepted)
}

export function backupsOf(box: LinkSandbox, relative: string): string[] {
  const backupRoot = path.join(box.data, "state", "keel", "link-backup")
  if (!fs.existsSync(backupRoot)) return []
  return fs.readdirSync(backupRoot).sort().map((stamp) => path.join(backupRoot, stamp, relative)).filter((candidate) => lexists(candidate))
}

export function onlyBackup(box: LinkSandbox, relative: string): string {
  const found = backupsOf(box, relative)
  assert.equal(found.length, 1, found.join(", "))
  return found[0] as string
}
