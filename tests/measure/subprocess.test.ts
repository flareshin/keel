import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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

  it("runProcessAsync_throwsWhatRunProcessThrows_onATimeout", async () => {
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
  })

  it("runProcessAsync_settlesNearTheTimeout_evenWhenAGrandchildKeepsTheOutputPipeOpen", async () => {
    const started = Date.now()
    await assert.rejects(runProcessAsync(["sh", "-c", "printf 'x\\r\\n'; sleep 5"], { timeoutSeconds: 1 }), TimeoutExpired)
    assert.ok(Date.now() - started < 3000, `settled after ${Date.now() - started} ms`)
  })

  it("runProcessAsync_failsWithTheErrorCodeRunProcessFailsWith_forAMissingAndANonExecutableProgram", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "keel-subprocess-test-"))
    const noShebang = path.join(directory, "no-shebang")
    fs.writeFileSync(noShebang, "echo hi\n", { mode: 0o755 })
    try {
      for (const program of ["/nonexistent/keel-program", noShebang]) {
        let syncError: NodeJS.ErrnoException | undefined
        try {
          runProcess([program])
        } catch (error) {
          syncError = error as NodeJS.ErrnoException
        }
        await assert.rejects(runProcessAsync([program]), (error) => (error as NodeJS.ErrnoException).code === syncError?.code)
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
