import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isSystemError, sortedByCodePoint } from "../../hooks/lib/hookkit/pycompat.ts";
import { OSError } from "../../hooks/lib/hookkit/subprocess.ts";
import { readJson, writeAtomic } from "./files.ts";
import type { ManagedFile } from "./files.ts";
import { ValueError } from "./pyerrors.ts";
import { childPath, isAbsolute, isSymlink, nameOf, parentOf, pathExists, resolvePath } from "./pyfs.ts";
import { cloneJson, isJsonObject, PyFloat, pythonJsonDumps } from "./pyjson.ts";
import type { JsonValue } from "./pyjson.ts";

export const REGISTRY_NAME = "keel-codex-skills.json";
export const LOCK_NAME = "keel-codex-skills.lock";
const LOCK_POLL_MILLISECONDS = 25;
const LOCK_TIMEOUT_MILLISECONDS = 60_000;
const UNOWNED_LOCK_GRACE_MILLISECONDS = 5_000;
const REGISTRY_VERSION = 1;

export interface SkillRecord {
  target: string;
  managed: boolean;
  profiles: string[];
  [extra: string]: JsonValue;
}

export type SkillRecords = Map<string, SkillRecord>;

export interface SkillPlan {
  records: SkillRecords;
  create: Map<string, string>;
  replace: Map<string, string>;
  remove: string[];
  problems: string[];
  changed: boolean;
}

export interface SkillFiles {
  writeAtomic: (path: string, content: string) => void;
  replaceLink: (path: string, target: string) => void;
}

export function installationLockDirectory(agentsHome: string): string {
  return childPath(agentsHome, `${LOCK_NAME}.d`);
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const OWNER_PROCESS_ID = /^[0-9]+$/;
const startedAfterLock = new Map<string, boolean>();

function ownerProcessId(lock: string): number | null {
  try {
    const text = readFileSync(`${lock}/owner`, "utf8");
    const id = OWNER_PROCESS_ID.test(text) ? Number(text) : 0;
    return id > 0 ? id : null;
  } catch (error) {
    if (!isSystemError(error)) throw error;
    return null;
  }
}

function processIsAlive(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return !(isSystemError(error) && error.code === "ESRCH");
  }
}

function processStartedAfter(id: number, moment: number): boolean {
  const key = `${id}@${moment}`;
  const known = startedAfterLock.get(key);
  if (known !== undefined) return known;
  const listing = spawnSync("ps", ["-o", "lstart=", "-p", String(id)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (listing.error !== undefined || listing.status !== 0 || typeof listing.stdout !== "string") return false;
  const started = Date.parse(listing.stdout.trim());
  const later = listing.status === 0 && !Number.isNaN(started) && started > moment;
  startedAfterLock.set(key, later);
  return later;
}

export function lockIsStale(lock: string, now: number = Date.now()): boolean {
  let modified: number;
  try {
    modified = statSync(lock).mtimeMs;
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
  const owner = ownerProcessId(lock);
  if (owner === null) return now - modified > UNOWNED_LOCK_GRACE_MILLISECONDS;
  return !processIsAlive(owner) || processStartedAfter(owner, modified);
}

function removeStaleLock(lock: string): void {
  const retired = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lock, retired);
  } catch (error) {
    if (isSystemError(error)) return;
    throw error;
  }
  rmSync(retired, { recursive: true, force: true });
}

function acquireLock(lock: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(`${lock}/owner`, String(process.pid));
      return;
    } catch (error) {
      if (!isSystemError(error) || error.code !== "EEXIST") throw error;
    }
    if (lockIsStale(lock)) removeStaleLock(lock);
    else if (Date.now() > deadline) throw new OSError(`timed out waiting for ${lock}`, "ETIMEDOUT");
    else sleep(LOCK_POLL_MILLISECONDS);
  }
}

