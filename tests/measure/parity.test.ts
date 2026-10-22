import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { ASK_EVENT, ASK_TEXT, EDIT_EVENT, EvalSandbox, initEvent, resultEvent } from "./eval_helpers.ts"
import type { RawRun } from "./eval_helpers.ts"
import { CHECKOUT, FUTURE, PAST, charterRow, ledgerRow, readText } from "./helpers.ts"

const REVIEW_STUB_DIR = path.join(CHECKOUT, "tests", "measure", "stubs", "review")
const STUBS_DIR = path.join(CHECKOUT, "tests", "measure", "stubs")
const CASES = path.join("measure", "evals", "review", "cases")
const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP"
const INVENTED_PRIVATE_IP = "10.250." + "3.4"

const MASKS: [RegExp, string][] = [
  [/smoke-\d{8}T\d{6}Z-[0-9a-f]{6}/g, "<run-id>"],
  [/\d{8}T\d{6}Z-[0-9a-f]{4}/g, "<stamp>"],
  [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, "<ts>"],
  [/line \d+, in /g, "line N, in "],
  [/\/tmp[A-Za-z0-9_]{6,8}\//g, "/<tmp>/"],
  [/^usage: [\s\S]*?(?=^\S+: error: )/gm, ""],
]

const mask = (text: string): string => MASKS.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text)

interface Outcome {
  status: number | null
  stdout: string
  stderr: string
  files: Record<string, string>
}

interface ParityCase {
  name: string
  tool: string
  args: string[]
  setup?: (box: EvalSandbox) => void
  cwd?: (box: EvalSandbox) => string
  stub?: "eval" | "review"
  helpText?: boolean
  engineDependentStderr?: boolean
}

let compared = 0
let mismatches = 0

function snapshotFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else if (entry.isFile()) files[mask(path.relative(root, entryPath))] = mask(readText(entryPath))
    }
  }
  if (fs.existsSync(root)) visit(root)
  return files
}

function run(box: EvalSandbox, command: string, args: string[], cwd: string): Outcome {
  const before = path.join(box.root, "data.before")
  fs.rmSync(before, { recursive: true, force: true })
  fs.cpSync(box.data, before, { recursive: true, verbatimSymlinks: true })
  fs.rmSync(path.join(box.scenarios, "calls.jsonl"), { force: true })
  const completed = spawnSync(command, args, { encoding: "utf8", env: box.env, cwd })
  const files = snapshotFiles(box.data)
  fs.rmSync(box.data, { recursive: true, force: true })
  fs.renameSync(before, box.data)
  return { status: completed.status, stdout: mask(completed.stdout), stderr: mask(completed.stderr).replace(/\n\s+at .*$/gm, ""), files }
}

function runBoth(box: EvalSandbox, parityCase: ParityCase): { python: Outcome; ts: Outcome } {
  const cwd = parityCase.cwd ? parityCase.cwd(box) : box.root
  const tool = parityCase.tool
  const pythonEntry = path.join(CHECKOUT, "measure", tool)
  const tsEntry = path.join(CHECKOUT, "measure", `${tool}.ts`)
  return { python: run(box, pythonEntry, parityCase.args, cwd), ts: run(box, process.execPath, [tsEntry, ...parityCase.args], cwd) }
}

function ledgerBox(box: EvalSandbox, rows: ReturnType<typeof ledgerRow>[]): void {
  box.writeLedger("keel/ledger.tsv", rows)
}

function suiteRuns(): RawRun[] {
  const ask = [initEvent(), ASK_EVENT, resultEvent(ASK_TEXT)]
  const edit = [initEvent(), EDIT_EVENT, resultEvent("Renamed it.")]
  return [
    { case: "a1", kind: "ambiguous", events: ask }, { case: "c1", kind: "clear-change", events: edit, changed: true },
    { case: "h1", kind: "ambiguous", events: ask }, { case: "h2", kind: "clear-change", events: edit, changed: true },
  ]
}

function repoWithStaged(box: EvalSandbox): string {
  const repo = path.join(box.root, "work")
  fs.mkdirSync(repo, { recursive: true })
  box.writeLexicon()
  box.initRepo(repo)
  box.write("work/app.txt", "one\ntwo\nthree\n")
  box.commitAll(repo)
  box.write("work/app.txt", `one\ntwo acmecorp\nthree\n++ TKT-9 header lookalike\nkey ${FAKE_AWS_KEY}\n`)
  box.git(repo, "add", "app.txt")
  return repo
}

