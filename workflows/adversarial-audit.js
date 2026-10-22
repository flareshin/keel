export const meta = {
  name: 'adversarial-audit',
  description: 'Independent lens coverage plus batched finding verification; returns confirmed and adjusted findings only',
  phases: [
    { title: 'Audit', detail: 'one independent auditor covers the lenses; split when the risk warrants it' },
    { title: 'Verify', detail: 'one separate verifier per nonempty source audit; incomplete decisions stay unverified' },
  ],
}

const A = readArgs()
const TARGET = A.target || null
const LENSES = A.lenses || null
const GUARDRAILS = A.guardrails || ''
const MAX_FINDINGS = A.maxFindingsPerLens || 8
const MODEL = A.model || 'opus'
const EFFORT = A.effort || 'high'
const AUDITOR_TYPE = 'keel-auditor'
const AUDIT_MODE = A.auditMode || 'combined'

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
          proposal: { type: 'string', description: 'concise fix direction; do not write a replacement patch during review' },
          repro: { type: 'string', description: 'how to see the failure: a command or input with the observed and the expected result; "static: <what> at file:line" when nothing can be run; "" when you have neither' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string', description: 'absolute path of the target file; "N/A - <reason>" for a non-edit action or several files' },
          quote: { type: 'string', description: 'current state quoted verbatim as file:line; "N/A" when file is N/A' },
          origin: { type: 'string', enum: ['introduced', 'pre-existing'], description: 'for a diff target: pre-existing when the failing lines and the failure are already present at the review base; omitted counts as introduced' },
        },
        required: ['id', 'summary', 'evidence', 'proposal', 'repro', 'impact', 'file', 'quote'],
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
    origin: { type: 'string', enum: ['introduced', 'pre-existing'], description: 'for a diff target: your own check of whether the failure is already present at the review base' },
  },
  required: ['verdict', 'evidence'],
}

const DECISIONS_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        ...VERDICT_SCHEMA,
        properties: { id: { type: 'string' }, ...VERDICT_SCHEMA.properties },
        required: ['id', ...VERDICT_SCHEMA.required],
      },
    },
  },
  required: ['decisions'],
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
const lensResults = AUDIT_MODE === 'split'
  ? await pipeline(LENSES, auditLens, verifyLensFindings)
  : await auditCombinedLenses()
return summarize(lensResults)

