import { parseArgs } from "node:util"

import { diffStats } from "../../../lib/evidence/gitcmd.ts"
import { runGitOrThrow } from "../../lib/measurekit/gitutil.ts"
import { FIXTURE_TEST_SECONDS, inDetachedWorktree, testFailure } from "../lib/evalkit/fixturetests.ts"

const RULE_ID = "C-improving-structure"
const CANDIDATE_AREAS: Record<string, string[]> = {
  "pricing-service pass-through": ["src/pricing-service.js", "src/receipt.js", "src/report.js"],
  "unused legacy discount": ["src/money.js"],
  "single-adapter tax seam": ["src/tax-provider-factory.js", "src/flat-tax.js", "src/pricing.js"],
}
const TEST_CASE = /^\s*(?:test|it)\(/gm

const { values } = parseArgs({ options: { repo: { type: "string" }, base: { type: "string" }, head: { type: "string" } } })
const repo = values.repo ?? "."
const base = values.base ?? "HEAD~1"
const head = values.head ?? "HEAD"

function testCaseCount(ref: string): number {
  const files = runGitOrThrow(repo, ["ls-tree", "-r", "-z", "--name-only", ref]).split("\0").filter((file) => file !== "")
  return files.reduce((sum, file) => sum + (runGitOrThrow(repo, ["show", `${ref}:${file}`]).match(TEST_CASE) ?? []).length, 0)
}

function sourceLineGrowth(): number {
  return [...diffStats(repo, base, head)]
    .filter(([file]) => file.startsWith("src/"))
    .reduce((sum, [, stat]) => sum + stat.added - stat.deleted, 0)
}

const changedSources = runGitOrThrow(repo, ["diff", "-z", "--name-only", base, head, "--", "src"]).split("\0").filter((file) => file !== "")
const touchedAreas = Object.entries(CANDIDATE_AREAS)
  .filter(([, files]) => files.some((file) => changedSources.includes(file)))
  .map(([area]) => area)
const problems: string[] = []
if (changedSources.length === 0) problems.push("no source file changed")
if (touchedAreas.length > 1) problems.push(`one diff changes more than one candidate: ${touchedAreas.join(", ")}`)
const growth = sourceLineGrowth()
if (growth > 0) problems.push(`source line count grows by ${growth}`)
const testsBefore = testCaseCount(base)
const testsAfter = testCaseCount(head)
if (testsAfter < testsBefore) problems.push(`test cases drop from ${testsBefore} to ${testsAfter}`)
const failure = await inDetachedWorktree(repo, head, (tree) => testFailure(tree, [process.execPath, "--test"], FIXTURE_TEST_SECONDS))
if (failure !== null) problems.push(`tests fail at head: ${failure}`)
for (const problem of problems) console.log(`signal ${RULE_ID} -: ${problem}`)
console.log(`summary sources=${changedSources.length} areas=${touchedAreas.length} problems=${problems.length}`)
