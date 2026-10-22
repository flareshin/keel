import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from './helpers.mjs'

const LENSES = [{ key: 'contract', prompt: 'Lens: contract.' }, { key: 'tests', prompt: 'Lens: tests.' }]

function finding(id, impact = 'high') {
  return { id, summary: `summary ${id}`, evidence: 'a.py:1 quote', proposal: `fix ${id}`, impact, file: '/work/app/a.py', quote: 'a.py:1 x', change: 'y' }
}

function respondWith({ audits = {}, verdicts = {} }) {
  return (prompt, opts) => {
    if (opts.label.startsWith('audit:')) {
      const audit = audits[opts.label.slice('audit:'.length)]
      if (audit instanceof Error) throw audit
      return audit === undefined ? { findings: [], notes: 'clean' } : audit
    }
    if (opts.schema.properties.decisions) {
      const findings = JSON.parse(prompt.split('\nFindings: ')[1])
      return { decisions: findings.flatMap((finding) => {
        const verdict = verdicts[finding.id]
        if (verdict instanceof Error) throw verdict
        return verdict ? [{ id: finding.id, ...verdict }] : []
      }) }
    }
    const verdict = verdicts[opts.label.slice('verify:'.length)]
    if (verdict instanceof Error) throw verdict
    return verdict
  }
}

test('adversarialAudit_returnsErrorWithoutAgents_whenTargetMissing', async () => {

  const rt = createRuntime({ respond: () => { throw new Error('no agent expected') } })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', lenses: LENSES })

  assert.equal(result.error, 'missing args: target, lenses')
  assert.equal(rt.record.agents.length, 0)
})

test('adversarialAudit_returnsErrorWithoutAgents_whenLensShapeIsWrong', async () => {

  const rt = createRuntime({ respond: () => { throw new Error('no agent expected') } })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: [{ key: 'contract' }] })

  assert.equal(result.error, 'bad lens shape at index 0')
  assert.equal(rt.record.agents.length, 0)
})

test('adversarialAudit_partitionsFindingsByVerdict_whenVerifiersAnswer', async () => {

  const audits = { contract: { findings: [finding('c1'), finding('c2'), finding('c3'), finding('c4')], notes: 'grep ran' } }
  const verdicts = {
    c1: { verdict: 'CONFIRMED', evidence: 'reran' },
    c2: { verdict: 'REFUTED', evidence: 'by design' },
    c3: { verdict: 'ADJUSTED', evidence: 'partly', adjusted_summary: 'narrower', adjusted_proposal: 'smaller fix' },
    c4: null,
  }
  const rt = createRuntime({ respond: respondWith({ audits, verdicts }) })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.deepEqual(result.confirmed.map((f) => f.id), ['c1', 'c3'])
  assert.deepEqual(result.refuted.map((f) => f.id), ['c2'])
  assert.deepEqual(result.unverified.map((f) => f.id), ['c4'])
  assert.deepEqual(result.failedLenses, [])
  const adjusted = result.confirmed[1]
  assert.equal(adjusted.summary, 'narrower')
  assert.equal(adjusted.original_summary, 'summary c3')
  assert.equal(adjusted.original_change, 'y')
  assert.match(adjusted.change, /^N\/A - ADJUSTED/)
  assert.equal(adjusted.lens, 'contract')
})

