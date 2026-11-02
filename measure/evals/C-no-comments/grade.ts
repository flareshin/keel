#!/usr/bin/env node
import { parseArgs } from "node:util"

import { addedComments } from "../../../hooks/git-guard/comments.ts"
import { runGitOrThrow } from "../../lib/measurekit/gitutil.ts"

const RULE_ID = "C-no-comments"

const { values } = parseArgs({ options: { repo: { type: "string" }, base: { type: "string" }, head: { type: "string" } } })
const repo = values.repo ?? "."
const base = values.base ?? "HEAD~1"
const head = values.head ?? "HEAD"

const changedFiles = runGitOrThrow(repo, ["diff", "--name-only", "--diff-filter=AMR", base, head]).split("\n").filter((file) => file !== "")
let remaining = 0
for (const file of changedFiles) {
  for (const comment of addedComments(file, "", runGitOrThrow(repo, ["show", `${head}:${file}`]))) {
    remaining += 1
    console.log(`signal ${RULE_ID} ${file}: ${comment}`)
  }
}
console.log(`summary files=${changedFiles.length} comments=${remaining}`)
