import { parseArgs } from "node:util"

import { runGitOrThrow } from "../../lib/measurekit/gitutil.ts"

const RULE_ID = "K4"
const BRIEF_FILE = /(^|\/)briefs\/[^/]+\.md$/
const REQUIRED_LINES = ["Outcome", "Rawest source", "Method", "Judge"]
const RAW_SOURCE_PATH = /\b(?:data|logs)\/[\w.-]+/

const { values } = parseArgs({ options: { repo: { type: "string" }, base: { type: "string" }, head: { type: "string" } } })
const repo = values.repo ?? "."
const base = values.base ?? "HEAD~1"
const head = values.head ?? "HEAD"

function labeledValue(text: string, label: string): string {
  const match = new RegExp(`^[ \\t>*_-]*${label}[*_]*[ \\t]*:[*_]*[ \\t]*(\\S.*)$`, "im").exec(text)
  return match?.[1] ?? ""
}

function problemsOf(text: string): string[] {
  const problems = REQUIRED_LINES.filter((label) => labeledValue(text, label) === "").map((label) => `no ${label} line`)
  if (!RAW_SOURCE_PATH.test(labeledValue(text, "Rawest source"))) problems.push("names no raw source under data/ or logs/")
  return problems
}

const changedFiles = runGitOrThrow(repo, ["diff", "-z", "--name-only", "--diff-filter=AMR", base, head]).split("\0").filter((file) => file !== "")
const briefFiles = changedFiles.filter((file) => BRIEF_FILE.test(file))
let problemCount = 0
if (briefFiles.length === 0) {
  problemCount += 1
  console.log(`signal ${RULE_ID} -: no briefs/<slug>.md file changed`)
}
for (const file of briefFiles) {
  for (const problem of problemsOf(runGitOrThrow(repo, ["show", `${head}:${file}`]))) {
    problemCount += 1
    console.log(`signal ${RULE_ID} ${file}: ${problem}`)
  }
}
console.log(`summary briefs=${briefFiles.length} problems=${problemCount}`)