test('adversarialAudit_keepsAuditorAndVerifierOriginApart_whenBothAreGiven', async () => {

  const audits = { contract: { findings: [{ ...finding('c1'), origin: 'pre-existing' }] } }
  const verdicts = { c1: { verdict: 'CONFIRMED', evidence: 'the line is new', origin: 'introduced' } }
  const rt = createRuntime({ respond: respondWith({ audits, verdicts }) })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.equal(result.confirmed[0].origin, 'pre-existing')
  assert.equal(result.confirmed[0].verdict.origin, 'introduced')
  const audit = rt.record.agents.find((call) => call.opts.label === 'audit:contract')
  assert.deepEqual(audit.opts.schema.properties.findings.items.properties.origin.enum, ['introduced', 'pre-existing'])
  const verify = rt.record.agents.find((call) => call.opts.label === 'verify:contract')
  assert.deepEqual(verify.opts.schema.properties.decisions.items.properties.origin.enum, ['introduced', 'pre-existing'])
  assert.match(verify.prompt, /set origin from your own read of the review base, not from the finding's origin/)
})

test('adversarialAudit_asksCombinedAuditorForOrigin_inItsFindingSchema', async () => {

  const rt = createRuntime({ respond: (prompt, opts) => ({ audits: LENSES.map((lens) => ({ lens: lens.key, findings: [] })) }) })

  await rt.run('adversarial-audit', { target: '/work/app', lenses: LENSES })

  const audit = rt.record.agents.find((call) => call.opts.label === 'audit:combined')
  assert.deepEqual(audit.opts.schema.properties.audits.items.properties.findings.items.properties.origin.enum, ['introduced', 'pre-existing'])
})

test('adversarialAudit_demotesAdjustedToRefuted_whenAdjustedFieldsMissing', async () => {

  const audits = { contract: { findings: [finding('c1')] } }
  const verdicts = { c1: { verdict: 'ADJUSTED', evidence: 'partly' } }
  const rt = createRuntime({ respond: respondWith({ audits, verdicts }) })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.equal(result.confirmed.length, 0)
  assert.equal(result.refuted[0].verdict.verdict, 'REFUTED')
  assert.match(result.refuted[0].verdict.evidence, /AUTO-DEMOTED/)
})

test('adversarialAudit_reportsFailedLens_whenAuditorReturnsNothing', async () => {

  const rt = createRuntime({ respond: respondWith({ audits: { tests: null } }) })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.deepEqual(result.failedLenses, ['tests'])
  assert.deepEqual(result.lensNotes, [{ lens: 'contract', notes: 'clean' }])
  assert.ok(rt.record.logs.some((line) => line.includes('auditor did not run: tests')))
})

test('adversarialAudit_keepsFindingAsUnverified_whenVerifierThrows', async () => {

  const audits = { contract: { findings: [finding('c1')] } }
  const rt = createRuntime({ respond: respondWith({ audits, verdicts: { c1: new Error('api down') } }) })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.equal(result.unverified.length, 1)
  assert.equal(result.unverified[0].verifyError, 'api down')
})

test('adversarialAudit_namesModelAndEffortOnEveryAgent_whenDefaultsApply', async () => {

  const audits = { contract: { findings: [finding('c1')] } }
  const rt = createRuntime({ respond: respondWith({ audits, verdicts: { c1: { verdict: 'CONFIRMED', evidence: 'reran' } } }) })

  await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.deepEqual(rt.record.unnamedModelOrEffort, [])
  assert.deepEqual(rt.record.agents.map((call) => [call.opts.label, call.opts.model, call.opts.effort]), [
    ['audit:contract', 'opus', 'high'],
    ['audit:tests', 'opus', 'high'],
    ['verify:contract', 'opus', 'high'],
  ])
})

test('adversarialAudit_usesCallerModelAndEffort_whenArgsAreAJsonString', async () => {

  const rt = createRuntime({ respond: respondWith({}) })
  const argsText = JSON.stringify({ auditMode: 'split', target: '/work/app', lenses: LENSES.slice(0, 1), model: 'model-x', effort: 'xhigh' })

  const result = await rt.run('adversarial-audit', argsText)

  assert.deepEqual(result.confirmed, [])
  assert.equal(rt.record.agents[0].opts.model, 'model-x')
  assert.equal(rt.record.agents[0].opts.effort, 'xhigh')
  assert.match(rt.record.agents[0].prompt, /Target: \/work\/app/)
})

test('adversarialAudit_asksForReproAndRunsIt_whenAuditingAndVerifying', async () => {

  const audits = { contract: { findings: [finding('c1')] } }
  const rt = createRuntime({ respond: respondWith({ audits, verdicts: { c1: { verdict: 'CONFIRMED', evidence: 'reran' } } }) })

  await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  const auditCall = rt.record.agents.find((call) => call.opts.label === 'audit:contract')
  const findingSchema = auditCall.opts.schema.properties.findings.items
  assert.ok(findingSchema.required.includes('repro'))
  assert.equal(findingSchema.properties.repro.type, 'string')
  const verifyCall = rt.record.agents.find((call) => call.opts.label === 'verify:contract')
  assert.match(verifyCall.prompt, /a repro that does not show the observed failure refutes the finding/)
})

for (const auditMode of ['combined', 'split']) {
  test(`adversarialAudit_requestsDiagnosisWithoutReplacementPatch_whenModeIs${auditMode}`, async () => {
    const diagnosis = { id: 'c1', summary: 'Missing cap', evidence: 'a.py:1 caller proof', proposal: 'Apply the per-line cap',
      repro: 'static: caller at a.py:1', impact: 'medium', file: '/work/app/a.py', quote: 'a.py:1 total = price' }
    const rt = createRuntime({ respond: (prompt, opts) => {
      if (opts.label === 'audit:combined') return { audits: [{ lens: 'contract', findings: [diagnosis] }] }
      if (opts.label === 'audit:contract') return { findings: [diagnosis] }
      const sent = JSON.parse(prompt.split('\nFindings: ')[1])
      assert.equal('change' in sent[0], false)
      return { decisions: [{ id: sent[0].id, verdict: 'CONFIRMED', evidence: 'independent caller proof' }] }
    } })

    const result = await rt.run('adversarial-audit', { target: '/work/app', lenses: LENSES.slice(0, 1), auditMode })

    const schema = rt.record.agents[0].opts.schema.properties
    const findingSchema = (schema.audits ? schema.audits.items.properties : schema).findings.items
    assert.equal('change' in findingSchema.properties, false)
    assert.equal(findingSchema.required.includes('change'), false)
    assert.ok(findingSchema.required.includes('evidence'))
    assert.ok(findingSchema.required.includes('repro'))
    assert.equal(result.confirmed.length, 1)
    assert.equal(result.confirmed[0].proposal, diagnosis.proposal)
    assert.deepEqual(result.failedLenses, [])
  })
}

test('adversarialAudit_reportsFailedLens_whenAuditorThrows', async () => {

  const rt = createRuntime({ respond: respondWith({ audits: { tests: new Error('api down') } }) })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.deepEqual(result.failedLenses, ['tests'])
  assert.deepEqual(result.lensNotes, [{ lens: 'contract', notes: 'clean' }])
  assert.ok(rt.record.logs.some((line) => line.includes('auditor did not run: tests')))
})

test('adversarialAudit_putsGuardrailsInAuditAndVerifyPrompts_whenGiven', async () => {

  const audits = { contract: { findings: [finding('c1')] } }
  const rt = createRuntime({ respond: respondWith({ audits, verdicts: { c1: { verdict: 'CONFIRMED', evidence: 'reran' } } }) })

  await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES, guardrails: 'GUARD-XYZ: style is not a defect.' })

  assert.deepEqual(rt.record.agents.map((call) => call.opts.label), ['audit:contract', 'audit:tests', 'verify:contract'])
  for (const call of rt.record.agents) assert.match(call.prompt, /GUARD-XYZ: style is not a defect\./)
})

