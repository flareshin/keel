import fs from "node:fs"
import os from "node:os"

import { readJsonl } from "./datafiles.ts"
import { iterRegistrations } from "./hook_settings.ts"
import type { Registration } from "./hook_settings.ts"
import { activeStackNames, hookRowsInForce, KEEL_SOURCE } from "./ledger.ts"
import type { LedgerRow } from "./ledger.ts"
import { FAIL, PASS } from "./metrics.ts"
import { isUnder, mainWorktreeOverlay } from "./overlay_checkout.ts"
import { isOsError, ValueError } from "./pyerrors.ts"
import { readText } from "./pyio.ts"
import { pythonJsonDumps, pythonJsonLoads } from "./pyjson.ts"
import { isFile, pyBasename, pyJoin, realpath } from "./pypath.ts"
import { sortedByCodePoint } from "./pystr.ts"
import { isJsonObject, PyFloat, pyStr } from "./pyvalue.ts"
import type { JsonObject, PyValue } from "./pyvalue.ts"
import { runProcess, TimeoutExpired } from "./subprocess.ts"
import { assertion, firstItems } from "./smoke_context.ts"
import type { Assertion, SmokeContext } from "./smoke_context.ts"

const FIXTURES_DIR = pyJoin("tests", "hooks", "fixtures")
const TMP_PLACEHOLDER = "{{TMP}}"
const DEFAULT_TIMEOUT_SECONDS = 60

class Unproven extends Error {}

interface FixtureRun {
  fixture: JsonObject
  exitCode: number
  fires: JsonObject[]
}

export function checkWiredFires(ctx: SmokeContext): Assertion[] {
  let rows: LedgerRow[]
  let registrations: Registration[]
  try {
    rows = hookRowsInForce(ctx.ledgers, activeStackNames(ctx.overlayDir))
    registrations = iterRegistrations(liveHooks(ctx.dataDir))
  } catch (error) {
    if (error instanceof ValueError || isOsError(error)) return [assertion("wired-fires", "all", FAIL, (error as Error).message)]
    throw error
  }
  if (rows.length === 0) return [assertion("wired-fires", "all", FAIL, "0 hook-layer rows recognized")]
  const realFires = pyJoin(ctx.dataDir, "logs", "keel-fires.jsonl")
  const before = fingerprint(realFires)
  const problems = rows.map((row) => badFixtureProblem(row, ctx, registrations)).filter(isProblem)
  const hookNames = sortedByCodePoint(new Set(rows.map((row) => row.hookName as string)))
  problems.push(...hookNames.map((hook) => goodFixtureProblem(hook, ctx, registrations)).filter(isProblem))
  if (fingerprint(realFires) !== before) problems.push("the real keel-fires.jsonl changed during the run (a hook ignores KEEL_DATA_DIR)")
  if (problems.length > 0) return [assertion("wired-fires", "all", FAIL, firstItems(problems))]
  return [assertion("wired-fires", "all", PASS, `${rows.length} rows fired on bad fixtures, ${hookNames.length} hooks quiet on good ones`)]
}

function isProblem(problem: string | null): problem is string {
  return problem !== null
}

function badFixtureProblem(row: LedgerRow, ctx: SmokeContext, registrations: Registration[]): string | null {
  const checkout = row.source === KEEL_SOURCE ? ctx.keelHome : ctx.overlayDir
  const path = pyJoin(checkout, FIXTURES_DIR, `${row.id}.bad.json`)
  let run: FixtureRun
  try {
    run = runFixture(path, row.hookName as string, registrations)
  } catch (error) {
    if (error instanceof Unproven) return `${row.id}: ${error.message}`
    throw error
  }
  const expected = run.fixture["expect"]
  if (run.fires.some((fire) => fire["rule_id"] === row.id && fire["outcome"] === expected)) return null
  return `${row.id}: bad fixture logged no ${pyStr(expected)} fires line for ${row.id} (exit ${run.exitCode})`
}

function goodFixtureProblem(hook: string, ctx: SmokeContext, registrations: Registration[]): string | null {
  const path = pyJoin(hookCheckout(hook, ctx, registrations), FIXTURES_DIR, `${hook}.good.json`)
  let run: FixtureRun
  try {
    run = runFixture(path, hook, registrations)
  } catch (error) {
    if (error instanceof Unproven) return `${hook}: ${error.message}`
    throw error
  }
  if (run.fires.length > 0) return `${hook}: good fixture fired ${sortedByCodePoint(new Set(run.fires.map((fire) => pyStr(fire["rule_id"])))).join(", ")}`
  if (run.exitCode !== 0) return `${hook}: good fixture exited ${run.exitCode}`
  return null
}