const CASES_UNDER_PARITY: ParityCase[] = [
  {
    name: "boundary paths with lexicon regex and generic hits", tool: "boundary", args: ["--paths", "notes.txt", "nested"],
    setup: (box) => {
      box.writeLexicon()
      box.write("work/notes.txt", `clean\nshipped for acmecorp\nsee TKT-1234\nhost ${INVENTED_PRIVATE_IP}\nkey ${FAKE_AWS_KEY}\ncaf\u00e9 \u{1F600}\n`)
      box.write("work/nested/b\u00e9.txt", "TKT-77777\nline\u2028two acmecorp\n")
      box.write("work/nested/bin.dat", "ab")
      fs.appendFileSync(path.join(box.root, "work", "nested", "bin.dat"), Buffer.from([0, 1]))
    },
    cwd: (box) => path.join(box.root, "work"),
  },
  { name: "boundary generic-only", tool: "boundary", args: ["--generic-only", "--paths", "notes.txt"], setup: (box) => box.write("work/notes.txt", `acmecorp\nkey ${FAKE_AWS_KEY}\n`), cwd: (box) => path.join(box.root, "work") },
  { name: "boundary generic-only folds the dotted capital I like re.I", tool: "boundary", args: ["--generic-only", "--paths", "notes.txt"], setup: (box) => box.write("work/notes.txt", 'AP\u0130_KEY = "abcdefghij"\n'), cwd: (box) => path.join(box.root, "work") },
  { name: "boundary generic-only folds the dotless small i like re.I", tool: "boundary", args: ["--generic-only", "--paths", "notes.txt"], setup: (box) => box.write("work/notes.txt", 'ap\u0131_key = "abcdefghij"\n'), cwd: (box) => path.join(box.root, "work") },
  {
    name: "boundary overlay regex with an empty quantifier, a lone bracket, an octal escape and a scoped flag group", tool: "boundary", args: ["--paths", "notes.txt"],
    setup: (box) => {
      box.writeLexicon()
      box.write("overlay/boundary/regex.txt", "(?s:BEGIN.SECRET)\nTOKEN{,}X\nZED]\nQ\\101\n(?i:abc)D\n")
      box.write("work/notes.txt", "TOKENNNX\nZED]\nQA\nBEGIN-SECRET\nABCD\nabcd\n")
    },
    cwd: (box) => path.join(box.root, "work"),
  },
  { name: "boundary missing lexicon", tool: "boundary", args: ["--paths", "notes.txt"], setup: (box) => box.write("work/notes.txt", "x\n"), cwd: (box) => path.join(box.root, "work") },
  { name: "boundary invalid regex", tool: "boundary", args: ["--paths", "notes.txt"], setup: (box) => { box.writeLexicon(); box.write("overlay/boundary/regex.txt", "(unclosed\n"); box.write("work/notes.txt", "x\n") }, cwd: (box) => path.join(box.root, "work"), engineDependentStderr: true },
  { name: "boundary staged", tool: "boundary", args: ["--staged"], setup: (box) => void repoWithStaged(box), cwd: (box) => path.join(box.root, "work") },
  { name: "boundary range", tool: "boundary", args: ["--range", "HEAD~1..HEAD"], setup: (box) => { const repo = repoWithStaged(box); box.git(repo, "commit", "-q", "--no-verify", "-m", "Fix TKT-4321 \u00e9") }, cwd: (box) => path.join(box.root, "work") },
  { name: "boundary range from zero sha", tool: "boundary", args: ["--range", `${"0".repeat(40)}..HEAD`], setup: (box) => { const repo = repoWithStaged(box); box.git(repo, "commit", "-q", "--no-verify", "-m", "m") }, cwd: (box) => path.join(box.root, "work") },
  { name: "boundary bad range", tool: "boundary", args: ["--range", "HEAD"], setup: (box) => void repoWithStaged(box), cwd: (box) => path.join(box.root, "work") },
  { name: "boundary no source", tool: "boundary", args: ["--generic-only"] },
  { name: "boundary two sources", tool: "boundary", args: ["--staged", "--paths", "x"] },
  { name: "boundary abbreviation", tool: "boundary", args: ["--gen", "--pa", "notes.txt"], setup: (box) => box.write("work/notes.txt", `key ${FAKE_AWS_KEY}\n`), cwd: (box) => path.join(box.root, "work") },
  { name: "boundary equals form", tool: "boundary", args: ["--range=HEAD..HEAD"], setup: (box) => void repoWithStaged(box), cwd: (box) => path.join(box.root, "work") },
  { name: "boundary repeated option keeps the last", tool: "boundary", args: ["--paths", "missing.txt", "--paths", "notes.txt"], setup: (box) => { box.writeLexicon(); box.write("work/notes.txt", "x\n") }, cwd: (box) => path.join(box.root, "work") },
  { name: "boundary unknown option", tool: "boundary", args: ["--bogus", "--staged"] },
  { name: "boundary paths without value", tool: "boundary", args: ["--paths"] },
  { name: "boundary help", tool: "boundary", args: ["-h"], helpText: true },
  {
    name: "run fires", tool: "run", args: ["C-demo"],
    setup: (box) => { ledgerBox(box, [ledgerRow("C-demo")]); box.fire("C-demo"); box.fire("C-demo", undefined, "error"); box.fire("C-demo", "2020-01-01T00:00:00Z") },
  },
  { name: "run grace", tool: "run", args: ["C-demo"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo", { grace_until: FUTURE })]) },
  { name: "run fail", tool: "run", args: ["C-demo"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo", { grace_until: PAST })]) },
  { name: "run since", tool: "run", args: ["C-demo", "--since", "2020-01-01"], setup: (box) => { ledgerBox(box, [ledgerRow("C-demo")]); box.fire("C-demo", "2020-01-02T00:00:00Z") } },
  { name: "run since equals abbreviation", tool: "run", args: ["--sin=2020-1-1", "C-demo"], setup: (box) => { ledgerBox(box, [ledgerRow("C-demo")]); box.fire("C-demo", "2020-01-02T00:00:00Z") } },
  { name: "run bad since", tool: "run", args: ["C-demo", "--since", "yesterday"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo")]) },
  { name: "run impossible date", tool: "run", args: ["C-demo", "--since", "2026-02-30"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo")]) },
  { name: "run unknown id", tool: "run", args: ["C-nope"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo")]) },
  { name: "run missing id", tool: "run", args: [] },
  { name: "run negative-number-looking value", tool: "run", args: ["C-demo", "--since", "-5"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo")]) },
  { name: "run double dash", tool: "run", args: ["--", "C-demo"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo")]) },
  { name: "run option without value", tool: "run", args: ["C-demo", "--since"] },
  { name: "run missing id with option", tool: "run", args: ["--since", "2020-01-01"] },
  { name: "run unknown short option", tool: "run", args: ["-x", "C-demo"] },
  { name: "run unique prefix", tool: "run", args: ["--s", "2020-01-01", "C-demo"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo")]) },
  { name: "run explicit value on a flag", tool: "boundary", args: ["--staged=1"] },
  { name: "run extra argument", tool: "run", args: ["C-demo", "extra"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo")]) },
  { name: "run help", tool: "run", args: ["--help"], helpText: true },
  {
    name: "run runner with floats unicode and nested items", tool: "run", args: ["C-demo"],
    setup: (box) => {
      ledgerBox(box, [ledgerRow("C-demo", { metric: "run:demo-runner" })])
      box.write("keel/measure/metrics/demo-runner", '#!/bin/bash\necho \'{"count": 3, "items": [1.0, "\u00e9\\ud83d\\ude00", {"b": 2, "a": 1.5e30, "c": [0.1, 1e-7, 12345678901234567890]}, null, true]}\'\n', true)
    },
  },
  { name: "run runner with a float count is rejected as not an int", tool: "run", args: ["C-demo"], setup: (box) => { ledgerBox(box, [ledgerRow("C-demo", { metric: "run:odd" })]); box.write("keel/measure/metrics/odd", "#!/bin/bash\necho '{\"count\": 1.0, \"items\": []}'\n", true) } },
  { name: "run runner with a boolean count", tool: "run", args: ["C-demo"], setup: (box) => { ledgerBox(box, [ledgerRow("C-demo", { metric: "run:odd" })]); box.write("keel/measure/metrics/odd", "#!/bin/bash\necho '{\"count\": true, \"items\": []}'\n", true) } },
  { name: "run runner with a false count", tool: "run", args: ["C-demo"], setup: (box) => { ledgerBox(box, [ledgerRow("C-demo", { metric: "run:odd" })]); box.write("keel/measure/metrics/odd", "#!/bin/bash\necho '{\"count\": false, \"items\": []}'\n", true) } },
  { name: "run runner with a count beyond 2^53", tool: "run", args: ["C-demo"], setup: (box) => { ledgerBox(box, [ledgerRow("C-demo", { metric: "run:odd" })]); box.write("keel/measure/metrics/odd", "#!/bin/bash\necho '{\"count\": 12345678901234567890, \"items\": []}'\n", true) } },
  { name: "run runner exits non-zero", tool: "run", args: ["C-demo"], setup: (box) => { ledgerBox(box, [ledgerRow("C-demo", { metric: "run:bad" })]); box.write("keel/measure/metrics/bad", "#!/bin/bash\necho oops >&2\nexit 4\n", true) } },
  { name: "run evals", tool: "run", args: ["C-demo"], setup: (box) => { ledgerBox(box, [ledgerRow("C-demo", { metric: "evals:demo" })]); box.appendLog("keel-evals.jsonl", { ts: new Date().toISOString(), eval_id: "demo", pass: true }) } },
  { name: "run unknown metric kind", tool: "run", args: ["C-demo"], setup: (box) => ledgerBox(box, [ledgerRow("C-demo", { metric: "odd:it's", grace_until: FUTURE })]) },
  {
    name: "propose expiry and recheck", tool: "propose", args: [],
    setup: (box) => ledgerBox(box, [
      ledgerRow("C-hook", { review_by: PAST }), ledgerRow("C-skill", { review_by: PAST, layer: "skill", enforced_at: "skill:demo", why_not_stronger: "J." }),
      ledgerRow("C-fires", { review_by: PAST, metric: "fires:C-fires" }), ledgerRow("C-bad", { review_by: PAST, metric: "run:none" }),
      ledgerRow("C-repo", { review_by: PAST, layer: "repo", enforced_at: "repo:a/b:c", metric: "exists:/nowhere:HEAD:x" }),
    ]),
  },
  {
    name: "propose expiry with a boolean and a huge runner count", tool: "propose", args: [],
    setup: (box) => {
      ledgerBox(box, [ledgerRow("C-bool", { review_by: PAST, metric: "run:odd" }), ledgerRow("C-huge", { review_by: PAST, metric: "run:huge" })])
      box.write("keel/measure/metrics/odd", "#!/bin/bash\necho '{\"count\": true, \"items\": []}'\n", true)
      box.write("keel/measure/metrics/huge", "#!/bin/bash\necho '{\"count\": 12345678901234567890, \"items\": []}'\n", true)
    },
  },
  { name: "propose model upgrade", tool: "propose", args: ["--model-upgrade", "m\u00e9"], setup: (box) => ledgerBox(box, [charterRow("K1"), ledgerRow("C-demo")]) },
  { name: "propose bad option", tool: "propose", args: ["--model-upgrade"] },
  {
    name: "weekly", tool: "weekly", args: [],
    setup: (box) => {
      box.initRepo(box.keel)
      ledgerBox(box, [charterRow("K1"), ledgerRow("C-late", { review_by: PAST, grace_until: FUTURE })])
      box.write("data/CLAUDE.md", "x".repeat(100))
      box.write("keel/lib/tool.py", "a = 1\nb = 2\n")
      box.write("keel/docs/DESIGN.md", "d".repeat(33))
      box.write("overlay/measure/metrics/defects-x", '#!/bin/bash\necho \'{"count": 1, "items": [1.0]}\'\n', true)
      box.write("overlay/measure/metrics/defects-y", "#!/bin/bash\nexit 3\n", true)
      box.commitAll(box.keel)
    },
  },
  {
    name: "weekly defect runner with a boolean count", tool: "weekly", args: [],
    setup: (box) => {
      box.initRepo(box.keel)
      ledgerBox(box, [charterRow("K1")])
      box.write("overlay/measure/metrics/defects-x", '#!/bin/bash\necho \'{"count": true, "items": []}\'\n', true)
      box.commitAll(box.keel)
    },
  },
  { name: "weekly extra argument", tool: "weekly", args: ["x"] },
  { name: "smoke clean json-only", tool: "smoke", args: ["--json-only"], setup: (box) => box.seedCleanKeel() },
  { name: "smoke clean with summary", tool: "smoke", args: [], setup: (box) => box.seedCleanKeel() },
  { name: "smoke failing", tool: "smoke", args: [], setup: (box) => { box.seedCleanKeel(); box.fire("C-unknown"); box.write("keel/PRINCIPLES.md", "- Untagged\n- [K9] ghost\n"); box.write("data/projects/p/memory/MEMORY.md", "x".repeat(9000)) } },
  { name: "smoke principles bullet after a unicode line separator", tool: "smoke", args: ["--json-only"], setup: (box) => { box.seedCleanKeel(); box.write("keel/PRINCIPLES.md", "# Principles\n\n- [K1] Tagged.\u2028- untagged bullet\n"); box.commitAll(box.keel) } },
  { name: "smoke principles bullet after a form feed", tool: "smoke", args: ["--json-only"], setup: (box) => { box.seedCleanKeel(); box.write("keel/PRINCIPLES.md", "# Principles\n\n- [K1] Tagged.\f- untagged bullet\n"); box.commitAll(box.keel) } },
  { name: "smoke seed ledger", tool: "smoke", args: ["--json-only"], setup: (box) => fs.copyFileSync(path.join(CHECKOUT, "ledger.tsv"), path.join(box.keel, "ledger.tsv")) },
  { name: "smoke bad flag", tool: "smoke", args: ["--candidate=1"] },
  { name: "eval dry-run", tool: "evals/eval", args: ["K4", "--model", "m", "--dry-run"], stub: "eval", setup: (box) => { box.linkKeel(); box.seedSuite(box.askScenario(), box.editScenario()) } },
  { name: "eval usage errors", tool: "evals/eval", args: ["K4", "--regrade", "x", "--model", "m"] },
  { name: "eval ambiguous prefix", tool: "evals/eval", args: ["K4", "--re", "3", "--model", "m"] },
  { name: "eval option without value", tool: "evals/eval", args: ["K4", "--model"] },
  { name: "eval later option wins", tool: "evals/eval", args: ["K4", "--model", "m", "--model", "n", "--dry-run"], stub: "eval", setup: (box) => { box.linkKeel(); box.seedSuite(box.askScenario(), box.editScenario()) } },
  { name: "eval repeat with spaces and underscores", tool: "evals/eval", args: ["K4", "--model", "m", "--repeat", " 1_0 ", "--dry-run"], stub: "eval", setup: (box) => { box.linkKeel(); box.seedSuite(box.askScenario(), box.editScenario()) } },
  { name: "eval repeat with a misplaced underscore", tool: "evals/eval", args: ["K4", "--model", "m", "--repeat", "1__0"] },
  { name: "eval repeat in another script", tool: "evals/eval", args: ["K4", "--model", "m", "--repeat", "\u0663", "--dry-run"], stub: "eval", setup: (box) => { box.linkKeel(); box.seedSuite(box.askScenario(), box.editScenario()) } },
  { name: "eval repeat not positive", tool: "evals/eval", args: ["K4", "--model", "m", "--repeat", "0"] },
  { name: "eval repeat not integer", tool: "evals/eval", args: ["K4", "--model", "m", "--repeat", "two"] },
  { name: "eval split invalid choice", tool: "evals/eval", args: ["K4", "--model", "m", "--split", "dev"] },
  { name: "eval full run", tool: "evals/eval", args: ["K4", "--model", "requested", "--repeat", "2"], stub: "eval", setup: (box) => { box.linkKeel(); box.seedSuite(box.askScenario(), box.editScenario()) } },
  {
    name: "eval full run with a fault and a failing case", tool: "evals/eval", args: ["K4", "--model", "m", "--repeat", "1"], stub: "eval",
    setup: (box) => { box.linkKeel(); box.seedSuite(box.askScenario(), box.scenario("logged-out", { events: [initEvent(), resultEvent("Not logged in", { isError: true, modelUsage: false })], exit: 1 })) },
  },
  { name: "eval regrade", tool: "evals/eval", args: ["K4", "--regrade", "@RAW"], setup: (box) => { box.seedSuite("unused", "unused"); box.writeRawDir("K4-old", suiteRuns()) } },
  { name: "eval regrade of unknown dir", tool: "evals/eval", args: ["K4", "--regrade", "/nowhere"], setup: (box) => box.seedSuite("unused", "unused") },
  { name: "eval no ledger row", tool: "evals/eval", args: ["K9", "--model", "m"], setup: (box) => box.seedSuite("unused", "unused") },
  { name: "review-eval dry-run", tool: "evals/review-eval", args: ["--dry-run"], stub: "review", setup: (box) => writeReviewCases(box) },
  { name: "review-eval full run", tool: "evals/review-eval", args: ["--repeat", "2"], stub: "review", setup: (box) => { writeReviewCases(box); playReview(box, 6) } },
  { name: "review-eval single case", tool: "evals/review-eval", args: ["--case", "mean-1", "--repeat", "1", "--model", "opus"], stub: "review", setup: (box) => { writeReviewCases(box); playReview(box, 1) } },
  { name: "review-eval bad repeat", tool: "evals/review-eval", args: ["--repeat", "0"] },
]

const REVIEW_BASE = "export function total(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0)\n}\n"
const REVIEW_CHANGE = "diff --git a/calc.ts b/calc.ts\n--- a/calc.ts\n+++ b/calc.ts\n@@ -1,3 +1,7 @@\n export function total(items: number[]): number {\n   return items.reduce((sum, item) => sum + item, 0)\n }\n+\n+export function mean(items: number[]): number {\n+  return total(items) / items.length\n+}\n"

function writeReviewCases(box: EvalSandbox): void {
  for (const [id, split, lens, locations] of [["mean-1", "train", "boundary", [{ file: "calc.ts", line: 6 }]], ["mean-2", "holdout", "boundary", [{ file: "calc.ts", line: 6 }]], ["control-1", "train", "control", []]] as const) {
    box.write(`keel/${CASES}/${id}/base/calc.ts`, REVIEW_BASE)
    box.write(`keel/${CASES}/${id}/change.diff`, REVIEW_CHANGE)
    box.write(`keel/${CASES}/${id}/expect.json`, JSON.stringify({ lens, must_find: "x", source: "t", split, locations }))
  }
}

function playReview(box: EvalSandbox, count: number): void {
  const hit = { result: { verdict: "NEEDS_FIXES", blocking: [{ id: "f", file: "{{REPO}}/calc.ts", quote: "calc.ts:6", impact: "high" }], nonBlocking: [] } }
  const clean = { result: { verdict: "PASS", blocking: [], nonBlocking: [] } }
  const rounds = Array.from({ length: count }, (_, index) => (index % 3 === 0 ? hit : clean))
  fs.writeFileSync(path.join(box.scenarios, "review.json"), JSON.stringify({ rounds }))
}

describe("python and typescript entries agree", () => {
  let box: EvalSandbox

  beforeEach(() => {
    box = new EvalSandbox()
  })
  afterEach(() => box.cleanup())

  for (const parityCase of CASES_UNDER_PARITY) {
    it(parityCase.name, () => {
      parityCase.setup?.(box)
      if (parityCase.stub === "review") box.env["PATH"] = REVIEW_STUB_DIR + path.delimiter + (box.env["PATH"] ?? "").replace(STUBS_DIR + path.delimiter, "")
      if (parityCase.args.includes("@RAW")) parityCase.args = parityCase.args.map((arg) => (arg === "@RAW" ? path.join(box.data, "logs", "keel-eval-K4-old") : arg))
      const { python, ts } = runBoth(box, parityCase)
      if (parityCase.helpText) python.stdout = ts.stdout = ""
      if (parityCase.engineDependentStderr) {
        for (const outcome of [python, ts]) outcome.stderr = outcome.stderr.replace(/(invalid regex: ).*/, "$1<engine message>")
      }
      compared++
      try {
        assert.deepEqual(ts, python)
      } catch (error) {
        mismatches++
        throw error
      }
    })
  }

  it("zzSummary_printsTheParityCount", () => {
    console.log(`parity: ${compared} cases, ${mismatches} mismatches`)
    assert.equal(mismatches, 0)
  })
})
