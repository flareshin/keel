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
