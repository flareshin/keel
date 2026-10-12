export const meta = {
  name: 'lens-review',
  description: 'Code review: the caller lenses plus readable-code and rule-checks through adversarial-audit, ending with a reporter agent whose message starts with VERDICT and carries one KEEL-EVIDENCE line per repo',
  phases: [
    { title: 'Prepare', detail: 'resolve review bases, snapshot working trees, derive the run id, load default lenses' },
    { title: 'Report', detail: 'reporter agent hands back the verdict and KEEL-EVIDENCE lines' },
  ],
}

// args: { diffs: [{ repo: '<absolute path>', base: '<ref>', head?: '<ref>', since?: '<40-hex tree id>' }],
//         lenses?: [{ key, prompt }]   (absent: workflows/review-lenses.json in the data dir),
//         guardrails?, requirement?: '<the request, as the user stated it>', readingGuide?,
//         priorFindings?: ['<merge-blocking finding of the NEEDS_FIXES at since>'],
//         runId?, rootRunId? (required with since), maxFindingsPerLens?, model?, effort? }
// Reviewer briefs carry no author claims: unknown keys fail, and readingGuide or guardrails text that asserts its own correctness fails.
// Without head the working tree is reviewed through a `keel snapshot` tree, so every lens reads exactly the content the evidence names.
const A = readArgs()
const DIFFS = A.diffs || null
const CALLER_LENSES = A.lenses
const PRIOR_FINDINGS = A.priorFindings
const MODEL = A.model || 'opus'
const EFFORT = A.effort || 'high'
const MECHANICAL_EFFORT = 'low'
const REVIEW_KIND = 'lens-review'
const READABLE_KEY = 'readable-code'
const RULE_CHECKS_KEY = 'rule-checks'
const BLOCKING_IMPACT = ['high', 'medium']
const AUTHOR_TEXT_ARGS = ['readingGuide', 'guardrails']
const KNOWN_ARGS = ['diffs', 'lenses', 'guardrails', 'requirement', 'readingGuide', 'priorFindings', 'runId', 'rootRunId', 'maxFindingsPerLens', 'model', 'effort']
const AUTHOR_CLAIMS = [
  /\btests? (?:all |now )?(?:pass|passes|passed|passing)\b/i,
  /\b(?:all|is|are|now) green\b/i,
  /\bLGTM\b/i,
  /\b(?:I|we) (?:fixed|changed|verified|tested|checked|confirmed)\b/i,
  /\bworks (?:correctly|as expected|fine)\b/i,
  /\bconfirm(?:s|ed)?\b[^.\n]{0,40}\bcorrect\b/i,
  /\bno (?:bugs|issues|regressions)\b/i,
]
const SHA = /^[0-9a-f]{40}$/
const RUN_ID = /^[A-Za-z0-9._-]{8,64}$/
const DERIVED_RUN_ID = /^rv-\d{8}T\d{6}Z-[0-9a-f]{6}$/
const SAFE_REF = /^[A-Za-z0-9._\/~^@{}-]+$/
const CONTROL_CHARS = /[\x00-\x1f\x7f\x85\u2028\u2029]/
const DATA_DIR = '"${KEEL_DATA_DIR:-$HOME/.claude}"'
const KEEL_CLI = `${DATA_DIR}/bin/keel`
const RULE_CHECKS = `${DATA_DIR}/skills/readable-code/scripts/rule-checks.py`
const DEFAULT_LENSES_FILE = `${DATA_DIR}/workflows/review-lenses.json`
const DERIVE_RUN_ID_COMMAND = `printf 'rv-%s-%s\\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$(od -An -N3 -tx1 /dev/urandom | tr -d ' \\n')"`
const LOAD_LENSES_COMMAND = `jq -c '{lenses, guardrails}' ${DEFAULT_LENSES_FILE}`
const REPORT_START = '<<<KEEL-REPORT'
const REPORT_END = 'KEEL-REPORT>>>'
const RULE_CHECKS_SUMMARY = /summary repos=\d+ scanned_lines=\d+ signals=\d+ unscanned=[^\n]*? blocked=(\S+)/g
const TRAILING_QUOTE_OR_PUNCTUATION = /[`'".,;:)\]]+$/
const EVIDENCE_PREFIX = 'KEEL-EVIDENCE: '
const EVIDENCE_LINE = /^\s*KEEL-EVIDENCE:/
const LINE_BREAKS = /\s*[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]+\s*/g
const JOINED_LINES = ' / '
const DELTA_NOTE = 'A `since` diff is a delta review: the branch passed review at that tree, so judge only the change after it (read the surrounding code for context, and say so if the change breaks something the earlier PASS relied on).'
const FIX_DELTA_NOTE = 'A `since` diff is a delta review of a fix: the review at that tree returned NEEDS_FIXES with the merge-blocking findings below, so judge only the change after it (read the surrounding code for context). Each finding below that the change leaves unresolved is a finding again, impact high, at its file:line.\nPrior merge-blocking findings:'
const REVIEW_GUARDRAILS = 'Review rules: a finding is valid only as a failure scenario (input leads to wrong output, an exception or a broken caller) with file:line evidence; style or impression critique is void; nothing outside the request. Impact high or medium = merge-blocking (wrong behavior, data loss, security, a broken caller or contract, fake-green tests); low = non-blocking. A merge-blocking finding needs a repro: a command or input with the observed and the expected result, or `static: <caller|contract|security|concurrency|rule> at file:line` when nothing can be run; without one it is reported as non-blocking. Test obligation: changed logic with no test that would fail if the change were reverted is impact high, never low.'
const PREPARE_SCHEMA = {
  type: 'object',
  properties: {
    diff_outputs: { type: 'array', items: { type: 'string' }, description: 'per diff command, in order: its exact stdout line, or "ERROR: <stderr>" when it failed' },
    run_id_output: { type: 'string', description: 'exact stdout of the run id command, or "" when none was given' },
    lenses_output: { type: 'string', description: 'exact stdout of the lenses command, or "" when none was given' },
  },
  required: ['diff_outputs', 'run_id_output', 'lenses_output'],
}

const argsProblem = findArgsProblem()
if (argsProblem) {
  log(`FATAL: ${argsProblem}`)
  return failed(argsProblem)
}

phase('Prepare')
const prepared = await prepareReview()
if (prepared.error) return failed(prepared.error)
const { runId, rootRunId, reviewed, lensSet } = prepared

const audit = await runAudit(reviewed, lensSet)
if (audit.error) return failed(audit.error)

const outcome = judge(audit, lensSet, reviewed.length)
log(`${outcome.verdict}: ${outcome.blocking.length} merge-blocking, ${outcome.nonBlocking.length} non-blocking, ${audit.unverified.length} unverified, ${outcome.failedLenses.length} lens(es) not run, ${audit.refuted.length} refuted`)
const evidenceLines = reviewed.map((target) => buildEvidenceLine(target, runId, rootRunId))
const expectedReport = buildReport(outcome, audit, reviewed, evidenceLines)

phase('Report')
const handedBack = await handBackReport(expectedReport)
const handBackProblem = findHandBackProblem(handedBack, expectedReport, evidenceLines)
if (handBackProblem) return failed(`reporter agent: ${handBackProblem}`, expectedReport)

return {
  verdict: outcome.verdict,
  runId,
  rootRunId,
  fixableFindings: outcome.fixableFindings,
  report: handedBack,
  evidence: evidenceLines.map((line) => JSON.parse(line.slice(EVIDENCE_PREFIX.length))),
  lensesFired: outcome.lensesFired,
  failedLenses: outcome.failedLenses,
  blocking: outcome.blocking,
  nonBlocking: outcome.nonBlocking,
  unverified: audit.unverified,
  refutedCount: audit.refuted.length,
}

function readArgs() {
  const raw = (typeof args !== 'undefined' && args) || {}
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch (e) {
    log('FATAL: args is a JSON string that does not parse: ' + e.message)
    return {}
  }
}

// Every value checked here is later pasted into shell text or an evidence line, so the shapes are strict.
function findArgsProblem() {
  const unknownKey = Object.keys(A).find((key) => !KNOWN_ARGS.includes(key))
  if (unknownKey) return `args.${unknownKey} is not an argument; reviewer briefs take only ${KNOWN_ARGS.join(', ')}`
  if (!Array.isArray(DIFFS) || DIFFS.length === 0) return 'args.diffs ([{repo, base}]) is required; an empty review does not run'
  const badDiffIndex = DIFFS.findIndex((d) => !isDiffShaped(d))
  if (badDiffIndex >= 0) return `diffs[${badDiffIndex}] has the wrong shape: {repo: absolute path without quotes, base: ref, head?: ref} or {repo, base, since: 40-hex tree id}`
  if (CALLER_LENSES !== undefined && (!Array.isArray(CALLER_LENSES) || CALLER_LENSES.length === 0)) return 'args.lenses, when given, is a non-empty list of {key, prompt}'
  const deltaCount = DIFFS.filter((d) => d.since).length
  if (deltaCount > 0 && deltaCount < DIFFS.length) return 'one run is either a root review or a delta review: give since on every diff or on none'
  if (PRIOR_FINDINGS !== undefined && (deltaCount === 0 || !isFindingList(PRIOR_FINDINGS))) return 'priorFindings is a non-empty list of finding texts, given only with since diffs'
  return findAuthorClaimProblem() || findRunIdProblem(deltaCount > 0)
}

// The requirement is the user's request and may name a goal ("so the tests pass"), so only author-written text is screened.
function findAuthorClaimProblem() {
  const nonText = ['requirement', ...AUTHOR_TEXT_ARGS].find((key) => A[key] !== undefined && typeof A[key] !== 'string')
  if (nonText) return `args.${nonText} is text`
  for (const key of AUTHOR_TEXT_ARGS.filter((k) => A[k] !== undefined)) {
    const claim = AUTHOR_CLAIMS.map((pattern) => A[key].match(pattern)).find(Boolean)
    if (claim) return `args.${key} claims "${claim[0]}"; a reviewer brief states the request, never that the work is correct`
  }
  return null
}

function isDiffShaped(d) {
  if (!d || !isPastableAbsolutePath(d.repo)) return false
  if (typeof d.base !== 'string' || !SAFE_REF.test(d.base)) return false
  if (d.head !== undefined && (typeof d.head !== 'string' || !SAFE_REF.test(d.head))) return false
  if (d.since === undefined) return true
  return d.head === undefined && typeof d.since === 'string' && SHA.test(d.since)
}

// The path is pasted inside single quotes into shell text and onto a report line, so a quote or line break could escape either.
function isPastableAbsolutePath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes("'") && !CONTROL_CHARS.test(value)
}

function isFindingList(findings) {
  return Array.isArray(findings) && findings.length > 0 && findings.every((f) => typeof f === 'string' && f.trim() !== '')
}

// A root review starts its own chain (root_run_id == run_id); a delta joins the chain of the root it names.
function findRunIdProblem(isDelta) {
  const malformedKey = ['runId', 'rootRunId'].find((key) => A[key] !== undefined && !(typeof A[key] === 'string' && RUN_ID.test(A[key])))
  if (malformedKey) return `args.${malformedKey} must match ${RUN_ID.source}`
  if (isDelta && A.rootRunId === undefined) return 'args.rootRunId is required for a delta review (since diffs)'
  if (isDelta && A.runId !== undefined && A.runId === A.rootRunId) return 'a delta review needs its own runId, different from rootRunId'
  if (!isDelta && A.rootRunId !== undefined && A.rootRunId !== A.runId) return 'a root review has rootRunId equal to runId; omit rootRunId'
  return null
}

async function prepareReview() {
  const output = await agent(buildPreparePrompt(), {
    label: 'prepare', phase: 'Prepare', schema: PREPARE_SCHEMA, model: MODEL, effort: MECHANICAL_EFFORT,
  })
  if (!output) return { error: 'prepare agent returned nothing' }
  const reviewed = parseReviewedTargets(output.diff_outputs)
  if (reviewed.error) return reviewed
  const runId = resolveRunId(output.run_id_output)
  if (!runId) return { error: `prepare agent returned no valid run id: ${JSON.stringify(output.run_id_output)}` }
  const lensSet = resolveLensSet(output.lenses_output, reviewed.targets)
  if (lensSet.error) return lensSet
  return { runId, rootRunId: A.rootRunId || runId, reviewed: reviewed.targets, lensSet }
}

function buildPreparePrompt() {
  const steps = DIFFS.map((d, i) => `diff ${i}:\n${buildPrepareCommand(d)}`)
  const runIdStep = A.runId === undefined ? `run id:\n${DERIVE_RUN_ID_COMMAND}` : 'run id: none, return ""'
  const lensesStep = CALLER_LENSES === undefined ? `lenses:\n${LOAD_LENSES_COMMAND}` : 'lenses: none, return ""'
  return `Mechanical step; do not modify any file and do not judge anything. Run each bash command below exactly as written, once, and copy its stdout verbatim (one line, no edits) into the matching field. When a diff command exits non-zero, return "ERROR: " followed by its stderr for that diff instead.

${steps.join('\n\n')}

${runIdStep}

${lensesStep}`
}

// One command per diff prints one JSON object, so the agent copies values instead of interpreting git output.
function buildPrepareCommand(d) {
  const root = `root=$(git -C '${d.repo}' rev-parse --show-toplevel)`
  if (d.head) {
    return `${root} && head=$(git -C "$root" rev-parse --verify '${d.head}^{commit}') && base=$(git -C "$root" merge-base '${d.base}' "$head") && stat=$(git -C "$root" diff --stat "$base" "$head" | tail -n 1) && jq -cn --arg r "$root" --arg b "$base" --arg h "$head" --arg s "$stat" '{repo_root:$r, review_base:$b, head:$h, snapshot_tree:null, diff_stat:$s}'`
  }
  const from = d.since ? `'${d.since}'` : '"$base"'
  const sinceCheck = d.since ? `{ [ "$(git -C "$root" cat-file -t '${d.since}' 2>/dev/null)" = tree ] || { echo "since ${d.since} is not a tree id: pass the snapshot_tree the earlier review named (for a commit, <commit>^{tree})" >&2; false; }; } && ` : ''
  return `${root} && ${sinceCheck}base=$(git -C "$root" merge-base '${d.base}' HEAD) && tree=$(${KEEL_CLI} snapshot "$root" | jq -r .tree) && stat=$(git -C "$root" diff --stat ${from} "$tree" | tail -n 1) && jq -cn --arg r "$root" --arg b "$base" --arg t "$tree" --arg s "$stat" '{repo_root:$r, review_base:$b, head:null, snapshot_tree:$t, diff_stat:$s}'`
}

function parseReviewedTargets(diffOutputs) {
  if (!Array.isArray(diffOutputs) || diffOutputs.length !== DIFFS.length) return { error: `prepare agent returned ${Array.isArray(diffOutputs) ? diffOutputs.length : 'no'} diff outputs for ${DIFFS.length} diffs` }
  const targets = []
  for (const [i, line] of diffOutputs.entries()) {
    const target = parseReviewedTarget(line, DIFFS[i])
    if (!target) return { error: `prepare failed for diffs[${i}] (${DIFFS[i].repo}): ${String(line).slice(0, 300)}` }
    targets.push(target)
  }
  return { targets }
}

function parseReviewedTarget(line, diff) {
  try {
    const parsed = JSON.parse(line)
    return isPreparedShaped(parsed) ? { ...parsed, since: diff.since || null } : null
  } catch (e) {
    return null
  }
}

// Exactly one of head and snapshot_tree names the reviewed content, as the KEEL-EVIDENCE contract requires.
function isPreparedShaped(p) {
  if (!p || !isPastableAbsolutePath(p.repo_root)) return false
  if (!SHA.test(p.review_base) || typeof p.diff_stat !== 'string') return false
  return (SHA.test(p.head) && p.snapshot_tree === null) || (p.head === null && SHA.test(p.snapshot_tree))
}

function resolveRunId(runIdOutput) {
  if (A.runId !== undefined) return A.runId
  const derived = String(runIdOutput || '').trim()
  return DERIVED_RUN_ID.test(derived) ? derived : null
}

function resolveLensSet(lensesOutput, reviewed) {
  const base = resolveBaseLenses(lensesOutput)
  if (base.error) return base
  return {
    lenses: withBuiltInLenses(base.lenses, reviewed),
    guardrails: base.guardrails,
    isRuleChecksBuiltIn: !hasLens(base.lenses, RULE_CHECKS_KEY),
  }
}

function resolveBaseLenses(lensesOutput) {
  if (CALLER_LENSES !== undefined) return { lenses: CALLER_LENSES, guardrails: A.guardrails || '' }
  let fileLenses
  try {
    fileLenses = JSON.parse(lensesOutput)
  } catch (e) {
    return { error: `default lenses did not load from workflows/review-lenses.json: ${String(lensesOutput).slice(0, 200)}` }
  }
  if (!fileLenses || !Array.isArray(fileLenses.lenses) || fileLenses.lenses.length === 0) return { error: 'workflows/review-lenses.json holds no lenses' }
  return { lenses: fileLenses.lenses, guardrails: A.guardrails !== undefined ? A.guardrails : (fileLenses.guardrails || '') }
}

function withBuiltInLenses(lenses, reviewed) {
  return [
    ...lenses.map(withReadingGuide),
    ...(hasLens(lenses, READABLE_KEY) ? [] : [buildReadableLens()]),
    ...(hasLens(lenses, RULE_CHECKS_KEY) ? [] : [buildRuleChecksLens(reviewed)]),
  ]
}

function hasLens(lenses, key) {
  return lenses.some((lens) => lens && lens.key === key)
}

// A caller's own readable-code lens still gets the guide: the guide goes to that lens and no other.
function withReadingGuide(lens) {
  if (!lens || lens.key !== READABLE_KEY || A.readingGuide === undefined) return lens
  return { ...lens, prompt: `${lens.prompt}\n${buildReadingGuideBlock()}` }
}

function buildReadableLens() {
  return {
    key: READABLE_KEY,
    prompt: `Lens: readable-code. Load the /readable-code skill (Skill tool) in full and judge only the new and changed lines against its rules, tagged K5.1-K5.16. Check the author's reading guide against the code (Entry point, Flow, Changed, Read first); a guide that misstates the code is a finding.\n${buildReadingGuideBlock()}`,
  }
}

