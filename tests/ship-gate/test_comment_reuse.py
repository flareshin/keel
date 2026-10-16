from __future__ import annotations

import unittest

from helpers import Sandbox, PUSH_APPROVAL_REGISTRY


class CommentDeletionTest(unittest.TestCase):
    def check(self, path, before, after):
        from evidence.comment_cleanup import only_comment_deletions
        return only_comment_deletions(path, before.encode(), after.encode())

    def test_comments_reuseCode_whenWholeOrdinaryCommentsAreRemoved(self):
        cases = [
            ('a.py', '# Explain the value.\nx = "# literal"\n', 'x = "# literal"\n'),
            ('a.ts', '// Explain the value.\nconst x = "// literal";\n', 'const x = "// literal";\n'),
            ('a.js', '/* Explain\n the value. */\nconst x = 1;\n', 'const x = 1;\n'),
            ('A.java', 'class A {\n  // Explain the value.\n  int x = 1;\n}\n', 'class A {\n  int x = 1;\n}\n'),
        ]
        for path, before, after in cases:
            with self.subTest(path=path):
                self.assertTrue(self.check(path, before, after))

    def test_comments_refuseCodeStringsModesAndUnsupportedSyntax(self):
        cases = [
            ('a.py', '# note\nx = 1\n', 'x = 2\n'),
            ('a.py', 'x = "# note"\n', 'x = ""\n'),
            ('a.py', '"""description"""\nx = 1\n', 'x = 1\n'),
            ('a.py', 'x = 1 # note\n', 'x = 1\n'),
            ('a.py', '# note\nx = 1\n', 'x=1\n'),
            ('a.js', 'const x = 1;\n', '// note\nconst x = 1;\n'),
            ('a.js', '// note\nconst x = /pattern/;\n', 'const x = /pattern/;\n'),
            ('a.ts', '// note\nconst x = `text`;\n', 'const x = `text`;\n'),
            ('a.tsx', '// note\nconst x = <div/>;\n', 'const x = <div/>;\n'),
            ('a.js', 'const x = <div>\n// visible text\n</div>;\n', 'const x = <div>\n</div>;\n'),
            ('A.java', '// note\nclass A { String x = """text"""; }\n', 'class A { String x = """text"""; }\n'),
            ('a.sh', '# note\necho value\n', 'echo value\n'),
            ('a.js', '/* unclosed\nconst x = 1;\n', 'const x = 1;\n'),
            ('a.js', '// note\rsideEffect()\nkeep()\n', 'keep()\n'),
            ('A.java', '// note\nclass A { String x = "\\u0022"; }\n', 'class A { String x = "\\u0022"; }\n'),
        ]
        for path, before, after in cases:
            with self.subTest(path=path, before=before):
                self.assertFalse(self.check(path, before, after))

    def test_comments_preserveNoticesAndToolDirectives_evenWhenRetained(self):
        for directive in ['Copyright owner', 'SPDX-License-Identifier: MIT', '@ts-ignore',
                          'eslint-disable-next-line', 'prettier-ignore', 'sourceMappingURL=file',
                          'istanbul ignore next', '#!/usr/bin/python3', 'coding: latin-1', 'noqa',
                          'falls through', 'global variable', 'fmt on', 'noinspection', 'NOSONAR']:
            with self.subTest(directive=directive):
                before = '// ' + directive + '\n// ordinary note\nconst x = 1;\n'
                self.assertFalse(self.check('a.ts', before, 'const x = 1;\n'))
                self.assertFalse(self.check('a.ts', before, '// ' + directive + '\nconst x = 1;\n'))

    def test_comments_preserveNotebookTypeAndCellMarkers_inPythonSources(self):
        for marker in ['Databricks notebook source', 'COMMAND ----------']:
            with self.subTest(marker=marker):
                before = '# ' + marker + '\n# ordinary explanation\nx = 1\n'
                self.assertFalse(self.check('notebook.py', before, 'x = 1\n'))
                self.assertFalse(self.check('notebook.py', before, '# ' + marker + '\nx = 1\n'))


class CommentReuseGateTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self, registry=PUSH_APPROVAL_REGISTRY)
        self.repo = self.box.clone('acme', 'app')
        self.repo.branch('feature')
        self.repo.commit({'src/a.py': '# Ordinary explanation.\nprint(1)\n',
                          'tests/test_a.py': 'def test_a():\n    # Ordinary explanation.\n    assert True\n'})
        self.box.full_bundle(self.repo)
        self.before = self.repo.head()

    def test_push_reusesApprovedReviewAndTests_afterPureCommentDeletion(self):
        self.repo.commit({'src/a.py': 'print(1)\n'})

        result = self.box.push(self.repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)
        self.assertEqual(len(self.box.evidence_files('review')), 1)
        self.assertEqual(len(self.box.evidence_files('tests')), 1)

    def test_merge_reusesApprovedReviewAndTests_afterPureCommentDeletion(self):
        import json
        self.repo.commit({'src/a.py': 'print(1)\n'})
        self.repo.git('push', '-q', 'origin', 'feature')
        with open(self.box.gh_response, 'w') as stream:
            json.dump({'state': 'OPEN', 'isDraft': False, 'mergeable': 'MERGEABLE',
                       'mergeStateStatus': 'CLEAN', 'statusCheckRollup': [], 'baseRefName': 'main',
                       'headRefOid': self.repo.head()}, stream)

        result = self.box.push(self.repo, 'gh pr merge 7 --squash --match-head-commit ' + self.repo.head())

        self.assertEqual(result.rc, 0, result.stderr)

    def test_push_reusesEvidence_whenOnlyTestCommentsAreDeleted(self):
        self.repo.commit({'tests/test_a.py': 'def test_a():\n    assert True\n'})

        result = self.box.push(self.repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_push_stillRequiresApproval_afterPureCommentDeletion(self):
        import os
        for path in self.box.evidence_files('approval'):
            os.unlink(path)
        self.repo.commit({'src/a.py': 'print(1)\n'})

        result = self.box.push(self.repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('no approval bound', result.stderr)

    def test_push_rejectsBehaviorOrTestChanges_afterReviewedCandidate(self):
        for path, content in [('src/a.py', 'print(2)\n'), ('tests/test_a.py', 'def test_a():\n    assert False\n')]:
            with self.subTest(path=path):
                self.repo.git('checkout', '--detach', self.before)
                self.repo.commit({path: content})
                result = self.box.push(self.repo, 'git push origin HEAD:feature')
                self.assertEqual(result.rc, 2)
                self.assertIn('content or mode changed after review', result.stderr)

    def test_push_reusesEvidence_withoutNewTestInCommentOnlyRange(self):
        self.repo.git('push', '-q', 'origin', 'HEAD:main')
        self.repo.git('fetch', '-q', 'origin')
        self.repo.commit({'src/a.py': 'print(1)\n'})

        result = self.box.push(self.repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_push_refusesModeChanges_evenAfterPureCommentDeletion(self):
        self.repo.write('src/a.py', 'print(1)\n', executable=True)
        self.repo.commit({})

        result = self.box.push(self.repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('content or mode changed after review', result.stderr)

    def test_push_refusesExpiredTests_evenAfterPureCommentDeletion(self):
        import json
        from pathlib import Path
        path = Path(self.box.evidence_files('tests')[0])
        evidence = json.loads(path.read_text())
        evidence['expires_at'] = '2000-01-01T00:00:00Z'
        path.write_text(json.dumps(evidence))
        self.repo.commit({'src/a.py': 'print(1)\n'})

        result = self.box.push(self.repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('no tests evidence', result.stderr)
