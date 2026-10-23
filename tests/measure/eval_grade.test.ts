import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { AMBIGUOUS, CLEAR_ANSWER, CLEAR_CHANGE, Case } from "../../measure/evals/lib/evalkit/cases.ts"
import { faultReason, graderCommit, runPasses, textAnswers, textAsks } from "../../measure/evals/lib/evalkit/grade.ts"
import { GENERATED_CLAUDE_MD_HEADER, isKeelLive, projectDirFor, suiteEvalId } from "../../measure/evals/lib/evalkit/liveconfig.ts"
import { QUESTION_PROTOCOL, claudeCommand } from "../../measure/evals/lib/evalkit/runner.ts"
import { RunFacts, summarizeStream } from "../../measure/evals/lib/evalkit/stream.ts"
import type { JsonObject } from "../../measure/lib/measurekit/json.ts"
import { CaseVerdict, passesNeeded, splitVerdict, suitePasses } from "../../measure/evals/lib/evalkit/verdict.ts"

const TIMEOUT = 300
const AMBIGUOUS_CASE = new Case("a1", "train", AMBIGUOUS, "-", "Improve this screen.")
const CHANGE_CASE = new Case("c1", "train", CLEAR_CHANGE, "-", "Rename x to y.")
const ANSWER_CASE = new Case("c2", "train", CLEAR_ANSWER, "grandTotalCents", "What does useCart return?")
const MAX_TURNS = "error_max_turns"

interface FactsOptions {
  changed?: boolean
  askCalls?: number
  denied?: string[]
  text?: string
  subtype?: string
  isError?: boolean
  exitCode?: number
  timedOut?: boolean
  modelUsage?: boolean
  leftover?: string | null
  noResult?: boolean
}

function facts(options: FactsOptions = {}): RunFacts {
  const { changed = false, askCalls = 0, denied = [], text = "Done.", subtype = "success", isError = false, exitCode = 0, timedOut = false, modelUsage = true, leftover = null, noResult = false } = options
  const usage: JsonObject = modelUsage ? { m: { inputTokens: 1 } } : {}
  const result: JsonObject | null = noResult ? null : { subtype, is_error: isError, result: text, modelUsage: usage }
  const stream = { init: { model: "m" }, result, askCalls, skillCalls: [], deniedTools: [...denied] }
  return new RunFacts({ stream, exitCode, timedOut, changed, leftoverProjectDir: leftover })
}

describe("textAsks", () => {
  it("textAsks_true_whenALineStartsWithTheQuestionMarker", () => {
    for (const reply of [
      "I looked at the screens.\n\nQUESTION: Which screen do you mean?", "Two readings.\n- QUESTION: delete it or tidy it?\n\nNothing changed yet.",
      "**QUESTION:** Which report?", "> QUESTION: which branch", "1. QUESTION: which screen?", "2) QUESTION: which one?", "+ QUESTION: which?",
      "### QUESTION: which?", "> - QUESTION: which?", "  QUESTION: which branch?", "**QUESTION**: which?", "__QUESTION__: which?", "__QUESTION:__ which?",
    ]) assert.equal(textAsks(reply), true, reply)
  })

  it("textAsks_true_whenThePromptRefineHeadingAppears", () => {
    assert.equal(textAsks("## Refined request\nGoal: improve a screen\n\nI will wait for your pick."), true)
  })

  it("textAsks_false_withoutTheMarker_evenForAQuestionInProse", () => {
    for (const reply of [
      "Which screen do you mean?", "Let me know which report you mean.", "The refined request is clear; I changed nothing.",
      "Refined request: none needed, the target is clear.",
    ]) {
      assert.equal(textAsks(reply), false, reply)
      assert.equal(runPasses(AMBIGUOUS_CASE, facts({ text: reply })), false, reply)
    }
  })

  it("textAsks_false_whenTheMarkerIsInsideAFenceOrMidLine", () => {
    for (const reply of ["Example:\n\n```\nQUESTION: not a real one\n```", "I would write QUESTION: here but I will not."]) {
      assert.equal(textAsks(reply), false, reply)
    }
  })

  it("textAsks_returnsQuickly_whenALineIsALongRunOfHashes", () => {
    const started = performance.now()
    assert.equal(textAsks("#".repeat(26) + " x"), false)
    assert.ok(performance.now() - started < 1000)
  })

  it("textAsks_false_whenNoFinalText", () => {
    assert.equal(textAsks(null), false)
  })
})

