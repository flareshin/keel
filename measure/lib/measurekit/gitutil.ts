import fs from "node:fs"
import os from "node:os"

import { isOsError } from "./pyerrors.ts"
import { pyJoin } from "./pypath.ts"
import { pyStrip } from "./pystr.ts"
import { runProcess } from "./subprocess.ts"

export class GitError extends Error {}

export function runGit(repo: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, stdinText?: string): string {
  const completed = runProcess(["git", "-C", repo, ...args], { input: stdinText, env: { ...process.env, ...extraEnv } })
  if (completed.returncode !== 0) throw new GitError(`git ${args.slice(0, 3).join(" ")} failed in ${repo}: ${pyStrip(completed.stderr)}`)
  return completed.stdout
}

export function gitSucceeds(repo: string, args: string[]): boolean {
  try {
    runGit(repo, args)
  } catch (error) {
    if (error instanceof GitError || isOsError(error)) return false
    throw error
  }
  return true
}

export function isGitRepo(path: string): boolean {
  return gitSucceeds(path, ["rev-parse", "--git-dir"])
}

export function snapshotTree(repo: string): string {
  const root = pyStrip(runGit(repo, ["rev-parse", "--show-toplevel"]))
  const head = gitSucceeds(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) ? "HEAD" : "--empty"
  const workTree = ["--work-tree", root]
  const tempDir = fs.mkdtempSync(pyJoin(os.tmpdir(), "tmp"))
  try {
    const indexEnv = { GIT_INDEX_FILE: pyJoin(tempDir, "index") }
    runGit(root, [...workTree, "read-tree", head], indexEnv)
    runGit(root, [...workTree, "add", "-A"], indexEnv)
    return pyStrip(runGit(root, [...workTree, "write-tree"], indexEnv))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export function repoKey(repo: string): string | null {
  let url: string
  try {
    url = pyStrip(runGit(repo, ["remote", "get-url", "origin"]))
  } catch (error) {
    if (error instanceof GitError) return null
    throw error
  }
  const withoutSuffix = url.replace(/\/+$/, "").replace(/\.git$/, "")
  const segments = withoutSuffix.replaceAll(":", "/").split("/").filter((segment) => segment !== "")
  return segments.length >= 2 ? segments.slice(-2).join("/").toLowerCase() : null
}
