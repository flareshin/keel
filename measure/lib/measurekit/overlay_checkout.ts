import { GitError, runGit } from "./gitutil.ts"
import { isOsError } from "./pyerrors.ts"
import { pyDirname, pyJoin, pyNormpath, pyRelpath, realpath } from "./pypath.ts"
import { pySplitlines } from "./pystr.ts"

export function mainWorktreeOverlay(overlayDir: string): string | null {
  const overlay = realpath(overlayDir)
  let lines: string[]
  try {
    lines = pySplitlines(runGit(overlay, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]))
  } catch (error) {
    if (error instanceof GitError || isOsError(error)) return null
    throw error
  }
  if (lines.length !== 3) return null
  const [toplevel, gitDir, commonDir] = lines as [string, string, string]
  if (realpath(gitDir) === realpath(commonDir)) return overlay
  const mainRoot = pyDirname(realpath(commonDir))
  return pyNormpath(pyJoin(mainRoot, pyRelpath(overlay, realpath(toplevel))))
}

export function isUnder(path: string, roots: ReadonlySet<string>): boolean {
  const resolved = realpath(path)
  return [...roots].some((root) => resolved.startsWith(root + "/"))
}
