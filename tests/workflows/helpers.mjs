import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, copyFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export const KEEL_HOME = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WORKFLOWS_DIR = join(KEEL_HOME, 'workflows')
export const REPORT_START = '<<<KEEL-REPORT'
export const REPORT_END = 'KEEL-REPORT>>>'
export const SHA_A = 'a'.repeat(40)
export const SHA_B = 'b'.repeat(40)
export const SHA_C = 'c'.repeat(40)
export const SHA_D = 'd'.repeat(40)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const RUNTIME_GLOBALS = ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow']
const META_EXPORT = 'export const meta = '
const BODY_MARKER = 'BODY'
// V8 compiles constructor source as "(" + fn.toString() + ")", so coverage offsets start one character before toString's.
const BODY_OFFSET = new AsyncFunction(...RUNTIME_GLOBALS, BODY_MARKER).toString().indexOf(BODY_MARKER) + 1

export function readScript(name) {
  return readFileSync(join(WORKFLOWS_DIR, `${name}.js`), 'utf8')
}

export function compileScript(name) {
  return compileWorkflowFile(join(WORKFLOWS_DIR, `${name}.js`))
}

// The workflow runtime evaluates the body as an async function; `export` is the only module syntax it strips.
export function compileWorkflowFile(file) {
  const source = readFileSync(file, 'utf8')
  if (!source.startsWith(META_EXPORT)) throw new Error(`${file} must begin with export const meta`)
  const sameLengthBody = ' '.repeat('export '.length) + source.slice('export '.length)
  const sourceUrl = `${pathToFileURL(file).href}#keel-prefix=${BODY_OFFSET}`
  return new AsyncFunction(...RUNTIME_GLOBALS, `${sameLengthBody}\n//# sourceURL=${sourceUrl}`)
}

export function extractMetaText(source) {
  const start = source.indexOf('{')
  const end = source.indexOf('\n}\n')
  return source.slice(start, end + 2)
}

// A pure literal holds only keys, strings, numbers, booleans, null and punctuation: no variables, calls, spreads or interpolation.
export function isPureLiteral(text) {
  if (text.includes('`') || text.includes('...')) return false
  const withoutStrings = text.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""')
  const withoutKeys = withoutStrings.replace(/[A-Za-z_$][\w$]*\s*:/g, '"":')
  const withoutValues = withoutKeys.replace(/""|-?\d+(?:\.\d+)?|\btrue\b|\bfalse\b|\bnull\b/g, '')
  return /^[\s{}[\],:]*$/.test(withoutValues)
}

// Runs a script with stubbed runtime globals. `respond(prompt, opts)` plays every agent; `workflow` defaults to running the real child script.
export function createRuntime({ respond, workflowImpl } = {}) {
  const record = { agents: [], logs: [], phases: [], workflows: [], unnamedModelOrEffort: [] }
  const agent = async (prompt, opts = {}) => {
    record.agents.push({ prompt, opts })
    if (typeof opts.model !== 'string' || !opts.model || typeof opts.effort !== 'string' || !opts.effort) record.unnamedModelOrEffort.push(opts.label)
    return respond(prompt, opts)
  }
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)))
  const pipeline = (items, ...stages) => Promise.all(items.map((item, index) => runStages(item, index, stages)))
  const phase = (title) => { record.phases.push(title) }
  const log = (message) => { record.logs.push(message) }
  const globals = { agent, parallel, pipeline, phase, log }
  const workflow = async (name, childArgs) => {
    record.workflows.push({ name, args: childArgs })
    if (workflowImpl) return workflowImpl(name, childArgs)
    return compileScript(name)(childArgs, agent, parallel, pipeline, phase, log, rejectNestedWorkflow)
  }
  const run = (name, scriptArgs) => compileScript(name)(scriptArgs, agent, parallel, pipeline, phase, log, workflow)
  return { run, record, globals }
}

async function runStages(item, index, stages) {
  let previous = item
  try {
    for (const stage of stages) previous = await stage(previous, item, index)
    return previous
  } catch (e) {
    return null
  }
}

function rejectNestedWorkflow() {
  throw new Error('workflow() nesting is one level only')
}

