import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mutate, seededRandom } from "../fuzz.ts";
import { digestOf, paddedRoot, restored, tokenized } from "../recorded-cases.ts";

const SKILL_SCRIPTS = join(import.meta.dirname, "..", "..", "skills", "readable-code", "scripts");
export const TYPESCRIPT_SCRIPT = join(SKILL_SCRIPTS, "rule-checks.ts");
export const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "rule-checks-parity.json");
const FIXED_COMMIT_DATES = { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
const MAX_CONCURRENT_RUNS = 8;
const MISMATCHES_SHOWN = 5;
const FUZZ_LINES_PER_FILE = 120;
const OBJECT_NAME = /\b[0-9a-f]{40}\b/g;
const MODULE_REPO_USAGE: readonly [recorded: RegExp, current: string] = [/\n( +)\[--self-test\]\n/, "\n$1[--module-repo MODULE_REPO] [--self-test]\n"];
const MODULE_REPO_HELP: readonly [recorded: string, current: string] = [
  "  --head HEAD\n  --self-test\n",
  "  --head HEAD\n  --module-repo MODULE_REPO\n               a repo holding the commits of a submodule that is not checked out\n               (repeatable)\n  --self-test\n"];

export interface Run {
  name: string;
  args: string[];
}

export interface ParityReport {
  runs: number;
  mismatches: number;
  details: string[];
  signalLines: number;
  exitCodes: Record<string, number>;
  usageRewrites: number;
}

export interface Observation {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RecordedRun extends Observation {
  input: string;
}

export interface RecordedRuns {
  rootLength: number;
  runs: Record<string, RecordedRun>;
}

const EXTRA_LINES = [
  "// previously it was different", "// prev\u0130ously it was different", "// \u0131t used to be", "// \u0130t used to be", "// we used to", "// WE USED TO",
  "// This Used To", "// design \u00a74", "// STAGE 5", "// stage 5", "// \u017ftage 5", "// no longer", "// no LONGER", "// nO lOnGeR",
  "// corrected", "// c\u0130orrected", "// 2026-10-07 note", "// 2026-1\u0661-07 note", "/* TODO */", "// TODO(ABC-123)", "// TODO ABC-123", "// TODO \u00c0BC-12",
  "// TODO ABC-\uff11\uff12", "// \u00e9TODO", "// TODO\u00e9", "// TODO_", "// _TODO", "// TODO-1", "// TODO ABC-123x", "// TODO x ABC-1\u00e9",
  "// ----", "// ====", "// ******", "// ####", "// ---", "//", "/*", " *", "  * corrected after", "\t// no longer", "\u3000// no longer",
  "const dataset = 1", "const data = 1", "const \u00e9process = 1", "let process = 1", "var\u00a0handle = 1", "function   do() {}", "const\tutil = 1",
  "const\u3000info = 1", "const result_ = 1", "const manager2 = 1", "const manager\u00e9 = 1", "const \u0130temp = 1",
  "x: any", "x:\u00a0any", "x: anyone", "xas any", "\u00e9 as any", "as any ", "foo<any>()", "const q = <any >x", "x:\tany;",
  "catch (e) {}", "catch {}", "catch(e){ }", "catch (e) { \u3000 }", "catch (e) {\n}", "log.warn(e.getMessage())", 'log.warn("a", e.getMessage() )',
  "xlog.warn(e.getMessage())", "\u00e9log.warn(e.getMessage())", "logger.error(e.getMessage())", "_log.error(e.getMessage())", "log.error(e.getMessage(), e)",
  "Map<String,Object>", "Map<String,\u00a0Object>", "Map<String, Object>", "Map<String,Objects>",
  "String data = x;", "List<String> list = x;", "\u00c9x data;", "Foo<Bar>[] info = x;", "Foo[] temp(", "\u00c9 data = 1", "Foo\u00e9 data = 1;", "foo data = 1;",
  "int result,", "Foo data  )", "Foo <T> data;",
  "JSON.parse(x)", "const j = JSON.parse(body)", "// eslint-disable-line react-hooks/exhaustive-deps", "// eslint-disable react-hooks/exhaustive-deps",
  "/* eslint-disable-next-line\treact-hooks/exhaustive-deps */", "// eslint-disable-next-line react-hooks/exhaustive-depsx",
  "// eslint-disable-next-line xreact-hooks/exhaustive-deps", "// eslint-disable-next-line \u00e9react-hooks/exhaustive-deps",
  "// @ts-ignore", "//@ts-ignore", "/** @ts-expect-error */", "// @ts-expecterror", "// @ts-ignore\u00e9", "// @ts-ignore_",
  '@SuppressWarnings("unchecked")', '@SuppressWarnings( "unchecked" )', "@SuppressWarnings(\"all\", \"unchecked\")",
  `${"x".repeat(150)}\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00 const data = 1`, `// ${"y".repeat(157)}\ud83d\ude00 no longer`,
  `  \t const data = ${"z".repeat(170)}`, "const data = 1 \u00a0 ", "const data = 1\u2003", "const a = 1;\u000bconst data = 2;", "const a = 1;\u000cconst data = 3;",
  "const a = 1;\u001cconst data = 4;", "const a = 1;\u0085const data = 5;", "const a = 1;\u2028const data = 6;", "const a = 1;\u2029const data = 7;",
  "const a: any = 1;\rconst b: any = 2;", "// tail\u00a0", "\u00a0// no longer", "useState(0); useState(1); useStateful()", "\u00e9useState(0)", "useState\u00e9(0)",
  "\ud83d\ude00 const data = 1", "const \ud83d\ude00data = 1", "/* corrected */ const data = 1",
];

const MUTATION_ALPHABET = [..."/*-=# \t.:;(){}[]<>'\"\\"].concat([
  "any", "as ", "@ts-ignore", "TODO", "ABC-1", "used to", "no longer", "const ", "let ", "data", "process", "catch", "{}", "log.", "getMessage()", "\u0130", "\u0131",
  "\u212a", "\u017f", "\u00e9", "\ud83d\ude00", "\u00a0", "\u3000", "\u0085", "\u2028", "\u000b", "\r", "9", "Map<String,Object>", "JSON.parse(", "eslint-disable",
  "react-hooks/exhaustive-deps", "STAGE 1", "design \u00a7", "2026-10-07", "----",
]);

const CORPUS_FILES = [
  "web/Screen.tsx", "web/Panel.jsx", "web/api/items.ts", "web/API/items.ts", "web/api-v2/items.ts", "web/ap\u0130/items.ts", "web/ap\u0131/items.ts",
  "web/a\u00e9pi/items.ts", "web/Screen.test.tsx", "web/util_test.ts", "web/x.spec.ts", "web/log.ts", "core/Service.java", "core/pom.xml", "tests/test_x.py",
  "src/app.py", "src/test/Helper.java", "web/a.js", "generated/x.ts", "web/x.min.js", "web/package-lock.json", "web/yarn.lock", "web/Weird.TSX", "web/z.ts.bak",
];

function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(root: string, repo: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const completed = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnvironment(root, extraEnv) });
  if (completed.status !== 0) throw new Error(`git ${JSON.stringify(args)} failed in ${repo}: ${completed.stderr}`);
  return completed.stdout.trim();
}

