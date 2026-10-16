from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from helpers import Sandbox, KEEL_HOME

sys.path.insert(0, os.path.join(KEEL_HOME, 'lib'))


class ActivationTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.repo = self.box.clone('acme', 'app')
        self.before = self.repo.head()
        self.repo.commit({'src/a.py': 'print(2)\n', 'tests/test_a.py': 'assert 2 == 2\n'})
        self.target = self.repo.head()
        self.box.review(self.repo)
        self.box.tests_evidence(self.repo)
        self.repo.git('checkout', '--detach', self.before)
        self.environment = patch.dict(os.environ, self.box.env)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def approve_target(self, read=False):
        self.repo.git('checkout', '--detach', self.target)
        arguments = ['approve', 'rv-root-0001'] + (['--read'] if read else [])
        self.assertEqual(self.box.keel(*arguments).rc, 0)
        self.repo.git('checkout', '--detach', self.before)

    def test_activation_requiresOwnerApproval_forExactTarget(self):
        from evidence.activation import approved_fast_forward
        self.assertFalse(approved_fast_forward(self.repo.path, self.target))
        self.approve_target(read=True)
        self.assertFalse(approved_fast_forward(self.repo.path, self.target))
        self.approve_target()

        self.assertTrue(approved_fast_forward(self.repo.path, self.target))
        self.assertFalse(approved_fast_forward(self.repo.path, 'main'))
        self.repo.write('dirty.txt', 'unreviewed\n')
        self.assertFalse(approved_fast_forward(self.repo.path, self.target))

    def test_activation_guardAllowsOnlyApprovedLiteralFastForward(self):
        self.approve_target()
        sys.path.insert(0, os.path.join(KEEL_HOME, 'hooks/lib'))
        spec = importlib.util.spec_from_file_location('activation_guard', os.path.join(KEEL_HOME, 'hooks/git-guard/git-guard.py'))
        guard = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = guard
        spec.loader.exec_module(guard)
        from hookkit.shell import steps

        with patch.dict(os.environ, {'KEEL_HOME': self.repo.path}):
            approved = guard.check_live_checkouts(steps('git merge --ff-only ' + self.target, self.repo.path))
            ordinary = guard.check_live_checkouts(steps('git merge ' + self.target, self.repo.path))

        self.assertEqual(approved, [])
        self.assertTrue(any(item.rule_id == 'C-isolation' for item in ordinary))

    def test_activation_refusesDifferentCommitWithSameTree(self):
        from evidence.activation import approved_fast_forward
        self.approve_target()
        self.repo.git('checkout', '--detach', self.target)
        self.repo.git('commit', '--allow-empty', '-m', 'unapproved identity')
        different = self.repo.head()
        self.repo.git('checkout', '--detach', self.before)

        self.assertFalse(approved_fast_forward(self.repo.path, different))

    def test_activation_refusesExpiredTests(self):
        from evidence.activation import approved_fast_forward
        self.approve_target()
        path = Path(self.box.evidence_files('tests')[0])
        evidence = json.loads(path.read_text())
        evidence['expires_at'] = '2000-01-01T00:00:00Z'
        path.write_text(json.dumps(evidence))
        self.assertFalse(approved_fast_forward(self.repo.path, self.target))

    def test_activation_refusesNonFastForward_withFreshEvidence(self):
        from evidence.activation import approved_fast_forward
        self.approve_target()
        self.assertTrue(approved_fast_forward(self.repo.path, self.target))
        self.repo.commit({'src/a.py': 'print(999)\n'})
        self.assertFalse(approved_fast_forward(self.repo.path, self.target))
