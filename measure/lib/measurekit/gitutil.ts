import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { isSystemError } from "./files.ts"
import { runProcess } from "./subprocess.ts"

export class GitError extends Error {}

export function runGit(repo: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, stdinText?: string): string {
  const completed = runProcess(["git", "-C", repo, ...args], { input: stdinText, env: { ...process.env, ...extraEnv } })
  if (completed.returncode !== 0) throw new GitError(`git ${args.slice(0, 3).join(" ")} failed in ${repo}: ${completed.stderr.trim()}`)
  return completed.stdout
}

export function gitSucceeds(repo: string, args: string[]): boolean {
  try {
    runGit(repo, args)
  } catch (error) {
    if (error instanceof GitError || isSystemError(error)) return false
    throw error
  }
  return true
}

export function isGitRepo(path: string): boolean {
  return gitSucceeds(path, ["rev-parse", "--git-dir"])
}

export function snapshotTree(repo: string): string {
  const root = runGit(repo, ["rev-parse", "--show-toplevel"]).trim()
  const head = gitSucceeds(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) ? "HEAD" : "--empty"
  const workTree = ["--work-tree", root]
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"))
  try {
    const indexEnv = { GIT_INDEX_FILE: path.join(tempDir, "index") }
    runGit(root, [...workTree, "read-tree", head], indexEnv)
    runGit(root, [...workTree, "add", "-A"], indexEnv)
    return runGit(root, [...workTree, "write-tree"], indexEnv).trim()
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export function repoKey(repo: string): string | null {
  let url: string
  try {
    url = runGit(repo, ["remote", "get-url", "origin"]).trim()
  } catch (error) {
    if (error instanceof GitError) return null
    throw error
  }
  const withoutSuffix = url.replace(/\/+$/, "").replace(/\.git$/, "")
  const segments = withoutSuffix.replaceAll(":", "/").split("/").filter((segment) => segment !== "")
  return segments.length >= 2 ? segments.slice(-2).join("/").toLowerCase() : null
}
