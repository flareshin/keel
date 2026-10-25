import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { runProcess, runProcessAsync, TimeoutExpired } from "../../measure/lib/measurekit/subprocess.ts"

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

describe("runProcessAsync", () => {
  it("runProcessAsync_returnsWhatRunProcessReturns_forExitCodesAndBothStreams", async () => {
    for (const script of ["printf 'a\\r\\nb\\rc\\n'; echo oops >&2; exit 7", "kill -9 $$"]) {
      assert.deepEqual(await runProcessAsync(["sh", "-c", script]), runProcess(["sh", "-c", script]))
    }
  })

  it("runProcessAsync_throwsWhatRunProcessThrows_onATimeoutAndForAMissingProgram", async () => {
    const command = ["sh", "-c", "printf 'x\\r\\n'; sleep 5"]
    let syncMessage = ""
    try {
      runProcess(command, { timeoutSeconds: 1 })
    } catch (error) {
      syncMessage = (error as Error).message
    }
    await assert.rejects(
      runProcessAsync(command, { timeoutSeconds: 1 }),
      (error) => error instanceof TimeoutExpired && error.partialStdout === "x\r\n" && error.message === syncMessage,
    )
    await assert.rejects(runProcessAsync(["/nonexistent/keel-program"]), (error) => (error as NodeJS.ErrnoException).code === "ENOENT")
  })
})