function gitEnvironment(root: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", ...FIXED_COMMIT_DATES, ...extraEnv };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) if (!(name in extraEnv)) delete env[name];
  return env;
}

function commitAll(root: string, repo: string): string {
  git(root, repo, ["add", "-A"]);
  git(root, repo, ["commit", "-q", "--allow-empty", "-m", "fixture"]);
  return git(root, repo, ["rev-parse", "HEAD"]);
}

function newRepo(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(root, repo, ["init", "-q", "-b", "main"]);
  return repo;
}

function snapshotTree(root: string, repo: string): string {
  const index = { GIT_INDEX_FILE: join(root, `snapshot-index-${Math.random().toString(36).slice(2)}`) };
  git(root, repo, ["read-tree", "HEAD"], index);
  git(root, repo, ["add", "-A"], index);
  return git(root, repo, ["write-tree"], index);
}

function corpusBody(seed: number, fileIndex: number): string {
  const random = seededRandom(seed + fileIndex);
  const lines = [...EXTRA_LINES];
  for (let index = 0; index < FUZZ_LINES_PER_FILE; index += 1) {
    lines.push(mutate(EXTRA_LINES[Math.floor(random() * EXTRA_LINES.length)] as string, MUTATION_ALPHABET, random));
  }
  return lines.join("\n") + "\n";
}

