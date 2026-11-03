import { parseArgs } from "node:util"

import { runGitOrThrow } from "../../lib/measurekit/gitutil.ts"

const RULE_ID = "C-improving-agents"
const AGENT_FILE = /^agents\/[^/]+\.md$/
const EVIDENCE_DIR = "runs/"
const OUTPUT_SECTION = "section Output"

const { values } = parseArgs({ options: { repo: { type: "string" }, base: { type: "string" }, head: { type: "string" } } })
const repo = values.repo ?? "."
const base = values.base ?? "HEAD~1"
const head = values.head ?? "HEAD"

function partsOf(text: string): Map<string, string> {
  const parts = new Map<string, string>()
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)
  for (const line of (frontmatter?.[1] ?? "").split("\n")) {
    const field = /^([A-Za-z-]+):(.*)$/.exec(line)
    if (field !== null) parts.set(`frontmatter ${field[1]}`, (field[2] ?? "").trim())
  }
  const [intro = "", ...sections] = text.slice(frontmatter?.[0].length ?? 0).split(/^## /m)
  parts.set("intro", intro.trim())
  for (const section of sections) {
    const [heading = "", ...body] = section.split("\n")
    parts.set(`section ${heading.trim()}`, body.join("\n").trim())
  }
  return parts
}

function changedParts(file: string, status: string): string[] {
  if (status === "A") return [file]
  const before = partsOf(runGitOrThrow(repo, ["show", `${base}:${file}`]))
  const after = status === "D" ? new Map<string, string>() : partsOf(runGitOrThrow(repo, ["show", `${head}:${file}`]))
  return [...new Set([...before.keys(), ...after.keys()])].filter((part) => before.get(part) !== after.get(part)).map((part) => `${file} ${part}`)
}

const changes = runGitOrThrow(repo, ["diff", "-z", "--name-status", "--no-renames", base, head]).split("\0").filter((field) => field !== "")
const components: string[] = []
let leverTouched = false
for (let index = 0; index < changes.length; index += 2) {
  const status = changes[index] ?? ""
  const file = changes[index + 1] ?? ""
  if (file.startsWith(EVIDENCE_DIR)) continue
  const changed = AGENT_FILE.test(file) ? changedParts(file, status) : [file]
  if (status === "A" || (AGENT_FILE.test(file) && changed.length > 0)) leverTouched = true
  components.push(...changed)
}
const problems: string[] = []
if (!leverTouched) problems.push("no agent definition part changed and no file added")
if (components.length > 1) problems.push(`candidate changes more than one component: ${components.join(", ")}`)
for (const component of components.filter((part) => part.endsWith(` ${OUTPUT_SECTION}`))) problems.push(`the deliverable's shape changed: ${component}`)
for (const problem of problems) console.log(`signal ${RULE_ID} -: ${problem}`)
console.log(`summary components=${components.length} problems=${problems.length}`)
