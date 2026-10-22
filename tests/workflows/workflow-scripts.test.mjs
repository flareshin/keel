import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  WORKFLOWS_DIR, readScript, extractMetaText, isPureLiteral, createRuntime, createSandbox,
  reportBetweenMarkers, evidenceLines, parseEvidenceLine, preparePromptCommands, preparedLine, cleanRuleChecksNotes, KEEL_HOME,
} from './helpers.mjs'

const SCRIPTS = ['adversarial-audit', 'lens-review']

for (const name of SCRIPTS) {
  test(`${name}_metaIsAPureLiteralNamedAfterTheFile_whenLoaded`, () => {
    // given
    const metaText = extractMetaText(readScript(name))
    // when
    const meta = new Function(`return (${metaText})`)()
    // then
    assert.ok(isPureLiteral(metaText))
    assert.equal(meta.name, name)
    assert.equal(typeof meta.description, 'string')
  })

  test(`${name}_avoidsNonReplayableBuiltIns_whenScanned`, () => {
    // given
    const source = readScript(name)
    // when
    const banned = source.match(/Date\.now\(|Math\.random\(|new Date\(/g)
    // then
    assert.equal(banned, null)
  })

  test(`${name}_namesModelAndEffortAtEveryAgentCallSite_whenScanned`, () => {
    // given
    const callSites = agentCallSites(readScript(name))
    // when
    const unnamed = callSites.filter((site) => !/\bmodel:/.test(site) || !/\beffort:/.test(site))
    // then
    assert.ok(callSites.length > 0)
    assert.deepEqual(unnamed, [])
  })
}

test('workflowAgentTypes_shipAsLinkedAgentFilesWithTheirToolLimitAndNoPin_whenScanned', () => {
  const named = [...new Set(SCRIPTS.flatMap((name) => [...readScript(name).matchAll(/_TYPE = '([\w-]+)'/g)].map((match) => match[1])))].sort()
  const links = readFileSync(join(KEEL_HOME, 'settings', 'links.tsv'), 'utf8')

  const definitions = named.map((type) => {
    const frontmatter = readFileSync(join(KEEL_HOME, 'agents', `${type}.md`), 'utf8').split('\n---\n')[0]
    const field = (key) => (frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm')) || [])[1]
    return { type, name: field('name'), tools: field('tools'), model: field('model'), effort: field('effort'), linked: links.includes(`{{KEEL}}/agents/${type}.md\tagents/${type}.md\n`) }
  })

  assert.deepEqual(definitions, [
    { type: 'keel-auditor', name: 'keel-auditor', tools: 'Bash, Read, Skill', model: undefined, effort: undefined, linked: true },
    { type: 'keel-reporter', name: 'keel-reporter', tools: 'Read', model: undefined, effort: undefined, linked: true },
  ])
})

test('isPureLiteral_rejectsInterpolationAndVariables_whenMetaIsNotLiteral', () => {
  // given
  const samples = ["{ name: NAME }", "{ name: `x${y}` }", "{ ...base, name: 'x' }", "{ name: make('x') }"]
  // when
  const verdicts = samples.map(isPureLiteral)
  // then
  assert.deepEqual(verdicts, [false, false, false, false])
  assert.equal(isPureLiteral("{ name: 'x', phases: [{ title: 'A', n: 2, ok: true }] }"), true)
})

test('reviewLenses_holdsKeyedPromptsAndGuardrails_whenParsed', () => {
  // given
  const file = JSON.parse(readFileSync(join(WORKFLOWS_DIR, 'review-lenses.json'), 'utf8'))
  // when
  const shapes = file.lenses.map((lens) => typeof lens.key === 'string' && typeof lens.prompt === 'string')
  // then
  assert.ok(file.lenses.length > 0)
  assert.ok(shapes.every(Boolean))
  assert.equal(typeof file.guardrails, 'string')
})

// Same literal as the private overlay's own contract-lens test: a caller that passes its own lenses never reads this file.
const GRADED_SAFETY_FACT = 'In your notes, name the one fact the change is safe because of (for example: the new parser accepts only the format the real files use) and grade it: cited (a file:line), reasoned (the failure case walked step by step and shown not to reach), or run (a command or test that exercises the real code or real data, its output quoted); write unproven when none applies. The graded fact informs the owner and is a finding only when it is shown false.'

test('reviewLenses_contractLensAsksForTheGradedSafetyFactInNotes_whenParsed', () => {
  // given
  const file = JSON.parse(readFileSync(join(WORKFLOWS_DIR, 'review-lenses.json'), 'utf8'))
  // when
  const contract = file.lenses.find((lens) => lens.key === 'contract')
  // then
  assert.ok(contract.prompt.includes(GRADED_SAFETY_FACT), contract.prompt)
})

test('lensReview_prepareCommandsYieldEvidenceForRealRepo_whenRunInBash', async () => {
  // given
  const box = createSandbox()
  const repo = join(box.root, 'app')
  execFileSync('git', ['init', '-q', repo], { env: box.env })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  box.git(repo, 'add', '-A')
  box.git(repo, 'commit', '-qm', 'base')
  const baseSha = box.git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  writeFileSync(join(repo, 'b.txt'), 'new\n')
  const rt = createRuntime({ respond: shellResponder(box) })
  // when
  const result = await rt.run('lens-review', { auditMode: 'split', diffs: [{ repo, base: 'main' }] })
  // then
  assert.equal(result.verdict, 'PASS')
  const evidence = parseEvidenceLine(evidenceLines(result.report)[0])
  assert.equal(evidence.repo_root, repo)
  assert.equal(evidence.review_base, baseSha)
  assert.match(evidence.run_id, /^rv-\d{8}T\d{6}Z-[0-9a-f]{6}$/)
  assert.equal(box.git(repo, 'diff', '--name-only', evidence.review_base, evidence.snapshot_tree), 'a.txt\nb.txt')
  assert.equal(box.git(repo, 'diff', '--cached', '--name-only'), '')
  assert.match(result.report, /2 files changed/)
  assert.deepEqual(result.lensesFired, ['reuse', 'contract', 'tests', 'readable-code', 'rule-checks'])
})

test('lensReview_cliPreparedSnapshotRunsWithoutPrepareAgent_whenCandidateMovesLater', async () => {
  const box = createSandbox()
  const repo = join(box.root, 'app')
  execFileSync('git', ['init', '-q', repo], { env: box.env })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  box.git(repo, 'add', '-A')
  box.git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  const request = { diffs: [{ repo, base: 'main' }] }
  const prepared = JSON.parse(execFileSync(join(KEEL_HOME, 'bin', 'keel'), ['review', 'prepare'], {
    env: box.env, input: JSON.stringify(request), encoding: 'utf8',
  }))
  const target = JSON.parse(prepared.diff_outputs[0])
  writeFileSync(join(repo, 'a.txt'), 'three\n')
  const rt = createRuntime({ respond: (prompt, opts) => {
    if (opts.label === 'report') return reportBetweenMarkers(prompt)
    assert.equal(opts.label, 'audit:combined')
    return { audits: opts.schema.properties.audits.items.properties.lens.enum.map((lens) => ({
      lens, findings: [], notes: lens === 'rule-checks' ? cleanRuleChecksNotes(prompt) : 'inspected',
    })) }
  } })

  const result = await rt.run('lens-review', { ...request, prepared })

  assert.equal(result.verdict, 'PASS')
  assert.deepEqual(rt.record.agents.map(({ opts }) => opts.label), ['audit:combined', 'report'])
  const evidence = parseEvidenceLine(evidenceLines(result.report)[0])
  assert.equal(evidence.snapshot_tree, target.snapshot_tree)
  assert.equal(box.git(repo, 'show', `${evidence.snapshot_tree}:a.txt`), 'two')
  assert.deepEqual(result.lensesFired, ['reuse', 'contract', 'tests', 'readable-code', 'rule-checks'])
  assert.equal(box.git(repo, 'diff', '--cached', '--name-only'), '')
})

test('lensReview_prepareCommandResolvesCommitRange_whenHeadIsABranch', async () => {
  // given
  const box = createSandbox()
  const repo = join(box.root, 'app')
  execFileSync('git', ['init', '-q', repo], { env: box.env })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  box.git(repo, 'add', '-A')
  box.git(repo, 'commit', '-qm', 'base')
  const baseSha = box.git(repo, 'rev-parse', 'HEAD')
  box.git(repo, 'switch', '-qc', 'feature/x')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  box.git(repo, 'commit', '-qam', 'change')
  const headSha = box.git(repo, 'rev-parse', 'HEAD')
  const rt = createRuntime({ respond: shellResponder(box) })
  // when
  const result = await rt.run('lens-review', { auditMode: 'split', diffs: [{ repo, base: 'main', head: 'feature/x' }], runId: 'rv-fixed-0001' })
  // then
  const evidence = parseEvidenceLine(evidenceLines(result.report)[0])
  assert.deepEqual([evidence.review_base, evidence.head, evidence.snapshot_tree], [baseSha, headSha, null])
  assert.equal(evidence.root_run_id, 'rv-fixed-0001')
  assert.match(result.report, /1 file changed/)
})

test('lensReviewExamples_passArgsValidation_whenRunWithStubbedAgents', async () => {
  // given
  const examples = JSON.parse(readFileSync(join(KEEL_HOME, 'examples', 'review-engine', 'lens-review-args.example.json'), 'utf8'))
  const { lenses, guardrails } = JSON.parse(readFileSync(join(WORKFLOWS_DIR, 'review-lenses.json'), 'utf8'))
  const respond = (prompt, opts) => {
    if (opts.label === 'prepare') return { diff_outputs: [preparedLine()], run_id_output: 'rv-20261011T093000Z-0c1d2e', lenses_output: { lenses, guardrails } }
    if (opts.label === 'report') return reportBetweenMarkers(prompt)
    return { findings: [], notes: opts.label === 'audit:rule-checks' ? cleanRuleChecksNotes(prompt) : 'clean' }
  }
  // when
  const verdicts = []
  for (const scriptArgs of [examples.root, examples.delta]) verdicts.push((await createRuntime({ respond }).run('lens-review', { ...scriptArgs, auditMode: 'split' })).verdict)
  // then
  assert.deepEqual(verdicts, ['PASS', 'PASS'])
})

// Plays the prepare agent and the rule-checks auditor by running their prompts' commands in bash, so the shell text itself is under test.
function shellResponder(box) {
  return (prompt, opts) => {
    if (opts.label === 'prepare') {
      const commands = preparePromptCommands(prompt)
      return {
        diff_outputs: commands.diffs.map((command) => runOrReportError(box, command)),
        run_id_output: commands.runId ? box.bash(commands.runId) : '',
        lenses_output: commands.lenses ? JSON.parse(box.bash(commands.lenses)) : { lenses: [], guardrails: '' },
      }
    }
    if (opts.label === 'report') return reportBetweenMarkers(prompt)
    if (opts.label === 'audit:rule-checks') return { findings: [], notes: runRuleChecksCommands(box, prompt) }
    return { findings: [], notes: 'clean' }
  }
}

function runOrReportError(box, command) {
  try {
    return box.bash(command)
  } catch (e) {
    return `ERROR: ${String(e.stderr).trim()}`
  }
}

function runRuleChecksCommands(box, prompt) {
  const commands = prompt.split('\n').filter((line) => line.startsWith('python3 '))
  return commands.map((command) => box.bash(command).split('\n').at(-1)).join('\n')
}

function agentCallSites(source) {
  const sites = []
  let from = source.indexOf('agent(')
  while (from >= 0) {
    const isCall = !/[\w.]/.test(source[from - 1] || '')
    if (isCall) sites.push(source.slice(from, closingParen(source, from + 'agent'.length) + 1))
    from = source.indexOf('agent(', from + 1)
  }
  return sites
}

function closingParen(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++
    if (source[i] === ')') depth--
    if (depth === 0) return i
  }
  throw new Error('unbalanced agent( call')
}

function commitTwice(box) {
  const repo = join(box.root, 'app')
  execFileSync('git', ['init', '-q', repo], { env: box.env })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  box.git(repo, 'add', '-A')
  box.git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  box.git(repo, 'commit', '-qam', 'reviewed')
  return repo
}

test('lensReview_prepareCommandDiffsFromSinceTree_whenSinceIsATree', async () => {
  // given
  const box = createSandbox()
  const repo = commitTwice(box)
  const sinceTree = box.git(repo, 'rev-parse', 'HEAD^{tree}')
  writeFileSync(join(repo, 'a.txt'), 'three\n')
  const rt = createRuntime({ respond: shellResponder(box) })
  // when
  const result = await rt.run('lens-review', { auditMode: 'split', diffs: [{ repo, base: 'HEAD~1', since: sinceTree }], rootRunId: 'rv-root-0001' })
  // then
  assert.equal(result.verdict, 'PASS')
  assert.equal(parseEvidenceLine(evidenceLines(result.report)[0]).since, sinceTree)
  assert.match(result.report, /1 file changed/)
})

test('lensReview_failsInPrepareNamingTheTree_whenSinceIsACommit', async () => {
  // given
  const box = createSandbox()
  const repo = commitTwice(box)
  const commit = box.git(repo, 'rev-parse', 'HEAD')
  const rt = createRuntime({ respond: shellResponder(box) })
  // when
  const result = await rt.run('lens-review', { auditMode: 'split', diffs: [{ repo, base: 'HEAD~1', since: commit }], rootRunId: 'rv-root-0001' })
  // then
  assert.equal(result.verdict, 'ERROR')
  assert.match(result.error, new RegExp(`prepare failed for diffs\\[0\\] [\\s\\S]*since ${commit} is not a tree id`))
  assert.deepEqual(rt.record.agents.map((call) => call.opts.label), ['prepare'])
})
