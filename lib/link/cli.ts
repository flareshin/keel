import fs from "node:fs"
import path from "node:path"

import { flagOption, noPositionals, parseCommandLine, stringOption, usageError } from "../../measure/lib/measurekit/cli.ts"
import type { CommandSpec } from "../../measure/lib/measurekit/cli.ts"
import { isFile, isSystemError, readUtf8, resolveLinks, splitLines } from "../../measure/lib/measurekit/files.ts"
import type { JsonObject } from "../../measure/lib/measurekit/json.ts"
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
const COMMAND: CommandSpec = {
  prog: "link",
  usage: "link [-h] [--write | --check | --unlink] [--force] [--allow-worktree] [--adopt] [--accept-drops FILE]",
  description: "Link keel into KEEL_DATA_DIR. No flag = dry run.",
  argumentHelp: [
    ["--write", "create/repair links, CLAUDE.md and owned settings keys"],
    ["--check", "report drift; exit 1 when any; write nothing"],
    ["--unlink", "remove keel links and print the v1 restore command"],
    ["--force", "with --write: move what is in the way aside, overwrite hand-edited owned keys"],
    ["--allow-worktree", "with --write: allow KEEL_HOME to be a linked worktree"],
    ["--adopt", "with --write: take over owned keys keel has never written; lists every drop"],
    ["--accept-drops FILE", "with --adopt: file listing each dropped item the user accepted"],
  ],
  options: {
    write: { type: "boolean" }, check: { type: "boolean" }, unlink: { type: "boolean" }, force: { type: "boolean" },
    "allow-worktree": { type: "boolean" }, adopt: { type: "boolean" }, "accept-drops": { type: "string" },
  },
}
const MODES = ["write", "check", "unlink"]

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
  const args = parseLinkArgs(argv)
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
  const movedAsideClaudeMd = member(settingsJson.readLinkState(paths), settingsJson.PRE_KEEL_CLAUDE_MD)
  const settingsRestore = settingsJson.restorePreKeelSettings(paths)
  const actions: JsonObject[] = settingsRestore ? [settingsRestore] : []
  for (const entry of entries) {
    const link = path.join(paths.dataDir, entry.target)
    if (links.isKeelLink(link, paths)) {
      fs.unlinkSync(link)
      actions.push({ op: "remove-link", path: link })
    }
  }
  const generated = path.join(paths.dataDir, claudeMd.FILE_NAME)
  if (claudeMd.isGeneratedClaudeMd(generated)) {
    fs.unlinkSync(generated)
    actions.push({ op: "remove-link", path: generated })
  }
  const claudeMdRestore = claudeMd.restoreMovedAside(generated, movedAsideClaudeMd)
  if (claudeMdRestore) actions.push({ ...claudeMdRestore })
  if (isFile(settingsJson.linkStatePath(paths))) fs.unlinkSync(settingsJson.linkStatePath(paths))
  const restorePaths = pathsLeftForV1(entries, claudeMdRestore !== null, settingsRestore)
  say("link: to restore v1, run:\n  " + buildV1RestoreCommand(paths.dataDir, restorePaths))
  process.stdout.write(JSON.stringify({ actions, problems: [] }) + "\n")
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

export function readAcceptedDrops(file: string | undefined): Set<string> {
  if (file === undefined) return new Set()
  try {
    return new Set(splitLines(readUtf8(file)).filter((line) => line.trim() !== "" && !line.startsWith("#")))
  } catch (error) {
    if (isSystemError(error)) throw new Refused(`--accept-drops ${file}: ${error.message}`)
    throw error
  }
}

function isLinkedWorktree(keelHome: string): boolean {
  const output = runGit(keelHome, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")
  if (output === null) return false
  const lines = splitLines(output)
  const [gitDir, commonDir] = lines
  if (lines.length !== 2 || gitDir === undefined || commonDir === undefined) {
    throw new TypeError(`git rev-parse printed ${lines.length} lines, expected the git dir and the common dir`)
  }
  return resolveLinks(gitDir) !== resolveLinks(commonDir)
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

function parseLinkArgs(argv: string[]): LinkArgs {
  const parsed = parseCommandLine(COMMAND, argv)
  noPositionals(COMMAND, parsed)
  if (MODES.filter((mode) => flagOption(parsed, mode)).length > 1) usageError(COMMAND, "give at most one of --write, --check, --unlink")
  const args: LinkArgs = {
    write: flagOption(parsed, "write"),
    check: flagOption(parsed, "check"),
    unlink: flagOption(parsed, "unlink"),
    force: flagOption(parsed, "force"),
    allowWorktree: flagOption(parsed, "allow-worktree"),
    adopt: flagOption(parsed, "adopt"),
    acceptDrops: stringOption(parsed, "accept-drops"),
  }
  if ((args.force || args.allowWorktree || args.adopt) && !args.write) usageError(COMMAND, "--force, --allow-worktree and --adopt require --write")
  if (args.acceptDrops && !args.adopt) usageError(COMMAND, "--accept-drops requires --adopt")
  return args
}

function emit(changes: Plan["changes"], problems: Problem[], dryRunFields: JsonObject = {}): void {
  process.stdout.write(JSON.stringify({ actions: changes.map(changeToJson), problems: problems.map(problemToJson), ...dryRunFields }) + "\n")
}

function sayDrops(dropped: string[]): void {
  for (const item of dropped) say(`link: adopt drops: ${item}`)
}

function say(message: string): void {
  process.stderr.write(message + "\n")
}