function buildReadingGuideBlock() {
  return `Author's reading guide (claims to check against the code, not evidence):\n${A.readingGuide || 'none provided; for a non-trivial diff, report the missing guide as a finding'}`
}

// --head is the reviewed commit or snapshot tree, so the scan covers exactly the content the evidence names.
function buildRuleChecksLens(reviewed) {
  const commands = reviewed.map((target) => `python3 ${RULE_CHECKS} --repo '${target.repo_root}' --base ${target.review_base} --head ${target.head || target.snapshot_tree}`)
  const deltaNote = reviewed.some((target) => target.since) ? ' In a delta review, only a line the delta changes is a candidate.' : ''
  return {
    key: RULE_CHECKS_KEY,
    prompt: `Lens: rule-checks. Run each command below and quote its \`summary\` line in your notes:\n${commands.join('\n')}\nEach \`signal K5.<n> <file:line> <text>\` line is a candidate, not a finding.${deltaNote} Read the line in context with /readable-code rule K5.<n>. Report it only when the rule is broken and its own exception does not cover it. Exit 2 or a \`blocked=\` value other than none means that repo was not checked: report that as a finding, never as clean. \`unscanned=\` names submodules the diff adds or removes and untracked nested repos: list them in your notes, not as findings.`,
  }
}

