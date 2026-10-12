from __future__ import annotations

import os
import subprocess
import unittest

from helpers import GITHOOKS_DIR, MEASURE_DIR, MeasureSandbox, read_text

ARGV_STUB = '#!/bin/bash\necho "$@" >> "%s"\necho \'{"scanned":0,"hits":[]}\'\n'


class GithooksTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()
        self.box.write_lexicon()
        self.repo = os.path.join(self.box.root, "work")
        self.remote = os.path.join(self.box.root, "remote.git")
        os.makedirs(self.repo)
        subprocess.run(["git", "init", "-q", "--bare", self.remote], check=True, env=self.box.env)
        self.box.init_repo(self.repo, self.remote)
        self.box.git(self.repo, "config", "core.hooksPath", GITHOOKS_DIR)
        self.box.env["KEEL_BOUNDARY"] = os.path.join(MEASURE_DIR, "boundary")

    def tearDown(self) -> None:
        self.box.cleanup()

    def git_result(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", self.repo] + list(args), capture_output=True, text=True, env=self.box.env)

    def stage(self, name: str, content: str) -> None:
        self.box.write("work/" + name, content)
        self.box.git(self.repo, "add", name)

    def use_argv_stub(self) -> str:
        log = os.path.join(self.box.root, "boundary-argv.log")
        self.box.env["KEEL_BOUNDARY"] = self.box.write("stubs/boundary", ARGV_STUB % log, executable=True)
        return log

    def test_preCommit_blocksTheCommit_whenStagedLinesHitTheLexicon(self) -> None:
        # given
        self.stage("a.txt", "made for acmecorp\n")
        # when
        completed = self.git_result("commit", "-q", "-m", "Add a")
        # then
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("pre-commit: commit blocked by the public-boundary scan (exit 1", completed.stderr)
        self.assertIn("a.txt:1 matches lexicon:1", completed.stderr)
        self.assertNotEqual(self.git_result("rev-parse", "--verify", "-q", "HEAD").returncode, 0)

    def test_preCommit_allowsTheCommit_whenStagedLinesAreClean(self) -> None:
        # given
        self.stage("a.txt", "public text\n")
        # when
        completed = self.git_result("commit", "-q", "-m", "Add a")
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_preCommit_blocksTheCommit_whenTheOverlayLexiconIsMissing(self) -> None:
        # given
        os.remove(os.path.join(self.box.overlay, "boundary", "lexicon.txt"))
        self.stage("a.txt", "public text\n")
        # when
        completed = self.git_result("commit", "-q", "-m", "Add a")
        # then
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("overlay lexicon missing", completed.stderr)

    def test_preCommit_blocksTheCommit_whenTheOverlayLexiconIsEmpty(self) -> None:
        # given
        self.box.write("overlay/boundary/lexicon.txt", "")
        self.stage("a.txt", "public text\n")
        # when
        completed = self.git_result("commit", "-q", "-m", "Add a")
        # then
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("overlay lexicon has no terms", completed.stderr)
        self.assertNotEqual(self.git_result("rev-parse", "--verify", "-q", "HEAD").returncode, 0)

    def test_preCommit_findsTheScannerBesideItself_whenNoOverrideIsSet(self) -> None:
        # given
        for name in ("KEEL_HOME", "KEEL_BOUNDARY"):
            self.box.env.pop(name)
        self.stage("a.txt", "see TKT-1234\n")
        # when
        completed = self.git_result("commit", "-q", "-m", "Add a")
        # then
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("matches lexicon:2", completed.stderr)

    def test_preCommit_passesStagedFlag_toTheScanner(self) -> None:
        # given
        log = self.use_argv_stub()
        self.stage("a.txt", "x\n")
        # when
        self.git_result("commit", "-q", "-m", "Add a")
        # then
        self.assertEqual(read_text(log), "--staged\n")

    def test_prePush_blocksThePush_whenACommitMessageHitsTheLexicon(self) -> None:
        # given
        self.box.write("work/a.txt", "public\n")
        self.box.commit_all(self.repo, "Fix TKT-4321")
        # when
        completed = self.git_result("push", "-q", "origin", "HEAD:refs/heads/main")
        # then
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("pre-push: pushed commits hit the public boundary", completed.stderr)
        self.assertEqual(self.box.git(self.remote, "for-each-ref"), "")

    def test_prePush_allowsThePush_whenPushedCommitsAreClean(self) -> None:
        # given
        self.box.write("work/a.txt", "public\n")
        self.box.commit_all(self.repo, "Add a")
        # when
        completed = self.git_result("push", "-q", "origin", "HEAD:refs/heads/main")
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_prePush_scansOnlyNewCommits_whenTheBranchExistsRemotely(self) -> None:
        # given
        self.box.write("work/a.txt", "public\n")
        first = self.box.commit_all(self.repo, "Add a")
        self.git_result("push", "-q", "origin", "HEAD:refs/heads/main")
        self.box.write("work/a.txt", "public\nmore\n")
        second = self.box.commit_all(self.repo, "Add more")
        log = self.use_argv_stub()
        # when
        completed = self.git_result("push", "-q", "origin", "HEAD:refs/heads/main")
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(read_text(log), "--range %s..%s\n" % (first, second))

    def test_prePush_skipsTheScanner_whenOnlyDeletingABranch(self) -> None:
        # given
        self.box.write("work/a.txt", "public\n")
        self.box.commit_all(self.repo, "Add a")
        self.git_result("push", "-q", "origin", "HEAD:refs/heads/topic")
        log = self.use_argv_stub()
        # when
        completed = self.git_result("push", "-q", "origin", ":refs/heads/topic")
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(os.path.exists(log))


if __name__ == "__main__":
    unittest.main()
