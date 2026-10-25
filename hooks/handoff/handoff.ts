import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataDir } from "../lib/hookkit/env.ts";
import { FireLog, utcNow } from "../lib/hookkit/fires.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";
import { basename, joinPath } from "../lib/hookkit/paths.ts";
import { dumpsAscii } from "../lib/hookkit/jsonout.ts";
import { getField, isNonEmptyString } from "../lib/hookkit/fields.ts";
import { parsePayload } from "../lib/hookkit/json.ts";
import { isDirectory, isFile } from "../lib/hookkit/files.ts";
import { describeError, RecursionError, ValueError } from "../lib/hookkit/errors.ts";
import { printLine, readStdin, writeStderr } from "../lib/hookkit/stdio.ts";
import { rstripChar, splitlines, trimCharacters, trimSpace } from "../lib/hookkit/text.ts";
import { findToplevel, findUpstream, gitOutput } from "../lib/hookkit/repo.ts";

const HOOK = "handoff";
const RULE = "C-handoff";
const RESUME_HEADING = "## Resume point";
const LOCATION_HEADING = "## Location";
const AUTO_PREFIX = "(auto-snapshot";
const NOT_GIVEN_PREFIX = "(not given";
const EMPTY_NOTE = "(not given — pass the resume point as an argument)";
const SUBMODULE_GIT_DIR_RE = /\/\.git\/(worktrees\/[^/]+\/)?modules\//;
const NON_ALPHANUMERIC = /[^A-Za-z0-9]/gu;
const EXIT_USAGE = 1;

class RepoPlace {
  readonly toplevel: string;
  readonly main: string;
  readonly branch: string;
  readonly file: string;

  constructor(toplevel: string) {
    this.toplevel = toplevel;
    this.main = mainRepo(toplevel);
    this.branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], toplevel) || "?";
    this.file = joinPath(dataDir(), "handoff", this.main.replace(NON_ALPHANUMERIC, "-") + ".md");
  }

  locationLines(): string[] {
    const worktree = this.toplevel !== this.main ? [`- Working worktree: \`${this.toplevel}\``] : [];
    return [...worktree, `- Branch: \`${this.branch}\``];
  }
}

function main(argv: string[]): number {
  const mode = argv[0] ?? "";
  if (mode === "--auto") return snapshotBeforeCompaction(readStdin());
  const toplevel = findToplevel(process.cwd());
  if (toplevel === null) {
    writeStderr(`handoff: run this inside a git repo (currently: ${process.cwd()})\n`);
    return EXIT_USAGE;
  }
  const place = new RepoPlace(toplevel);
  if (mode === "--path") {
    printLine(place.file);
  } else if (mode === "--status") {
    printLine(dumpsAscii({ path: place.file, hasResumePoint: hasResumePoint(place.file) }));
  } else if (mode === "--read") {
    printLine(isFile(place.file) ? readFileSync(place.file, "utf8") : `no handoff: ${place.file}`);
  } else if (mode === "--clear") {
    if (isFile(place.file)) rmSync(place.file);
    printLine(`handoff deleted: ${place.file}`);
  } else {
    writeHandoff(place, argv.join(" ") || EMPTY_NOTE, null);
  }
  return protocol.EXIT_PASS;
}

function snapshotBeforeCompaction(raw: string): number {
  let payload: Payload = {};
  try {
    payload = parsePayload(raw);
  } catch (error) {
    if (error instanceof RecursionError) {
      new FireLog(HOOK, null).append(RULE, "error", { detail: describeError(error) });
      return protocol.EXIT_PASS;
    }
    if (!(error instanceof ValueError)) throw error;
  }
  const session = getField(payload, "session_id") as string | null;
  const fires = new FireLog(HOOK, session);
  try {
    const cwd = protocol.cwdOrProcessDirectory(payload);
    const toplevel = isDirectory(cwd) ? findToplevel(cwd) : null;
    if (toplevel === null) return protocol.EXIT_PASS;
    const place = new RepoPlace(toplevel);
    const trigger = textOrQuestionMark(getField(payload, "trigger"));
    const transcript = textOrQuestionMark(getField(payload, "transcript_path"));
    let note = `${AUTO_PREFIX} before ${trigger} compaction · transcript: ${transcript})`;
    if (hasResumePoint(place.file)) {
      if (!writtenHere(place)) return protocol.EXIT_PASS;
      note = rstripChar(resumeNote(place.file), "\n") + "\n" + note;
    }
    writeHandoff(place, note, session);
  } catch (error) {
    fires.append(RULE, "error", { detail: describeError(error) });
  }
  return protocol.EXIT_PASS;
}

