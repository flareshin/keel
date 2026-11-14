import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import { readFragments } from "../../lib/changelog/cli.ts"
import { UNRELEASED_POINTER, assembleRelease, unreleasedBody } from "../../lib/changelog/release.ts"

const KEEL = path.resolve(import.meta.dirname, "../..")
const changelog = fs.readFileSync(path.join(KEEL, "CHANGELOG.md"), "utf8")

describe("keel's own changelog", () => {
  it("unreleasedSection_holdsOnlyThePointer_soNoBranchEditsTheSharedLines", () => {
    assert.equal(unreleasedBody(changelog), UNRELEASED_POINTER, "put the entry in changelog.d/<change-name>.md, not in CHANGELOG.md [Unreleased]")
  })

  it("everyFragment_foldsIntoAReleaseSection", () => {
    const fragments = readFragments(path.join(KEEL, "changelog.d"))
    assert.ok(fragments.length > 0)

    const { section } = assembleRelease(changelog, fragments, "999.0.0", "2026-01-01")

    assert.match(section, /^## \[999\.0\.0\] - 2026-01-01\n/)
  })
})
