import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import * as codexReview from '../../lib/evidence/codex_review.ts';
import { RegistryError, normalizeRepoKey, readTsv } from '../../lib/evidence/registry.ts';
import { provenanceReasons } from '../../lib/evidence/verify.ts';
import type { Chain } from '../../lib/evidence/chain.ts';
import { Refused } from '../../lib/evidence/writers.ts';
import { AUDIT, CodexFixture } from './codex_helpers.ts';
import { LOGIC_WITH_TEST, Sandbox } from './helpers.ts';

const scratch = mkdtempSync(join(tmpdir(), 'keel-blank-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const PYTHON_ONLY_SPACES = ['\u001c', '\u001f', '\u0085'];
const JAVASCRIPT_ONLY_SPACE = '﻿';
const BLANKS = [...PYTHON_ONLY_SPACES, JAVASCRIPT_ONLY_SPACE, ' \t', ''];

describe('a text that is blank by either reading of whitespace is blank', () => {
  test('write-review refuses a no_test_reason made only of such characters, exit 2', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    repo.commit(LOGIC_WITH_TEST);
    for (const reason of BLANKS) {
      const run = sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(sandbox.reviewRequest(repo, { noTestReason: reason })) });
      assert.equal(run.rc, 2, JSON.stringify(reason));
      assert.ok(run.stderr.includes('no_test_reason must be a non-empty string'), run.stderr);
    }
    assert.deepEqual(sandbox.evidenceFiles('review'), []);
  });

  for (const blank of BLANKS) {
    test('a Codex lens, decision or finding text of ' + JSON.stringify(blank) + ' is refused', (t) => {
      const f = new CodexFixture(t);
      const lensWith = (evidence: string) => ({ ...f.report, lenses: { ...f.report.lenses, reuse: { status: 'complete', evidence } } });
      assert.throws(() => codexReview.validateReports(lensWith(blank), { ...f.verification, lenses: lensWith('ok').lenses }, f.repo.path, AUDIT),
        (error: Error) => error instanceof Refused && error.message === 'incomplete or unproven review lens');
      const finding = { id: 'f1', impact: 'low', evidence: 'src/a.py:1', scenario: 'it fails' };
      for (const key of ['id', 'evidence', 'scenario']) {
        assert.throws(() => codexReview.validateFindings([{ ...finding, [key]: blank }]),
          (error: Error) => error instanceof Refused && error.message === 'finding needs impact, file evidence and a failure scenario', key);
      }
      assert.throws(() => codexReview.adjudicatedFindings([finding], [{ id: 'f1', verdict: 'confirmed', evidence: blank }]),
        (error: Error) => error instanceof Refused && error.message === 'every finding needs an evidenced verifier decision');
      assert.deepEqual(codexReview.adjudicatedFindings([finding], [{ id: 'f1', verdict: 'confirmed', evidence: 'src/a.py:1' }]), [finding]);
    });
  }
});

describe('a gate decision never reads less strictly than either reading of whitespace', () => {
  test('a repo key is stripped of the characters either reading strips', () => {
    for (const edge of [...PYTHON_ONLY_SPACES, JAVASCRIPT_ONLY_SPACE, ' ']) {
      assert.equal(normalizeRepoKey('https://github.com/Acme/App.git' + edge), 'acme/app', JSON.stringify(edge));
      assert.equal(normalizeRepoKey(edge + 'https://github.com/Acme/App'), 'acme/app', JSON.stringify(edge));
    }
  });

  test('a registry line of only a BOM or only U+001C is not skipped as blank', () => {
    const header = ['origin', 'gate', 'integration_base', 'risk_rules', 'tests'];
    const path = join(scratch, 'gated-repos.tsv');
    for (const line of ['﻿', '\u001c']) {
      writeFileSync(path, header.join('\t') + '\n' + line + '\nacme/app\tcode\tmain\tacme\trequired\n');
      assert.throws(() => readTsv(path, header), (error: Error) => error instanceof RegistryError && error.message.includes('expected 5 columns'), JSON.stringify(line));
    }
    writeFileSync(path, header.join('\t') + '\n \t \n\nacme/app\tcode\tmain\tacme\trequired\n');
    assert.deepEqual(readTsv(path, header).map((row) => row['origin']), ['acme/app']);
  });

  test('a review link counts as having agent provenance only with a non-empty string agent id', () => {
    const chainWith = (agentId: unknown): Chain => ({
      links: [{ evidence_id: 'review-1', review_kind: 'lens-review', source: { agent_id: agentId } }],
    }) as unknown as Chain;
    for (const agentId of [[], {}, '', null, 0, 5]) {
      assert.deepEqual(provenanceReasons(chainWith(agentId)).map((reason) => reason.text), ['review review-1 has no agent provenance'], JSON.stringify(agentId));
    }
    assert.deepEqual(provenanceReasons(chainWith('ag1')), []);
  });

  for (const waiver of ['["covered elsewhere"]', '{"why":"x"}', '"\\u001f"', '"\\u0085"', '5']) {
    test('a stored no_test_reason of ' + JSON.stringify(waiver) + ' does not waive the K3 test requirement', (t) => {
      const sandbox = new Sandbox(t);
      const repo = sandbox.clone('acme', 'app');
      repo.branch('feature');
      repo.commit({ 'src/a.py': 'print(1)\n' });
      sandbox.review(repo, { noTestReason: 'log line wording only' });
      sandbox.testsEvidence(repo);
      sandbox.approve('rv-root-0001');
      const path = sandbox.evidenceFiles('review')[0]!;
      writeFileSync(path, readFileSync(path, 'utf8').replace('"no_test_reason":"log line wording only"', '"no_test_reason":' + waiver));
      assert.ok(readFileSync(path, 'utf8').includes('"no_test_reason":' + waiver));
      const run = sandbox.push(repo, 'git push origin feature');
      assert.equal(run.rc, 2, run.stderr);
      assert.ok(run.stderr.includes('logic changed with no test in the same range: src/a.py'), run.stderr);
    });
  }

  test('write-smoke refuses a run whose tree for the repo is not a non-empty string, exit 3', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    mkdirSync(join(sandbox.data, 'logs'), { recursive: true });
    for (const tree of ['[]', '{}', '""', '5']) {
      writeFileSync(join(sandbox.data, 'logs', 'keel-smoke.jsonl'), '{"run_id":"sm-0001","ok":true,"trees":{"' + repo.key + '":' + tree + '}}\n');
      const run = sandbox.keel(['evidence', 'write-smoke', '--repo', repo.path]);
      assert.equal(run.rc, 3, tree);
      assert.ok(run.stderr.includes('did not cover acme/app'), run.stderr);
    }
  });
});