describe("textAnswers", () => {
  it("textAnswers_true_whenTheTokenIsOnALineThatIsNotAQuestion", () => {
    assert.equal(textAnswers("useCart returns lineItems, grandTotalCents and addItem.\n\nQUESTION: add a clear() too?", "grandTotalCents"), true)
  })

  it("textAnswers_false_whenTheTokenIsOnlyInTheOptionsUnderAQuestion", () => {
    for (const reply of [
      "QUESTION: which field do you mean?\n- grandTotalCents\n- totalCents",
      "QUESTION: which field do you mean?\n\n1. grandTotalCents\n2. totalCents",
      "1. QUESTION: do you mean grandTotalCents?",
    ]) {
      assert.equal(textAnswers(reply, "grandTotalCents"), false, reply)
      assert.equal(runPasses(ANSWER_CASE, facts({ text: reply })), false, reply)
    }
  })

  it("textAnswers_true_whenTheAnswerComesRightBeforeAFollowUpQuestion", () => {
    assert.equal(textAnswers("It returns grandTotalCents.\nQUESTION: want a clear() too?", "grandTotalCents"), true)
  })

  it("textAnswers_false_whenTheTokenIsOnlyInAQuestionLine", () => {
    assert.equal(textAnswers("QUESTION: do you mean grandTotalCents or totalCents?", "grandTotalCents"), false)
  })

  it("textAnswers_true_whenTokenIsInBackticksOrAnotherCase", () => {
    assert.equal(textAnswers("It returns `grandTotalCents` among others.", "grandTotalCents"), true)
    assert.equal(textAnswers("GRANDTOTALCENTS is the total.", "grandTotalCents"), true)
  })

  it("textAnswers_false_whenTokenOnlyInsideAFence", () => {
    assert.equal(textAnswers("The hook body:\n\n```ts\nreturn { grandTotalCents };\n```\n\nThat is all.", "grandTotalCents"), false)
  })

  it("textAnswers_false_whenNoFinalText", () => {
    assert.equal(textAnswers(null, "4317"), false)
  })
})

describe("question protocol", () => {
  it("claudeCommand_appendsTheQuestionProtocol_namingTheMarker", () => {
    const command = claudeCommand("m")
    assert.equal(command[command.indexOf("--append-system-prompt") + 1], QUESTION_PROTOCOL)
    assert.ok(QUESTION_PROTOCOL.includes("QUESTION:"))
    assert.equal(textAsks("QUESTION: which one?"), true)
  })
})

describe("ambiguous grade", () => {
  it("ambiguous_passes_whenAskToolCalledAndNothingChanged", () => assert.equal(runPasses(AMBIGUOUS_CASE, facts({ askCalls: 1 })), true))
  it("ambiguous_passes_whenAskToolDeniedAndNothingChanged", () => assert.equal(runPasses(AMBIGUOUS_CASE, facts({ denied: ["AskUserQuestion"] })), true))
  it("ambiguous_passes_whenFinalTextAsks_withoutTheAskTool", () => assert.equal(runPasses(AMBIGUOUS_CASE, facts({ text: "QUESTION: Which screen?" })), true))
  it("ambiguous_fails_whenAskedThenEdited", () => assert.equal(runPasses(AMBIGUOUS_CASE, facts({ askCalls: 1, changed: true })), false))
  it("ambiguous_fails_whenEditWasDenied_evenIfAsked", () => assert.equal(runPasses(AMBIGUOUS_CASE, facts({ askCalls: 1, denied: ["Edit"] })), false))
  it("ambiguous_fails_whenAnsweredWithoutAsking", () => assert.equal(runPasses(AMBIGUOUS_CASE, facts({ text: "I improved the dashboard." })), false))
  it("ambiguous_passes_onMaxTurns_whenAskToolCalled", () => {
    assert.equal(runPasses(AMBIGUOUS_CASE, facts({ askCalls: 1, subtype: MAX_TURNS, isError: true, exitCode: 1 })), true)
  })
  it("ambiguous_fails_onMaxTurns_withoutAskTool", () => {
    assert.equal(runPasses(AMBIGUOUS_CASE, facts({ text: "QUESTION: Which screen?", subtype: MAX_TURNS, isError: true, exitCode: 1 })), false)
  })
  it("ambiguous_ignoresLookupDenials", () => assert.equal(runPasses(AMBIGUOUS_CASE, facts({ askCalls: 1, denied: ["Read", "Grep"] })), true))
})

