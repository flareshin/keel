import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { graderCommit } from "../../measure/evals/lib/evalkit/grade.ts"
import { ASK_EVENT, ASK_TEXT, EDIT_EVENT, MODEL, EvalSandbox, caseRow, initEvent, readJson, readJsonl, resultEvent, toolUse } from "./eval_helpers.ts"
import type { RawRun } from "./eval_helpers.ts"
import { CHECKOUT, readText } from "./helpers.ts"

const RUN_ONCE = ["--repeat", "1"]

describe("eval cli", () => {
  let box: EvalSandbox

  beforeEach(() => {
    box = new EvalSandbox()
  })
  afterEach(() => box.cleanup())

  const evalIds = (): string[] => box.evalLines().map((line) => line.eval_id)
  const linesOf = (evalId: string): any[] => box.evalLines().filter((line) => line.eval_id === evalId)

  it("fullRun_writesK4SuiteLineAndCaseLines_whenKeelIsLinked", () => {
    box.linkKeel()
    box.seedSuite(box.askScenario(), box.editScenario())
    const [completed, report] = box.runEvalJson("K4", "--model", "requested-model", ...RUN_ONCE)
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual([report.eval_id, report.pass, report.written, report.model], ["K4", true, true, MODEL])
    const suite = linesOf("K4")
    assert.deepEqual(suite, [{ ts: suite[0].ts, eval_id: "K4", rule_id: "K4", case: "suite train=2/2 holdout=2/2", pass: true, model: MODEL }])
    assert.deepEqual(linesOf("K4.case").map((line) => [line.case, line.pass]), [["a1", true], ["c1", true], ["h1", true], ["h2", true]])
  })

  it("fullRun_writesV1BaselineLine_whenKeelIsNotLinked", () => {
    box.seedSuite(box.askScenario(), box.editScenario())
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE)
    assert.deepEqual([completed.status, report.eval_id], [0, "K4-v1baseline"], completed.stderr)
    assert.equal(evalIds().filter((id) => id === "K4").length, 0)
    assert.equal(evalIds().filter((id) => id === "K4-v1baseline").length, 1)
  })

  it("fullRun_writesAFailingSuiteLine_whenAClearCaseFails", () => {
    box.linkKeel()
    const silent = box.scenario("silent", { events: [initEvent(), resultEvent("I would rename it, but which one?")] })
    box.seedSuite(box.askScenario(), silent)
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE)
    assert.deepEqual([completed.status, report.pass, report.written], [1, false, true], completed.stderr)
    assert.deepEqual(linesOf("K4").map((line) => line.pass), [false])
  })

  it("fullRun_passesACaseWithTwoOfThreeRuns_andTwoThirdsOfAmbiguousCases", () => {
    box.linkKeel()
    const ask = box.round([initEvent(), ASK_EVENT, resultEvent(ASK_TEXT)])
    const silent = box.round([initEvent(), resultEvent("Done, I guessed.")])
    const twoOfThree = box.scenario("two", { rounds: [ask, ask, silent] })
    const oneOfThree = box.scenario("one", { rounds: [ask, silent, silent] })
    box.writeCases("keel/measure/evals/K4/train.tsv", [
      caseRow("a1", "ambiguous", twoOfThree), caseRow("a2", "ambiguous", oneOfThree), caseRow("a3", "ambiguous", twoOfThree),
      caseRow("c1", "clear-change", box.editScenario()),
    ])
    box.writeCases("keel/measure/evals/K4/holdout.tsv", [caseRow("h1", "ambiguous", twoOfThree), caseRow("h2", "clear-change", "edit")])
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL)
    assert.deepEqual([completed.status, report.pass], [0, true], completed.stderr)
    const byCase = new Map<string, [boolean[], boolean]>(report.cases.map((entry: any) => [entry.id, [entry.runs, entry.pass]]))
    assert.deepEqual(byCase.get("a1"), [[true, true, false], true])
    assert.deepEqual(byCase.get("a2"), [[true, false, false], false])
    assert.deepEqual(report.splits.train, { cases: 4, passed: 3, pass: true })
    assert.deepEqual(box.evalLines().filter((line) => line.case === "a2").map((line) => line.pass), [false])
  })

  it("fullRun_handsClaudeTheDesignedCommand_promptOnStdin_inAFreshTempRepo", () => {
    box.seedSuite(box.askScenario(), box.editScenario())
    box.runEval("K4", "--model", "pinned", ...RUN_ONCE)
    const call = box.stubCalls()[0]
    const argv = call.argv.join(" ")
    assert.ok(argv.includes('-p --model pinned --output-format stream-json --verbose --settings {"disableAllHooks":true}'), argv)
    assert.ok(argv.includes("--tools Skill,Read,Grep,Glob,Edit,Write,AskUserQuestion --disallowedTools Bash,NotebookEdit,Agent,Task,Workflow,WebFetch,WebSearch"), argv)
    assert.ok(argv.includes("--permission-mode acceptEdits --strict-mcp-config --max-turns 8 --no-session-persistence"), argv)
    assert.deepEqual([call.scenario, call.auto_memory_disabled], ["ask", "1"])
    assert.ok(!call.cwd.startsWith(box.root), call.cwd)
    assert.equal(fs.existsSync(call.cwd), false, "the temp repo is removed after the run")
  })

  it("subsetRun_writesPartialAndCaseLines_neverK4", () => {
    box.linkKeel()
    box.seedSuite(box.askScenario(), box.editScenario())
    for (const selection of [["--case", "c1"], ["--split", "train"]]) {
      const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE, ...selection)
      assert.deepEqual([completed.status, report.eval_id, report.pass], [0, "K4-partial", true], completed.stderr)
    }
    assert.equal(evalIds().filter((id) => id === "K4").length, 0)
    assert.equal(evalIds().filter((id) => id === "K4-partial").length, 2)
    assert.deepEqual(linesOf("K4-partial").map((line) => line.case), ["subset train=1/1 holdout=0/0", "subset train=2/2 holdout=0/0"])
    assert.deepEqual(linesOf("K4.case").map((line) => line.case), ["c1", "a1", "c1"])
  })

  it("measureRunK4_countsOnlyFullRunLines", () => {
    box.linkKeel()
    box.seedSuite(box.askScenario(), box.editScenario())
    box.runEval("K4", "--model", MODEL, ...RUN_ONCE, "--case", "a1")
    const [, before] = box.runJson("run", ["K4"])
    box.runEval("K4", "--model", MODEL, ...RUN_ONCE)
    const [, after] = box.runJson("run", ["K4"])
    assert.deepEqual([before.count, after.count, after.status], [0, 1, "PASS"])
  })

  it("clearChange_passes_whenAFileIsWrittenWithoutAnEditToolUse", () => {
    box.linkKeel()
    const quietWrite = box.scenario("quiet-write", { events: [initEvent(), resultEvent("Added it.")], writes: { "src/new.ts": "export {};\n" } })
    box.seedSuite(box.askScenario(), quietWrite)
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE)
    assert.deepEqual([completed.status, report.pass], [0, true], completed.stderr)
    assert.ok(readText(path.join(report.raw_dir, "c1-1.diff")).includes("src/new.ts"))
  })

  it("run_ignoresWritesUnderDotClaude", () => {
    box.linkKeel()
    const askAndSettings = box.scenario("ask-settings", { events: [initEvent(), ASK_EVENT, resultEvent(ASK_TEXT)], writes: { ".claude/settings.local.json": "{}" } })
    const onlySettings = box.scenario("only-settings", { events: [initEvent(), EDIT_EVENT, resultEvent("Done.")], writes: { ".claude/settings.local.json": "{}" } })
    box.seedSuite(askAndSettings, onlySettings)
    const [, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE)
    const byCase = new Map<string, boolean>(report.cases.map((entry: any) => [entry.id, entry.pass]))
    assert.deepEqual([byCase.get("a1"), byCase.get("c1")], [true, false])
  })

  it("fault_loggedOutShape_exitsOneAndWritesNoEvalLine", () => {
    box.linkKeel()
    const loggedOut = box.scenario("logged-out", { events: [initEvent(), resultEvent("Not logged in", { isError: true, modelUsage: false })], exit: 1 })
    box.seedSuite(box.askScenario(), loggedOut)
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE)
    assert.deepEqual([completed.status, report.pass, report.written], [1, null, false], completed.stderr)
    assert.deepEqual(report.faults.map((fault: any) => [fault.case, fault.run]), [["c1", 1], ["h2", 1]])
    assert.ok(report.faults[0].reason.includes("logged out"))
    assert.deepEqual(box.evalLines(), [])
    const runs = readJsonl(path.join(report.raw_dir, "runs.jsonl"))
    assert.deepEqual(runs.map((run) => run.fault !== null), [false, true, false, true])
    assert.ok(fs.existsSync(path.join(report.raw_dir, "c1-1.stream.jsonl")))
  })

  it("fault_whenClaudeExceedsTheTimeout", () => {
    const slow = box.scenario("slow", { events: [initEvent(), resultEvent("late")], sleep: 3 })
    box.seedSuite(box.askScenario(), slow)
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE, "--case", "c1", "--timeout-seconds", "1")
    assert.deepEqual([completed.status, report.written], [1, false], completed.stderr)
    assert.ok(report.faults[0].reason.includes("timed out after 1s"))
  })

  it("fault_whenNoResultEventArrives", () => {
    const noResult = box.scenario("no-result", { events: [initEvent(), ASK_EVENT] })
    box.seedSuite(noResult, box.editScenario())
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE, "--case", "a1")
    assert.deepEqual([completed.status, report.faults[0].reason], [1, "no result event"], completed.stderr)
    assert.deepEqual(box.evalLines(), [])
  })

  it("fault_whenTheSessionLeavesAProjectDirectoryUnderTheConfigDir", () => {
    const leaves = box.scenario("leaves", { events: [initEvent(), ASK_EVENT, resultEvent(ASK_TEXT)], leaveProjectDir: true })
    box.seedSuite(leaves, box.editScenario())
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE, "--case", "a1")
    assert.equal(completed.status, 1, completed.stderr)
    const reason = report.faults[0].reason as string
    assert.ok(reason.includes("project directory"))
    assert.ok(reason.includes(path.join(box.data, "projects", "-")), "the slug of an absolute realpath starts with '-'")
  })

  it("fault_whenAToolOutsideTheGradedSetIsDenied", () => {
    const bashDenied = box.scenario("bash-denied", { events: [initEvent(), ASK_EVENT, resultEvent(ASK_TEXT, { denials: ["Bash"] })] })
    box.seedSuite(bashDenied, box.editScenario())
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE, "--case", "a1")
    assert.deepEqual([completed.status, report.faults[0].reason], [1, "permission denied for Bash"], completed.stderr)
  })

  it("exitTwo_whenACaseIdRepeatsAcrossKeelAndOverlayFiles", () => {
    box.seedSuite(box.askScenario(), box.editScenario())
    box.writeCases("overlay/measure/evals/K4/train.tsv", [caseRow("a1", "ambiguous", "ask")])
    const completed = box.runEval("K4", "--model", MODEL)
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("duplicate case id 'a1'"))
    assert.deepEqual([box.stubCalls(), box.evalLines()], [[], []])
  })

  it("exitTwo_whenNoCaseIsSelected", () => {
    box.seedSuite(box.askScenario(), box.editScenario())
    const completed = box.runEval("K4", "--model", MODEL, "--case", "nope")
    assert.deepEqual([completed.status, completed.stdout], [2, ""])
    assert.ok(completed.stderr.includes("no case selected"))
    assert.deepEqual(box.stubCalls(), [])
  })

  it("exitTwo_whenAFullRunSplitLacksAnAmbiguousOrClearCase", () => {
    box.seedSuite(box.askScenario(), box.editScenario())
    box.writeCases("keel/measure/evals/K4/holdout.tsv", [caseRow("h2", "clear-change", "edit")])
    const completed = box.runEval("K4", "--model", MODEL)
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("holdout has no ambiguous case"))
    assert.deepEqual([box.stubCalls(), box.evalLines()], [[], []])
  })

  it("exitTwo_whenTheLedgerHasNoRowForTheEvalId", () => {
    box.seedSuite(box.askScenario(), box.editScenario())
    const completed = box.runEval("K9", "--model", MODEL)
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("no ledger row with id 'K9'"))
  })

  it("ambiguousRun_passes_whenTheFinalTextCarriesAQuestionLine", () => {
    const marked = box.scenario("marked", { events: [initEvent(), resultEvent("Two screens fit.\n\nQUESTION: Which screen do you mean?")] })
    box.seedSuite(marked, box.editScenario())
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE, "--case", "a1")
    assert.deepEqual([completed.status, report.cases[0].runs], [0, [true]], completed.stderr)
  })

  it("exitTwo_whenACaseFileHasAnUnknownKind", () => {
    box.writeCases("keel/measure/evals/K4/train.tsv", [caseRow("a1", "vague", "ask")])
    const completed = box.runEval("K4", "--model", MODEL)
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("unknown kind 'vague'"))
  })

  it("dryRun_printsThePlanAndCommand_andSpendsNothing", () => {
    box.linkKeel()
    box.seedSuite(box.askScenario(), box.editScenario())
    const [completed, plan] = box.runEvalJson("K4", "--model", MODEL, "--dry-run")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual([plan.eval_id, plan.runs, plan.keel_live], ["K4", 12, true])
    assert.deepEqual(plan.cases.map((entry: any) => entry.id), ["a1", "c1", "h1", "h2"])
    assert.deepEqual(plan.command.slice(0, 4), ["claude", "-p", "--model", MODEL])
    assert.ok(!JSON.stringify(plan.cases).includes("ask"), "prompts never reach stdout")
    assert.deepEqual([box.stubCalls(), box.evalLines(), box.rawDirs()], [[], [], []])
  })

  it("fault_beforeAnyRun_whenTheCliConfigDirDiffersFromTheDataDir", () => {
    box.seedSuite(box.askScenario(), box.editScenario())
    box.env["CLAUDE_CONFIG_DIR"] = path.join(box.root, "home", ".claude")
    const [completed, report] = box.runEvalJson("K4", "--model", MODEL)
    assert.deepEqual([completed.status, report.written], [1, false], completed.stderr)
    assert.ok(report.faults[0].reason.includes("differs from KEEL_DATA_DIR"))
    assert.deepEqual(box.stubCalls(), [])
  })

  it("rawDir_holdsConfigStreamDiffFinalTextAndSkillDiagnostic", () => {
    box.linkKeel()
    const fires = box.scenario("fires", { events: [initEvent(), toolUse("Skill", { skill: "prompt-refine" }), ASK_EVENT, resultEvent(ASK_TEXT)] })
    box.seedSuite(fires, box.editScenario())
    const [, report] = box.runEvalJson("K4", "--model", "pinned", ...RUN_ONCE)
    const raw = report.raw_dir as string
    const config = readJson(path.join(raw, "config.json"))
    assert.deepEqual([config.summary_eval_id, config.model_requested, config.model_observed, config.cli_version], ["K4", "pinned", MODEL, "2.1.296"])
    assert.equal(config.claude_md_sha256.length, 64)
    assert.equal(config.skill_md_sha256.length, 64)
    assert.equal(readText(path.join(raw, "a1-1.final.txt")), ASK_TEXT)
    assert.deepEqual(readJson(path.join(raw, "skill-diagnostic.json")), { skill: "prompt-refine", ambiguous_runs: 2, ambiguous_fired: 2, clear_runs: 2, clear_false_fires: 0 })
    assert.equal(report.skill.ambiguous_fired, 2)
    assert.deepEqual(fs.readdirSync(raw).filter((name) => name.startsWith("c1-1")).sort(), ["c1-1.diff", "c1-1.final.txt", "c1-1.stream.jsonl"])
  })

  it("rawDir_filesAreByteIdenticalToPythonJsonDump_withSortedKeysTwoSpaceIndent", () => {
    box.linkKeel()
    box.seedSuite(box.askScenario(), box.editScenario())
    const [, report] = box.runEvalJson("K4", "--model", "pinned", ...RUN_ONCE)
    const text = readText(path.join(report.raw_dir, "skill-diagnostic.json"))
    assert.equal(text, '{\n  "ambiguous_fired": 0,\n  "ambiguous_runs": 2,\n  "clear_false_fires": 0,\n  "clear_runs": 2,\n  "skill": "prompt-refine"\n}\n')
  })

  function suiteRuns(changeDenials: string[] = []): RawRun[] {
    const ask = [initEvent(), ASK_EVENT, resultEvent(ASK_TEXT)]
    const edit = [initEvent(), EDIT_EVENT, resultEvent("Renamed it.", { denials: changeDenials })]
    return [
      { case: "a1", kind: "ambiguous", events: ask }, { case: "c1", kind: "clear-change", events: edit, changed: true },
      { case: "h1", kind: "ambiguous", events: ask }, { case: "h2", kind: "clear-change", events: edit, changed: true },
    ]
  }

  it("regrade_writesTheSuiteLineWithTheCurrentGrader_andCallsNoClaude", () => {
    box.seedSuite("unused", "unused")
    const runs = suiteRuns(["Skill"])
    runs[1] = { ...(runs[1] as RawRun), fault: "permission denied for Skill" }
    runs[3] = { ...(runs[3] as RawRun), fault: "permission denied for Skill", leftover: null }
    const raw = box.writeRawDir("K4-old", runs)
    const [completed, report] = box.runEvalJson("K4", "--regrade", raw)
    assert.deepEqual([completed.status, report.eval_id, report.pass, report.written, report.faults], [0, "K4", true, true, []], completed.stderr)
    assert.deepEqual(box.stubCalls(), [])
    assert.deepEqual(report.leftover_unknown, ["c1-1"], "c1's old Skill fault stopped the grader before its leftover check; h2 recorded it")
    const suite = linesOf("K4")
    assert.deepEqual(suite, [{
      ts: suite[0].ts, eval_id: "K4", rule_id: "K4", case: "suite train=2/2 holdout=2/2", pass: true,
      model: MODEL, regraded_from: "keel-eval-K4-old", grader: graderCommit(CHECKOUT),
    }])
    assert.deepEqual(linesOf("K4.case").map((line) => [line.case, line.regraded_from]), ["a1", "c1", "h1", "h2"].map((name) => [name, "keel-eval-K4-old"]))
  })

  it("regrade_matchesTheRunThatWroteTheRawDir", () => {
    box.linkKeel()
    const silent = box.scenario("silent", { events: [initEvent(), resultEvent("I would rename it, but which one?")] })
    box.seedSuite(box.askScenario(), silent)
    const [, runReport] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE)
    const calls = box.stubCalls().length
    const [completed, report] = box.runEvalJson("K4", "--regrade", runReport.raw_dir)
    assert.deepEqual([completed.status, report.eval_id, report.cases], [1, "K4", runReport.cases], completed.stderr)
    assert.equal(box.stubCalls().length, calls)
    assert.ok(readJsonl(path.join(runReport.raw_dir, "runs.jsonl")).every((run) => "leftover_project_dir" in run))
  })

  it("regrade_keepsATimeoutFault_withTheRunsTimeout", () => {
    const slow = box.scenario("slow", { events: [initEvent(), resultEvent("late")], sleep: 3 })
    box.seedSuite(box.askScenario(), slow)
    const [, runReport] = box.runEvalJson("K4", "--model", MODEL, ...RUN_ONCE, "--case", "c1", "--timeout-seconds", "1")
    const [completed, report] = box.runEvalJson("K4", "--regrade", runReport.raw_dir)
    assert.deepEqual([completed.status, report.written, report.faults[0].reason], [1, false, "timed out after 1s"], completed.stderr)
  })

  describe("regrade writes partial when the raw dir is not a full run of the current cases", () => {
    const u = (id: string, kind: string) => caseRow(id, kind, "u")
    const variants: [string, { repeat?: number; summaryEvalId?: string }, [any[], any[]] | null][] = [
      ["short-of-runs", { repeat: 2 }, null],
      ["subset-summary", { summaryEvalId: "K4-partial" }, null],
      ["case-joined", {}, [[u("a1", "ambiguous"), u("c1", "clear-change"), u("a9", "ambiguous")], [u("h1", "ambiguous"), u("h2", "clear-change")]]],
      ["split-gap", {}, [[u("a1", "ambiguous"), u("c1", "clear-change"), u("h1", "ambiguous")], [u("h2", "clear-change")]]],
    ]
    for (const [name, rawOptions, caseFiles] of variants) {
      it(name, () => {
        box.seedSuite("unused", "unused")
        if (caseFiles) {
          box.writeCases("keel/measure/evals/K4/train.tsv", caseFiles[0])
          box.writeCases("keel/measure/evals/K4/holdout.tsv", caseFiles[1])
        }
        const raw = box.writeRawDir("K4-" + name, suiteRuns(), rawOptions)
        const [completed, report] = box.runEvalJson("K4", "--regrade", raw)
        assert.deepEqual([completed.status, report.eval_id], [0, "K4-partial"], completed.stderr)
        assert.equal(evalIds().filter((id) => id === "K4").length, 0)
      })
    }
  })

  it("regrade_writesNoCaseLine_forACaseWithoutASavedRun", () => {
    box.seedSuite("unused", "unused")
    const raw = box.writeRawDir("K4-interrupted", suiteRuns().slice(0, 2), { cases: ["a1", "c1", "h1", "h2"] })
    const [completed, report] = box.runEvalJson("K4", "--regrade", raw)
    assert.deepEqual([completed.status, report.eval_id], [0, "K4-partial"], completed.stderr)
    assert.deepEqual(linesOf("K4.case").map((line) => line.case), ["a1", "c1"])
  })

  describe("regrade faults when the record names a leftover project dir", () => {
    const variants: [string, Partial<RawRun>][] = [
      ["recorded", { leftover: "/cfg/projects/-tmp-x" }],
      ["older-record", { fault: "session left a project directory behind: /cfg/projects/-tmp-x" }],
    ]
    for (const [name, runFields] of variants) {
      it(name, () => {
        box.seedSuite("unused", "unused")
        const runs = suiteRuns()
        runs[0] = { ...(runs[0] as RawRun), ...runFields }
        const raw = box.writeRawDir("K4-leftover-" + name, runs)
        const [completed, report] = box.runEvalJson("K4", "--regrade", raw)
        assert.deepEqual([completed.status, report.written, report.faults[0].case], [1, false, "a1"], completed.stderr)
        assert.deepEqual(report.leftover_unknown, [])
        assert.deepEqual(box.evalLines(), [])
      })
    }
  })

  describe("regrade exits two when the raw dir does not match the case files", () => {
    const variants: [string, string, (runs: RawRun[]) => Parameters<EvalSandbox["writeRawDir"]>[2]][] = [
      ["kind-changed", "a1", (runs) => { runs[0] = { ...(runs[0] as RawRun), kind: "clear-answer" }; return {} }],
      ["case-removed", "z9", (runs) => { runs.push({ case: "z9", kind: "ambiguous", events: [] }); return {} }],
      ["other-eval", "K5", () => ({ evalId: "K5" })],
      ["stray-run", "c1", () => ({ cases: ["a1", "h1", "h2"] })],
    ]
    for (const [name, named, change] of variants) {
      it(name, () => {
        box.seedSuite("unused", "unused")
        const runs = suiteRuns()
        const options = change(runs)
        const raw = box.writeRawDir("K4-" + name, runs, options)
        const completed = box.runEval("K4", "--regrade", raw)
        assert.equal(completed.status, 2, completed.stderr)
        assert.ok(completed.stderr.includes(named), completed.stderr)
        assert.deepEqual(box.evalLines(), [])
      })
    }
  })

  describe("regrade exits two when the runs file is unreadable", () => {
    const damages: [string, (file: string) => void][] = [
      ["no-runs-file", (file) => fs.rmSync(file)],
      ["empty-runs-file", (file) => fs.writeFileSync(file, "")],
      ["malformed-line", (file) => fs.appendFileSync(file, "{oops\n")],
      ["record-missing-a-key", (file) => fs.appendFileSync(file, '{"case": "a1", "run": 2}\n')],
    ]
    for (const [name, damage] of damages) {
      it(name, () => {
        box.seedSuite("unused", "unused")
        const raw = box.writeRawDir("K4-" + name, suiteRuns())
        damage(path.join(raw, "runs.jsonl"))
        const completed = box.runEval("K4", "--regrade", raw)
        assert.equal(completed.status, 2, completed.stderr)
        assert.ok(completed.stderr.includes("runs.jsonl"), completed.stderr)
        assert.deepEqual(box.evalLines(), [])
      })
    }
  })

  it("regrade_exitsTwo_whenTheGraderCheckoutHasNoCommit", () => {
    box.seedSuite("unused", "unused")
    const raw = box.writeRawDir("K4-uncommitted", suiteRuns())
    const code = path.join(box.root, "code")
    fs.cpSync(path.join(CHECKOUT, "measure"), path.join(code, "measure"), { recursive: true, dereference: true })
    fs.copyFileSync(path.join(CHECKOUT, "package.json"), path.join(code, "package.json"))
    const completed = spawnSync(process.execPath, [path.join(code, "measure", "evals", "eval.ts"), "K4", "--regrade", raw], { encoding: "utf8", env: box.env, cwd: box.root })
    assert.equal(completed.status, 2, completed.stderr)
    assert.deepEqual(box.evalLines(), [])
  })

  describe("exitTwo when regrade is mixed with a run option, or a run lacks a model", () => {
    const mixed = [["--case", "a1"], ["--model", MODEL], ["--split", "train"], ["--dry-run"]]
    const argsOf = (raw: string): string[][] => [...mixed.map((option) => ["K4", "--regrade", raw, ...option]), ["K4"]]
    it("rejects every combination", () => {
      box.seedSuite(box.askScenario(), box.editScenario())
      const raw = box.writeRawDir("K4-mixed", suiteRuns())
      for (const args of argsOf(raw)) {
        const completed = box.runEval(...args)
        assert.equal(completed.status, 2, `${args.join(" ")}: ${completed.stderr}`)
      }
      assert.deepEqual([box.evalLines(), box.stubCalls()], [[], []])
    })
  })

  it("exitTwo_whenRepeatIsNotAPositiveInteger", () => {
    box.seedSuite(box.askScenario(), box.editScenario())
    for (const value of ["0", "-1", "two"]) {
      const completed = box.runEval("K4", "--model", MODEL, "--repeat", value)
      assert.equal(completed.status, 2, `${value}: ${completed.stderr}`)
    }
  })
})
