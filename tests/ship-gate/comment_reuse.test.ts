import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { onlyCommentDeletions } from '../../lib/evidence/comment_cleanup.ts';
import { PUSH_APPROVAL_REGISTRY, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

function check(path: string, before: string, after: string): boolean {
  return onlyCommentDeletions(path, Buffer.from(before), Buffer.from(after));
}

describe('CommentDeletionTest', () => {
  test('comments_reuseCode_whenWholeOrdinaryCommentsAreRemoved', () => {
    const cases: Array<[string, string, string]> = [
      ['a.py', '# Explain the value.\nx = "# literal"\n', 'x = "# literal"\n'],
      ['a.ts', '// Explain the value.\nconst x = "// literal";\n', 'const x = "// literal";\n'],
      ['a.js', '/* Explain\n the value. */\nconst x = 1;\n', 'const x = 1;\n'],
      ['A.java', 'class A {\n  // Explain the value.\n  int x = 1;\n}\n', 'class A {\n  int x = 1;\n}\n'],
    ];
    for (const [path, before, after] of cases) assert.equal(check(path, before, after), true, path);
  });

  test('comments_refuseCodeStringsModesAndUnsupportedSyntax', () => {
    const cases: Array<[string, string, string]> = [
      ['a.py', '# note\nx = 1\n', 'x = 2\n'],
      ['a.py', 'x = "# note"\n', 'x = ""\n'],
      ['a.py', '"""description"""\nx = 1\n', 'x = 1\n'],
      ['a.py', 'x = 1 # note\n', 'x = 1\n'],
      ['a.py', '# note\nx = 1\n', 'x=1\n'],
      ['a.js', 'const x = 1;\n', '// note\nconst x = 1;\n'],
      ['a.js', '// note\nconst x = /pattern/;\n', 'const x = /pattern/;\n'],
      ['a.ts', '// note\nconst x = `text`;\n', 'const x = `text`;\n'],
      ['a.tsx', '// note\nconst x = <div/>;\n', 'const x = <div/>;\n'],
      ['a.js', 'const x = <div>\n// visible text\n</div>;\n', 'const x = <div>\n</div>;\n'],
      ['A.java', '// note\nclass A { String x = """text"""; }\n', 'class A { String x = """text"""; }\n'],
      ['a.sh', '# note\necho value\n', 'echo value\n'],
      ['a.js', '/* unclosed\nconst x = 1;\n', 'const x = 1;\n'],
      ['a.js', '// note\rsideEffect()\nkeep()\n', 'keep()\n'],
      ['A.java', '// note\nclass A { String x = "\\u0022"; }\n', 'class A { String x = "\\u0022"; }\n'],
    ];
    for (const [path, before, after] of cases) assert.equal(check(path, before, after), false, `${path} ${JSON.stringify(before)}`);
  });

  test('comments_preserveNoticesAndToolDirectives_evenWhenRetained', () => {
    const directives = ['Copyright owner', 'SPDX-License-Identifier: MIT', '@ts-ignore', 'eslint-disable-next-line',
      'prettier-ignore', 'sourceMappingURL=file', 'istanbul ignore next', '#!/usr/bin/python3', 'coding: latin-1', 'noqa',
      'falls through', 'global variable', 'fmt on', 'noinspection', 'NOSONAR'];
    for (const directive of directives) {
      const before = `// ${directive}\n// ordinary note\nconst x = 1;\n`;
      assert.equal(check('a.ts', before, 'const x = 1;\n'), false, directive);
      assert.equal(check('a.ts', before, `// ${directive}\nconst x = 1;\n`), false, directive);
    }
  });

  test('comments_preserveNotebookTypeAndCellMarkers_inPythonSources', () => {
    for (const marker of ['Databricks notebook source', 'COMMAND ----------']) {
      const before = `# ${marker}\n# ordinary explanation\nx = 1\n`;
      assert.equal(check('notebook.py', before, 'x = 1\n'), false, marker);
      assert.equal(check('notebook.py', before, `# ${marker}\nx = 1\n`), false, marker);
    }
  });
});

const PUSH_FEATURE = 'git push origin feature';

class CommentReuseFixture {
  box: Sandbox;
  repo: Repo;
  before: string;

  constructor(t: TestContext) {
    this.box = new Sandbox(t, PUSH_APPROVAL_REGISTRY);
    this.repo = this.box.clone('acme', 'app');
    this.repo.branch('feature');
    this.repo.commit({
      'src/a.py': '# Ordinary explanation.\nprint(1)\n',
      'tests/test_a.py': 'def test_a():\n    # Ordinary explanation.\n    assert True\n',
    });
    this.box.fullBundle(this.repo);
    this.before = this.repo.head();
  }
}

describe('CommentReuseGateTest', () => {
  test('push_reusesApprovedReviewAndTests_afterPureCommentDeletion', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.commit({ 'src/a.py': 'print(1)\n' });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 0, result.stderr);
    assert.equal(f.box.evidenceFiles('review').length, 1);
    assert.equal(f.box.evidenceFiles('tests').length, 1);
  });

  test('merge_reusesApprovedReviewAndTests_afterPureCommentDeletion', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.commit({ 'src/a.py': 'print(1)\n' });
    f.repo.git('push', '-q', 'origin', 'feature');
    writeFileSync(f.box.ghResponse, JSON.stringify({
      state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
      baseRefName: 'main', headRefOid: f.repo.head(),
    }));

    const result = f.box.push(f.repo, 'gh pr merge 7 --squash --match-head-commit ' + f.repo.head());

    assert.equal(result.rc, 0, result.stderr);
  });

  test('push_reusesEvidence_whenOnlyTestCommentsAreDeleted', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.commit({ 'tests/test_a.py': 'def test_a():\n    assert True\n' });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 0, result.stderr);
  });

  test('push_stillRequiresApproval_afterPureCommentDeletion', (t) => {
    const f = new CommentReuseFixture(t);
    for (const path of f.box.evidenceFiles('approval')) unlinkSync(path);
    f.repo.commit({ 'src/a.py': 'print(1)\n' });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('no approval bound'), result.stderr);
  });

  test('push_rejectsBehaviorOrTestChanges_afterReviewedCandidate', (t) => {
    const f = new CommentReuseFixture(t);
    for (const [path, content] of [['src/a.py', 'print(2)\n'], ['tests/test_a.py', 'def test_a():\n    assert False\n']] as const) {
      f.repo.git('checkout', '--detach', f.before);
      f.repo.commit({ [path]: content });
      const result = f.box.push(f.repo, 'git push origin HEAD:feature');
      assert.equal(result.rc, 2, path);
      assert.ok(result.stderr.includes('content or mode changed after review'), result.stderr);
    }
  });

  test('push_reusesEvidence_withoutNewTestInCommentOnlyRange', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.git('push', '-q', 'origin', 'HEAD:main');
    f.repo.git('fetch', '-q', 'origin');
    f.repo.commit({ 'src/a.py': 'print(1)\n' });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 0, result.stderr);
  });

  test('push_refusesModeChanges_evenAfterPureCommentDeletion', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.write('src/a.py', 'print(1)\n', true);
    f.repo.commit({});

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('content or mode changed after review'), result.stderr);
  });

  test('push_refusesExpiredTests_evenAfterPureCommentDeletion', (t) => {
    const f = new CommentReuseFixture(t);
    const path = f.box.evidenceFiles('tests')[0]!;
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    evidence.expires_at = '2000-01-01T00:00:00Z';
    writeFileSync(path, JSON.stringify(evidence));
    f.repo.commit({ 'src/a.py': 'print(1)\n' });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('no tests evidence'), result.stderr);
  });
});
