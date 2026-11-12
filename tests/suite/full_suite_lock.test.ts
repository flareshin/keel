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

  const checkoutWith = (testFiles: Record<string, string>): string => {
    delete env.NODE_TEST_CONTEXT
    const checkout = path.join(dataDir, "checkout")
    fs.mkdirSync(path.join(checkout, "tests"), { recursive: true })
    for (const script of ["run-all.sh", "suite-lock.sh"]) fs.copyFileSync(path.join(CHECKOUT, "tests", script), path.join(checkout, "tests", script))
    for (const [file, body] of Object.entries(testFiles)) {
      fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true })
      fs.writeFileSync(path.join(checkout, file), body)
    }
    return checkout
  }

  const PASSING = 'import { it } from "node:test"\nit("passes", () => {})\n'
  const FAILING = 'import { it } from "node:test"\nit("fails", () => { throw new Error("red") })\n'
  const HANGING = [
    'import fs from "node:fs"',
    'import { spawn } from "node:child_process"',
    'fs.writeFileSync(process.env.HANG_PID_FILE as string, String(process.pid))',
    'let previous: ReturnType<typeof spawn> | undefined',
    'setInterval(() => {',
    '  const next = spawn("sleep", ["600"])',
    '  fs.appendFileSync(process.env.HANG_FORKS_FILE as string, `${next.pid}\\n`)',
    '  previous?.kill("SIGKILL")',
    '  previous = next',
    '}, 10)',
    '',
  ].join("\n")

  const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  const hangingRunAll = (limitSeconds: string, extraEnv: NodeJS.ProcessEnv = {}): { run: Run; hangPidFile: string; forksFile: string } => {
    const hangPidFile = path.join(dataDir, "hang.pid")
    const forksFile = path.join(dataDir, "hang.forks")
    const checkout = checkoutWith({ "tests/hang.test.ts": HANGING })
    env = { ...env, ...extraEnv, HANG_PID_FILE: hangPidFile, HANG_FORKS_FILE: forksFile, KEEL_SUITE_TIMEOUT_SECONDS: limitSeconds }
    return { run: spawnRun([path.join(checkout, "tests", "run-all.sh")]), hangPidFile, forksFile }
  }

  const theHangStarted = (hangPidFile: string): boolean => fs.existsSync(hangPidFile) && fs.readFileSync(hangPidFile, "utf8") !== ""

  const aliveAfterTheStop = async (hangPidFile: string, forksFile: string): Promise<number[]> => {
    const hangPid = Number(fs.readFileSync(hangPidFile, "utf8"))
    const forks = fs.readFileSync(forksFile, "utf8").trim().split("\n").map(Number)
    const commandOf = (pid: number): string => spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()
    const stillOurs = (pid: number): boolean => isAlive(pid) && (pid === hangPid ? commandOf(pid).includes("hang.test.ts") : commandOf(pid) === "sleep 600")
    const pids = [hangPid, ...forks]
    const deadline = Date.now() + 5_000
    while (pids.some(stillOurs) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    const alive = pids.filter(stillOurs)
    for (const pid of alive) process.kill(pid, "SIGKILL")
    return alive
  }

  const theOnlyHang = (): string => {
    const hangsDir = path.join(dataDir, "state", "keel", "suite-hangs")
    const [hang] = fs.readdirSync(hangsDir)
    return path.join(hangsDir, hang as string)
  }

  it("runAll_aSuitePastTheLimit_isStoppedWithEachProcessStackSaved_includingProcessesForkedMeanwhile_andReleasesTheLock", async () => {
    const { run, hangPidFile, forksFile } = hangingRunAll("5")
    assert.equal((await run.done).code, 124)
    const savedTo = theOnlyHang()
    const hangPid = Number(fs.readFileSync(hangPidFile, "utf8"))
    const message = run.stderr().match(/run-all: the full suite ran past 5 seconds; saved (\d+) of (\d+) process stacks to (.+) and stopped it/)
    assert.ok(message, run.stderr())
    assert.equal(message[3], savedTo)
    assert.match(fs.readFileSync(path.join(savedTo, "processes.txt"), "utf8"), /hang\.test\.ts/)
    if (process.platform === "darwin") {
      assert.match(fs.readFileSync(path.join(savedTo, `${hangPid}.txt`), "utf8"), /Call graph/)
      assert.ok(Number(message[1]) >= 1, run.stderr())
    }
    assert.deepEqual(await aliveAfterTheStop(hangPidFile, forksFile), [])
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("runAll_aSuitePastTheLimitWhoseStacksCannotBeSampled_saysNoneWereSaved_andStillStopsIt", async () => {
    const stubs = path.join(dataDir, "stubs")
    fs.mkdirSync(stubs)
    fs.writeFileSync(path.join(stubs, "sample"), "#!/bin/bash\nexit 1\n", { mode: 0o755 })
    const { run, hangPidFile, forksFile } = hangingRunAll("5", { PATH: `${stubs}:${process.env.PATH}` })
    assert.equal((await run.done).code, 124)
    assert.match(run.stderr(), /run-all: the full suite ran past 5 seconds; saved 0 of \d+ process stacks to .+ and stopped it/)
    assert.deepEqual(await aliveAfterTheStop(hangPidFile, forksFile), [])
    assert.equal(fs.existsSync(lockDir), false)
  })

  it("runAll_stoppedByTermBeforeTheLimit_stopsTheSuiteItStarted_includingProcessesForkedMeanwhile_andReleasesTheLock", async () => {
    const { run, hangPidFile, forksFile } = hangingRunAll("600")
    await until(() => theHangStarted(hangPidFile))
    assert.equal(holderPid(), String(run.child.pid))
    run.child.kill("SIGTERM")
    assert.equal((await run.done).code, 143)
    assert.deepEqual(await aliveAfterTheStop(hangPidFile, forksFile), [])
    assert.equal(fs.existsSync(lockDir), false)
  })

  for (const limit of ["30m", "08"]) {
    it(`runAll_aLimitThatIsNotWholeSecondsWrittenPlainly_${limit}_failsNamingTheVariable_beforeStartingAnySuite`, async () => {
      const { run, hangPidFile } = hangingRunAll(limit)
      assert.equal((await run.done).code, 2)
      assert.ok(run.stderr().includes(`run-all: KEEL_SUITE_TIMEOUT_SECONDS must be whole seconds without leading zeros, got '${limit}'`), run.stderr())
      assert.equal(fs.existsSync(hangPidFile), false)
      assert.equal(fs.existsSync(lockDir), false)
    })
  }

  it("runAll_aSuiteWithinTheLimit_keepsItsExitStatus", async () => {
    env = { ...env, KEEL_SUITE_TIMEOUT_SECONDS: "600" }
    const passing = spawnRun([path.join(checkoutWith({ "tests/a.test.ts": PASSING, "codex/tests/b.test.ts": PASSING, "tests/workflows/c.test.mjs": PASSING }), "tests", "run-all.sh")])
    assert.equal((await passing.done).code, 0)
    fs.rmSync(path.join(dataDir, "checkout"), { recursive: true, force: true })
    const failing = spawnRun([path.join(checkoutWith({ "tests/a.test.ts": PASSING, "tests/workflows/c.test.mjs": FAILING }), "tests", "run-all.sh")])
    assert.equal((await failing.done).code, 1)
    assert.equal(fs.existsSync(lockDir), false)
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
