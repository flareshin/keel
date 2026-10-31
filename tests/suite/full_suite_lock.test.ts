import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

const CHECKOUT = path.resolve(import.meta.dirname, "..", "..")
const WAITING = "waiting for the full suite run"
const PAST_THE_GRACE_MS = 90_000
const TAKEOVER_DEADLINE_MS = 5_000

type Run = { child: ChildProcess; stdout: () => string; stderr: () => string; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

describe("full suite lock", { timeout: 60_000 }, () => {
  let dataDir: string
  let lockDir: string
  let env: NodeJS.ProcessEnv
  let children: ChildProcess[]

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-lock-"))
    lockDir = path.join(dataDir, "state", "keel", "full-suite.lock")
    env = { ...process.env, KEEL_DATA_DIR: dataDir, KEEL_SUITE_LOCK_POLL_SECONDS: "0.02" }
    children = []
  })
  afterEach(() => {
    for (const child of children) {
      try { process.kill(-(child.pid as number), "SIGKILL") } catch { }
    }
    fs.chmodSync(path.dirname(lockDir), 0o755)
    if (fs.existsSync(lockDir)) fs.chmodSync(lockDir, 0o755)
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const spawnRun = (args: string[]): Run => {
    const child = spawn("bash", args, { cwd: CHECKOUT, env, detached: true })
    children.push(child)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })))
    return { child, stdout: () => stdout, stderr: () => stderr, done }
  }

  const underLock = (script: string): Run => spawnRun(["-c", `source tests/suite-lock.sh; hold_suite_lock; ${script}`])

  const until = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out waiting")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  const backdatePastTheGrace = (dir: string): void => {
    const pastTheGrace = new Date(Date.now() - PAST_THE_GRACE_MS)
    fs.utimesSync(dir, pastTheGrace, pastTheGrace)
  }

  const holderPid = (): string => fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim()

  const givenLockHeldBy = (pid: string | null): void => {
    fs.mkdirSync(lockDir, { recursive: true })
    if (pid !== null) fs.writeFileSync(path.join(lockDir, "pid"), pid + "\n")
  }

  const deadPid = (): string => String(spawnSync("true").pid)

  const holdingUntilReleased = (marker: string, release: string, after: string = ""): Run =>
    underLock(`touch '${marker}'; while [ ! -e '${release}' ]; do sleep 0.02; done; ${after}`)

  it("aSecondRun_waitsUntilTheFirstReleasesTheLock_andSaysWhoHoldsIt", async () => {
    const order = path.join(dataDir, "order")
    const release = path.join(dataDir, "release")
    const first = underLock(`echo first >> '${order}'; while [ ! -e '${release}' ]; do sleep 0.02; done`)
    await until(() => fs.existsSync(order))
    const second = underLock(`echo second >> '${order}'`)
    await until(() => second.stderr().includes(WAITING))
    assert.match(second.stderr(), new RegExp(`pid ${first.child.pid}`))
    assert.equal(fs.readFileSync(order, "utf8"), "first\n")
    fs.writeFileSync(release, "")
    assert.deepEqual([(await first.done).code, (await second.done).code], [0, 0])
    assert.equal(fs.readFileSync(order, "utf8"), "first\nsecond\n")
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("manyContenders_neverHoldTheLockAtTheSameTime", async () => {
    for (let trial = 0; trial < 5; trial++) {
      const log = path.join(dataDir, `log-${trial}`)
      const runs = Array.from({ length: 8 }, () => underLock(`echo "start $$" >> '${log}'; sleep 0.05; echo "end $$" >> '${log}'`))
      assert.deepEqual((await Promise.all(runs.map((run) => run.done))).map((exit) => exit.code), Array(8).fill(0))
      const lines = fs.readFileSync(log, "utf8").trim().split("\n")
      for (let index = 0; index < lines.length; index += 2) {
        assert.equal(lines[index + 1], lines[index]?.replace("start", "end"), `trial ${trial}: ${lines.join(" | ")}`)
      }
    }
  })

  it("aLockWhoseHolderIsGone_isTakenOver", async () => {
    givenLockHeldBy(deadPid())
    const run = underLock(`cat '${path.join(lockDir, "pid")}'`)
    assert.equal((await run.done).code, 0)
    assert.equal(run.stdout().trim(), String(run.child.pid))
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("aReclaimJudgedOnAHolderThatIsGone_leavesTheLockANewHolderTookMeanwhile", async () => {
    givenLockHeldBy(String(process.pid))
    const reclaim = spawnRun(["-c", `source tests/suite-lock.sh; reclaim_suite_lock ${deadPid()}`])
    assert.equal((await reclaim.done).code, 0)
    assert.equal(holderPid(), String(process.pid))
    assert.equal(fs.existsSync(`${lockDir}.reclaim`), false)
  })

  const reclaimRun = (judged: string): Run => spawnRun(["-c", `source tests/suite-lock.sh; reclaim_suite_lock '${judged}'`])

  it("aReclaimWhileAnotherReclaimIsUnderWay_leavesTheLockAndTheOtherReclaim", async () => {
    const dead = deadPid()
    givenLockHeldBy(dead)
    fs.mkdirSync(`${lockDir}.reclaim`)
    assert.equal((await reclaimRun(dead).done).code, 0)
    assert.equal(holderPid(), dead)
    assert.equal(fs.existsSync(`${lockDir}.reclaim`), true)
  })

  it("aReclaimThatStoppedHalfway_failsTheRunWithAMessageNamingBothPaths", async () => {
    givenLockHeldBy(deadPid())
    fs.mkdirSync(`${lockDir}.reclaim`)
    backdatePastTheGrace(`${lockDir}.reclaim`)
    const run = spawnRun(["-c", "source tests/suite-lock.sh; hold_suite_lock || exit 1; echo acquired"])
    assert.equal((await run.done).code, 1)
    assert.match(run.stderr(), /reclaim of the full suite lock stopped halfway/)
    assert.ok(run.stderr().includes(`remove ${lockDir}.reclaim and ${lockDir} if`))
    assert.equal(run.stdout(), "")
  })

  it("aReclaimJudgedOnAnUnownedLock_leavesItWhileItIsStillWithinTheGrace", async () => {
    givenLockHeldBy(null)
    assert.equal((await reclaimRun("").done).code, 0)
    assert.equal(fs.existsSync(lockDir), true)
    assert.equal(fs.existsSync(`${lockDir}.reclaim`), false)
  })

  it("aStaleLockThatCannotBeRemoved_failsTheRunWithAMessage", async () => {
    givenLockHeldBy(deadPid())
    fs.chmodSync(lockDir, 0o555)
    const run = spawnRun(["-c", "source tests/suite-lock.sh; hold_suite_lock || exit 1; echo acquired"])
    assert.equal((await run.done).code, 1)
    assert.ok(run.stderr().includes(`cannot remove the stale full suite lock ${lockDir}: `))
    assert.match(run.stderr(), /Permission denied/)
    assert.equal(run.stdout(), "")
    assert.equal(fs.existsSync(`${lockDir}.reclaim`), false)
  })

  it("anUnownedLockPastTheGrace_isTakenOver_butAFreshOneIsWaitedFor", async () => {
    givenLockHeldBy(null)
    const waiting = underLock("true")
    await until(() => waiting.stderr().includes(`${WAITING} by pid unknown`))
    backdatePastTheGrace(lockDir)
    const timedOut = new Promise((resolve) => setTimeout(resolve, TAKEOVER_DEADLINE_MS, "still waiting"))
    assert.deepEqual(await Promise.race([waiting.done, timedOut]), { code: 0, signal: null })
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("aLockThatCannotBeCreated_failsWithAMessage", async () => {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true })
    fs.chmodSync(path.dirname(lockDir), 0o555)
    const run = spawnRun(["-c", "source tests/suite-lock.sh; hold_suite_lock || exit 1; echo acquired"])
    assert.equal((await run.done).code, 1)
    assert.match(run.stderr(), /cannot create the full suite lock/)
    assert.equal(run.stdout(), "")
  })

  it("aFailingRun_releasesTheLock_andKeepsItsExitStatus", async () => {
    const run = underLock(`test -d '${lockDir}' || exit 9; exit 3`)
    assert.equal((await run.done).code, 3)
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("aHolderStoppedByTermOrInt_exitsWithTheSignalStatus_releasesTheLock_andRunsNothingAfter", async () => {
    for (const [signal, status] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
      const marker = path.join(dataDir, `held-${signal}`)
      const after = path.join(dataDir, `after-${signal}`)
      const holder = holdingUntilReleased(marker, path.join(dataDir, "never"), `touch '${after}'`)
      await until(() => fs.existsSync(marker))
      holder.child.kill(signal)
      assert.equal((await holder.done).code, status, signal)
      assert.equal(fs.existsSync(after), false, signal)
      assert.equal(fs.existsSync(lockDir), false, signal)
    }
  })

  it("aHolderWhoseLockWasTakenOver_leavesTheNewHoldersLockOnExit", async () => {
    const marker = path.join(dataDir, "held")
    const release = path.join(dataDir, "release")
    const holder = holdingUntilReleased(marker, release)
    await until(() => fs.existsSync(marker))
    fs.writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`)
    fs.writeFileSync(release, "")
    assert.equal((await holder.done).code, 0)
    assert.equal(holderPid(), String(process.pid))
  })

  it("aWaitingRunThatIsStopped_leavesTheHoldersLockInPlace", async () => {
    givenLockHeldBy(String(process.pid))
    const waiting = underLock("true")
    await until(() => waiting.stderr().includes(WAITING))
    waiting.child.kill("SIGTERM")
    await waiting.done
    assert.equal(holderPid(), String(process.pid))
  })

  it("runAll_waitsForTheLockBeforeStartingAnySuite", async () => {
    givenLockHeldBy(String(process.pid))
    const runAll = spawnRun(["tests/run-all.sh"])
    await until(() => runAll.stderr().includes(WAITING))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.doesNotMatch(runAll.stdout() + runAll.stderr(), /TAP version|^# /m)
    assert.equal(spawnSync("pgrep", ["-P", String(runAll.child.pid), "node"]).status, 1)
  })
})
