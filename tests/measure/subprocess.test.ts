import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { runProcess, TimeoutExpired } from "../../measure/lib/measurekit/subprocess.ts"

describe("runProcess", () => {
  it("runProcess_returnsOutputAsPrinted_andKeepsPartialOutputOnATimeout", () => {
    assert.equal(runProcess(["printf", "a\\r\\nb\\rc\\n"]).stdout, "a\r\nb\rc\n")
    assert.throws(
      () => runProcess(["sh", "-c", "printf 'x\\r\\n'; sleep 5"], { timeoutSeconds: 1 }),
      (error) => error instanceof TimeoutExpired && error.partialStdout === "x\r\n",
    )
  })

  it("runProcess_throwsTheSpawnError_whenTheProgramIsMissing", () => {
    assert.throws(() => runProcess(["/nonexistent/keel-program"]), (error) => (error as NodeJS.ErrnoException).code === "ENOENT")
  })
})