function hookCheckout(hook: string, ctx: SmokeContext, registrations: Registration[]): string {
  const mainOverlay = mainWorktreeOverlay(ctx.overlayDir)
  const overlays = new Set([realpath(ctx.overlayDir), ...(mainOverlay === null ? [] : [mainOverlay])])
  const fromOverlay = registrations.some((registration) => registration.hookName === hook && isUnder(registration.script, overlays))
  return fromOverlay ? ctx.overlayDir : ctx.keelHome
}

function runFixture(path: string, hook: string, registrations: Registration[]): FixtureRun {
  const fixture = readFixture(path)
  const payload = fixture["payload"] as JsonObject
  const registration = findRegistration(registrations, hook, payload)
  const tempDir = fs.mkdtempSync(pyJoin(os.tmpdir(), "keel-wired-"))
  try {
    const env = { ...process.env, KEEL_DATA_DIR: pyJoin(tempDir, "data"), KEEL_OVERLAY_DIR: pyJoin(tempDir, "overlay") }
    const setup = fixture["setup"]
    for (const command of Array.isArray(setup) ? setup : []) {
      if (runProcess(String(command), { shell: true, cwd: tempDir, env }).returncode !== 0) {
        throw new Unproven(`setup command failed in ${pyBasename(path)}: ${pyStr(command)}`)
      }
    }
    const stdin = pythonJsonDumps(payload).replaceAll(TMP_PLACEHOLDER, pythonJsonDumps(tempDir).slice(1, -1))
    let completed
    try {
      completed = runProcess(registration.command, { shell: true, input: stdin, cwd: tempDir, env, timeoutSeconds: hookTimeout(registration) })
    } catch (error) {
      if (error instanceof TimeoutExpired) throw new Unproven(`hook timed out on ${pyBasename(path)}`)
      throw error
    }
    const { records: fires } = readJsonl(pyJoin(tempDir, "data", "logs", "keel-fires.jsonl"))
    return { fixture, exitCode: completed.returncode, fires }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function hookTimeout(registration: Registration): number {
  const timeout = registration.hook["timeout"]
  if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS
  if (typeof timeout === "number") return timeout
  if (timeout instanceof PyFloat) return timeout.value
  if (typeof timeout === "bigint") return Number(timeout)
  throw new TypeError(`timeout must be a number, got ${pyStr(timeout)}`)
}

function readFixture(path: string): JsonObject {
  if (!isFile(path)) throw new Unproven(`missing fixture ${path}`)
  let fixture: PyValue
  try {
    fixture = pythonJsonLoads(readText(path))
  } catch (error) {
    if (error instanceof ValueError) throw new Unproven(`unreadable fixture ${path}: ${error.message}`)
    throw error
  }
  if (!isJsonObject(fixture) || !isJsonObject(fixture["payload"])) throw new Unproven(`fixture ${path} has no payload object`)
  return fixture
}

function findRegistration(registrations: Registration[], hook: string, payload: JsonObject): Registration {
  const event = payload["hook_event_name"]
  const tool = payload["tool_name"]
  for (const registration of registrations) {
    if (registration.hookName === hook && registration.event === event && (tool === undefined || tool === null || registration.coversTool(tool as string))) {
      if (!isFile(registration.script)) throw new Unproven(`script missing: ${registration.script}`)
      return registration
    }
  }
  throw new Unproven(`no ${pyStr(event)}[${tool === undefined || tool === null || tool === "" ? "*" : pyStr(tool)}] registration of hook ${hook} in settings.json`)
}

function liveHooks(dataDir: string): PyValue | undefined {
  const path = pyJoin(dataDir, "settings.json")
  if (!isFile(path)) return {}
  const settings = pythonJsonLoads(readText(path))
  return isJsonObject(settings) ? (settings["hooks"] ?? {}) : {}
}

function fingerprint(path: string): string | null {
  try {
    const stat = fs.statSync(path, { bigint: true })
    return `${stat.size}:${stat.mtimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
