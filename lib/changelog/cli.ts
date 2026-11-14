import fs from "node:fs"
import path from "node:path"

import { EXIT_NEGATIVE, EXIT_OK, flagOption, parseCommandLine, usageError } from "../../measure/lib/measurekit/cli.ts"
import type { CommandSpec } from "../../measure/lib/measurekit/cli.ts"
import { readUtf8 } from "../../measure/lib/measurekit/files.ts"
import { ReleaseRefused, assembleRelease } from "./release.ts"
import type { Fragment } from "./release.ts"

export const FRAGMENT_DIR = "changelog.d"
const FRAGMENT_GUIDE = "README.md"
const CHANGELOG = "CHANGELOG.md"

const COMMAND: CommandSpec = {
  prog: "changelog",
  usage: "changelog [-h] [--write] VERSION DATE",
  description: "Fold the changelog.d/ fragments into a CHANGELOG.md release section. No flag = print the section only.",
  argumentHelp: [
    ["VERSION", "the release version, such as 1.1.0"],
    ["DATE", "the release date, YYYY-MM-DD"],
    ["--write", "write CHANGELOG.md and delete the folded fragments"],
  ],
  options: { write: { type: "boolean" } },
}

export function main(argv: string[], repoRoot: string): number {
  const parsed = parseCommandLine(COMMAND, argv)
  const [version, date, ...extra] = parsed.positionals
  if (version === undefined || date === undefined) usageError(COMMAND, "VERSION and DATE are required")
  if (extra.length > 0) usageError(COMMAND, `unrecognized arguments: ${extra.join(" ")}`)

  const changelogPath = path.join(repoRoot, CHANGELOG)
  const fragments = readFragments(path.join(repoRoot, FRAGMENT_DIR))
  try {
    const release = assembleRelease(readUtf8(changelogPath), fragments, version, date)
    if (!flagOption(parsed, "write")) {
      process.stdout.write(release.section)
      return EXIT_OK
    }
    fs.writeFileSync(changelogPath, release.changelog)
    for (const fragment of fragments) fs.rmSync(path.join(repoRoot, FRAGMENT_DIR, fragment.name))
    process.stdout.write(`changelog: wrote ${version} from ${fragments.length} fragment(s)\n`)
    return EXIT_OK
  } catch (error) {
    if (!(error instanceof ReleaseRefused)) throw error
    process.stderr.write(`changelog: ${error.message}\n`)
    return EXIT_NEGATIVE
  }
}

export function readFragments(directory: string): Fragment[] {
  if (!fs.existsSync(directory)) return []
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".md") && name !== FRAGMENT_GUIDE)
    .map((name) => ({ name, text: readUtf8(path.join(directory, name)) }))
}
