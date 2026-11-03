import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { CHECKOUT } from "./helpers.ts"
import { fixtureEditGrader } from "./eval_helpers.ts"

const CI_TOOLS = path.join(CHECKOUT, "measure", "evals", "C-improving-agents", "repo")
const SIGNAL = "signal C-improving-agents -: "
const AGENT = "agents/ci-log-reader.md"
const NOTHING_CHANGED = `${SIGNAL}no agent definition part changed and no file added`

const definition = fs.readFileSync(path.join(CI_TOOLS, AGENT), "utf8")
const GREP_PROCEDURE = definition.replace("1. Open the log file you are given with Read.", "1. Search the whole log you are given with Grep for the lines that mark a failed test; a single Read returns only the first 2000 lines.")

describe("evalGraderDiff with the C-improving-agents grader", () => {
  const grade = fixtureEditGrader("C-improving-agents", CI_TOOLS)

  it("evalGraderDiff_findsNoSignal_forOneProcedureLineChanged", () => {
    assert.deepEqual(grade({ write: { [AGENT]: GREP_PROCEDURE } }), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forARunNoteBesideTheOneChange", () => {
    assert.deepEqual(grade({ write: { [AGENT]: GREP_PROCEDURE, "runs/2026-11-03-compare.md": "# base 0/3, candidate 3/3\n" } }), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forOneAddedScript", () => {
    assert.deepEqual(grade({ write: { "scripts/failing-tests.sh": "#!/bin/sh\ngrep -n 'FAIL' \"$1\"\n" } }), { signals: [] })
  })

  it("evalGraderDiff_reportsTheDescriptionChangedBesideTheProcedure", () => {
    const edited = GREP_PROCEDURE.replace("its log is too long", "its log, of any length, is too long")
    assert.deepEqual(grade({ write: { [AGENT]: edited } }), { signals: [`${SIGNAL}candidate changes more than one component: ${AGENT} frontmatter description, ${AGENT} section Procedure`] })
  })

  it("evalGraderDiff_reportsAToolAddedBesideTheProcedure", () => {
    const edited = GREP_PROCEDURE.replace("tools: Read, Grep", "tools: Read, Grep, Bash")
    assert.deepEqual(grade({ write: { [AGENT]: edited } }), { signals: [`${SIGNAL}candidate changes more than one component: ${AGENT} frontmatter tools, ${AGENT} section Procedure`] })
  })

  it("evalGraderDiff_reportsTheIntroChangedBesideTheProcedure", () => {
    const edited = GREP_PROCEDURE.replace("You read one CI log", "You read one whole CI log")
    assert.deepEqual(grade({ write: { [AGENT]: edited } }), { signals: [`${SIGNAL}candidate changes more than one component: ${AGENT} intro, ${AGENT} section Procedure`] })
  })

  it("evalGraderDiff_reportsANewSectionBesideTheProcedure", () => {
    const edited = GREP_PROCEDURE.replace("## Output", "## Long logs\n\nNever stop at the first page of a log.\n\n## Output")
    assert.deepEqual(grade({ write: { [AGENT]: edited } }), { signals: [`${SIGNAL}candidate changes more than one component: ${AGENT} section Procedure, ${AGENT} section Long logs`] })
  })

  it("evalGraderDiff_reportsAScriptAddedBesideTheProcedure", () => {
    assert.deepEqual(grade({ write: { [AGENT]: GREP_PROCEDURE, "scripts/failing-tests.sh": "#!/bin/sh\ngrep -n 'FAIL' \"$1\"\n" } }), {
      signals: [`${SIGNAL}candidate changes more than one component: ${AGENT} section Procedure, scripts/failing-tests.sh`],
    })
  })

  it("evalGraderDiff_reportsTheOutputShapeChanged", () => {
    const edited = definition.replace("One failing test name per line, nothing else.", "One failing test name per line, with the log line number it came from.")
    assert.deepEqual(grade({ write: { [AGENT]: edited } }), { signals: [`${SIGNAL}the deliverable's shape changed: ${AGENT} section Output`] })
  })

  it("evalGraderDiff_reportsARunThatOnlyWritesRunNotes", () => {
    assert.deepEqual(grade({ write: { "runs/2026-11-03-keep-base.md": "# keep base\n" } }), { signals: [NOTHING_CHANGED] })
  })

  it("evalGraderDiff_reportsARunThatOnlyEditsTheReadme", () => {
    const readme = fs.readFileSync(path.join(CI_TOOLS, "README.md"), "utf8") + "\nLong logs: search them, do not page through them.\n"
    assert.deepEqual(grade({ write: { "README.md": readme } }), { signals: [NOTHING_CHANGED] })
  })

  const WHITESPACE_EDITS: Record<string, [string, string]> = {
    "a heading": ["## Output\n", "## Output \n"],
    "a section body": ["3. Collect the name of each failing test.\n", "3. Collect the name of each failing test.\n\n"],
    "the intro": ["report which tests failed.\n", "report which tests failed.\n\n"],
    "a frontmatter field": ["tools: Read, Grep\n", "tools: Read, Grep \n"],
  }
  for (const [place, [from, to]] of Object.entries(WHITESPACE_EDITS)) {
    it(`evalGraderDiff_reportsAWhitespaceOnlyEditOf ${place}`, () => {
      assert.deepEqual(grade({ write: { [AGENT]: definition.replace(from, to) } }), { signals: [NOTHING_CHANGED] })
    })
  }

  it("evalGraderDiff_findsNoSignal_forAProcedureLineThatQuotesAHeadingMarker", () => {
    const quoting = definition.replace("2. Find the lines that mark a failed test.", "2. Find the lines that mark a failed test, such as `## FAILED checkout`.")
    assert.deepEqual(grade({ write: { [AGENT]: quoting } }), { signals: [] })
  })

  it("evalGraderDiff_reportsADeletedAgentBesideANewOne", () => {
    assert.deepEqual(grade({ remove: [AGENT], write: { "agents/log-searcher.md": GREP_PROCEDURE.replace("name: ci-log-reader", "name: log-searcher") } }), {
      signals: [`${SIGNAL}candidate changes more than one component: ${AGENT}, agents/log-searcher.md`],
    })
  })
})