async function runAudit(reviewed, lensSet) {
  try {
    const audit = await workflow('adversarial-audit', {
      target: buildTarget(reviewed),
      lenses: lensSet.lenses,
      guardrails: `${REVIEW_GUARDRAILS}\n${lensSet.guardrails}`,
      maxFindingsPerLens: A.maxFindingsPerLens,
      model: MODEL,
      effort: EFFORT,
    })
    if (!audit || audit.error) return { error: (audit && audit.error) || 'adversarial-audit returned nothing' }
    return audit
  } catch (e) {
    return { error: 'adversarial-audit threw: ' + String((e && e.message) || e) }
  }
}

function buildTarget(reviewed) {
  const commands = reviewed.map(buildLensDiffCommand).join('\n')
  const delta = reviewed.some((target) => target.since) ? `\n${describeDelta()}` : ''
  const requirement = A.requirement ? `\nRequirement (the request as stated, not a claim that the diff meets it):\n${A.requirement}` : ''
  return `the code diff from these commands; review only what it introduces or changes. Read file content at the reviewed end with \`git show <end>:<path>\`, never from the live working tree, which may have moved on:\n${commands}${delta}${requirement}`
}

function buildLensDiffCommand(target) {
  const end = target.head || target.snapshot_tree
  const start = target.since || target.review_base
  return `git -C '${target.repo_root}' diff ${start} ${end}`
}

