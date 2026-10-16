export const meta = {
  name: 'adversarial-audit',
  description: 'Lens fan-out audit plus per-finding adversarial verification; returns confirmed and adjusted findings only',
  phases: [
    { title: 'Audit', detail: 'one auditor agent per lens over the target' },
    { title: 'Verify', detail: 'one refuting verifier per finding; insufficient evidence means REFUTED' },
  ],
}



const A = readArgs()
const TARGET = A.target || null
const LENSES = A.lenses || null
const GUARDRAILS = A.guardrails || ''
const MAX_FINDINGS = A.maxFindingsPerLens || 8
const MODEL = A.model || 'opus'

const EFFORT = A.effort || 'high'

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: MAX_FINDINGS,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          summary: { type: 'string' },
          evidence: { type: 'string', description: 'file:line quote plus the command you ran and its output' },
          proposal: { type: 'string' },
          repro: { type: 'string', description: 'how to see the failure: a command or input with the observed and the expected result; "static: <what> at file:line" when nothing can be run; "" when you have neither' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string', description: 'absolute path of the target file; "N/A - <reason>" for a non-edit action or several files' },
          quote: { type: 'string', description: 'current state quoted verbatim as file:line; "N/A" when file is N/A' },
          change: { type: 'string', description: 'full replacement text to apply; "N/A - <alternative action>" when it cannot be applied directly' },
        },
        required: ['id', 'summary', 'evidence', 'proposal', 'repro', 'impact', 'file', 'quote', 'change'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'ADJUSTED', 'REFUTED'] },
    evidence: { type: 'string', description: 'the commands and quotes you ran to try to refute it, with their results; the verdict is void without them' },
    adjusted_summary: { type: 'string' },
    adjusted_proposal: { type: 'string' },
  },
  required: ['verdict', 'evidence'],
}

if (!TARGET || !Array.isArray(LENSES) || LENSES.length === 0) {
  log('FATAL: args.target and args.lenses ([{key, prompt}]) are required; an empty audit does not run')
  return { error: 'missing args: target, lenses', confirmed: [], refuted: [], unverified: [], failedLenses: [] }
}
const badLensIndex = LENSES.findIndex((lens) => !lens || typeof lens.key !== 'string' || typeof lens.prompt !== 'string')
if (badLensIndex >= 0) {
  log(`FATAL: lenses[${badLensIndex}] has the wrong shape; each item is {key: string, prompt: string}`)
  return { error: `bad lens shape at index ${badLensIndex}`, confirmed: [], refuted: [], unverified: [], failedLenses: [] }
}

const COMMON = buildCommonPrompt()

phase('Audit')
const lensResults = await pipeline(LENSES, auditLens, verifyLensFindings)
return summarize(lensResults)

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

function buildCommonPrompt() {
  return `You are a read-only auditor; do not modify any file.
Target: ${TARGET}
${GUARDRAILS}
Finding discipline (a violation voids the finding):
- Every finding needs disk evidence: a file:line quote or the actual output of a command. Distrust counters, labels and claims in documents until you re-check them on disk.
- No impression critique: report a finding only when it converts into a cost (wrong behavior, bytes, misclassification, double maintenance).
- Put in evidence and proposal only what the judgment needs, in complete sentences; no arrow chains or abbreviations.
- Run this audit yourself; do not delegate to subagents. The workflow already fans out per lens.`
}

function auditLens(lens) {
  return agent(`${COMMON}\n\n${lens.prompt}`, {
    label: `audit:${lens.key}`, phase: 'Audit', schema: FINDINGS_SCHEMA, model: MODEL, effort: EFFORT,
  })
}


function verifyLensFindings(audit, lens) {
  if (!audit) return { lens: lens.key, verified: [], notes: '', failed: true }
  const findings = audit.findings || []
  const notes = audit.notes || ''
  if (findings.length === 0) return { lens: lens.key, verified: [], notes }
  return parallel(findings.map((finding) => () => verifyFinding(finding, lens)))
    .then((verified) => ({ lens: lens.key, verified, notes }))
}

function verifyFinding(finding, lens) {
  return agent(buildVerifyPrompt(finding), {
    label: `verify:${finding.id}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: MODEL, effort: EFFORT,
  })
    .then((verdict) => applyVerdict(finding, lens, demoteIncompleteAdjustment(verdict)))
    .catch((e) => ({ ...finding, lens: lens.key, verdict: null, verifyError: String((e && e.message) || e) }))
}

function buildVerifyPrompt(finding) {
  return `${COMMON}

You are an adversarial verifier in a separate context from the finder (author != reviewer). Try to REFUTE the finding below with disk evidence:
(a) Does the quote match the actual file:line? Re-measure any numbers.
(b) Does an alternative explanation hold (by design, already fixed, a different cause, a measurement error)?
(c) Is the proposal safe (side effects, the other side of a double-maintained surface)?
(d) When the repro is a command or input, run it (temp files only): a repro that does not show the observed failure refutes the finding.
Refutation fails: CONFIRMED. Partial correction: ADJUSTED (adjusted_summary and adjusted_proposal required). Insufficient evidence: lean toward REFUTED.
A CONFIRMED without a refutation attempt is void; put the commands you ran and their output in evidence.

Finding: ${JSON.stringify(finding)}`
}

function demoteIncompleteAdjustment(verdict) {
  const isIncompleteAdjustment = verdict && verdict.verdict === 'ADJUSTED' && (!verdict.adjusted_summary || !verdict.adjusted_proposal)
  if (!isIncompleteAdjustment) return verdict
  return { ...verdict, verdict: 'REFUTED', evidence: `${verdict.evidence || ''} [AUTO-DEMOTED: ADJUSTED without adjusted_summary and adjusted_proposal]` }
}

function applyVerdict(finding, lens, verdict) {
  if (!verdict || verdict.verdict !== 'ADJUSTED') return { ...finding, lens: lens.key, verdict }
  return {
    ...finding,
    summary: verdict.adjusted_summary,
    proposal: verdict.adjusted_proposal,
    change: 'N/A - ADJUSTED: re-derive the change from the adjusted proposal; original_change is the pre-correction text, never apply it as-is',
    original_summary: finding.summary,
    original_change: finding.change,
    lens: lens.key,
    verdict,
  }
}


function summarize(lensResults) {
  const ranLenses = lensResults.filter((result) => result && !result.failed)
  const failedLenses = LENSES.filter((lens, i) => !lensResults[i] || lensResults[i].failed).map((lens) => lens.key)
  const all = ranLenses.flatMap((result) => result.verified || []).filter(Boolean)
  const confirmed = all.filter((f) => f.verdict && f.verdict.verdict !== 'REFUTED')
  const refuted = all.filter((f) => f.verdict && f.verdict.verdict === 'REFUTED')
  const unverified = all.filter((f) => !f.verdict)
  log(`Verification done: ${confirmed.length} confirmed or adjusted, ${refuted.length} refuted, ${unverified.length} unverified`)
  if (unverified.length) log(`WARNING: ${unverified.length} finding(s) unverified because the verifier failed; re-verify, do not treat them as confirmed`)
  if (failedLenses.length) log(`WARNING: lenses whose auditor did not run: ${failedLenses.join(', ')}; their silence is not a clean result`)
  return {
    confirmed,
    refuted,
    unverified,
    failedLenses,
    lensNotes: ranLenses.map((result) => ({ lens: result.lens, notes: result.notes })),
  }
}
