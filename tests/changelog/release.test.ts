import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { ReleaseRefused, UNRELEASED_POINTER, assembleRelease } from "../../lib/changelog/release.ts"

const KEEL = path.resolve(import.meta.dirname, "../..")
const OLDER_RELEASE = "## [1.0.0] - 2026-10-23\n\nThe first release.\n"
const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n${UNRELEASED_POINTER}\n\n${OLDER_RELEASE}`

describe("assembleRelease", () => {
  it("assembleRelease_withFragmentsOutOfNameOrder_putsLeadsFirstThenEachCategoryOnceInReleaseOrder", () => {
    const fragments = [
      { name: "b-second.md", text: "Lead of b.\n\n### Fixed\n- b fixed\n\n### Added\n- b added\n" },
      { name: "a-first.md", text: "### Notes\n- a note\n\n### Added\n- a added\n" },
      { name: "c-third.md", text: "Lead of c.\n" },
    ]

    const { section } = assembleRelease(CHANGELOG, fragments, "1.1.0", "2026-11-12")

    assert.equal(
      section,
      "## [1.1.0] - 2026-11-12\n\nLead of b.\n\nLead of c.\n\n### Added\n\n- a added\n\n- b added\n\n### Fixed\n\n- b fixed\n\n### Notes\n\n- a note\n",
    )
  })

  it("assembleRelease_keepsThePointerAndPlacesTheNewSectionAboveTheOlderRelease", () => {
    const { changelog } = assembleRelease(CHANGELOG, [{ name: "x.md", text: "### Added\n- x\n" }], "1.1.0", "2026-11-12")

    assert.equal(
      changelog,
      `# Changelog\n\n## [Unreleased]\n\n${UNRELEASED_POINTER}\n\n## [1.1.0] - 2026-11-12\n\n### Added\n\n- x\n\n${OLDER_RELEASE}`,
    )
  })

  const refusals: [name: string, changelog: string, text: string, version: string, date: string, reason: RegExp][] = [
    ["anUnreleasedEntryBesideThePointer", CHANGELOG.replace(UNRELEASED_POINTER, `${UNRELEASED_POINTER}\n\n- stray entry`), "### Added\n- x\n", "1.1.0", "2026-11-12", /only the changelog\.d\/ pointer/],
    ["aVersionAlreadyReleased", CHANGELOG, "### Added\n- x\n", "1.0.0", "2026-11-12", /already has a 1\.0\.0 section/],
    ["aSecondLevelHeadingInAFragment", CHANGELOG, "## Added\n- x\n", "1.1.0", "2026-11-12", /only "### <category>" headings/],
    ["anEmptyFragment", CHANGELOG, "\n### Added\n\n", "1.1.0", "2026-11-12", /x\.md: the fragment is empty/],
    ["aVersionThatIsNotSemver", CHANGELOG, "### Added\n- x\n", "v1.1", "2026-11-12", /version must look like 1\.2\.3/],
    ["aDateThatIsNotIso", CHANGELOG, "### Added\n- x\n", "1.1.0", "12/11/2026", /date must be YYYY-MM-DD/],
  ]
  for (const [name, changelog, text, version, date, reason] of refusals) {
    it(`assembleRelease_with${name[0]!.toUpperCase()}${name.slice(1)}_refuses`, () => {
      assert.throws(() => assembleRelease(changelog, [{ name: "x.md", text }], version, date), (error: unknown) => error instanceof ReleaseRefused && reason.test(error.message))
    })
  }

  it("assembleRelease_withNoFragment_refuses", () => {
    assert.throws(() => assembleRelease(CHANGELOG, [], "1.1.0", "2026-11-12"), /holds no fragment/)
  })
})

describe("bin/changelog", () => {
  function scratchRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-changelog-"))
    fs.mkdirSync(path.join(root, "bin"))
    fs.mkdirSync(path.join(root, "changelog.d"))
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), CHANGELOG)
    fs.writeFileSync(path.join(root, "changelog.d", "README.md"), "# guide, never folded\n")
    fs.writeFileSync(path.join(root, "changelog.d", "x.md"), "### Added\n- x\n")
    fs.cpSync(path.join(KEEL, "bin", "changelog.ts"), path.join(root, "bin", "changelog.ts"))
    fs.symlinkSync(path.join(KEEL, "lib"), path.join(root, "lib"))
    fs.symlinkSync(path.join(KEEL, "measure"), path.join(root, "measure"))
    return root
  }

  function run(root: string, ...args: string[]) {
    return spawnSync("node", [path.join(root, "bin", "changelog.ts"), ...args], { encoding: "utf8" })
  }

  it("changelog_withoutWrite_printsTheSectionAndChangesNoFile", () => {
    const root = scratchRepo()
    try {
      const completed = run(root, "1.1.0", "2026-11-12")

      assert.equal(completed.status, 0, completed.stderr)
      assert.equal(completed.stdout, "## [1.1.0] - 2026-11-12\n\n### Added\n\n- x\n")
      assert.equal(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), CHANGELOG)
      assert.deepEqual(fs.readdirSync(path.join(root, "changelog.d")).sort(), ["README.md", "x.md"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("changelog_withWrite_writesTheReleaseAndDeletesOnlyTheFoldedFragments", () => {
    const root = scratchRepo()
    try {
      const completed = run(root, "--write", "1.1.0", "2026-11-12")

      assert.equal(completed.status, 0, completed.stderr)
      assert.match(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), /## \[1\.1\.0\] - 2026-11-12\n\n### Added\n\n- x\n\n## \[1\.0\.0\]/)
      assert.deepEqual(fs.readdirSync(path.join(root, "changelog.d")), ["README.md"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("changelog_whenRefused_exitsOneAndChangesNoFile", () => {
    const root = scratchRepo()
    try {
      const completed = run(root, "--write", "1.0.0", "2026-11-12")

      assert.equal(completed.status, 1)
      assert.match(completed.stderr, /already has a 1\.0\.0 section/)
      assert.equal(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), CHANGELOG)
      assert.ok(fs.existsSync(path.join(root, "changelog.d", "x.md")))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
