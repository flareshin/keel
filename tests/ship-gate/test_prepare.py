from __future__ import annotations

import json
import unittest
import sys
import os

from helpers import Sandbox, KEEL_HOME

sys.path.insert(0, os.path.join(KEEL_HOME, "lib"))
from evidence import prepare, gitcmd, writers


class PrepareTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.repo = self.box.clone('acme', 'app')
        self.base = self.repo.head()

    def test_prepare_pinsUntrackedCandidate_withoutChangingIndex(self):
        self.repo.write('new.py', 'print(1)\n')
        before = self.repo.git('diff', '--cached')

        prepared = prepare.review({'diffs': [{'repo': self.repo.path, 'base': self.base}], 'lenses': []})

        target = json.loads(prepared['diff_outputs'][0])
        self.assertEqual(target['review_base'], self.base)
        self.assertEqual(target['snapshot_tree'], gitcmd.snapshot_tree(self.repo.path))
        self.assertEqual(before, self.repo.git('diff', '--cached'))
        self.assertIn('new.py', self.repo.git('ls-tree', '--name-only', target['snapshot_tree']))

    def test_prepare_refusesMissingHead_andInvalidSince(self):
        for extra in ({'head': 'missing-ref'}, {'since': self.base}):
            with self.subTest(extra=extra), self.assertRaises(writers.Refused):
                prepare.prepare_target({'repo': self.repo.path, 'base': self.base, **extra})

    def test_prepare_refusesOptionLikeRef(self):
        with self.assertRaises(writers.Usage):
            prepare.prepare_target({'repo': self.repo.path, 'base': '--help'})

    def test_prepare_countsNeedsFixesLinksInTheRootChain_whenRootRunIdIsGiven(self):
        root_tree = self.box.keel('snapshot', self.repo.path).json['tree']
        self.box.review(self.repo, verdict='NEEDS_FIXES')
        self.repo.write('fix.py', 'print(2)\n')
        delta_tree = self.box.keel('snapshot', self.repo.path).json['tree']
        self.box.review(self.repo, run_id='rv-delta-0002', root_run_id='rv-root-0001', since=root_tree, verdict='NEEDS_FIXES')
        self.repo.write('fix.py', 'print(3)\n')
        self.box.review(self.repo, run_id='rv-delta-0003', root_run_id='rv-root-0001', since=delta_tree)
        diffs = [{'repo': self.repo.path, 'base': self.base}]

        delta = self.box.keel('review', 'prepare', stdin=json.dumps({'diffs': diffs, 'lenses': [], 'rootRunId': 'rv-root-0001'}))
        root = self.box.keel('review', 'prepare', stdin=json.dumps({'diffs': diffs, 'lenses': []}))
        other = self.box.keel('review', 'prepare', stdin=json.dumps({'diffs': diffs, 'lenses': [], 'rootRunId': 'rv-other-0001'}))

        self.assertEqual((delta.rc, delta.json['needs_fixes_rounds']), (0, 2))
        self.assertEqual(root.json['needs_fixes_rounds'], 0)
        self.assertEqual(other.json['needs_fixes_rounds'], 0)

    def test_prepare_countsTheLongestRepoChain_notTheSumAcrossRepos(self):
        lib = self.box.clone('acme', 'lib')
        for repo in (self.repo, lib):
            self.box.review(repo, verdict='NEEDS_FIXES')
        request = {'diffs': [{'repo': self.repo.path, 'base': self.base}], 'lenses': [], 'rootRunId': 'rv-root-0001'}

        prepared = self.box.keel('review', 'prepare', stdin=json.dumps(request))

        self.assertEqual(prepared.json['needs_fixes_rounds'], 1)

    def test_prepare_reportsTheTierOfTheReviewedDiff_byTheRepoRiskRules(self):
        cases = [({'docs/guide.md': 'x\n'}, 'light'), ({'src/app.py': 'print(2)\n'}, 'standard'),
                 ({'docs/guide.md': 'x\n', 'src/a/billing/pay.py': 'print(3)\n'}, 'heavy')]
        for files, risk_class in cases:
            with self.subTest(risk_class=risk_class):
                base = self.repo.head()
                head = self.repo.commit(files, risk_class)

                prepared = self.prepare([{'repo': self.repo.path, 'base': base, 'head': head}])

                self.assertEqual(prepared['risk_class'], risk_class)

    def test_prepare_takesTheHeaviestTier_acrossReviewedRepos(self):
        lib = self.box.clone('acme', 'lib')
        self.box.registry(['acme/app\tcode\tmain\tacme\trequired', 'acme/lib\tcode\tmain\tacme\trequired'])
        app_head = self.repo.commit({'docs/guide.md': 'x\n'}, 'docs')
        lib_head = lib.commit({'src/lib.py': 'print(2)\n'}, 'logic')

        prepared = self.prepare([{'repo': self.repo.path, 'base': self.base, 'head': app_head},
                                 {'repo': lib.path, 'base': 'origin/main', 'head': lib_head}])

        self.assertEqual(prepared['risk_class'], 'standard')

    def test_prepare_reportsNoTier_whenAReviewedRepoHasNoGatedRow(self):
        lib = self.box.clone('acme', 'lib')
        app_head = self.repo.commit({'docs/guide.md': 'x\n'}, 'docs')
        lib_head = lib.commit({'docs/guide.md': 'x\n'}, 'docs')
        app_target = {'repo': self.repo.path, 'base': self.base, 'head': app_head}

        unlisted = self.prepare([app_target, {'repo': lib.path, 'base': 'origin/main', 'head': lib_head}])
        self.box.registry(['acme/app\toff\tmain\t-\tnone'])
        off = self.prepare([app_target])

        self.assertIsNone(unlisted['risk_class'])
        self.assertIsNone(off['risk_class'])

    def prepare(self, diffs):
        prepared = self.box.keel('review', 'prepare', stdin=json.dumps({'diffs': diffs, 'lenses': []}))
        self.assertEqual(prepared.rc, 0, prepared.stderr)
        return prepared.json