export function withInstallationLock<T>(agentsHome: string, write: boolean, body: () => T): T {
  if (!write) return body();
  mkdirSync(agentsHome, { recursive: true });
  const lock = installationLockDirectory(agentsHome);
  acquireLock(lock);
  try {
    return body();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export const realSkillFiles: SkillFiles = { writeAtomic, replaceLink };

export function planSkills(agentsHome: string, profile: string, desired: Map<string, ManagedFile>): SkillPlan {
  const original = readRegistry(agentsHome);
  const plan: SkillPlan = { records: new Map(Array.from(original, ([name, record]) => [name, cloneJson(record)])), create: new Map(), replace: new Map(), remove: [], problems: [], changed: false };
  const desiredNames = new Set(Array.from(desired.keys(), nameOf));
  for (const [name, record] of Array.from(plan.records)) {
    if (!desiredNames.has(name) && record.profiles.includes(profile)) releaseSkill(plan, childPath(agentsHome, `skills/${name}`), profile);
  }
  for (const [path, link] of desired) registerSkill(plan, path, link.content, profile);
  plan.changed = !isDeepStrictEqual(plan.records, original) || plan.create.size > 0 || plan.replace.size > 0 || plan.remove.length > 0;
  return plan;
}

function readRegistry(agentsHome: string): SkillRecords {
  const registry = readJson(childPath(agentsHome, REGISTRY_NAME));
  if (Object.keys(registry).length === 0) return new Map();
  const skills = registry["skills"];
  if (!isVersionOne(registry["version"]) || !isJsonObject(skills)) throw new ValueError("invalid shared skill registry");
  const records: SkillRecords = new Map();
  for (const [name, entry] of Object.entries(skills)) {
    records.set(name, validatedRecord(name, entry));
  }
  return records;
}

function isVersionOne(version: JsonValue | undefined): boolean {
  return version === REGISTRY_VERSION || version === true || (version instanceof PyFloat && version.value === REGISTRY_VERSION);
}

function validatedRecord(name: string, entry: JsonValue): SkillRecord {
  if (name === "" || name === "." || name === ".." || name.includes("/") || !isJsonObject(entry)) {
    throw new ValueError("invalid skill registry entry");
  }
  const { target, profiles, managed } = entry as { [key: string]: JsonValue | undefined };
  if (typeof target !== "string" || !isAbsolute(target) || typeof managed !== "boolean") {
    throw new ValueError(`invalid skill target or ownership: ${name}`);
  }
  if (!Array.isArray(profiles) || profiles.length === 0) throw new ValueError(`invalid skill profile references: ${name}`);
  if (profiles.some((profile) => typeof profile !== "string" || !isAbsolute(profile))) {
    throw new ValueError(`invalid skill profile path: ${name}`);
  }
  return entry as SkillRecord;
}

function recordOf(plan: SkillPlan, name: string): SkillRecord {
  const record = plan.records.get(name);
  if (record === undefined) throw new ValueError(`unknown skill: ${name}`);
  return record;
}

function releaseSkill(plan: SkillPlan, path: string, profile: string): void {
  const name = nameOf(path);
  const record = recordOf(plan, name);
  const remaining = record.profiles.filter((item) => item !== profile);
  if (remaining.length > 0) {
    record.profiles = remaining;
    return;
  }
  if (record.managed && (pathExists(path) || isSymlink(path))) {
    if (!sameLink(path, record.target)) {
      plan.problems.push(`managed skill edited: ${path}`);
      return;
    }
    plan.remove.push(path);
  }
  plan.records.delete(name);
}

function registerSkill(plan: SkillPlan, path: string, target: string, profile: string): void {
  const name = nameOf(path);
  let record = plan.records.get(name);
  if (record !== undefined && record.target !== target) {
    retargetSkill(plan, record, path, target, profile);
    return;
  }
  const exists = pathExists(path) || isSymlink(path);
  if (exists && !sameLink(path, target)) {
    plan.problems.push(`conflict: ${path}; preserve it and reconcile manually`);
    return;
  }
  if (record === undefined) {
    record = { target, managed: !exists, profiles: [] };
    plan.records.set(name, record);
  }
  record.profiles = sortedByCodePoint(new Set([...record.profiles, profile]));
  if (!exists) {
    plan.create.set(path, target);
    record.managed = true;
  }
}

function retargetSkill(plan: SkillPlan, record: SkillRecord, path: string, target: string, profile: string): void {
  const completed = sameLink(path, target);
  const owned = record.managed && record.profiles.length === 1 && record.profiles[0] === profile;
  if (owned && (completed || sameLink(path, record.target))) {
    if (!completed) plan.replace.set(path, target);
    record.target = target;
  } else {
    plan.problems.push(`shared skill target conflicts with another installation: ${path}`);
  }
}

function sameLink(path: string, target: string): boolean {
  return isSymlink(path) && resolvePath(path) === target;
}

export function applySkillPlan(agentsHome: string, plan: SkillPlan, files: SkillFiles = realSkillFiles): void {
  for (const [path, target] of plan.create) {
    mkdirSync(parentOf(path), { recursive: true });
    symlinkSync(target, path, "dir");
  }
  for (const [path, target] of plan.replace) files.replaceLink(path, target);
  if (plan.changed) {
    files.writeAtomic(childPath(agentsHome, REGISTRY_NAME), pythonJsonDumps({ version: REGISTRY_VERSION, skills: recordsAsJson(plan.records) }, { indent: 2 }) + "\n");
  }
  for (const path of plan.remove) unlinkSync(path);
}

function recordsAsJson(records: SkillRecords): { [key: string]: JsonValue } {
  const skills: { [key: string]: JsonValue } = {};
  for (const [name, record] of records) Object.defineProperty(skills, name, { value: record, enumerable: true, writable: true, configurable: true });
  return skills;
}

export function replaceLink(path: string, target: string): void {
  const directory = parentOf(path);
  const temporary = mkdtempSync(`${directory}/.${nameOf(path)}.`);
  try {
    const replacement = `${temporary}/link`;
    symlinkSync(target, replacement, "dir");
    renameSync(replacement, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