function textOrQuestionMark(value: unknown): string {
  return isNonEmptyString(value) ? value : "?";
}

function writeHandoff(place: RepoPlace, note: string, session: string | null): void {
  mkdirSync(dirname(place.file), { recursive: true });
  writeFileSync(place.file, renderHandoff(place, note), "utf8");
  new FireLog(HOOK, session).append(RULE, "record", { detail: `snapshot ${basename(place.file)}` });
  printLine(`handoff recorded: ${place.file}`);
}

function renderHandoff(place: RepoPlace, note: string): string {
  const toplevel = place.toplevel;
  const dirty = gitOutput(["status", "--porcelain"], toplevel) || "";
  const dirtyCount = splitlines(dirty).filter((line) => line !== "").length;
  const lines = [
    `# HANDOFF — ${basename(place.main)}`,
    "",
    `> Generated ${utcNow()} · overwritten by \`hooks/handoff/handoff.ts\`. **Once you have resumed, delete it ` +
      "with `--clear`** (a stale handoff = false state).",
    "",
    RESUME_HEADING,
    note,
    "",
    LOCATION_HEADING,
    `- Main repo: \`${place.main}\``,
    ...place.locationLines(),
    `- HEAD: \`${gitOutput(["log", "-1", "--pretty=%h %s"], toplevel) || "?"}\``,
  ];
  const upstreamPosition = upstreamPositionOf(toplevel);
  if (upstreamPosition) lines.push(`- upstream: ${upstreamPosition}`);
  lines.push("", `## Uncommitted (${dirtyCount})`);
  lines.push(...(dirtyCount > 0 ? ["```", dirty, "```"] : ["(none — working tree clean)"]));
  const recent = gitOutput(["log", "-3", "--pretty=%h %ad %s", "--date=short"], toplevel) || "?";
  return [...lines, "", "## Recent commits", "```", recent, "```", ""].join("\n");
}

function resumeNote(path: string): string {
  const noteLines: string[] = [];
  let inside = false;
  for (const line of splitlines(readFileSync(path, "utf8"))) {
    if (line === RESUME_HEADING) inside = true;
    else if (line === LOCATION_HEADING) inside = false;
    else if (inside && !line.startsWith(AUTO_PREFIX)) noteLines.push(line);
  }
  return trimCharacters(noteLines.join("\n"), "\n") + "\n";
}

function hasResumePoint(path: string): boolean {
  if (!isFile(path)) return false;
  const first = splitlines(resumeNote(path)).find((line) => trimSpace(line) !== "") ?? "";
  return first !== "" && !first.startsWith(AUTO_PREFIX) && !first.startsWith(NOT_GIVEN_PREFIX);
}

function writtenHere(place: RepoPlace): boolean {
  const recorded: string[] = [];
  let inside = false;
  for (const line of splitlines(readFileSync(place.file, "utf8"))) {
    if (line === LOCATION_HEADING) inside = true;
    else if (line.startsWith("## ")) inside = false;
    else if (inside && (line.startsWith("- Branch: ") || line.startsWith("- Working worktree: "))) recorded.push(line);
  }
  const expected = place.locationLines();
  return recorded.length === expected.length && recorded.every((line, index) => line === expected[index]);
}

function mainRepo(toplevel: string): string {
  const common = gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], toplevel);
  if (!common || SUBMODULE_GIT_DIR_RE.test(common + "/")) return toplevel;
  return dirname(common);
}

function upstreamPositionOf(toplevel: string): string | null {
  const upstream = findUpstream(toplevel, "HEAD");
  const counts = upstream && gitOutput(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], toplevel);
  if (!upstream || !counts) return null;
  const [behind, ahead] = trimSpace(counts).split(/\s+/);
  return `${behind} behind / ${ahead} ahead (vs ${upstream})`;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
