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
      ['a.ts', '// Explain the value.\nconst x = "// literal";\n', 'const x = "// literal";\n'],
      ['a.js', '/* Explain\n the value. */\nconst x = 1;\n', 'const x = 1;\n'],
      ['A.java', 'class A {\n  // Explain the value.\n  int x = 1;\n}\n', 'class A {\n  int x = 1;\n}\n'],
    ];
    for (const [path, before, after] of cases) assert.equal(check(path, before, after), true, path);
  });

  test('comments_invalidateEvidence_inPythonSourcesThatPythonOnceReused', () => {
    const cases: Array<[recordedPython: boolean, path: string, before: string, after: string]> = [
      [true, 'a.py', '# Explain the value.\nx = "# literal"\n', 'x = "# literal"\n'],
    ];
    for (const [recordedPython, path, before, after] of cases) {
      assert.equal(check(path, before, after), false, `${path} ${JSON.stringify(before)} (Python recorded ${recordedPython})`);
    }
  });

  test('comments_refuseCodeStringsModesAndUnsupportedSyntax', () => {
    const cases: Array<[string, string, string]> = [
      ['a.py', '# note\nx = 1\n', 'x = 2\n'],
      ['a.py', 'x = "# note"\n', 'x = ""\n'],
      ['a.py', '"""description"""\nx = 1\n', 'x = 1\n'],
      ['a.py', 'x = 1 # note\n', 'x = 1\n'],
      ['a.py', '# note\nx = 1\n', 'x=1\n'],
      ['a.py', 's = f"""{x=\n# hello there\n}"""\nprint(s)\n', 's = f"""{x=\n}"""\nprint(s)\n'],
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

  test('comments_preserveNotebookTypeAndCellMarkers_inSlashCommentSources', () => {
    for (const marker of ['Databricks notebook source', 'COMMAND ----------']) {
      const before = `// ${marker}\n// ordinary explanation\nconst x = 1;\n`;
      for (const path of ['notebook.ts', 'notebook.js']) {
        assert.equal(check(path, before, 'const x = 1;\n'), false, `${path} ${marker}`);
        assert.equal(check(path, before, `// ${marker}\nconst x = 1;\n`), false, `${path} ${marker}`);
      }
      const block = `/* ${marker} */\n/* ordinary explanation */\nconst x = 1;\n`;
      assert.equal(check('notebook.js', block, 'const x = 1;\n'), false, `block ${marker}`);
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
const DENIED_WHERE_PYTHON_PASSED = 2;
const CHANGED_AFTER_REVIEW = 'content or mode changed after review';

interface SourceFlavor {
  source: string;
  test: string;
  sourceBefore: string;
  sourceAfter: string;
  testBefore: string;
  testAfter: string;
  sourceBehaviorChange: string;
  testBehaviorChange: string;
}

const PYTHON: SourceFlavor = {
  source: 'src/a.py', test: 'tests/test_a.py',
  sourceBefore: '# Ordinary explanation.\nprint(1)\n', sourceAfter: 'print(1)\n',
  testBefore: 'def test_a():\n    # Ordinary explanation.\n    assert True\n', testAfter: 'def test_a():\n    assert True\n',
  sourceBehaviorChange: 'print(2)\n', testBehaviorChange: 'def test_a():\n    assert False\n',
};

const TYPESCRIPT: SourceFlavor = {
  source: 'src/a.ts', test: 'tests/a.test.ts',
  sourceBefore: '// Ordinary explanation.\nconsole.log(1);\n', sourceAfter: 'console.log(1);\n',
  testBefore: 'test("a", () => {\n  // Ordinary explanation.\n  assert(true);\n});\n', testAfter: 'test("a", () => {\n  assert(true);\n});\n',
  sourceBehaviorChange: 'console.log(2);\n', testBehaviorChange: 'test("a", () => {\n  assert(false);\n});\n',
};

const JAVASCRIPT_BLOCK_COMMENTS: SourceFlavor = {
  source: 'src/a.js', test: 'tests/a.test.js',
  sourceBefore: '/* Ordinary explanation. */\nconsole.log(1);\n', sourceAfter: 'console.log(1);\n',
  testBefore: 'test("a", () => {\n  /* Ordinary explanation. */\n  assert(true);\n});\n', testAfter: 'test("a", () => {\n  assert(true);\n});\n',
  sourceBehaviorChange: 'console.log(2);\n', testBehaviorChange: 'test("a", () => {\n  assert(false);\n});\n',
};

const JAVA: SourceFlavor = {
  source: 'src/A.java', test: 'tests/ATest.java',
  sourceBefore: 'class A {\n  // Ordinary explanation.\n  int x = 1;\n}\n', sourceAfter: 'class A {\n  int x = 1;\n}\n',
  testBefore: 'class ATest {\n  // Ordinary explanation.\n  void a() {}\n}\n', testAfter: 'class ATest {\n  void a() {}\n}\n',
  sourceBehaviorChange: 'class A {\n  int x = 2;\n}\n', testBehaviorChange: 'class ATest {\n  void a() { fail(); }\n}\n',
};

class CommentReuseFixture {
  box: Sandbox;
  repo: Repo;
  before: string;

  constructor(t: TestContext, files: SourceFlavor = PYTHON) {
    this.box = new Sandbox(t, PUSH_APPROVAL_REGISTRY);
    this.repo = this.box.clone('acme', 'app');
    this.repo.branch('feature');
    this.repo.commit({ [files.source]: files.sourceBefore, [files.test]: files.testBefore });
    this.box.fullBundle(this.repo);
    this.before = this.repo.head();
  }
}

describe('CommentReuseGateTest', () => {
  test('push_requiresFreshEvidence_afterPythonCommentDeletion_thatPythonReused', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.commit({ 'src/a.py': 'print(1)\n' });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, DENIED_WHERE_PYTHON_PASSED, result.stderr);
    assert.ok(result.stderr.includes(CHANGED_AFTER_REVIEW), result.stderr);
  });

  test('merge_requiresFreshEvidence_afterPythonCommentDeletion_thatPythonReused', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.commit({ 'src/a.py': 'print(1)\n' });
    f.repo.git('push', '-q', 'origin', 'feature');
    writeFileSync(f.box.ghResponse, JSON.stringify({
      state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
      baseRefName: 'main', headRefOid: f.repo.head(),
    }));

    const result = f.box.push(f.repo, 'gh pr merge 7 --squash --match-head-commit ' + f.repo.head());

    assert.equal(result.rc, DENIED_WHERE_PYTHON_PASSED, result.stderr);
    assert.ok(result.stderr.includes(CHANGED_AFTER_REVIEW), result.stderr);
  });

  test('push_requiresFreshEvidence_whenOnlyPythonTestCommentsAreDeleted_thatPythonReused', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.commit({ 'tests/test_a.py': 'def test_a():\n    assert True\n' });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, DENIED_WHERE_PYTHON_PASSED, result.stderr);
    assert.ok(result.stderr.includes(CHANGED_AFTER_REVIEW), result.stderr);
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

  test('push_requiresFreshEvidence_withoutNewTestInPythonCommentOnlyRange_thatPythonReused', (t) => {
    const f = new CommentReuseFixture(t);
    f.repo.git('push', '-q', 'origin', 'HEAD:main');
    f.repo.git('fetch', '-q', 'origin');
    f.repo.commit({ 'src/a.py': 'print(1)\n' });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, DENIED_WHERE_PYTHON_PASSED, result.stderr);
    assert.ok(result.stderr.includes(CHANGED_AFTER_REVIEW), result.stderr);
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

describe('CommentReuseGateTest for the supported suffixes', () => {
  for (const [name, files] of [['ts', TYPESCRIPT], ['js', JAVASCRIPT_BLOCK_COMMENTS], ['java', JAVA]] as const) {
    test(`push_reusesApprovedReviewAndTests_afterPureCommentDeletion_in_${name}`, (t) => {
      const f = new CommentReuseFixture(t, files);
      f.repo.commit({ [files.source]: files.sourceAfter });

      const result = f.box.push(f.repo, PUSH_FEATURE);

      assert.equal(result.rc, 0, result.stderr);
      assert.equal(f.box.evidenceFiles('review').length, 1);
      assert.equal(f.box.evidenceFiles('tests').length, 1);
    });
  }

  test('merge_reusesApprovedReviewAndTests_afterPureCommentDeletion_in_ts', (t) => {
    const f = new CommentReuseFixture(t, TYPESCRIPT);
    f.repo.commit({ [TYPESCRIPT.source]: TYPESCRIPT.sourceAfter });
    f.repo.git('push', '-q', 'origin', 'feature');
    writeFileSync(f.box.ghResponse, JSON.stringify({
      state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
      baseRefName: 'main', headRefOid: f.repo.head(),
    }));

    const result = f.box.push(f.repo, 'gh pr merge 7 --squash --match-head-commit ' + f.repo.head());

    assert.equal(result.rc, 0, result.stderr);
  });

  test('push_reusesEvidence_whenOnlyTestCommentsAreDeleted_in_ts', (t) => {
    const f = new CommentReuseFixture(t, TYPESCRIPT);
    f.repo.commit({ [TYPESCRIPT.test]: TYPESCRIPT.testAfter });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 0, result.stderr);
  });

  test('push_stillRequiresApproval_afterPureCommentDeletion_in_ts', (t) => {
    const f = new CommentReuseFixture(t, TYPESCRIPT);
    for (const path of f.box.evidenceFiles('approval')) unlinkSync(path);
    f.repo.commit({ [TYPESCRIPT.source]: TYPESCRIPT.sourceAfter });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('no approval bound'), result.stderr);
    assert.ok(!result.stderr.includes(CHANGED_AFTER_REVIEW), result.stderr);
  });

  test('push_rejectsBehaviorOrTestChanges_afterReviewedCandidate_in_ts', (t) => {
    const f = new CommentReuseFixture(t, TYPESCRIPT);
    for (const [path, content] of [[TYPESCRIPT.source, TYPESCRIPT.sourceBehaviorChange], [TYPESCRIPT.test, TYPESCRIPT.testBehaviorChange]] as const) {
      f.repo.git('checkout', '--detach', f.before);
      f.repo.commit({ [path]: content });
      const result = f.box.push(f.repo, 'git push origin HEAD:feature');
      assert.equal(result.rc, 2, path);
      assert.ok(result.stderr.includes(CHANGED_AFTER_REVIEW), result.stderr);
    }
  });

  test('push_reusesEvidence_withoutNewTestInCommentOnlyRange_in_ts', (t) => {
    const f = new CommentReuseFixture(t, TYPESCRIPT);
    f.repo.git('push', '-q', 'origin', 'HEAD:main');
    f.repo.git('fetch', '-q', 'origin');
    f.repo.commit({ [TYPESCRIPT.source]: TYPESCRIPT.sourceAfter });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 0, result.stderr);
  });

  test('push_refusesModeChanges_evenAfterPureCommentDeletion_in_ts', (t) => {
    const f = new CommentReuseFixture(t, TYPESCRIPT);
    f.repo.write(TYPESCRIPT.source, TYPESCRIPT.sourceAfter, true);
    f.repo.commit({});

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes(CHANGED_AFTER_REVIEW), result.stderr);
  });

  test('push_refusesExpiredTests_evenAfterPureCommentDeletion_in_ts', (t) => {
    const f = new CommentReuseFixture(t, TYPESCRIPT);
    const path = f.box.evidenceFiles('tests')[0]!;
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    evidence.expires_at = '2000-01-01T00:00:00Z';
    writeFileSync(path, JSON.stringify(evidence));
    f.repo.commit({ [TYPESCRIPT.source]: TYPESCRIPT.sourceAfter });

    const result = f.box.push(f.repo, PUSH_FEATURE);

    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('no tests evidence'), result.stderr);
    assert.ok(!result.stderr.includes(CHANGED_AFTER_REVIEW), result.stderr);
  });
});
