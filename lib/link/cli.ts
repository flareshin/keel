import fs from "node:fs"

import { ArgumentParser } from "../../measure/lib/measurekit/argparse.ts"
import type { ParsedArguments } from "../../measure/lib/measurekit/argparse.ts"
import { ValueError, isOsError } from "../../measure/lib/measurekit/pyerrors.ts"
import { backslashReplaceLoneSurrogates, readText, newlineSeparatedLines } from "../../measure/lib/measurekit/pyio.ts"
import { pythonJsonDumps } from "../../measure/lib/measurekit/pyjson.ts"
import { isFile, pyJoin, realpath } from "../../measure/lib/measurekit/pypath.ts"
import { pySplitlines, pyStrip } from "../../measure/lib/measurekit/pystr.ts"
import type { JsonObject } from "../../measure/lib/measurekit/pyvalue.ts"
import { shlexQuote } from "../../measure/lib/measurekit/shlex.ts"
import * as claudeMd from "./claude_md.ts"
import { EXIT_INTERNAL, EXIT_NEGATIVE, EXIT_OK, EXIT_REFUSED, Refused, resolvePaths, runGit } from "./config.ts"
import type { KeelPaths } from "./config.ts"
import { describeInternalError } from "./internal_error.ts"
import * as links from "./links.ts"
import { member } from "./members.ts"
import { FORCE_FLAG, LIFTING_FLAGS, buildPlan, changeToJson, problemBlocks, problemToJson } from "./plan.ts"
import type { BlockLevel, Plan, Problem } from "./plan.ts"
import * as settingsJson from "./settings_json.ts"

const V1_TAG = "v1-final"

interface LinkArgs {
  readonly write: boolean
  readonly check: boolean
  readonly unlink: boolean
  readonly force: boolean
  readonly allowWorktree: boolean
  readonly adopt: boolean
  readonly acceptDrops: string | undefined
}

export function main(argv: string[]): number {
  const args = parseArgs(argv)
  try {
    const paths = resolvePaths()
    if (args.unlink) return runUnlink(paths)
    const plan = buildPlan(paths)
    for (const conflict of plan.conflicts) say(`link: warning: settings conflict: ${conflict}`)
    if (args.write) return runWrite(plan, paths, args)
    if (args.check) {
      emit([], plan.problems)
      return plan.problems.length > 0 ? EXIT_NEGATIVE : EXIT_OK
    }
    emit(plan.changes, plan.problems, { dropped: plan.droppedSettings, claude_md_bytes: plan.claudeMdBytes })
    return EXIT_OK
  } catch (error) {
    if (error instanceof Refused) {
      say(`link: refused: ${error.message}`)
      return EXIT_REFUSED
    }
    say(`link: internal error: ${describeInternalError(error)}`)
    return EXIT_INTERNAL
  }
}

function runWrite(plan: Plan, paths: KeelPaths, args: LinkArgs): number {
  if (!args.allowWorktree && isLinkedWorktree(paths.keelHome)) {
    throw new Refused(`KEEL_HOME ${paths.keelHome} is a linked worktree; link a merged checkout or pass --allow-worktree`)
  }
  const blocking = plan.problems.filter((problem) => problemBlocks(problem, args.force, args.adopt))
  if (blocking.length > 0) {
    sayDrops(plan.droppedSettings)
    emit([], blocking)
    say("link: refused: resolve the problems above; nothing was written")
    if (blocking.every((problem) => LIFTING_FLAGS[problem.blocksWrite] !== null)) {
      say(`link: or, once each one is reviewed, run: ${buildWriteCommand(plan, args.allowWorktree)}`)
    }
    return EXIT_REFUSED
  }
  if (args.adopt) requireEveryDropAccepted(plan, args.acceptDrops, args.allowWorktree)
  for (const problem of plan.problems) {
    if (args.force && LIFTING_FLAGS[problem.blocksWrite]?.includes(FORCE_FLAG)) say(`link: forced: ${problem.path}: ${problem.detail}`)
  }
  for (const change of plan.changes) change.apply()
  settingsJson.recordLastWrite(paths, plan.mergedSettings, plan.settingsBackup, plan.claudeMdBackup)
  emit(plan.changes, [])
  return EXIT_OK
}

