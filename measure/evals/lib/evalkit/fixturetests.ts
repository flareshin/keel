import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runProcessGroup } from "../../../../lib/evidence/subprocess.ts"
import { withoutParentTestRunner } from "../../../../lib/precheck/testfile.ts"
import { runGitOrThrow } from "../../../lib/measurekit/gitutil.ts"
import { TimeoutExpired } from "../../../lib/measurekit/timeout.ts"

export const FIXTURE_TEST_SECONDS = 120
const DURATION = /\s*\([\d.]+m?s\)\s*$/

export async function inDetachedWorktree<T>(repo: string, ref: string, use: (tree: string) => Promise<T>): Promise<T> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fixture"))
  try {
    const tree = path.join(parent, "tree")
    runGitOrThrow(repo, ["worktree", "add", "-q", "--detach", tree, ref])
    try {
      return await use(tree)
    } finally {
      runGitOrThrow(repo, ["worktree", "remove", "--force", tree])
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

export async function testFailure(tree: string, command: string[], timeoutSeconds: number): Promise<string | null> {
  const [program = "", ...args] = command
  const shown = [path.basename(program), ...args].join(" ")
  try {
    const completed = await runProcessGroup(command, { cwd: tree, env: withoutParentTestRunner(process.env), timeoutSeconds })
    if (completed.returncode === 0) return null
    const failing = completed.stdout.toString().split("\n").find((line) => line.startsWith("✖")) ?? `${shown} exit ${completed.returncode}`
    return failing.replace(DURATION, "")
  } catch (error) {
    if (error instanceof TimeoutExpired) return `${shown} timed out after ${timeoutSeconds}s`
    throw error
  }
}