function describeDelta() {
  return PRIOR_FINDINGS ? `${FIX_DELTA_NOTE}\n${PRIOR_FINDINGS.map((f) => `- ${f}`).join('\n')}` : DELTA_NOTE
}

// A lens that never ran or a finding nobody verified leaves the review incomplete, so it cannot pass.
function judge(audit, lensSet, repoCount) {
  const failedLenses = [...(audit.failedLenses || []), ...findUnprovenRuleChecks(audit, lensSet, repoCount)]
  const blocking = audit.confirmed.filter(isMergeBlocking)
  const nonBlocking = audit.confirmed.filter((f) => !isMergeBlocking(f))
  const isIncomplete = audit.unverified.length > 0 || failedLenses.length > 0
  return {
    verdict: blocking.length || isIncomplete ? 'NEEDS_FIXES' : 'PASS',
    // Only a complete review gives a delta review of the fix a closed list to settle.
    fixableFindings: isIncomplete ? 0 : blocking.length,
    lensesFired: lensSet.lenses.map((lens) => lens.key).filter((key) => !failedLenses.includes(key)),
    failedLenses,
    blocking,
    nonBlocking,
  }
}

// The built-in rule-checks lens counts as run only when its notes quote one clean scan summary per reviewed repo.
function findUnprovenRuleChecks(audit, lensSet, repoCount) {
  if (!lensSet.isRuleChecksBuiltIn || (audit.failedLenses || []).includes(RULE_CHECKS_KEY)) return []
  const noted = (audit.lensNotes || []).find((n) => n.lens === RULE_CHECKS_KEY)
  const blockedValues = [...String((noted && noted.notes) || '').matchAll(RULE_CHECKS_SUMMARY)].map((match) => match[1].replace(TRAILING_QUOTE_OR_PUNCTUATION, ''))
  const isProven = blockedValues.length === repoCount && blockedValues.every((value) => value === 'none')
  return isProven ? [] : [RULE_CHECKS_KEY]
}

