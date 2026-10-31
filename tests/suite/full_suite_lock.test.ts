import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

const CHECKOUT = path.resolve(import.meta.dirname, "..", "..")
const NO_SUCH_PID = "999999"

describe("full suite lock", () => {
  let dataDir: string
  let lockDir: string
  let env: NodeJS.ProcessEnv
  const children: ChildProcess[] = []

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-lock-"))
    lockDir = path.join(dataDir, "state", "keel", "full-suite.lock")
    env = { ...process.env, KEEL_DATA_DIR: dataDir, KEEL_SUITE_LOCK_POLL_SECONDS: "0.05" }
  })
  afterEach(() => {
    for (const child of children) child.kill("SIGKILL")
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const underLock = (script: string): { child: ChildProcess; stderr: () => string; done: Promise<number | null> } => {
    const child = spawn("bash", ["-c", `source tests/suite-lock.sh; hold_suite_lock; ${script}`], { cwd: CHECKOUT, env })
    children.push(child)
    let stderr = ""
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    const done = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
    return { child, stderr: () => stderr, done }
  }

  const until = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out waiting")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  const givenLockHeldBy = (pid: string): void => {
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, "pid"), pid + "\n")
  }

  it("aSecondRun_waitsUntilTheFirstReleasesTheLock_andSaysWhoHoldsIt", async () => {
    const order = path.join(dataDir, "order")
    const release = path.join(dataDir, "release")
    const first = underLock(`echo first >> '${order}'; while [ ! -e '${release}' ]; do sleep 0.02; done`)
    await until(() => fs.existsSync(order))
    const second = underLock(`echo second >> '${order}'`)
    await until(() => second.stderr().includes("waiting for the full suite run"))
    assert.match(second.stderr(), new RegExp(`pid ${first.child.pid}`))
    assert.equal(fs.readFileSync(order, "utf8"), "first\n")
    fs.writeFileSync(release, "")
    assert.deepEqual([await first.done, await second.done], [0, 0])
    assert.equal(fs.readFileSync(order, "utf8"), "first\nsecond\n")
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("aLockWhoseHolderIsGone_isTakenOver", async () => {
    givenLockHeldBy(NO_SUCH_PID)
    const run = underLock(`cat '${path.join(lockDir, "pid")}'`)
    let stdout = ""
    run.child.stdout?.on("data", (chunk) => { stdout += chunk })
    assert.equal(await run.done, 0)
    assert.equal(stdout.trim(), String(run.child.pid))
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("aFailingRun_releasesTheLock_andKeepsItsExitStatus", async () => {
    assert.equal(await underLock("exit 3").done, 3)
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("aWaitingRunThatIsStopped_leavesTheHoldersLockInPlace", async () => {
    givenLockHeldBy(String(process.pid))
    const waiting = underLock("true")
    await until(() => waiting.stderr().includes("waiting for the full suite run"))
    waiting.child.kill("SIGTERM")
    await waiting.done
    assert.equal(fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim(), String(process.pid))
  })

  it("runAll_waitsForTheLockBeforeStartingAnySuite", async () => {
    givenLockHeldBy(String(process.pid))
    const runAll = spawn("bash", ["tests/run-all.sh"], { cwd: CHECKOUT, env })
    children.push(runAll)
    let output = ""
    runAll.stdout.on("data", (chunk) => { output += chunk })
    runAll.stderr.on("data", (chunk) => { output += chunk })
    await until(() => output.includes("waiting for the full suite run"))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.doesNotMatch(output, /TAP version|^# /m)
    assert.equal(spawnSync("pgrep", ["-P", String(runAll.pid), "node"]).status, 1)
  })
})
