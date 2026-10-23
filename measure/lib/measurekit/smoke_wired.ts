import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readJsonl } from "./datafiles.ts"
import { InvalidUtf8Error, isFile, isSystemError, readUtf8, resolveLinks } from "./files.ts"
import { iterRegistrations } from "./hook_settings.ts"
import type { Registration } from "./hook_settings.ts"
import { displayText, isJsonObject, parseJson } from "./json.ts"
import type { JsonObject, JsonValue } from "./json.ts"
import { activeStackNames, hookRowsInForce, KEEL_SOURCE, StackNameError } from "./ledger.ts"
import type { LedgerRow } from "./ledger.ts"
import { FAIL, PASS } from "./metrics.ts"
import { isUnder, mainWorktreeOverlay } from "./overlay_checkout.ts"
import { runProcess, TimeoutExpired } from "./subprocess.ts"
import { assertion, firstItems } from "./smoke_context.ts"
import type { Assertion, SmokeContext } from "./smoke_context.ts"

const FIXTURES_DIR = path.join("tests", "hooks", "fixtures")
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
    if (isUnreadableSetup(error)) return [assertion("wired-fires", "all", FAIL, (error as Error).message)]
    throw error
  }
  if (rows.length === 0) return [assertion("wired-fires", "all", FAIL, "0 hook-layer rows recognized")]
  const realFires = path.join(ctx.dataDir, "logs", "keel-fires.jsonl")
  const before = fingerprint(realFires)
  const problems = rows.map((row) => badFixtureProblem(row, ctx, registrations)).filter(isProblem)
  const hookNames = [...new Set(rows.map((row) => row.hookName as string))].sort()
  problems.push(...hookNames.map((hook) => goodFixtureProblem(hook, ctx, registrations)).filter(isProblem))
  if (fingerprint(realFires) !== before) problems.push("the real keel-fires.jsonl changed during the run (a hook ignores KEEL_DATA_DIR)")
  if (problems.length > 0) return [assertion("wired-fires", "all", FAIL, firstItems(problems))]
  return [assertion("wired-fires", "all", PASS, `${rows.length} rows fired on bad fixtures, ${hookNames.length} hooks quiet on good ones`)]
}

function isUnreadableSetup(error: unknown): boolean {
  return error instanceof StackNameError || error instanceof SyntaxError || error instanceof InvalidUtf8Error || isSystemError(error)
}

function isProblem(problem: string | null): problem is string {
  return problem !== null
}

function badFixtureProblem(row: LedgerRow, ctx: SmokeContext, registrations: Registration[]): string | null {
  const checkout = row.source === KEEL_SOURCE ? ctx.keelHome : ctx.overlayDir
  const fixturePath = path.join(checkout, FIXTURES_DIR, `${row.id}.bad.json`)
  let run: FixtureRun
  try {
    run = runFixture(fixturePath, row.hookName as string, registrations)
  } catch (error) {
    if (error instanceof Unproven) return `${row.id}: ${error.message}`
    throw error
  }
  const expected = run.fixture["expect"]
  if (run.fires.some((fire) => fire["rule_id"] === row.id && fire["outcome"] === expected)) return null
  return `${row.id}: bad fixture logged no ${displayText(expected)} fires line for ${row.id} (exit ${run.exitCode})`
}

function goodFixtureProblem(hook: string, ctx: SmokeContext, registrations: Registration[]): string | null {
  const fixturePath = path.join(hookCheckout(hook, ctx, registrations), FIXTURES_DIR, `${hook}.good.json`)
  let run: FixtureRun
  try {
    run = runFixture(fixturePath, hook, registrations)
  } catch (error) {
    if (error instanceof Unproven) return `${hook}: ${error.message}`
    throw error
  }
  if (run.fires.length > 0) return `${hook}: good fixture fired ${[...new Set(run.fires.map((fire) => displayText(fire["rule_id"])))].sort().join(", ")}`
  if (run.exitCode !== 0) return `${hook}: good fixture exited ${run.exitCode}`
  return null
}

function hookCheckout(hook: string, ctx: SmokeContext, registrations: Registration[]): string {
  const mainOverlay = mainWorktreeOverlay(ctx.overlayDir)
  const overlays = new Set([resolveLinks(ctx.overlayDir), ...(mainOverlay === null ? [] : [mainOverlay])])
  const fromOverlay = registrations.some((registration) => registration.hookName === hook && isUnder(registration.script, overlays))
  return fromOverlay ? ctx.overlayDir : ctx.keelHome
}

function runFixture(fixturePath: string, hook: string, registrations: Registration[]): FixtureRun {
  const fixture = readFixture(fixturePath)
  const payload = fixture["payload"] as JsonObject
  const registration = findRegistration(registrations, hook, payload)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-wired-"))
  try {
    const env = { ...process.env, KEEL_DATA_DIR: path.join(tempDir, "data"), KEEL_OVERLAY_DIR: path.join(tempDir, "overlay") }
    const setup = fixture["setup"]
    for (const command of Array.isArray(setup) ? setup : []) {
      if (runProcess(String(command), { shell: true, cwd: tempDir, env }).returncode !== 0) {
        throw new Unproven(`setup command failed in ${path.basename(fixturePath)}: ${displayText(command)}`)
      }
    }
    const stdin = JSON.stringify(payload).replaceAll(TMP_PLACEHOLDER, JSON.stringify(tempDir).slice(1, -1))
    let completed
    try {
      completed = runProcess(registration.command, { shell: true, input: stdin, cwd: tempDir, env, timeoutSeconds: hookTimeout(registration) })
    } catch (error) {
      if (error instanceof TimeoutExpired) throw new Unproven(`hook timed out on ${path.basename(fixturePath)}`)
      throw error
    }
    const { records: fires } = readJsonl(path.join(tempDir, "data", "logs", "keel-fires.jsonl"))
    return { fixture, exitCode: completed.returncode, fires }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function hookTimeout(registration: Registration): number {
  const timeout = registration.hook["timeout"]
  if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS
  if (typeof timeout === "number") return timeout
  throw new TypeError(`timeout must be a number, got ${displayText(timeout)}`)
}

function readFixture(fixturePath: string): JsonObject {
  if (!isFile(fixturePath)) throw new Unproven(`missing fixture ${fixturePath}`)
  let fixture: JsonValue
  try {
    fixture = parseJson(readUtf8(fixturePath))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidUtf8Error) throw new Unproven(`unreadable fixture ${fixturePath}: ${error.message}`)
    throw error
  }
  if (!isJsonObject(fixture) || !isJsonObject(fixture["payload"])) throw new Unproven(`fixture ${fixturePath} has no payload object`)
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
  throw new Unproven(`no ${displayText(event)}[${tool === undefined || tool === null || tool === "" ? "*" : displayText(tool)}] registration of hook ${hook} in settings.json`)
}

function liveHooks(dataDir: string): JsonValue | undefined {
  const settingsPath = path.join(dataDir, "settings.json")
  if (!isFile(settingsPath)) return {}
  const settings = parseJson(readUtf8(settingsPath))
  return isJsonObject(settings) ? (settings["hooks"] ?? {}) : {}
}

function fingerprint(file: string): string | null {
  try {
    const stat = fs.statSync(file, { bigint: true })
    return `${stat.size}:${stat.mtimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