function isMergeBlocking(finding) {
  return BLOCKING_IMPACT.includes(finding.impact) && hasRepro(finding)
}

function hasRepro(finding) {
  return typeof finding.repro === 'string' && finding.repro.trim() !== ''
}

function buildEvidenceLine(target, runId, rootRunId) {
  const evidence = {
    v: 1,
    repo_root: target.repo_root,
    review_base: target.review_base,
    head: target.head,
    snapshot_tree: target.snapshot_tree,
    since: target.since,
    run_id: runId,
    root_run_id: rootRunId,
    review_kind: REVIEW_KIND,
  }
  return `${EVIDENCE_PREFIX}${JSON.stringify(evidence)}`
}

// Agent text is flattened to one line and never starts a line: report-gate records every KEEL-EVIDENCE line it finds.
function buildReport(outcome, audit, reviewed, evidenceLines) {
  return [
    `VERDICT: ${outcome.verdict}`,
    `Diff: ${reviewed.map((target) => `${target.repo_root}: ${toOneLine(target.diff_stat).trim() || '0 files changed'}`).join('; ')}`,
    `Lenses fired: ${toOneLine(outcome.lensesFired.join(', '))}`,
    describeFindings('Merge-blocking', outcome.blocking),
    describeFindings('Non-blocking', outcome.nonBlocking),
    describeFindings('Unverified (the verifier failed; re-verify before any PASS)', audit.unverified),
    `Lenses that did not run (re-run the review): ${outcome.failedLenses.length ? toOneLine(outcome.failedLenses.join(', ')) : 'none'}`,
    `Refuted: ${audit.refuted.length}`,
    describeLensNotes(audit.lensNotes || []),
    evidenceLines.join('\n'),
  ].join('\n\n')
}

