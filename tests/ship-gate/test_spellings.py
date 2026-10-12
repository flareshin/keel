"""Every row of tests/fixtures/push-merge-spellings.tsv through the hook: gate rows are denied without
evidence, passed with a bundle, and seen by git-guard's push scan; deny rows name the user-run command;
pass rows never deny; the crash fallback reads every gate and deny row as a push or merge."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from typing import List, NamedTuple, Optional

from helpers import KEEL_HOME, LOGIC_WITH_TEST, Repo, Run, Sandbox
from test_hook_commands import load_hook_module

FIXTURE = os.path.join(KEEL_HOME, "tests", "fixtures", "push-merge-spellings.tsv")
GIT_GUARD = os.path.join(KEEL_HOME, "hooks", "git-guard", "git-guard.py")
EXPECTATIONS = ("gate", "pass", "deny")
GATED_CLONE, FORK_CLONE, FORK_ORIGIN_CLONE = "gated", "fork", "fork-origin"
CLONES = (GATED_CLONE, FORK_CLONE, FORK_ORIGIN_CLONE)
MIN_ROWS = 25
ATTRIBUTION_TRAILER = "Co-Authored-By: Claude <noreply@example.invalid>"
UNATTRIBUTABLE = "- [K1] cannot attribute this push or merge"
RUN_YOURSELF = "Run it yourself in your terminal: "


class Row(NamedTuple):
    command: str
    expect: str
    note: str
    clone: str = GATED_CLONE


def load_rows() -> List[Row]:
    rows = []
    with open(FIXTURE, encoding="utf-8") as stream:
        for line in stream:
            line = line.rstrip("\n")
            if not line or line.startswith("#") or line.startswith("command\t"):
                continue
            command, *cells = line.split("\t")
            rows.append(Row(command.replace("\\n", "\n"), *cells))
    return rows


class SpellingTableTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = load_rows()

    def test_table_hasEnoughRows_withKnownExpectations(self):
        self.assertGreaterEqual(len(self.rows), MIN_ROWS)
        self.assertTrue(all(row.expect in EXPECTATIONS for row in self.rows), [row.expect for row in self.rows])
        self.assertTrue(all(row.clone in CLONES for row in self.rows), [row.clone for row in self.rows])
        self.assertEqual(len({(row.command, row.clone) for row in self.rows}), len(self.rows), "duplicate commands")

    def test_everySpelling_getsItsExpectedVerdict(self):
        sandbox, repo, head = self.fixture_repo()
        clones = {GATED_CLONE: (repo, head), FORK_CLONE: self.fork_clone(sandbox, "fork", push_remote="upstream"),
                  FORK_ORIGIN_CLONE: self.fork_clone(sandbox, "fork-origin", push_remote=None)}
        for row in self.rows:
            with self.subTest(command=row.command, note=row.note, clone=row.clone):
                passes, denies = len(sandbox.fires("risk", "pass")), len(sandbox.fires(outcome="deny"))
                clone, clone_head = clones[row.clone]
                run = sandbox.push(clone, self.filled(row.command, sandbox, clone, clone_head))
                self.assertNotIn("Traceback", run.stderr)
                if row.expect == "gate":
                    self.assertDeniedForMissingEvidence(run)
                elif row.expect == "deny":
                    self.assertDeniedAsUnattributable(run)
                else:
                    self.assertEqual(run.rc, 0, run.stderr + run.stdout)
                    self.assertEqual(len(sandbox.fires(outcome="deny")), denies, "a pass spelling logged a deny")
                if row.expect != "pass":
                    self.assertEqual(len(sandbox.fires("risk", "pass")), passes, "a denied spelling logged a pass")

    def test_gateSpellings_pass_whenABundleCoversTheBranch(self):
        sandbox, repo, head = self.fixture_repo()
        sandbox.full_bundle(repo)
        for row in self.rows:
            if row.expect != "gate" or row.clone != GATED_CLONE:
                continue
            with self.subTest(command=row.command, note=row.note):
                run = sandbox.push(repo, self.filled(row.command, sandbox, repo, head))
                self.assertEqual(run.rc, 0, run.stderr + run.stdout)
                line = sandbox.fires("risk", "pass")[-1]
                self.assertEqual((line["repo"], line["head"], line["risk"]), ("acme/app", head, "standard"))

    def test_gateSpellings_areScannedByGitGuard_whenTheRangeCarriesAttribution(self):
        sandbox, repo, head = self.fixture_repo(commit_message="Add feature\n\n" + ATTRIBUTION_TRAILER)
        for row in self.rows:
            if row.expect != "gate" or row.clone != GATED_CLONE or "push" not in row.command:
                continue
            with self.subTest(command=row.command, note=row.note):
                run = self.git_guard(sandbox, repo, self.filled(row.command, sandbox, repo, head))
                self.assertEqual(run.rc, 2, "%r: %s%s" % (row.command, run.stderr, run.stdout))
                self.assertIn("[F-attribution]", run.stderr)

    def test_parseMerge_readsTheRepo_whenTheFlagValueIsAttached(self):
        hook = load_hook_module()
        for flag in ("-Racme/app", "-R=acme/app", "--repo=acme/app"):
            with self.subTest(flag=flag):
                merge = hook.parse_merge(["gh", "pr", "merge", "7", flag], "/nowhere", None)
                self.assertEqual("acme/app", merge.repo_flag)

    def test_crashFallback_readsEveryGateAndDenySpelling_asAPushOrMerge(self):
        hook = load_hook_module()
        for row in self.rows:
            if row.expect == "pass":
                continue
            with self.subTest(command=row.command, note=row.note):
                self.assertTrue(hook.may_push_or_merge(row.command))

    # --- fixture ---

    def fixture_repo(self, commit_message: str = "feature"):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        head = repo.commit(LOGIC_WITH_TEST, commit_message)
        repo.git("tag", "tmp")
        with open(sandbox.gh_response, "w") as stream:
            json.dump({"state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                       "statusCheckRollup": [], "baseRefName": "main", "headRefOid": head}, stream)
        self.tmp = os.path.join(sandbox.root, "elsewhere")
        os.makedirs(self.tmp, exist_ok=True)
        return sandbox, repo, head

    def fork_clone(self, sandbox: Sandbox, name: str, push_remote: Optional[str]):
        """(clone, feature commit) of me/app, an ungated fork of acme/app whose `feature` pushes to `push_remote`
        (None: origin)."""
        fork = sandbox.clone("me", "app", name=name)
        fork.git("remote", "add", "upstream", sandbox.remote("acme", "app"))
        fork.branch("feature")
        head = fork.commit(LOGIC_WITH_TEST, "feature")
        if push_remote:
            fork.git("config", "branch.feature.pushRemote", push_remote)
        return fork, head

    def filled(self, command: str, sandbox: Sandbox, repo: Repo, head: str) -> str:
        return command.replace("{repo}", repo.path).replace("{tmp}", self.tmp).replace("{head}", head)

    def git_guard(self, sandbox: Sandbox, repo: Repo, command: str) -> Run:
        payload = sandbox.bash_payload(repo, command)
        completed = subprocess.run([sys.executable, GIT_GUARD], input=json.dumps(payload), capture_output=True,
                                   text=True, env=sandbox.env)
        return Run(completed.returncode, completed.stdout, completed.stderr)

    # --- assertions ---

    def assertDeniedForMissingEvidence(self, run: Run) -> None:
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [K1] no review evidence for acme/app", run.stderr)
        self.assertIn(RUN_YOURSELF, run.stderr)

    def assertDeniedAsUnattributable(self, run: Run) -> None:
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertTrue(UNATTRIBUTABLE in run.stderr or "- [F-irreversible]" in run.stderr, run.stderr)
        self.assertNotIn("- [K1] no review evidence", run.stderr)
        self.assertIn(RUN_YOURSELF, run.stderr)


if __name__ == "__main__":
    unittest.main()
