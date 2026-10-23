import assert from "node:assert/strict"
import { describe, it } from "node:test"
import path from "node:path"

import { HEADER } from "../../lib/link/claude_md.ts"
import { GENERATED_CLAUDE_MD_HEADER } from "../../measure/evals/lib/evalkit/liveconfig.ts"
import { REFINED_REQUEST_HEADER } from "../../measure/evals/lib/evalkit/grade.ts"
import { GENERATED_HEADER as SKILLS_GENERATED_HEADER } from "../skills/helpers.ts"
import { GENERATED_HEADER } from "./eval_helpers.ts"
import { CHECKOUT, readText } from "./helpers.ts"

const PROMPT_REFINE_SKILL = "skills/prompt-refine/SKILL.md"

describe("shared copies", () => {
  it("generatedClaudeMdHeader_equalsLinkHeader_inEveryCopy", () => {
    const source = HEADER
    const copies = {
      "measure/evals/lib/evalkit/liveconfig.ts": GENERATED_CLAUDE_MD_HEADER,
      "tests/measure/eval_helpers.ts": GENERATED_HEADER,
      "tests/skills/helpers.ts": SKILLS_GENERATED_HEADER,
    }
    assert.deepEqual(copies, Object.fromEntries(Object.keys(copies).map((copyPath) => [copyPath, source])))
  })

  it("refinedRequestHeader_isAHeadingInThePromptRefineSkill", () => {
    const lines = readText(path.join(CHECKOUT, PROMPT_REFINE_SKILL)).split("\n").map((line) => line.trim())
    assert.ok(lines.includes("## " + REFINED_REQUEST_HEADER))
  })
})
