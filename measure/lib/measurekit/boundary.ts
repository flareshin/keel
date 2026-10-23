import fs from "node:fs"

import { dataLines, readTsvRecords, TsvError } from "./datafiles.ts"
import { CHECKOUT_ROOT } from "./env.ts"
import { GitError, runGit } from "./gitutil.ts"
import { decodeReplacing } from "./pyio.ts"
import { isDir, isFile, isLink, pyJoin, pyRelpath, pyNormpath, walk } from "./pypath.ts"
import { compilePythonRegex, PyRegexError } from "./pyregex.ts"
import { pySplitlines, pySplitWhitespace, pyStrip, sortedByCodePoint } from "./pystr.ts"
import { isOsError } from "./pyerrors.ts"
import { pyRepr } from "./pyvalue.ts"

const GENERIC_RULES_PATH = pyJoin(CHECKOUT_ROOT, "measure", "boundary-generic.tsv")
const ZERO_SHA_PATTERN = /^0+$/
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const DIFF_ARGS = ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames"]
const CHANGED_NAMES_ARGS = ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=d"]
const PATH_NAME_LINE = 0

export type ScanLine = [string, number, string]

export class BoundaryUsageError extends Error {}

export interface Rule {
  name: string
  matches: (text: string) => boolean
}

export interface Hit {
  file: string
  line: number
  rule: string
}

export function loadRules(overlayDir: string, genericOnly: boolean): Rule[] {
  const rules = genericRules()
  if (genericOnly) return rules
  const lexiconPath = pyJoin(overlayDir, "boundary", "lexicon.txt")
  if (!isFile(lexiconPath)) {
    throw new BoundaryUsageError(`overlay lexicon missing: ${lexiconPath} (set KEEL_OVERLAY_DIR or pass --generic-only)`)
  }
  const lexiconRules = dataLines(lexiconPath).map(([number, term]) => lexiconRule(`lexicon:${number}`, term))
  if (lexiconRules.length === 0) {
    throw new BoundaryUsageError(`overlay lexicon has no terms: ${lexiconPath}; an empty lexicon would pass every private term`)
  }
  rules.push(...lexiconRules)
  const regexPath = pyJoin(overlayDir, "boundary", "regex.txt")
  if (isFile(regexPath)) rules.push(...dataLines(regexPath).map(([number, pattern]) => regexRule(`regex:${number}`, pattern)))
  return rules
}

function genericRules(): Rule[] {
  let records: Record<string, string>[]
  try {
    records = readTsvRecords(GENERIC_RULES_PATH, ["name", "regex"])
  } catch (error) {
    if (error instanceof TsvError || isOsError(error)) throw new BoundaryUsageError(`generic rules unreadable: ${(error as Error).message}`)
    throw error
  }
  return records.map((record) => regexRule("generic:" + record["name"], record["regex"] as string))
}

function lexiconRule(name: string, term: string): Rule {
  const lowered = term.toLowerCase()
  return { name, matches: (text) => text.toLowerCase().includes(lowered) }
}

function regexRule(name: string, pattern: string): Rule {
  let compiled: RegExp
  try {
    compiled = compilePythonRegex(pattern)
  } catch (error) {
    if (error instanceof PyRegexError) throw new BoundaryUsageError(`rule ${name} has an invalid regex: ${error.message}`)
    throw error
  }
  return { name, matches: (text) => compiled.test(text) }
}

export function scan(lines: Iterable<ScanLine>, rules: Rule[]): { scanned: number; hits: Hit[] } {
  let scanned = 0
  const hits: Hit[] = []
  for (const [file, line, text] of lines) {
    scanned++
    for (const rule of rules) if (rule.matches(text)) hits.push({ file, line, rule: rule.name })
  }
  return { scanned, hits }
}

export function* fileLines(root: string, relativePaths: Iterable<string>): Generator<ScanLine> {
  for (const relativePath of relativePaths) {
    const fullPath = pyJoin(root, relativePath)
    if (isDir(fullPath) && !isLink(fullPath)) {
      yield* fileLines(root, directoryFiles(root, fullPath))
      continue
    }
    yield [relativePath, PATH_NAME_LINE, relativePath]
    yield* splitlinesOfFile(relativePath, fullPath)
  }
}

