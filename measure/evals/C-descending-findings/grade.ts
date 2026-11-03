import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import { runGitOrThrow } from "../../lib/measurekit/gitutil.ts"
import { FIXTURE_TEST_SECONDS, inDetachedWorktree, testFailure } from "../lib/evalkit/fixturetests.ts"

const RULE_ID = "C-descending-findings"
const PLANT = "src/planted-call.js"
const VIOLATING_PLANT = 'export async function plantedItems() {\n  const response = await fetch("https://planted.example.invalid/items")\n  return response.json()\n}\n'
const SANCTIONED_PLANT = 'import { getJson } from "./http.js"\n\nexport async function plantedItems() {\n  return getJson("https://planted.example.invalid/items")\n}\n'
const CI_COMMAND = ["npm", "test"]

const { values } = parseArgs({ options: { repo: { type: "string" }, base: { type: "string" }, head: { type: "string" } } })
const repo = values.repo ?? "."
const head = values.head ?? "HEAD"

function plant(tree: string, text: string): void {
  fs.writeFileSync(path.join(tree, PLANT), text)
  runGitOrThrow(tree, ["add", PLANT])
}

const problems = await inDetachedWorktree(repo, head, async (tree) => {
  const found: string[] = []
  const atHead = await testFailure(tree, CI_COMMAND, FIXTURE_TEST_SECONDS)
  if (atHead !== null) found.push(`tests fail at head: ${atHead}`)
  plant(tree, SANCTIONED_PLANT)
  const withSanctioned = await testFailure(tree, CI_COMMAND, FIXTURE_TEST_SECONDS)
  if (withSanctioned !== null) found.push(`tests fail with a planted getJson call in ${PLANT}: ${withSanctioned}`)
  plant(tree, VIOLATING_PLANT)
  if ((await testFailure(tree, CI_COMMAND, FIXTURE_TEST_SECONDS)) === null) found.push(`tests pass with a planted global fetch call in ${PLANT}`)
  return found
})
for (const problem of problems) console.log(`signal ${RULE_ID} -: ${problem}`)
console.log(`summary problems=${problems.length}`)