describe("clear change grade", () => {
  it("clearChange_passes_whenChangedWithoutAskTool", () => assert.equal(runPasses(CHANGE_CASE, facts({ changed: true })), true))
  it("clearChange_passes_whenChangedThenAskedInText", () => assert.equal(runPasses(CHANGE_CASE, facts({ changed: true, text: "Renamed it. Want a test too?" })), true))
  it("clearChange_fails_whenAskToolCalled_evenAfterTheEdit", () => assert.equal(runPasses(CHANGE_CASE, facts({ changed: true, askCalls: 1 })), false))
  it("clearChange_fails_whenAskToolDenied", () => assert.equal(runPasses(CHANGE_CASE, facts({ changed: true, denied: ["AskUserQuestion"] })), false))
  it("clearChange_fails_whenEditDeniedAndNothingChanged", () => assert.equal(runPasses(CHANGE_CASE, facts({ denied: ["Edit"] })), false))
  it("clearChange_passes_onMaxTurns_whenChanged", () => {
    assert.equal(runPasses(CHANGE_CASE, facts({ changed: true, subtype: MAX_TURNS, isError: true, exitCode: 1 })), true)
  })
})

describe("clear answer grade", () => {
  it("clearAnswer_passes_whenTokenAnsweredAndOfferFollows", () => {
    assert.equal(runPasses(ANSWER_CASE, facts({ text: "It returns grandTotalCents.\n\nShall I document it?" })), true)
  })
  it("clearAnswer_fails_whenQuestionEchoesTheToken", () => {
    assert.equal(runPasses(ANSWER_CASE, facts({ text: "QUESTION: Do you mean grandTotalCents?" })), false)
  })
  it("clearAnswer_fails_whenAnsweredButFilesChanged", () => {
    assert.equal(runPasses(ANSWER_CASE, facts({ text: "It returns grandTotalCents.", changed: true })), false)
  })
  it("clearAnswer_fails_whenAnsweredButEditDenied", () => {
    assert.equal(runPasses(ANSWER_CASE, facts({ text: "It returns grandTotalCents.", denied: ["Write"] })), false)
  })
  it("clearAnswer_fails_whenAskToolCalled", () => {
    assert.equal(runPasses(ANSWER_CASE, facts({ text: "It returns grandTotalCents.", askCalls: 1 })), false)
  })
  it("clearAnswer_fails_onMaxTurns_becauseThereIsNoFinalText", () => {
    assert.equal(runPasses(ANSWER_CASE, facts({ text: "It returns grandTotalCents.", subtype: MAX_TURNS, isError: true, exitCode: 1 })), false)
  })
})

describe("summarizeStream", () => {
  const assistant = (name: string, input: object, parent: string | null = null): string =>
    `{"type":"assistant","parent_tool_use_id":${parent ? `"${parent}"` : "null"},"message":{"content":[{"type":"tool_use","name":"${name}","input":${JSON.stringify(input)}}]}}`

  it("summarizeStream_countsAskCalls_inTheMainConversationOnly", () => {
    const summary = summarizeStream([assistant("AskUserQuestion", {}), assistant("AskUserQuestion", {}, "toolu_1")])
    assert.equal(summary.askCalls, 1)
  })

  it("summarizeStream_recordsBareSkillName_forPluginSpelling", () => {
    const summary = summarizeStream([assistant("Skill", { skill: "plug:prompt-refine" }), assistant("Read", { skill: "prompt-refine" })])
    assert.deepEqual(summary.skillCalls, ["prompt-refine"])
  })

  it("summarizeStream_skipsNonJsonLines", () => {
    const summary = summarizeStream(["[verbose] starting", assistant("AskUserQuestion", {}), ""])
    assert.equal(summary.askCalls, 1)
  })

  it("summarizeStream_keepsInitAndResultAndDeniedTools", () => {
    const lines = [
      '{"type":"system","subtype":"init","model":"m1"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","modelUsage":{"m1":{}},"permission_denials":[{"tool_name":"Edit"},{"tool_name":"Bash"}]}',
    ]
    const summary = summarizeStream(lines)
    assert.deepEqual([summary.init?.["model"], summary.result?.["result"], summary.deniedTools], ["m1", "ok", ["Edit", "Bash"]])
  })
})

