import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { onlyCommentDeletions } from '../../lib/evidence/comment_cleanup.ts';

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
