import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import { candidateTests } from "../../lib/precheck/select.ts"

const KEEL_ROOT = join(import.meta.dirname, "..", "..")

describe("candidateTests", () => {
  const roots: string[] = []
  after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
  const repo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "precheck-select-"))
    roots.push(root)
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return root
  }

  it("candidateTests_selectsATestThatImportsTheChangedFile_directlyOrThroughAnotherSource", () => {
    const root = repo({
      "lib/a.ts": "export const a = 1",
      "lib/b.ts": "import { a } from './a.ts'\nexport const b = a",
      "tests/direct.test.ts": "import { a } from '../lib/a.ts'",
      "tests/indirect.test.ts": "import { b } from '../lib/b.ts'",
      "tests/other.test.ts": "import { c } from '../lib/c.ts'",
      "lib/c.ts": "export const c = 3",
    })

    assert.deepEqual(candidateTests(root, ["lib/a.ts"]), ["tests/direct.test.ts", "tests/indirect.test.ts"])
  })

  it("candidateTests_followsABareImport_aDynamicImport_andARequireInsideASource", () => {
    const root = repo({
      "lib/a.ts": "export const a = 1",
      "lib/bare.ts": "import './a.ts'",
      "lib/dynamic.ts": "const { a } = await import(\"./a.ts\")",
      "lib/required.ts": "const { a } = require('./a.ts')",
      "tests/bare.test.ts": "import '../lib/bare.ts'",
      "tests/dynamic.test.ts": "import '../lib/dynamic.ts'",
      "tests/required.test.ts": "import '../lib/required.ts'",
    })

    assert.deepEqual(candidateTests(root, ["lib/a.ts"]), [
      "tests/bare.test.ts",
      "tests/dynamic.test.ts",
      "tests/required.test.ts",
    ])
  })

  it("candidateTests_selectsATestWhoseHelperNamesASpawnedScriptThatImportsTheChangedFile", () => {
    const root = repo({
      "lib/a.ts": "export const a = 1",
      "hooks/guard/guard.ts": "import { a } from '../../lib/a.ts'",
      "tests/hooks/helpers.ts": "export const GUARD = 'hooks/guard/guard.ts'",
      "tests/hooks/guard.test.ts": "import { GUARD } from './helpers.ts'",
    })

    assert.deepEqual(candidateTests(root, ["lib/a.ts"]), ["tests/hooks/guard.test.ts"])
  })

  it("candidateTests_selectsATestThatReadsAFixtureNamingTheChangedFile", () => {
    const root = repo({
      "hooks/guard/guard.ts": "export {}",
      "tests/hooks/fixtures/parity/cases.jsonl": "{\"script\":\"hooks/guard/guard.ts\"}",
      "tests/hooks/parity.ts": "readFileSync(join(FIXTURES, 'cases.jsonl'))",
      "tests/hooks/parity.test.ts": "import { run } from './parity.ts'",
    })

    assert.deepEqual(candidateTests(root, ["hooks/guard/guard.ts"]), ["tests/hooks/parity.test.ts"])
  })

  it("candidateTests_selectsATestThatNamesTheChangedFileWithoutItsExtension", () => {
    const root = repo({
      "workflows/lens-review.js": "export const meta = {}",
      "tests/workflows/helpers.mjs": "export const load = (name) => readFileSync(`workflows/${name}.js`)",
      "tests/workflows/lens-review.test.mjs": "import { load } from './helpers.mjs'\nload('lens-review')",
      "tests/workflows/other.test.mjs": "import { load } from './helpers.mjs'\nload('lens-review-delta')",
    })

    assert.deepEqual(candidateTests(root, ["workflows/lens-review.js"]), ["tests/workflows/lens-review.test.mjs"])
  })

  it("candidateTests_selectsATestThatRunsAShellWrapperWhoseScriptImportsTheChangedFile", () => {
    const root = repo({
      "lib/a.ts": "export const a = 1",
      "measure/smoke.ts": "import { a } from '../lib/a.ts'",
      "measure/smoke": "#!/bin/bash\nexec node \"$(dirname \"$0\")/smoke.ts\" \"$@\"",
      "measure/notes": "smoke.ts runs the smoke stage",
      "tests/smoke.test.ts": "const SMOKE = join(HOME, 'measure', 'smoke')",
      "tests/prose.test.ts": "it('smoke stage runs', () => readFileSync(join(HOME, 'measure', 'notes')))",
    })

    assert.deepEqual(candidateTests(root, ["lib/a.ts"]), ["tests/smoke.test.ts"])
  })

  it("candidateTests_ignoresANameInsideALongerName_andAMentionOutsideTheTestDirectories", () => {
    const root = repo({
      "lib/coverage.ts": "export {}",
      "lib/report.ts": "const label = 'coverage.ts'",
      "tests/url.test.ts": "const name = 'coverage-url'\nconst old = 'legacy-coverage'\nconst env = 'NODE_V8_coverage'\nconst old = 'coverage_old'",
      "tests/report.test.ts": "import '../lib/report.ts'",
    })

    assert.deepEqual(candidateTests(root, ["lib/coverage.ts"]), [])
  })

  it("candidateTests_doesNotSpreadThroughAHelperNamedByAnotherSuite", () => {
    const root = repo({
      "lib/a.ts": "export const a = 1",
      "tests/hooks/helpers.ts": "import { a } from '../../lib/a.ts'",
      "tests/hooks/guard.test.ts": "import './helpers.ts'",
      "tests/skills/helpers.ts": "export {}",
      "tests/skills/rules.test.ts": "import './helpers.ts'\nconst file = 'helpers.ts'",
    })

    assert.deepEqual(candidateTests(root, ["lib/a.ts"]), ["tests/hooks/guard.test.ts"])
  })

  it("candidateTests_returnsOnlyFilesTheSuiteRunnerGlobsMatch", () => {
    const root = repo({
      "lib/a.ts": "export const a = 1",
      "tests/unit/a.test.ts": "import '../../lib/a.ts'",
      "tests/unit/helpers.ts": "import '../../lib/a.ts'",
      "codex/tests/a.test.ts": "import '../../lib/a.ts'",
      "codex/tests/deep/a.test.ts": "import '../../../lib/a.ts'",
      "tests/workflows/a.test.mjs": "import '../../lib/a.ts'",
      "tests/other/a.test.mjs": "import '../../lib/a.ts'",
    })

    assert.deepEqual(candidateTests(root, ["lib/a.ts"]), [
      "codex/tests/a.test.ts",
      "tests/unit/a.test.ts",
      "tests/workflows/a.test.mjs",
    ])
  })

  it("candidateTests_selectsTheMutantGeneratorTestForTheGeneratorInThisRepo", () => {
    assert.ok(candidateTests(KEEL_ROOT, ["lib/precheck/mutants.ts"]).includes("tests/precheck/mutants.test.ts"))
  })
})