describe("faultReason", () => {
  it("fault_whenTimedOut", () => assert.ok(faultReason(facts({ timedOut: true, noResult: true, exitCode: 124 }), TIMEOUT)?.includes("timed out")))
  it("fault_whenNoResultEvent", () => assert.equal(faultReason(facts({ noResult: true }), TIMEOUT), "no result event"))
  it("fault_whenLoggedOutShape_exitOneSuccessIsErrorEmptyModelUsage", () => {
    assert.ok(faultReason(facts({ exitCode: 1, isError: true, modelUsage: false, text: "Not logged in" }), TIMEOUT)?.includes("logged out"))
  })
  it("fault_whenOnlyIsErrorIsSetOnASuccessResult", () => {
    assert.equal(faultReason(facts({ isError: true }), TIMEOUT), "result has is_error with subtype success (logged out?)")
  })
  it("fault_whenModelUsageEmpty_evenWithACleanResult", () => assert.ok(faultReason(facts({ modelUsage: false }), TIMEOUT)?.includes("modelUsage")))
  it("fault_whenExitNonZero_withASuccessResult", () => assert.ok(faultReason(facts({ exitCode: 1 }), TIMEOUT)?.includes("exit 1")))
  it("noFault_whenExitNonZero_onMaxTurns", () => assert.equal(faultReason(facts({ exitCode: 1, subtype: MAX_TURNS, isError: true }), TIMEOUT), null))
  it("fault_whenAToolOutsideTheGradedSetIsDenied", () => assert.equal(faultReason(facts({ denied: ["Edit", "Bash"] }), TIMEOUT), "permission denied for Bash"))
  it("noFault_whenOnlyGradedOrLookupToolsAreDenied", () => {
    assert.equal(faultReason(facts({ denied: ["Edit", "Write", "AskUserQuestion", "Read", "Grep", "Glob"] }), TIMEOUT), null)
  })
  it("noFault_whenASkillCallIsDenied_soTheRunIsGradedOnWhatItDid", () => {
    const run = facts({ changed: true, denied: ["Skill"] })
    assert.deepEqual([faultReason(run, TIMEOUT), runPasses(CHANGE_CASE, run)], [null, true])
  })
  it("fault_whenAProjectDirectoryWasLeftBehind", () => {
    assert.ok(faultReason(facts({ leftover: "/cfg/projects/-tmp-x" }), TIMEOUT)?.includes("/cfg/projects/-tmp-x"))
  })
  it("noFault_onACleanRun", () => assert.equal(faultReason(facts(), TIMEOUT), null))
})

describe("graderCommit", () => {
  it("graderCommit_isHead_andMarkedDirty_onlyWhenMeasureEvalsDiffers", (t) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "keel-grader-test-"))
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
    const git = ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
    const run = (...args: string[]) => {
      const completed = spawnSync(git[0] as string, [...git.slice(1), ...args], { encoding: "utf8" })
      assert.equal(completed.status, 0, completed.stderr)
      return completed.stdout
    }
    fs.mkdirSync(path.join(repo, "measure", "evals"), { recursive: true })
    for (const name of ["measure/evals/grade.py", "README.md"]) fs.writeFileSync(path.join(repo, name), "v1\n")
    spawnSync("git", ["init", "-q", repo])
    run("add", "-A")
    run("commit", "-q", "-m", "init")
    const head = run("rev-parse", "HEAD").trim()
    fs.appendFileSync(path.join(repo, "README.md"), "outside the grader\n")
    const clean = graderCommit(repo)
    fs.appendFileSync(path.join(repo, "measure", "evals", "grade.py"), "v2\n")
    const dirty = graderCommit(repo)
    assert.deepEqual([clean, dirty], [head, head + "-dirty"])
  })
})

describe("verdicts", () => {
  it("passesNeeded_isTwoThirdsRoundedUp", () => {
    assert.deepEqual([1, 2, 3, 4, 6].map(passesNeeded), [1, 2, 2, 3, 4])
  })

  it("caseVerdict_passes_withTwoOfThreeRuns_andFailsWithOne", () => {
    assert.equal(new CaseVerdict(AMBIGUOUS_CASE, [true, false, true]).passed, true)
    assert.equal(new CaseVerdict(AMBIGUOUS_CASE, [true, false, false]).passed, false)
  })

  it("splitVerdict_fails_whenAnyClearCaseFails", () => {
    const verdicts = [new CaseVerdict(AMBIGUOUS_CASE, [true]), new CaseVerdict(CHANGE_CASE, [false]), new CaseVerdict(ANSWER_CASE, [true])]
    assert.equal(splitVerdict("train", verdicts).passed, false)
  })

  it("splitVerdict_passes_withTwoThirdsOfAmbiguousCases_andFailsBelow", () => {
    const ambiguous = [0, 1, 2].map((n) => new Case(`a${n}`, "train", AMBIGUOUS, "-", "p"))
    const withOutcomes = (outcomes: boolean[]) => [...ambiguous.map((c, index) => new CaseVerdict(c, [outcomes[index] as boolean])), new CaseVerdict(CHANGE_CASE, [true])]
    assert.equal(splitVerdict("train", withOutcomes([true, true, false])).passed, true)
    assert.equal(splitVerdict("train", withOutcomes([true, false, false])).passed, false)
  })

  it("splitVerdict_countsOnlyItsOwnSplit", () => {
    const holdout = new Case("h1", "holdout", CLEAR_CHANGE, "-", "p")
    const verdict = splitVerdict("holdout", [new CaseVerdict(CHANGE_CASE, [false]), new CaseVerdict(holdout, [true])])
    assert.deepEqual([verdict.cases, verdict.passedCases, verdict.passed], [1, 1, true])
  })

  it("suitePasses_onlyWhenBothSplitsPass", () => {
    const passing = splitVerdict("train", [new CaseVerdict(AMBIGUOUS_CASE, [true]), new CaseVerdict(CHANGE_CASE, [true])])
    const failing = splitVerdict("train", [new CaseVerdict(AMBIGUOUS_CASE, [false]), new CaseVerdict(CHANGE_CASE, [true])])
    assert.equal(suitePasses([passing, passing]), true)
    assert.equal(suitePasses([passing, failing]), false)
  })
})