function buildLinesRepo(root: string): { repo: string; tree: string } {
  const repo = newRepo(root, "lines");
  put(join(repo, "README"), "x\n");
  put(join(repo, "m/Mod.ts"), "export const a = 1\nexport const b = 2\n");
  put(join(repo, "web/Screen.tsx"), "export const S = 1\n");
  commitAll(root, repo);
  git(root, repo, ["branch", "base"]);
  CORPUS_FILES.forEach((file, index) => put(join(repo, "c", file), corpusBody(100, index)));
  put(join(repo, "m/Mod.ts"), "export const a = 1\nexport const b = 2\nconst c: any = 3\n");
  put(join(repo, "web/Screen.tsx"), "export const S = 1\nconst data = load()\r\nconst d: any = 2\r\n");
  put(join(repo, "crlf/Win.ts"), "const a: any = 1\r\nconst data = 2\r\n// no longer\r\n");
  put(join(repo, "lone-cr/Old.ts"), "const a: any = 1\rconst data = 2\r");
  put(join(repo, "empty/Empty.ts"), "");
  put(join(repo, "nonl/NoNewline.ts"), "const a: any = 1");
  put(join(repo, "bom/Bom.ts"), "\ufeffconst a: any = 1\n");
  put(join(repo, "latin/Latin.java"), Buffer.from("String s = \"caf\xe9\"; // no longer\nMap<String, Object> m;\n", "latin1"));
  put(join(repo, "bin/Blob.java"), Buffer.from([0x4d, 0x61, 0x70, 0x3c, 0x00, 0xff, 0x0a]));
  commitAll(root, repo);
  CORPUS_FILES.forEach((file, index) => put(join(repo, "s", file), corpusBody(200, index)));
  git(root, repo, ["add", "s"]);
  CORPUS_FILES.forEach((file, index) => put(join(repo, "u", file), corpusBody(300, index)));
  put(join(repo, "m/Mod.ts"), "export const a = 1\nexport const b = 2\nconst c: any = 3\nconst data = 4\n");
  put(join(repo, "u/utf8-invalid.java"), Buffer.from("String s = \"\xff\xfe\"; // corrected\nint info = 1;\n", "latin1"));
  put(join(repo, "u/Binary.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Buffer.from("const v: any = 1\n")]));
  symlinkSync("../README", join(repo, "u/link.ts"));
  symlinkSync("../../no-such-file", join(repo, "u/dangling.ts"));
  const tree = snapshotTree(root, repo);
  const nested = join(repo, "u/nested");
  mkdirSync(nested);
  git(root, nested, ["init", "-q"]);
  put(join(nested, "n.ts"), "const a: any = 1\n");
  return { repo, tree };
}

function buildNamesRepo(root: string): string {
  const repo = newRepo(root, "names");
  put(join(repo, "README"), "x\n");
  put(join(repo, "old name.ts"), "const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n");
  put(join(repo, "gone.ts"), "const a: any = 1\n");
  put(join(repo, "mode.ts"), "const a = 1\n");
  put(join(repo, "plain.ts"), "line one\nline two\nline three\n");
  commitAll(root, repo);
  git(root, repo, ["branch", "base"]);
  const names = ["sp ace.ts", 'qu"ote.ts', "back\\slash.ts", "tab\tname.ts", "nl\nname.ts", "\u00e9/\u00fc.ts", "\ud83d\ude00.ts", "-lead.ts", "trail .ts", "semi;colon.ts", "ap\u0130/in.ts", "a b/api/x.ts"];
  for (const name of names) put(join(repo, name), `const a: any = 1\nconst data = 2\n// no longer ${name.length}\n`);
  git(root, repo, ["mv", "old name.ts", "new name.ts"]);
  put(join(repo, "new name.ts"), "const a = 1\nconst b: any = 2\nconst c = 3\nconst d = 4\nconst data = 5\n");
  rmSync(join(repo, "gone.ts"));
  chmodSync(join(repo, "mode.ts"), 0o755);
  put(join(repo, "plain.ts"), "line one\nline three\n");
  put(join(repo, "added-binary.bin"), Buffer.from([0, 1, 2, 3, 0xff]));
  commitAll(root, repo);
  put(join(repo, "later.ts"), "const a: any = 1\n");
  put(join(repo, "sp ace.ts"), "const a: any = 1\nconst data = 2\n// no longer 6\nconst more: any = 3\n");
  return repo;
}

function sizeBody(lines: number, pattern: string): string {
  return Array.from({ length: lines }, () => pattern).join("\n") + "\n";
}

function buildSizesRepo(root: string): string {
  const repo = newRepo(root, "sizes");
  put(join(repo, "web/Big.tsx"), sizeBody(290, "x"));
  put(join(repo, "web/Legacy.tsx"), sizeBody(310, "x"));
  put(join(repo, "web/State.tsx"), sizeBody(10, "useState(0)"));
  put(join(repo, "web/StateWords.tsx"), sizeBody(9, "useState(0)") + "useStateful()\n\u00e9useState(1)\n");
  put(join(repo, "web/Exactly.tsx"), sizeBody(300, "x"));
  put(join(repo, "core/Big.java"), sizeBody(495, "x"));
  put(join(repo, "core/Exactly.java"), sizeBody(500, "x"));
  put(join(repo, "web/Panel.test.tsx"), sizeBody(290, "x"));
  put(join(repo, "web/Renamed.tsx"), sizeBody(299, "x"));
  put(join(repo, "web/Crlf.tsx"), sizeBody(299, "x").replaceAll("\n", "\r\n"));
  put(join(repo, "web/Unicode.tsx"), sizeBody(299, "x\u2028y"));
  put(join(repo, "rewrite.md"), sizeBody(300, "old"));
  commitAll(root, repo);
  git(root, repo, ["branch", "base"]);
  put(join(repo, "web/Big.tsx"), sizeBody(305, "x"));
  put(join(repo, "web/Legacy.tsx"), sizeBody(320, "x"));
  put(join(repo, "web/State.tsx"), sizeBody(11, "useState(0)"));
  put(join(repo, "web/StateWords.tsx"), sizeBody(10, "useState(0)") + "useStateful()\n\u00e9useState(1)\nuseState\n");
  put(join(repo, "web/Exactly.tsx"), sizeBody(301, "x"));
  put(join(repo, "core/Big.java"), sizeBody(505, "x"));
  put(join(repo, "core/Exactly.java"), sizeBody(501, "x"));
  put(join(repo, "web/Panel.test.tsx"), sizeBody(305, "x"));
  git(root, repo, ["mv", "web/Renamed.tsx", "web/Moved.tsx"]);
  put(join(repo, "web/Moved.tsx"), sizeBody(302, "x"));
  put(join(repo, "web/Crlf.tsx"), sizeBody(302, "x").replaceAll("\n", "\r\n"));
  put(join(repo, "web/Unicode.tsx"), sizeBody(302, "x\u2028y"));
  put(join(repo, "rewrite.md"), sizeBody(50, "old") + sizeBody(200, "new"));
  put(join(repo, "web/NewBig.tsx"), sizeBody(301, "x"));
  put(join(repo, "package-lock.json"), sizeBody(450, "{}"));
  return repo;
}

function buildSubmoduleRepos(root: string): { parent: string; plain: string; dirty: string } {
  const source = newRepo(root, "mod-src");
  put(join(source, "f.ts"), "export const v = 1\n");
  commitAll(root, source);
  const parent = newRepo(root, "parent");
  git(root, parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod"]);
  commitAll(root, parent);
  git(root, parent, ["branch", "base"]);
  const mod = join(parent, "mod");
  git(root, mod, ["branch", "base"]);
  put(join(mod, "f.ts"), "const v: any = 1\n");
  commitAll(root, mod);
  commitAll(root, parent);
  put(join(mod, "g.ts"), "const w: any = 2\n");
  git(root, parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "extra"]);
  put(join(parent, "top.ts"), "const t: any = 3\n");
  commitAll(root, parent);

  const plain = newRepo(root, "plain-parent");
  git(root, plain, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod"]);
  commitAll(root, plain);
  git(root, plain, ["branch", "base"]);
  put(join(plain, "mod/f.ts"), "const dirty: any = 1\n");

  const dirty = newRepo(root, "dirty-parent");
  git(root, dirty, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod"]);
  commitAll(root, dirty);
  git(root, dirty, ["branch", "base"]);
  git(root, dirty, ["submodule", "deinit", "-q", "-f", "mod"]);
  return { parent, plain, dirty };
}

export function buildRuns(root: string): Run[] {
  mkdirSync(root, { recursive: true });
  put(join(root, "gitconfig"), "[user]\n\tname = keel-test\n\temail = keel-test@localhost\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n");
  const lines = buildLinesRepo(root);
  const names = buildNamesRepo(root);
  const sizes = buildSizesRepo(root);
  const { parent, plain, dirty } = buildSubmoduleRepos(root);
  const namesTree = snapshotTree(root, names);
  const sizesTree = snapshotTree(root, sizes);
  const parentTree = snapshotTree(root, parent);
  const runs: Run[] = [];
  const scan = (name: string, repo: string, base: string, ...head: string[]): void => {
    runs.push({ name, args: ["--repo", repo, "--base", base, ...(head.length > 0 ? ["--head", ...head] : [])] });
  };
  scan("lines worktree", lines.repo, "base");
  scan("lines head commit", lines.repo, "base", "HEAD");
  scan("lines snapshot tree", lines.repo, "base", lines.tree);
  scan("lines head-relative base", lines.repo, "HEAD~1");
  scan("lines unknown base", lines.repo, "no-such-ref");
  scan("lines unknown head", lines.repo, "base", "no-such-head");
  scan("lines tree with unknown base", lines.repo, "no-such-ref", lines.tree);
  scan("lines base is tag-like sha", lines.repo, git(root, lines.repo, ["rev-parse", "base"]));
  scan("lines empty head", lines.repo, "base", "");
  scan("names worktree", names, "base");
  scan("names head", names, "base", "HEAD");
  scan("names snapshot", names, "base", namesTree);
  scan("names mid base", names, "HEAD~1");
  scan("sizes worktree", sizes, "base");
  scan("sizes snapshot", sizes, "base", sizesTree);
  scan("parent submodule worktree", parent, "base");
  scan("parent submodule head", parent, "base", "HEAD");
  scan("parent submodule snapshot", parent, git(root, parent, ["rev-parse", "base"]), parentTree);
  scan("parent submodule head-relative", parent, "HEAD~1");
  scan("parent submodule foreign sha", parent, "0123456789abcdef0123456789abcdef01234567");
  scan("plain parent dirty submodule", plain, "base");
  scan("plain parent dirty submodule head", plain, "base", "HEAD");
  scan("deinitialized submodule", dirty, "base", "HEAD");
  scan("deinitialized submodule worktree", dirty, "base");
  scan("repo path missing", join(root, "nowhere"), "base");
  scan("repo path is a file", join(root, "gitconfig"), "base");
  const helpArguments: string[][] = [
    [], ["--self-test"], ["--base", "x"], ["--repo", lines.repo], ["-h"], ["--help"], ["--h"], ["--he"], ["--hea", "x"], ["--repo"], ["--repo", "--base"],
    [`--repo=${lines.repo}`, "--base=base"], ["--re", lines.repo, "--ba", "base"], ["--self-test=1"], ["--self"], ["--s"], ["x"], ["--", "a"], ["--base", "base", "--repo", lines.repo, "extra"],
    ["--repo", lines.repo, "--base", "base", "--bogus"], ["-hx"], ["-hh"], ["-h=1"], ["--help=1"], ["--repo", "-x"], ["--repo", "-5", "--base", "b"], ["--repo", "a b", "--base", "b"],
    ["--repo", lines.repo, "--base"], ["--b", "base", "--r", lines.repo], ["--r=", "--b="], ["--repo=", "--base=base"], ["--repo", "", "--base", "base"], ["--he", "--h"],
    ["--self-test", "--bogus"], ["--bogus", "--self-test"], ["--bogus", "-h"], ["--base", "--h"], ["-"], ["-5"], ["--repo", lines.repo, "--", "--base", "base"],
  ];
  helpArguments.forEach((args, index) => runs.push({ name: `arguments ${index}: ${args.join(" ")}`, args }));
  return runs;
}

export function execute(command: string[], args: string[], prog: string): Promise<Observation> {
  return new Promise((resolve) => {
    const child = spawn(command[0] as string, [...command.slice(1), ...args], { env: process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("close", (status) => resolve({
      status, stdout: Buffer.concat(out).toString("utf8").replaceAll(prog, "rule-checks"), stderr: Buffer.concat(err).toString("utf8").replaceAll(prog, "rule-checks"),
    }));
  });
}

export function recordedName(run: Run, root: string): string {
  return tokenized(run.name, root);
}

export function inputDigest(run: Run, root: string): string {
  return digestOf(tokenized(JSON.stringify(run.args), root).replace(OBJECT_NAME, "<object>"));
}

function differences(python: Observation, typescript: Observation): string[] {
  const found: string[] = [];
  if (python.status !== typescript.status) found.push(`exit ${python.status} vs ${typescript.status}`);
  if (python.stdout !== typescript.stdout) {
    const pythonLines = python.stdout.split("\n");
    const typescriptLines = typescript.stdout.split("\n");
    const at = pythonLines.findIndex((line, index) => line !== typescriptLines[index]);
    found.push(`stdout differs at line ${at + 1} of ${pythonLines.length}/${typescriptLines.length}\n    py: ${JSON.stringify(pythonLines[at])}\n    ts: ${JSON.stringify(typescriptLines[at])}`);
  }
  const crashed = python.stdout.includes("(crashed:");
  if (!crashed && python.stderr !== typescript.stderr) found.push(`stderr\n    py: ${JSON.stringify(python.stderr)}\n    ts: ${JSON.stringify(typescript.stderr)}`);
  return found;
}

function restoredObservation(recorded: Observation, root: string): Observation {
  return { status: recorded.status, stdout: withModuleRepoFlag(restored(recorded.stdout, root)), stderr: withModuleRepoFlag(restored(recorded.stderr, root)) };
}

function withModuleRepoFlag(text: string): string {
  return text.replace(...MODULE_REPO_USAGE).replace(...MODULE_REPO_HELP);
}

export async function runRuleChecksParity(): Promise<ParityReport> {
  const recorded = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RecordedRuns;
  const root = paddedRoot(realpathSync(tmpdir()), recorded.rootLength);
  const report: ParityReport = { runs: 0, mismatches: 0, details: [], signalLines: 0, exitCodes: {}, usageRewrites: 0 };
  try {
    const runs = buildRuns(root);
    report.runs = runs.length;
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const run = runs[next];
        next += 1;
        if (run === undefined) return;
        const entry = recorded.runs[recordedName(run, root)];
        const typescript = await execute([process.execPath, TYPESCRIPT_SCRIPT], run.args, "rule-checks.ts");
        const found = entry === undefined ? ["no recorded Python outcome for this run"] : differences(restoredObservation(entry, root), typescript);
        if (entry !== undefined && entry.input !== inputDigest(run, root)) found.push("the run's arguments differ from the recorded ones");
        if (found.length > 0) {
          report.mismatches += 1;
          if (report.details.length < MISMATCHES_SHOWN) report.details.push(`${run.name}: ${found.join("; ")}`);
        }
        if (entry !== undefined && withModuleRepoFlag(entry.stdout + entry.stderr) !== entry.stdout + entry.stderr) report.usageRewrites += 1;
        report.signalLines += (entry?.stdout ?? "").split("\n").filter((line) => line.startsWith("signal ")).length;
        const key = String(entry?.status);
        report.exitCodes[key] = (report.exitCodes[key] ?? 0) + 1;
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT_RUNS }, worker));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return report;
}
