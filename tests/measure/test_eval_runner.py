"""What the candidate session sees of the run: its work dir name and the commit it starts from carry no meta words."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from helpers import CHECKOUT

sys.path.insert(0, os.path.join(CHECKOUT, "measure", "evals", "lib"))
sys.path.insert(0, os.path.join(CHECKOUT, "measure", "lib"))

from evalkit import runner  # noqa: E402

K4_FIXTURE = os.path.join(CHECKOUT, "measure", "evals", "K4", "repo")
META_WORDS = ("eval", "test", "judge", "fixture", "keel", "candidate")
TIMEOUT = 30
# Plays the CLI: records its cwd and the starting commit's identity, so the test can read them after run_once removes the work dir.
RECORDER = """
import json, os, subprocess, sys
identity = subprocess.run(["git", "log", "-1", "--format=%an%n%ae%n%cn%n%ce"], capture_output=True, text=True, check=True).stdout.split()
with open(sys.argv[1], "w") as handle:
    json.dump({"cwd": os.getcwd(), "identity": identity}, handle)
"""


class RunOnceBlindingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp())
        self.seen_path = os.path.join(self.root, "seen.json")

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def run_recorder(self, fixture: str) -> dict:
        runner.run_once("prompt", fixture, [sys.executable, "-c", RECORDER, self.seen_path], self.root, TIMEOUT)
        with open(self.seen_path, encoding="utf-8") as handle:
            return json.load(handle)

    def fixture_with_readme(self, readme: str | None) -> str:
        fixture = os.path.join(self.root, "repo")
        os.makedirs(fixture)
        with open(os.path.join(fixture, "notes.txt"), "w", encoding="utf-8") as handle:
            handle.write("port 4317\n")
        if readme is not None:
            with open(os.path.join(fixture, "README.md"), "w", encoding="utf-8") as handle:
                handle.write(readme)
        return fixture

    def assertNoMetaWord(self, text: str) -> None:
        found = [word for word in META_WORDS if word in text.lower()]
        self.assertEqual(found, [], text)

    def test_runOnce_namesWorkDirAfterReadmeTitle_forTheK4Fixture(self) -> None:
        # when
        seen = self.run_recorder(K4_FIXTURE)
        # then
        self.assertEqual(os.path.basename(seen["cwd"]), "shop-admin")

    def test_runOnce_workDirNameCarriesNoMetaWord(self) -> None:
        # when
        seen = self.run_recorder(K4_FIXTURE)
        # then
        self.assertNoMetaWord(os.path.basename(seen["cwd"]))

    def test_runOnce_commitAuthorAndCommitterCarryNoMetaWord(self) -> None:
        # when
        seen = self.run_recorder(K4_FIXTURE)
        # then
        self.assertEqual(len(seen["identity"]), 4, seen["identity"])
        for value in seen["identity"]:
            self.assertNoMetaWord(value)

    def test_runOnce_commitIdentityIgnoresHostGitIdentityEnv(self) -> None:
        # given
        host_identity = {"GIT_AUTHOR_NAME": "keel-fixture", "GIT_AUTHOR_EMAIL": "fixture@eval.test",
                         "GIT_COMMITTER_NAME": "keel-fixture", "GIT_COMMITTER_EMAIL": "fixture@eval.test"}
        # when
        with mock.patch.dict(os.environ, host_identity):
            seen = self.run_recorder(K4_FIXTURE)
        # then
        for value in seen["identity"]:
            self.assertNoMetaWord(value)

    def test_runOnce_slugsTheReadmeTitle_intoAFolderName(self) -> None:
        # given
        fixture = self.fixture_with_readme("Intro line\n\n# My Shop: Admin!\n")
        # when
        seen = self.run_recorder(fixture)
        # then
        self.assertEqual(os.path.basename(seen["cwd"]), "my-shop-admin")

    def test_runOnce_usesTheNeutralName_whenTheFixtureHasNoReadme(self) -> None:
        # given
        fixture = self.fixture_with_readme(None)
        # when
        seen = self.run_recorder(fixture)
        # then
        self.assertEqual(os.path.basename(seen["cwd"]), runner.NEUTRAL_PROJECT_NAME)
        self.assertNoMetaWord(runner.NEUTRAL_PROJECT_NAME)

    def test_runOnce_usesTheNeutralName_whenTheReadmeTitleHasNoLetterOrDigit(self) -> None:
        # given
        fixture = self.fixture_with_readme("# !!!\n")
        # when
        seen = self.run_recorder(fixture)
        # then
        self.assertEqual(os.path.basename(seen["cwd"]), runner.NEUTRAL_PROJECT_NAME)


if __name__ == "__main__":
    unittest.main()
