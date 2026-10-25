import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { readCoverage } from '../../lib/precheck/coverage.ts'
import { executedLineNumbers } from '../precheck/fixture.ts'

const HELPERS_URL = new URL('./helpers.mjs', import.meta.url).href
const FIXTURE = [
  "export const meta = { name: 'fixture' }",
  'if (args.flag) {',
  "  log('taken')",
  '} else {',
  "  log('untaken')",
  '}',
  'function neverCalled() {',
  '  return 0',
  '}',
  'return meta.name',
]

describe('compileWorkflowFile coverage', () => {
  let root

  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'keel-wf-coverage-'))) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('compileWorkflowFile_reportsCoverageOnTheWorkflowFilesOwnLines_withTheUntakenElseAndUncalledFunctionLeftOut', () => {
    const workflowFile = join(root, 'fixture.js')
    writeFileSync(workflowFile, FIXTURE.join('\n') + '\n')
    const runner = join(root, 'run.mjs')
    writeFileSync(runner, [
      `import { compileWorkflowFile } from ${JSON.stringify(HELPERS_URL)}`,
      `const run = compileWorkflowFile(${JSON.stringify(workflowFile)})`,
      "const name = await run({ flag: true }, null, null, null, null, () => {}, null)",
      "if (name !== 'fixture') process.exit(1)",
    ].join('\n'))
    const coverageDir = join(root, 'coverage')
    const result = spawnSync(process.execPath, [runner], { env: { ...process.env, NODE_V8_COVERAGE: coverageDir }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)

    const coverage = readCoverage(coverageDir, root)
    assert.ok(coverage.seen.has('fixture.js'), `seen: ${[...coverage.seen]}`)
    assert.deepEqual(executedLineNumbers(workflowFile, coverage.executedSpans.get('fixture.js')), [1, 2, 3, 4, 10])
  })
})
