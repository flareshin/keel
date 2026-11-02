import path from "node:path"
import { parseArgs } from "node:util"

import { runGitOrThrow } from "../../lib/measurekit/gitutil.ts"

const RULE_ID = "C-authoring-agents"
const AGENT_FILE = /(^|\/)agents\/[^/]+\.md$/
const REVIEW_ROLE = /review|verif/i
const RULED_OUT_CLAUSE = /^(not|do not|don't|never)\b/i
const LIST_ITEM = /^\s+-\s+(.+)$/

const { values } = parseArgs({ options: { repo: { type: "string" }, base: { type: "string" }, head: { type: "string" } } })
const repo = values.repo ?? "."
const base = values.base ?? "HEAD~1"
const head = values.head ?? "HEAD"

function frontmatterOf(text: string): Map<string, string> | null {
  const match = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text)
  if (match === null) return null
  const [, block = ""] = match
  const fields = new Map<string, string>()
  let listKey = ""
  for (const line of block.split("\n")) {
    const item = LIST_ITEM.exec(line)
    if (item !== null && listKey !== "") {
      const [, entry = ""] = item
      const listed = fields.get(listKey) ?? ""
      fields.set(listKey, listed === "" ? entry.trim() : `${listed}, ${entry.trim()}`)
      continue
    }
    const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (field === null) continue
    const [, key = "", value = ""] = field
    fields.set(key, unquoted(value.trim()))
    listKey = value.trim() === "" ? key : ""
  }
  return fields
}

function unquoted(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value)
  return quoted === null ? value : (quoted[2] ?? "")
}

function namesReviewRole(name: string, description: string): boolean {
  const clauses = description.split(/[.;,]/).map((clause) => clause.trim())
  return REVIEW_ROLE.test(name) || clauses.some((clause) => !RULED_OUT_CLAUSE.test(clause) && REVIEW_ROLE.test(clause))
}

function problemsOf(file: string, text: string): string[] {
  const fields = frontmatterOf(text)
  if (fields === null) return ["no frontmatter"]
  const problems: string[] = []
  const name = fields.get("name") ?? ""
  const description = fields.get("description") ?? ""
  if (name !== path.basename(file, ".md")) problems.push(`name "${name}" is not the file name`)
  if (description === "") problems.push("no description")
  if ((fields.get("tools") ?? "") === "") problems.push("no tools list")
  if (fields.has("model") && namesReviewRole(name, description)) problems.push("a reviewer or verifier pins model")
  return problems
}

const changedFiles = runGitOrThrow(repo, ["diff", "-z", "--name-only", "--diff-filter=AMR", base, head]).split("\0").filter((file) => file !== "")
const agentFiles = changedFiles.filter((file) => AGENT_FILE.test(file))
let problemCount = 0
if (agentFiles.length === 0) {
  problemCount += 1
  console.log(`signal ${RULE_ID} -: no agents/<name>.md file changed`)
}
for (const file of agentFiles) {
  for (const problem of problemsOf(file, runGitOrThrow(repo, ["show", `${head}:${file}`]))) {
    problemCount += 1
    console.log(`signal ${RULE_ID} ${file}: ${problem}`)
  }
}
console.log(`summary agents=${agentFiles.length} problems=${problemCount}`)