describe("live config", () => {
  let root: string
  let keel: string
  let config: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-eval-cfg-")))
    keel = path.join(root, "keel")
    config = path.join(root, "config")
    fs.mkdirSync(path.join(keel, "skills", "prompt-refine"), { recursive: true })
    fs.mkdirSync(path.join(config, "skills"), { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const linkSkill = () => fs.symlinkSync(path.join(keel, "skills", "prompt-refine"), path.join(config, "skills", "prompt-refine"))
  const writeClaudeMd = (firstLine: string) => fs.writeFileSync(path.join(config, "CLAUDE.md"), firstLine + "\n# Principles\n")

  it("projectDirFor_slugsTheRealpath_withEveryNonAlphanumericAsDash", () => {
    const link = path.join(root, "work-link")
    fs.symlinkSync(keel, link)
    assert.equal(projectDirFor(link, "/cfg"), "/cfg/projects/" + keel.replaceAll("/", "-").replaceAll("_", "-").replaceAll(".", "-"))
  })

  it("projectDirFor_countsANonBmpCharacterOnce", () => {
    const astral = path.join(root, "café-\u{1F600}")
    fs.mkdirSync(astral)
    assert.equal(projectDirFor(astral, "/cfg"), "/cfg/projects/" + root.replaceAll(/[^A-Za-z0-9]/g, "-") + "-caf---")
  })

  it("isKeelLive_true_whenSkillLinkedIntoKeelAndClaudeMdGenerated", () => {
    linkSkill()
    writeClaudeMd(GENERATED_CLAUDE_MD_HEADER)
    assert.equal(isKeelLive(config, keel, "prompt-refine"), true)
  })

  it("isKeelLive_false_whenSkillIsARealDirectory", () => {
    fs.mkdirSync(path.join(config, "skills", "prompt-refine"))
    writeClaudeMd(GENERATED_CLAUDE_MD_HEADER)
    assert.equal(isKeelLive(config, keel, "prompt-refine"), false)
  })

  it("isKeelLive_false_whenClaudeMdIsNotGenerated", () => {
    linkSkill()
    writeClaudeMd("# My own CLAUDE.md")
    assert.equal(isKeelLive(config, keel, "prompt-refine"), false)
  })

  it("isKeelLive_false_whenTheHeaderLineEndsWithCarriageReturn", () => {
    linkSkill()
    fs.writeFileSync(path.join(config, "CLAUDE.md"), GENERATED_CLAUDE_MD_HEADER + "\r\n# Principles\n")
    assert.equal(isKeelLive(config, keel, "prompt-refine"), false)
  })

  it("isKeelLive_true_whenConfigDirAndKeelHomeAreReachedThroughSymlinks", () => {
    linkSkill()
    writeClaudeMd(GENERATED_CLAUDE_MD_HEADER)
    const configAlias = path.join(root, "dot-claude")
    const keelAlias = path.join(root, "keel-alias")
    fs.symlinkSync(config, configAlias)
    fs.symlinkSync(keel, keelAlias)
    assert.equal(isKeelLive(configAlias, keelAlias, "prompt-refine"), true)
  })

  it("suiteEvalId_addsBaselineSuffix_whenKeelIsNotLive", () => {
    assert.deepEqual([suiteEvalId("K4", true), suiteEvalId("K4", false)], ["K4", "K4-v1baseline"])
  })
})