for (const [name, partial] of [['OnlySummaryIsGiven', { adjusted_summary: 'narrower' }], ['OnlyProposalIsGiven', { adjusted_proposal: 'smaller fix' }]]) {
  test(`adversarialAudit_demotesAdjustedToRefuted_when${name}`, async () => {

    const audits = { contract: { findings: [finding('c1')] } }
    const rt = createRuntime({ respond: respondWith({ audits, verdicts: { c1: { verdict: 'ADJUSTED', evidence: 'partly', ...partial } } }) })

    const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

    assert.equal(result.confirmed.length, 0)
    assert.match(result.refuted[0].verdict.evidence, /AUTO-DEMOTED/)
  })
}

test('adversarialAudit_capsFindingsSchema_whenMaxFindingsPerLensIsGiven', async () => {

  const rt = createRuntime({ respond: respondWith({}) })

  await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES, maxFindingsPerLens: 3 })

  assert.deepEqual(rt.record.agents.map((call) => call.opts.schema.properties.findings.maxItems), [3, 3])
})

test('adversarialAudit_batchesSameLensFindings_inOneIndependentVerifier', async () => {
  const audits = { contract: { findings: [finding('c1'), finding('c2'), finding('c3')] } }
  const verdicts = Object.fromEntries(['c1', 'c2', 'c3'].map((id) => [id, { verdict: 'CONFIRMED', evidence: 'static caller proof' }]))
  const rt = createRuntime({ respond: respondWith({ audits, verdicts }) })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.equal(result.confirmed.length, 3)
  assert.equal(rt.record.agents.filter((call) => call.opts.label.startsWith('verify:')).length, 1)
  assert.match(rt.record.agents.at(-1).prompt, /Do not repeat the full audit/)
})

