import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { describe, it } from "node:test"
import path from "node:path"

import { GENERATED_CLAUDE_MD_HEADER } from "../../measure/evals/lib/evalkit/liveconfig.ts"
import { REFINED_REQUEST_HEADER } from "../../measure/evals/lib/evalkit/grade.ts"
import { RULES_HEADING_PATTERN } from "../../measure/lib/measurekit/smoke_files.ts"
import { GENERATED_HEADER } from "./eval_helpers.ts"
import { CHECKOUT, readText } from "./helpers.ts"

const LITERAL_EVAL = "import ast, sys\ntree = ast.parse(open(sys.argv[1], encoding='utf-8').read())\n" +
  "for node in tree.body:\n" +
  "    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == sys.argv[2] for t in node.targets):\n" +
  "        sys.stdout.write(ast.literal_eval(node.value))\n        sys.exit(0)\nsys.exit(3)\n"
const PROMPT_REFINE_SKILL = "skills/prompt-refine/SKILL.md"

function pythonStringConstant(relativePath: string, name: string): string {
  const completed = spawnSync("python3", ["-I", "-c", LITERAL_EVAL, path.join(CHECKOUT, relativePath), name], { encoding: "utf8" })
  if (completed.status !== 0) throw new Error(`${relativePath} defines no ${name}`)
  return completed.stdout
}

describe("shared copies", () => {
  it("generatedClaudeMdHeader_equalsLinkHeader_inEveryCopy", () => {
    const source = pythonStringConstant("lib/link/claude_md.py", "HEADER")
    const copies = {
      "measure/evals/lib/evalkit/liveconfig.ts": GENERATED_CLAUDE_MD_HEADER,
      "tests/measure/eval_helpers.ts": GENERATED_HEADER,
      "tests/skills/helpers.py": pythonStringConstant("tests/skills/helpers.py", "GENERATED_HEADER"),
    }
    assert.deepEqual(copies, Object.fromEntries(Object.keys(copies).map((copyPath) => [copyPath, source])))
  })

  it("refinedRequestHeader_isAHeadingInThePromptRefineSkill", () => {
    const lines = readText(path.join(CHECKOUT, PROMPT_REFINE_SKILL)).split("\n").map((line) => line.trim())
    assert.ok(lines.includes("## " + REFINED_REQUEST_HEADER))
  })

  it("pythonStringConstant_throws_whenTheNameIsMissing", () => {
    assert.throws(() => pythonStringConstant("lib/link/claude_md.py", "NO_SUCH_NAME"), /defines no NO_SUCH_NAME/)
  })

  it("rulesHeadingPattern_ofTheSkillsTests_equalsSmoke", () => {
    assert.equal(pythonStringConstant("tests/skills/helpers.py", "RULES_HEADING_PATTERN"), RULES_HEADING_PATTERN)
  })

  it("rulesHeadingPattern_ofTheStillPythonSmoke_equalsTheTypeScriptSmoke", () => {
    assert.equal(pythonStringConstant("measure/lib/measurekit/smoke_files.py", "RULES_HEADING_PATTERN"), RULES_HEADING_PATTERN)
  })
})