function runUnlink(paths: KeelPaths): number {
  const entries = links.readLinkManifest(paths)
  const recordedClaudeMdBackup = member(settingsJson.readLinkState(paths), settingsJson.PRE_KEEL_CLAUDE_MD)
  const movedAsideClaudeMd = typeof recordedClaudeMdBackup === "string" ? recordedClaudeMdBackup : null
  const settingsRestore = settingsJson.restorePreKeelSettings(paths)
  const actions: JsonObject[] = settingsRestore ? [settingsRestore] : []
  for (const entry of entries) {
    const path = pyJoin(paths.dataDir, entry.target)
    if (links.isKeelLink(path, paths)) {
      fs.unlinkSync(path)
      actions.push({ op: "remove-link", path })
    }
  }
  const generated = pyJoin(paths.dataDir, claudeMd.FILE_NAME)
  if (claudeMd.isGeneratedClaudeMd(generated)) {
    fs.unlinkSync(generated)
    actions.push({ op: "remove-link", path: generated })
  }
  const claudeMdRestore = claudeMd.restoreMovedAside(generated, movedAsideClaudeMd)
  if (claudeMdRestore) actions.push({ ...claudeMdRestore })
  if (isFile(settingsJson.linkStatePath(paths))) fs.unlinkSync(settingsJson.linkStatePath(paths))
  const restorePaths = pathsLeftForV1(entries, claudeMdRestore !== null, settingsRestore)
  say("link: to restore v1, run:\n  " + buildV1RestoreCommand(paths.dataDir, restorePaths))
  process.stdout.write(pythonJsonDumps({ actions, problems: [] }) + "\n")
  return EXIT_OK
}

export function buildV1RestoreCommand(dataDir: string, candidates: string[]): string {
  let restorable: string[]
  if (runGit(dataDir, "rev-parse", "-q", "--verify", `refs/tags/${V1_TAG}`) === null) {
    say(`link: warning: tag ${V1_TAG} not found in ${dataDir}; the command below assumes it exists`)
    restorable = candidates
  } else {
    restorable = candidates.filter((path) => runGit(dataDir, "cat-file", "-e", `${V1_TAG}:${path}`) !== null)
  }
  if (restorable.length === 0) return `# ${V1_TAG} holds none of the keel-managed paths; nothing to restore`
  return `git -C ${shlexQuote(dataDir)} checkout ${V1_TAG} -- ${restorable.map(shlexQuote).join(" ")}`
}

export function readAcceptedDrops(path: string | undefined): Set<string> {
  if (path === undefined) return new Set()
  try {
    return new Set(newlineSeparatedLines(readText(path)).filter((line) => pyStrip(line) !== "" && !line.startsWith("#")))
  } catch (error) {
    if (isOsError(error)) throw new Refused(`--accept-drops ${path}: ${(error as Error).message}`)
    throw error
  }
}