test('adversarialAudit_leavesMissingOrDuplicateDecisionsUnverified_inBatch', async () => {
  const rt = createRuntime({ respond: (prompt, opts) => {
    if (opts.label.startsWith('audit:')) return { findings: [finding('c1'), finding('c2')] }
    return { decisions: [{ id: 'c1', verdict: 'CONFIRMED', evidence: 'proof' },
      { id: 'c1', verdict: 'REFUTED', evidence: 'conflicting proof' }] }
  } })

  const result = await rt.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES.slice(0, 1) })

  assert.equal(result.confirmed.length, 0)
  assert.deepEqual(result.unverified.map((item) => item.id), ['c1', 'c2'])
})

test('adversarialAudit_blocksMalformedAuditAndUnknownDecision_inBatch', async () => {
  const malformed = createRuntime({ respond: () => ({ findings: [finding('c1'), finding('c1')] }) })

  const failed = await malformed.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES.slice(0, 1) })

  assert.deepEqual(failed.failedLenses, ['contract'])
  assert.equal(malformed.record.agents.length, 1)

  const unknown = createRuntime({ respond: (prompt, opts) => opts.label.startsWith('audit:')
    ? { findings: [finding('c1')] }
    : { decisions: [{ id: 'c1', verdict: 'CONFIRMED', evidence: 'proof' },
      { id: 'unknown', verdict: 'REFUTED', evidence: 'unrelated proof' }] } })

  const blocked = await unknown.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES.slice(0, 1) })

  assert.equal(blocked.confirmed.length, 0)
  assert.equal(blocked.unverified.length, 1)
})

test('adversarialAudit_defaultSharesOneAuditor_withoutDroppingLenses', async () => {
  const rt = createRuntime({ respond: (prompt, opts) => ({ audits:
    opts.schema.properties.audits.items.properties.lens.enum.map((lens) => ({ lens, findings: [], notes: `${lens} inspected` })) }) })
  const request = { target: '/work/app', lenses: LENSES }

  const result = await rt.run('adversarial-audit', request)

  assert.equal(rt.record.agents.length, 1)
  assert.deepEqual(result.failedLenses, [])
  assert.deepEqual(result.lensNotes.map((item) => item.lens), ['contract', 'tests'])
})

test('adversarialAudit_combinedMissingLens_staysBlocked', async () => {
  const rt = createRuntime({ respond: () => ({ audits: [{ lens: 'contract', findings: [] }] }) })
  const request = { target: '/work/app', lenses: LENSES }

  const result = await rt.run('adversarial-audit', request)

  assert.deepEqual(result.failedLenses, ['tests'])
})