export function reportBetweenMarkers(prompt) {
  const start = prompt.indexOf(`${REPORT_START}\n`)
  const end = prompt.lastIndexOf(`\n${REPORT_END}`)
  if (start < 0 || end < 0) throw new Error('reporter prompt has no report markers')
  return prompt.slice(start + REPORT_START.length + 1, end)
}

// Plays a rule-checks auditor that ran every command in its prompt and quoted each clean summary line.
export function cleanRuleChecksNotes(prompt) {
  const repoCount = (prompt.match(/ --repo '/g) || []).length
  return Array.from({ length: repoCount }, () => CLEAN_RULE_CHECKS_SUMMARY).join('\n')
}

export const CLEAN_RULE_CHECKS_SUMMARY = 'summary repos=1 scanned_lines=3 signals=0 unscanned=none blocked=none'

export function evidenceLines(message) {
  return message.split('\n').filter((line) => line.startsWith('KEEL-EVIDENCE: '))
}

export function parseEvidenceLine(line) {
  return JSON.parse(line.slice('KEEL-EVIDENCE: '.length))
}

export function preparedLine({ repoRoot = '/work/app', reviewBase = SHA_A, head = null, snapshotTree = SHA_B, diffStat = ' 2 files changed, 5 insertions(+)' } = {}) {
  return JSON.stringify({ repo_root: repoRoot, review_base: reviewBase, head, snapshot_tree: snapshotTree, diff_stat: diffStat })
}

// Pulls the one-line command that follows each "diff N:", "run id:" and "lenses:" header in the prepare prompt.
export function preparePromptCommands(prompt) {
  const lines = prompt.split('\n')
  const commands = { diffs: [], runId: null, lenses: null }
  lines.forEach((line, i) => {
    const next = lines[i + 1]
    if (/^diff \d+:$/.test(line)) commands.diffs.push(next)
    if (line === 'run id:') commands.runId = next
    if (line === 'lenses:') commands.lenses = next
  })
  return commands
}

// A temp sandbox per test: KEEL_DATA_DIR, HOME and git config never point at the real user setup.
export function createSandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'keel-workflows-')))
  const dataDir = join(root, 'data')
  const env = {
    PATH: process.env.PATH,
    KEEL_DATA_DIR: dataDir,
    HOME: join(root, 'home'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  if (!env.KEEL_DATA_DIR.startsWith(root)) throw new Error('KEEL_DATA_DIR escaped the sandbox')
  mkdirSync(env.HOME, { recursive: true })
  mkdirSync(join(dataDir, 'bin'), { recursive: true })
  mkdirSync(join(dataDir, 'workflows'), { recursive: true })
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n')
  writeKeelSnapshotStub(join(dataDir, 'bin', 'keel'))
  copyFileSync(join(WORKFLOWS_DIR, 'review-lenses.json'), join(dataDir, 'workflows', 'review-lenses.json'))
  mkdirSync(join(dataDir, 'skills'), { recursive: true })
  symlinkSync(join(KEEL_HOME, 'skills', 'readable-code'), join(dataDir, 'skills', 'readable-code'))
  const git = (repo, ...gitArgs) => execFileSync('git', ['-C', repo, ...gitArgs], { env, encoding: 'utf8' }).trim()
  const bash = (command) => execFileSync('bash', ['-c', command], { env, encoding: 'utf8' }).trim()
  return { root, env, git, bash }
}

// Stands in for the ship-gate track's `keel snapshot` (Interfaces (e)): temp-index snapshot, real index untouched.
function writeKeelSnapshotStub(path) {
  writeFileSync(path, `#!/bin/bash
set -e
[ "$1" = snapshot ] || exit 2
root=$(git -C "$2" rev-parse --show-toplevel)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
index="$tmp/index"
GIT_INDEX_FILE="$index" git -C "$root" read-tree HEAD
GIT_INDEX_FILE="$index" git -C "$root" add -A
tree=$(GIT_INDEX_FILE="$index" git -C "$root" write-tree)
jq -cn --arg r "$root" --arg t "$tree" '{repo_root:$r, tree:$t}'
`)
  chmodSync(path, 0o755)
}
