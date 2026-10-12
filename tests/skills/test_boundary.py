from __future__ import annotations

import json
import os
import re
import subprocess
import unittest

from helpers import KEEL_HOME, IsolatedTestCase, read

TRACK_ROOTS = ['PRINCIPLES.md', 'skills', 'examples/skills', 'tests/skills']
# Not in keel's generic boundary rules, so this track checks it on top of the scanner.
HOME_PATH = re.compile(r'/(?:Users|home)/[A-Za-z][\w.-]*')


def track_files():
    found = []
    for entry in TRACK_ROOTS:
        full = os.path.join(KEEL_HOME, entry)
        if os.path.isfile(full):
            found.append(full)
        for dirpath, dirnames, filenames in os.walk(full):
            dirnames[:] = [d for d in dirnames if d != '__pycache__']
            found += [os.path.join(dirpath, name) for name in filenames]
    return found


class BoundaryTest(IsolatedTestCase):

    def run_boundary(self, cwd, *args):
        """(exit code, parsed stdout) of the boundary scanner the git hooks run (Interfaces (a)/(i))."""
        scanner = self.env.get('KEEL_BOUNDARY') or os.path.join(KEEL_HOME, 'measure', 'boundary')
        completed = subprocess.run([scanner, *args], cwd=cwd, capture_output=True, text=True, env=self.env)
        self.assertIn(completed.returncode, (0, 1), completed.stderr)
        return completed.returncode, json.loads(completed.stdout)

    def test_trackFiles_passGenericBoundaryScan_includingThisFile(self):
        # when
        code, result = self.run_boundary(KEEL_HOME, '--generic-only', '--paths', *TRACK_ROOTS)
        # then
        self.assertEqual((code, result['hits']), (0, []))
        self.assertGreater(result['scanned'], len(read(__file__).splitlines()))

    def test_trackFiles_holdNoHomePath(self):
        # given
        paths = track_files()
        # when
        hits = [(path, n) for path in paths for n, line in enumerate(read(path).splitlines(), 1)
                if HOME_PATH.search(line)]
        # then
        self.assertIn(os.path.realpath(__file__), map(os.path.realpath, paths))
        self.assertEqual(hits, [])


if __name__ == '__main__':
    unittest.main()