async function auditCombinedLenses() {
  const schema = {
    type: 'object',
    properties: {
      audits: {
        type: 'array',
        items: {
          ...FINDINGS_SCHEMA,
          properties: { lens: { type: 'string', enum: LENSES.map((lens) => lens.key) }, ...FINDINGS_SCHEMA.properties },
          required: ['lens', ...FINDINGS_SCHEMA.required],
        },
      },
    },
    required: ['audits'],
  }
  let response
  try {
    response = await agent(`${COMMON}\nInspect each required lens and return exactly one audit per lens. Reuse context reads, not conclusions between lenses.\nLenses: ${JSON.stringify(LENSES)}`, {
      label: 'audit:combined', phase: 'Audit', schema, model: MODEL, effort: EFFORT, agentType: AUDITOR_TYPE,
    })
  } catch (e) {
    return LENSES.map((lens) => ({ lens: lens.key, verified: [], notes: '', failed: true }))
  }
  const audits = Array.isArray(response?.audits) ? response.audits : []
  const unknown = audits.some((audit) => !LENSES.some((lens) => lens.key === audit?.lens))
  const groups = LENSES.map((lens) => {
    const matching = audits.filter((audit) => audit?.lens === lens.key)
    const audit = !unknown && matching.length === 1 ? matching[0] : null
    return { lens: lens.key, findings: audit?.findings, notes: audit?.notes || '', failed: !hasValidFindingIds(audit?.findings) }
  })
  const findings = groups.filter((group) => !group.failed).flatMap((group) => group.findings.map((finding) => ({ ...finding, id: `${group.lens}:${finding.id}` })))
  const batch = await verifyLensFindings({ findings }, { key: 'combined' })
  return groups.map((group) => ({ lens: group.lens, failed: group.failed || Boolean(batch.failed), notes: group.notes,
    verified: (batch.verified || []).filter((finding) => group.findings?.some((local) => finding.id === `${group.lens}:${local.id}`)).map((finding) => ({ ...finding, id: finding.id.slice(group.lens.length + 1), lens: group.lens })),
  }))
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

function buildCommonPrompt() {
  return `You are a read-only auditor; do not modify any file.
Target: ${TARGET}
${GUARDRAILS}
Finding discipline (a violation voids the finding):
- Every finding needs disk evidence: a file:line quote or the actual output of a command. Distrust counters, labels and claims in documents until you re-check them on disk.
- No impression critique: report a finding only when it converts into a cost (wrong behavior, bytes, misclassification, double maintenance).
- Put in evidence and proposal only what the judgment needs, in complete sentences; no arrow chains or abbreviations.
- Run this audit yourself; do not delegate to subagents. Required lens coverage remains complete when lenses share one auditor.`
}

function auditLens(lens) {
  return agent(`${COMMON}\n\n${lens.prompt}`, {
    label: `audit:${lens.key}`, phase: 'Audit', schema: FINDINGS_SCHEMA, model: MODEL, effort: EFFORT, agentType: AUDITOR_TYPE,
  })
}

async function verifyLensFindings(audit, lens) {
  if (!hasValidFindingIds(audit?.findings)) return { lens: lens.key, verified: [], notes: '', failed: true }
  const findings = audit.findings
  const ids = findings.map((finding) => finding?.id)
  const notes = audit.notes || ''
  if (findings.length === 0) return { lens: lens.key, verified: [], notes }
  try {
    const response = await agent(buildVerifyPrompt(findings), {
      label: `verify:${lens.key}`, phase: 'Verify', schema: DECISIONS_SCHEMA, model: MODEL, effort: EFFORT, agentType: AUDITOR_TYPE,
    })
    const decisions = Array.isArray(response?.decisions) ? response.decisions : []
    const hasUnknownDecision = decisions.some((item) => !ids.includes(item?.id))
    const verified = findings.map((finding) => {
      const matching = decisions.filter((item) => item?.id === finding.id)
      const verdict = !hasUnknownDecision && matching.length === 1 && isEvidencedVerdict(matching[0]) ? matching[0] : null
      return applyVerdict(finding, lens, demoteIncompleteAdjustment(verdict))
    })
    return { lens: lens.key, verified, notes }
  } catch (e) {
    return { lens: lens.key, verified: findings.map((finding) => ({ ...finding, lens: lens.key, verdict: null, verifyError: String(e?.message || e) })), notes }
  }
}

function hasValidFindingIds(findings) {
  if (!Array.isArray(findings)) return false
  const ids = findings.map((finding) => finding?.id)
  return ids.every((id) => typeof id === 'string' && id.trim()) && new Set(ids).size === ids.length
}

function isEvidencedVerdict(decision) {
  return ['CONFIRMED', 'ADJUSTED', 'REFUTED'].includes(decision.verdict) && typeof decision.evidence === 'string' && decision.evidence.trim().length > 0
}

function buildVerifyPrompt(findings) {
  return `${COMMON}

You are an adversarial verifier in a separate context from the finder (author != reviewer). Try to REFUTE each finding below with disk evidence. Do not repeat the full audit. Return one decision per finding id; share relevant reads across these findings, but provide evidence for each decision:
(a) Does the quote match the actual file:line? Re-measure any numbers.
(b) Does an alternative explanation hold (by design, already fixed, a different cause, a measurement error)?
(c) Is the proposal safe (side effects, the other side of a double-maintained surface)?
(d) When the repro is a command or input, run it (temp files only): a repro that does not show the observed failure refutes the finding.
(e) For a diff target, set origin from your own read of the review base, not from the finding's origin.
Refutation fails: CONFIRMED. Partial correction: ADJUSTED (adjusted_summary and adjusted_proposal required). Insufficient evidence: lean toward REFUTED.
A CONFIRMED without a refutation attempt is void; put the commands you ran and their output in evidence.

Findings: ${JSON.stringify(findings)}`
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
