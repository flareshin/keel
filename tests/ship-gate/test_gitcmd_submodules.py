from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

from helpers import KEEL_HOME, Sandbox

sys.path.insert(0, os.path.join(KEEL_HOME, 'lib'))
from evidence import gitcmd


class IgnoredSubmoduleDiffTest(unittest.TestCase):
    def setUp(self):
        self.sandbox = Sandbox(self)
        self.parent, child = self.sandbox.clone_with_submodule()
        self.parent.git('config', '--file', '.gitmodules', 'submodule.lib.ignore', 'all')
        self.parent.git('add', '.gitmodules')
        self.parent.git('commit', '-q', '-m', 'ignore local submodule changes')
        self.base = self.parent.head()
        self.old_child = child.head()
        self.new_child = child.commit({'lib.py': 'LIB = 2\n'}, 'update library')
        self.parent.git('update-index', '--cacheinfo', '160000,' + self.new_child + ',lib')
        self.parent.git('commit', '-q', '-m', 'advance library')
        self.tree = self.parent.tree()
        environment = patch.dict(os.environ, self.sandbox.env)
        environment.start()
        self.addCleanup(environment.stop)

    def test_diff_entries_includes_ignored_gitlink_for_review_coverage(self):
        entries = gitcmd.diff_entries(self.parent.path, self.base, self.tree)

        self.assertEqual(entries, [gitcmd.PathEntry(
            'lib', self.new_child, '160000', '160000', self.old_child)])
        self.assertTrue(entries[0].is_gitlink)

    def test_diff_stats_counts_ignored_gitlink_for_risk_classification(self):
        stats = gitcmd.diff_stats(self.parent.path, self.base, self.tree)

        self.assertEqual(stats, {'lib': gitcmd.PathStat(1, 1)})