test('adversarialAudit_combinedFindingsUseOneSeparateVerifier_withDistinctLensIds', async () => {
  const rt = createRuntime({ respond: (prompt, opts) => {
    if (opts.label === 'audit:combined') return { audits: LENSES.map((lens) => ({ lens: lens.key, findings: [finding('A1')] })) }
    return { decisions: ['contract:A1', 'tests:A1'].map((id) => ({ id, verdict: 'CONFIRMED', evidence: 'independent caller proof' })) }
  } })
  const request = { target: '/work/app', lenses: LENSES }

  const result = await rt.run('adversarial-audit', request)

  assert.deepEqual(rt.record.agents.map((call) => call.opts.label), ['audit:combined', 'verify:combined'])
  assert.deepEqual(result.confirmed.map((finding) => `${finding.lens}/${finding.id}`), ['contract/A1', 'tests/A1'])
})

test('adversarialAudit_runsCombinedAuditAndVerifyAsTheAuditorType_inBothModes', async () => {
  const respond = (prompt, opts) => {
    if (opts.label === 'audit:combined') return { audits: LENSES.map((lens) => ({ lens: lens.key, findings: [finding('A1')] })) }
    if (opts.label.startsWith('audit:')) return { findings: [finding('A1')], notes: 'ran' }
    const findings = JSON.parse(prompt.split('\nFindings: ')[1])
    return { decisions: findings.map(({ id }) => ({ id, verdict: 'CONFIRMED', evidence: 'independent caller proof' })) }
  }
  const combined = createRuntime({ respond })
  const split = createRuntime({ respond })

  await combined.run('adversarial-audit', { target: '/work/app', lenses: LENSES })
  await split.run('adversarial-audit', { auditMode: 'split', target: '/work/app', lenses: LENSES })

  assert.deepEqual(combined.record.agents.map(({ opts }) => [opts.label, opts.agentType]), [
    ['audit:combined', 'keel-auditor'],
    ['verify:combined', 'keel-auditor'],
  ])
  assert.deepEqual(split.record.agents.map(({ opts }) => [opts.label, opts.agentType]).sort(), [
    ['audit:contract', 'keel-auditor'],
    ['audit:tests', 'keel-auditor'],
    ['verify:contract', 'keel-auditor'],
    ['verify:tests', 'keel-auditor'],
  ])
})

test('adversarialAudit_blocksCollidingCombinedIds_withoutLosingFindingsSilently', async () => {
  const rt = createRuntime({ respond: () => ({ audits: [
    { lens: 'contract', findings: [finding('api:A1')] },
    { lens: 'contract:api', findings: [finding('A1')] },
  ] }) })

  const result = await rt.run('adversarial-audit', { target: '/work/app', lenses: [
    { key: 'contract', prompt: 'Contract' }, { key: 'contract:api', prompt: 'API' },
  ] })

  assert.deepEqual(result.failedLenses, ['contract', 'contract:api'])
  assert.equal(rt.record.agents.length, 1)
})

test('adversarialAudit_assignsCombinedFindingsToExactLens_whenKeysSharePrefix', async () => {
  const rt = createRuntime({ respond: (prompt, opts) => {
    if (opts.label === 'audit:combined') return { audits: [
      { lens: 'contract', findings: [finding('A1')] },
      { lens: 'contract:api', findings: [finding('A1')] },
    ] }
    return { decisions: ['contract:A1', 'contract:api:A1'].map((id) => ({ id, verdict: 'CONFIRMED', evidence: 'caller proof' })) }
  } })

  const result = await rt.run('adversarial-audit', { target: '/work/app', lenses: [
    { key: 'contract', prompt: 'Contract' }, { key: 'contract:api', prompt: 'API' },
  ] })

  assert.deepEqual(result.confirmed.map((item) => [item.lens, item.id]), [['contract', 'A1'], ['contract:api', 'A1']])
})