function describeFindings(title, findings) {
  if (findings.length === 0) return `${title}: none`
  const items = findings.map((f) => {
    const adjusted = f.verdict && f.verdict.verdict === 'ADJUSTED' ? ', ADJUSTED' : ''
    const unreproduced = BLOCKING_IMPACT.includes(f.impact) && !hasRepro(f) ? ', no repro' : ''
    return `- [${toOneLine(f.impact)}${adjusted}${unreproduced}] ${toOneLine(f.lens)}/${toOneLine(f.id)}: ${toOneLine(f.summary)}\n  At: ${toOneLine(f.file)} - ${toOneLine(f.quote)}\n  Repro: ${hasRepro(f) ? toOneLine(f.repro) : 'none'}\n  Fix: ${toOneLine(f.proposal)}`
  })
  return `${title} (${findings.length}):\n${items.join('\n')}`
}

// Lens notes carry each lens's evidence (commands run, test counts) when it found nothing: a PASS still shows its work.
function describeLensNotes(lensNotes) {
  const noted = lensNotes.filter((n) => n.notes)
  if (noted.length === 0) return 'Lens notes: none'
  return 'Lens notes:\n' + noted.map((n) => `- ${toOneLine(n.lens)}: ${toOneLine(n.notes)}`).join('\n')
}

