import path from "node:path"

import { isSystemError, resolveLinks, splitLines } from "./files.ts"
import { GitError, runGit } from "./gitutil.ts"

export function mainWorktreeOverlay(overlayDir: string): string | null {
  const overlay = resolveLinks(overlayDir)
  let lines: string[]
  try {
    lines = splitLines(runGit(overlay, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]))
  } catch (error) {
    if (error instanceof GitError || isSystemError(error)) return null
    throw error
  }
  if (lines.length !== 3) return null
  const [toplevel, gitDir, commonDir] = lines as [string, string, string]
  if (resolveLinks(gitDir) === resolveLinks(commonDir)) return overlay
  const mainRoot = path.dirname(resolveLinks(commonDir))
  return path.join(mainRoot, path.relative(resolveLinks(toplevel), overlay))
}

export function isUnder(file: string, roots: ReadonlySet<string>): boolean {
  const resolved = resolveLinks(file)
  return [...roots].some((root) => resolved.startsWith(root + "/"))
}
