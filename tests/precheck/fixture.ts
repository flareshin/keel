import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

export function committedRepo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "precheck-repo-")))
  execFileSync("git", ["init", "-q", root])
  writeFiles(root, files)
  execFileSync("git", ["-C", root, "add", "-A"])
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "fixture"])
  return root
}

export function executedLineNumbers(file: string, spans: Array<{ start: number, end: number }>): number[] {
  const source = readFileSync(file, "utf8")
  const lines = new Set<number>()
  for (const { start, end } of spans) {
    for (let offset = start; offset < end; offset++) {
      if (/\S/u.test(source[offset] as string)) lines.add(source.slice(0, offset).split("\n").length)
    }
  }
  return [...lines].sort((a, b) => a - b)
}