function isLinkedWorktree(keelHome: string): boolean {
  const output = runGit(keelHome, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")
  if (output === null) return false
  const lines = pySplitlines(output)
  const [gitDir, commonDir] = lines
  if (lines.length !== 2 || gitDir === undefined || commonDir === undefined) {
    throw new ValueError(lines.length < 2 ? `not enough values to unpack (expected 2, got ${lines.length})` : "too many values to unpack (expected 2)")
  }
  return realpath(gitDir) !== realpath(commonDir)
}

function pathsLeftForV1(entries: links.LinkEntry[], claudeMdRestored: boolean, settingsRestore: JsonObject | null): string[] {
  const paths = entries.map((entry) => entry.target)
  if (!claudeMdRestored) paths.push(claudeMd.FILE_NAME)
  if (settingsRestore === null || settingsRestore["op"] !== settingsJson.RESTORE_OP) paths.push(settingsJson.FILE_NAME)
  return paths
}

function requireEveryDropAccepted(plan: Plan, acceptDrops: string | undefined, allowWorktree: boolean): void {
  sayDrops(plan.droppedSettings)
  const accepted = readAcceptedDrops(acceptDrops)
  const notAccepted = plan.droppedSettings.filter((item) => !accepted.has(item))
  if (notAccepted.length > 0) {
    const listed = notAccepted.map((item) => `  not accepted: ${item}`).join("\n")
    throw new Refused(
      `${notAccepted.length} dropped items are not in --accept-drops:\n${listed}\n` +
        "Decide each one (re-declare it in an overlay fragment, or accept the drop), then list accepted lines in a file " +
        `and run: ${buildWriteCommand(plan, allowWorktree)}`,
    )
  }
}

function buildWriteCommand(plan: Plan, allowWorktree: boolean): string {
  const levels = new Set<BlockLevel>(plan.problems.map((problem) => problem.blocksWrite))
  const flags = ["--write"]
  for (const [level, lifting] of Object.entries(LIFTING_FLAGS)) if (levels.has(level as BlockLevel)) flags.push(...(lifting ?? []))
  if (plan.droppedSettings.length > 0) flags.push("--accept-drops <file>")
  if (allowWorktree) flags.push("--allow-worktree")
  return "bin/link " + flags.join(" ")
}

function parseArgs(argv: string[]): LinkArgs {
  const parser = new ArgumentParser({
    prog: "link",
    description: "Link keel into KEEL_DATA_DIR. No flag = dry run.",
    arguments: [
      { flags: ["--write"], dest: "write", kind: "flag", help: "create/repair links, CLAUDE.md and owned settings keys" },
      { flags: ["--check"], dest: "check", kind: "flag", help: "report drift; exit 1 when any; write nothing" },
      { flags: ["--unlink"], dest: "unlink", kind: "flag", help: "remove keel links and print the v1 restore command" },
      { flags: ["--force"], dest: "force", kind: "flag", help: "with --write: move what is in the way aside, overwrite hand-edited owned keys" },
      { flags: ["--allow-worktree"], dest: "allow_worktree", kind: "flag", help: "with --write: allow KEEL_HOME to be a linked worktree" },
      { flags: ["--adopt"], dest: "adopt", kind: "flag", help: "with --write: take over owned keys keel has never written; lists every drop" },
      { flags: ["--accept-drops"], dest: "accept_drops", kind: "value", metavar: "FILE", help: "with --adopt: file listing each dropped item the user accepted" },
    ],
    exclusive: [{ dests: ["write", "check", "unlink"], required: false }],
  })
  const parsed: ParsedArguments = parser.parse(argv)
  const args: LinkArgs = {
    write: parsed["write"] === true,
    check: parsed["check"] === true,
    unlink: parsed["unlink"] === true,
    force: parsed["force"] === true,
    allowWorktree: parsed["allow_worktree"] === true,
    adopt: parsed["adopt"] === true,
    acceptDrops: typeof parsed["accept_drops"] === "string" ? parsed["accept_drops"] : undefined,
  }
  if ((args.force || args.allowWorktree || args.adopt) && !args.write) parser.error("--force, --allow-worktree and --adopt require --write")
  if (args.acceptDrops && !args.adopt) parser.error("--accept-drops requires --adopt")
  return args
}

function emit(changes: Plan["changes"], problems: Problem[], dryRunFields: JsonObject = {}): void {
  process.stdout.write(pythonJsonDumps({ actions: changes.map(changeToJson), problems: problems.map(problemToJson), ...dryRunFields }) + "\n")
}

function sayDrops(dropped: string[]): void {
  for (const item of dropped) say(`link: adopt drops: ${item}`)
}

function say(message: string): void {
  process.stderr.write(backslashReplaceLoneSurrogates(message) + "\n")
}
