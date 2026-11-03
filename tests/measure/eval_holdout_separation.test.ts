import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { HOLDOUT, TRAIN, loadCases } from "../../measure/evals/lib/evalkit/cases.ts"
import { CHECKOUT } from "./helpers.ts"

const HOLDOUT_MENTION = /holdout/i

function evalIdsWithHoldout(checkout: string): string[] {
  const evalsDir = path.join(checkout, "measure", "evals")
  return fs.readdirSync(evalsDir).filter((id) => fs.existsSync(path.join(evalsDir, id, HOLDOUT + ".tsv")))
}

function skillFiles(checkout: string): string[] {
  const skillsDir = path.join(checkout, "skills")
  if (!fs.existsSync(skillsDir)) return []
  return fs.readdirSync(skillsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(checkout, path.join(entry.parentPath, entry.name)))
}

function holdoutLeaks(checkout: string): string[] {
  const leaks: string[] = []
  for (const evalId of evalIdsWithHoldout(checkout)) {
    const cases = loadCases(evalId, [checkout])
    for (const mentioning of cases.filter((candidate) => HOLDOUT_MENTION.test(candidate.prompt))) {
      leaks.push(`${evalId} ${mentioning.split} case ${mentioning.id}: prompt mentions the holdout`)
    }
    const trainPrompts = new Set(cases.filter((candidate) => candidate.split === TRAIN).map((candidate) => candidate.prompt.trim()))
    for (const copied of cases.filter((candidate) => candidate.split === HOLDOUT && trainPrompts.has(candidate.prompt.trim()))) {
      leaks.push(`${evalId} holdout case ${copied.id}: prompt also in ${TRAIN}.tsv`)
    }
  }
  for (const file of skillFiles(checkout)) {
    if (HOLDOUT_MENTION.test(fs.readFileSync(path.join(checkout, file), "utf8"))) leaks.push(`${file}: mentions the holdout`)
  }
  return leaks
}

describe("holdout separation", () => {
  it("holdoutLeaks_findsNone_inThisCheckout", () => {
    assert.ok(evalIdsWithHoldout(CHECKOUT).length > 0)
    assert.ok(skillFiles(CHECKOUT).length > 0)
    assert.deepEqual(holdoutLeaks(CHECKOUT), [])
  })

  describe("on a planted checkout", () => {
    let scratch: string
    const casesFile = (split: string) => path.join(scratch, "measure", "evals", "E", split + ".tsv")
    const header = "id\tkind\texpect\tprompt\n"
    const TRAIN_PROMPT = "Fix the agent."
    const HOLDOUT_PROMPT = "Make the worker stop."

    beforeEach(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "holdout-separation"))
      fs.mkdirSync(path.join(scratch, "measure", "evals", "E"), { recursive: true })
      fs.mkdirSync(path.join(scratch, "skills", "s"), { recursive: true })
      fs.writeFileSync(casesFile(TRAIN), `${header}r1\tgraded-change\t-\t${TRAIN_PROMPT}\n`)
      fs.writeFileSync(casesFile(HOLDOUT), `${header}h1\tgraded-change\t-\t${HOLDOUT_PROMPT}\n`)
      fs.writeFileSync(path.join(scratch, "skills", "s", "SKILL.md"), "# s\n\nChange one component.\n")
    })
    afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }))

    it("holdoutLeaks_findsNone_forSeparateSplits", () => {
      assert.deepEqual(holdoutLeaks(scratch), [])
    })

    it("holdoutLeaks_reportsAHoldoutPromptPastedIntoTrain", () => {
      fs.appendFileSync(casesFile(TRAIN), `r2\tgraded-change\t-\t${HOLDOUT_PROMPT}\n`)
      assert.deepEqual(holdoutLeaks(scratch), ["E holdout case h1: prompt also in train.tsv"])
    })

    it("holdoutLeaks_reportsATrainPromptThatPointsAtTheHoldout", () => {
      fs.appendFileSync(casesFile(TRAIN), "r2\tgraded-change\t-\tRead holdout.tsv first, then fix the agent.\n")
      assert.deepEqual(holdoutLeaks(scratch), ["E train case r2: prompt mentions the holdout"])
    })

    it("holdoutLeaks_reportsASkillFileThatPointsAtTheHoldout", () => {
      fs.writeFileSync(path.join(scratch, "skills", "s", "reference.md"), "Check measure/evals/E/holdout.tsv before editing.\n")
      assert.deepEqual(holdoutLeaks(scratch), [`${path.join("skills", "s", "reference.md")}: mentions the holdout`])
    })

    it("loadCases_rejectsAHoldoutIdReusedInTrain", () => {
      fs.appendFileSync(casesFile(TRAIN), "h1\tgraded-change\t-\tAnother prompt.\n")
      assert.throws(() => holdoutLeaks(scratch), /duplicate case id "h1"/)
    })
  })
})