function toOneLine(text) {
  return String(text).replace(LINE_BREAKS, JOINED_LINES)
}

// The reporter is a separate subagent with no schema: report-gate records review evidence from its final message.
function handBackReport(report) {
  const prompt = `Your final message must be exactly the report between the two marker lines below, character for character: no text before or after it, no markdown fences, no edits. Do not run any tool and do not judge the report.
${REPORT_START}
${report}
${REPORT_END}`
  return agent(prompt, { label: 'report', phase: 'Report', model: MODEL, effort: MECHANICAL_EFFORT })
}

// The caller gets the reporter's text as the report, so it must be the expected report up to trailing whitespace.
function findHandBackProblem(message, expectedReport, evidenceLines) {
  if (typeof message !== 'string' || message.trim() === '') return 'returned no message'
  const lines = toComparableLines(message)
  const expected = toComparableLines(expectedReport)
  if (lines[0] !== expected[0]) return `first line is ${JSON.stringify(lines[0].slice(0, 80))}, expected "${expected[0]}"`
  const handedEvidence = lines.filter((line) => EVIDENCE_LINE.test(line))
  const missing = evidenceLines.filter((line) => !handedEvidence.includes(line))
  if (missing.length) return `${missing.length} KEEL-EVIDENCE line(s) missing or altered`
  if (handedEvidence.length !== evidenceLines.length) return `${handedEvidence.length} KEEL-EVIDENCE lines for ${evidenceLines.length} reviewed repo(s)`
  const differing = findFirstDifferentLine(lines, expected)
  if (differing >= 0) return `line ${differing + 1} differs from the expected report: ${JSON.stringify(String(lines[differing] ?? '<missing>').slice(0, 80))}`
  return null
}

function toComparableLines(text) {
  return text.replace(/\s+$/, '').split('\n').map((line) => line.replace(/\s+$/, ''))
}

function findFirstDifferentLine(lines, expected) {
  const length = Math.max(lines.length, expected.length)
  for (let i = 0; i < length; i++) if (lines[i] !== expected[i]) return i
  return -1
}

function failed(error, expectedReport) {
  return { verdict: 'ERROR', error, report: `VERDICT: ERROR - ${error}`, ...(expectedReport ? { expectedReport } : {}) }
}
