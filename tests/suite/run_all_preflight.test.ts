import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const RUN_ALL = join(import.meta.dirname, "..", "run-all.sh")

describe("run-all.sh preflight", () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "run-all-preflight-")))
  after(() => rmSync(checkout, { recursive: true, force: true }))

  it("stopsBeforeAnySuite_andNamesNpmCi_whenTypescriptCannotBeResolvedFromTheCheckout", () => {
    cpSync(RUN_ALL, join(checkout, "tests", "run-all.sh"))

    const completed = spawnSync("bash", [join(checkout, "tests", "run-all.sh")], { encoding: "utf8" })

    assert.notEqual(completed.status, 0)
    assert.match(completed.stderr, /typescript is not installed.*npm ci/)
  })
})