function directoryFiles(root: string, directory: string): string[] {
  let tracked: string[]
  try {
    tracked = runGit(directory, ["ls-files", "-z"]).split("\0")
  } catch (error) {
    if (error instanceof GitError) return walkWithoutGit(root, directory)
    throw error
  }
  const members = tracked.filter((name) => name !== "").map((name) => pyNormpath(pyJoin(directory, name)))
  const found = members.filter((member) => member !== pyNormpath(directory)).map((member) => pyRelpath(member, root))
  if (found.length === 0 && walkWithoutGit(root, directory).length > 0) {
    throw new BoundaryUsageError(`${directory} holds no tracked file; stage its files or name them`)
  }
  return found
}

function walkWithoutGit(root: string, directory: string): string[] {
  const found: string[] = []
  for (const entry of walk(directory, new Set([".git"]))) {
    for (const name of entry.fileNames) if (name !== ".git") found.push(pyRelpath(pyJoin(entry.current, name), root))
  }
  return sortedByCodePoint(found)
}

function* splitlinesOfFile(label: string, fullPath: string): Generator<ScanLine> {
  if (isLink(fullPath) || !isFile(fullPath)) return
  const content = fs.readFileSync(fullPath)
  if (content.includes(0)) return
  let number = 1
  for (const line of pySplitlines(decodeReplacing(content))) yield [label, number++, line]
}

export function* stagedLines(repo: string): Generator<ScanLine> {
  yield* diffLines(repo, ["--cached"], "")
}

export function* rangeLines(repo: string, commitRange: string): Generator<ScanLine> {
  for (const commit of commitsInRange(repo, commitRange)) {
    const short = commit.slice(0, 12)
    const message = runGit(repo, ["log", "-1", "--format=%B", commit])
    let number = 1
    for (const line of pySplitlines(message)) yield [`${short}:message`, number++, line]
    yield* diffLines(repo, [firstParent(repo, commit), commit], short + ":")
  }
}

function* diffLines(repo: string, diffTarget: string[], labelPrefix: string): Generator<ScanLine> {
  for (const name of runGit(repo, [...CHANGED_NAMES_ARGS, ...diffTarget]).split("\0")) {
    if (name !== "") yield [labelPrefix + name, PATH_NAME_LINE, name]
  }
  yield* addedLines(runGit(repo, [...DIFF_ARGS, ...diffTarget]), labelPrefix)
}

function commitsInRange(repo: string, commitRange: string): string[] {
  const separatorAt = commitRange.indexOf("..")
  const old = separatorAt < 0 ? commitRange : commitRange.slice(0, separatorAt)
  const next = separatorAt < 0 ? "" : commitRange.slice(separatorAt + 2)
  if (separatorAt < 0 || old === "" || next === "" || next.startsWith(".")) {
    throw new BoundaryUsageError(`--range takes <old>..<new>, got ${pyRepr(commitRange)}`)
  }
  if (ZERO_SHA_PATTERN.test(old)) return pySplitWhitespace(runGit(repo, ["rev-list", "--reverse", next, "--not", "--remotes"]))
  return pySplitWhitespace(runGit(repo, ["rev-list", "--reverse", `${old}..${next}`]))
}

function firstParent(repo: string, commit: string): string {
  const parents = pySplitWhitespace(runGit(repo, ["rev-list", "--parents", "-n", "1", commit])).slice(1)
  return parents[0] ?? pyStrip(runGit(repo, ["hash-object", "-t", "tree", "--stdin"], {}, ""))
}

export function* addedLines(diffText: string, labelPrefix: string): Generator<ScanLine> {
  let path: string | null = null
  let nextNewLine = 0
  let oldLeft = 0
  let newLeft = 0
  for (const line of pySplitlines(diffText)) {
    const inHunk = oldLeft > 0 || newLeft > 0
    const header = inHunk ? null : HUNK_HEADER.exec(line)
    if (inHunk && line.startsWith("-")) {
      oldLeft--
    } else if (inHunk && line.startsWith("+")) {
      if (path !== null) yield [labelPrefix + path, nextNewLine, line.slice(1)]
      nextNewLine++
      newLeft--
    } else if (header) {
      oldLeft = Number(header[1] ?? 1)
      nextNewLine = Number(header[2])
      newLeft = Number(header[3] ?? 1)
    } else if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4)
      path = target === "/dev/null" ? null : target.startsWith("b/") ? target.slice(2) : target
    }
  }
}
