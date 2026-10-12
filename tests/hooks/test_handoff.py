import json
import os
import re
import unittest

import helpers
from helpers import HANDOFF, base_payload


class HandoffTestCase(helpers.SandboxTestCase):
    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")

    def handoff_file(self, main_repo=None):
        slug = re.sub(r"[^A-Za-z0-9]", "-", main_repo or self.repo)
        return os.path.join(self.sandbox.data, "handoff", slug + ".md")

    def auto(self, cwd=None, raw=None):
        payload = base_payload("PreCompact", cwd or self.repo, "/data/projects/p/s1.jsonl", in_subagent=False)
        payload.update({"trigger": "auto", "custom_instructions": ""})
        return self.sandbox.run_hook(HANDOFF, payload, args=["--auto"], cwd=cwd or self.repo, raw=raw)

    def cli(self, *args, cwd=None):
        return self.sandbox.run_hook(HANDOFF, args=list(args), cwd=cwd or self.repo)

    def read(self, path):
        with open(path) as stream:
            return stream.read()


class AutoSnapshotTest(HandoffTestCase):
    def test_auto_writesSnapshotAndRecordsFire_whenInsideRepo(self):
        # given
        self.sandbox.write(os.path.join(self.repo, "wip.txt"), "x\n")
        # when
        result = self.auto()
        # then
        self.assertEqual(0, result.code)
        text = self.read(self.handoff_file())
        self.assertIn("(auto-snapshot before auto compaction · transcript: /data/projects/p/s1.jsonl)", text)
        self.assertIn("- Branch: `main`", text)
        self.assertIn("## Uncommitted (1)", text)
        self.assertFired("C-handoff", "record", "handoff")

    def test_auto_passesWithoutFile_whenOutsideRepo(self):
        outside = os.path.join(self.sandbox.root, "plain")
        os.makedirs(outside)
        result = self.auto(cwd=outside)
        self.assertEqual(0, result.code)
        self.assertFalse(os.path.exists(os.path.join(self.sandbox.data, "handoff")))
        self.assertEqual([], self.sandbox.fires())

    def test_auto_keepsHandWrittenNote_whenSameBranch(self):
        self.cli("next: rerun the parser test")
        self.auto()
        text = self.read(self.handoff_file())
        self.assertIn("next: rerun the parser test\n(auto-snapshot before auto", text)

    def test_auto_writesNothing_whenNoteBelongsToAnotherBranch(self):
        self.cli("next: rerun the parser test")
        before = self.read(self.handoff_file())
        self.sandbox.git(self.repo, "checkout", "-q", "-b", "other")
        self.auto()
        self.assertEqual(before, self.read(self.handoff_file()))

    def test_auto_keysOnMainRepo_whenRunInWorktree(self):
        worktree = os.path.join(self.sandbox.root, "wt-feature")
        self.sandbox.git(self.repo, "worktree", "add", "-q", "-b", "feature", worktree)
        self.auto(cwd=worktree)
        self.assertIn("- Working worktree: `%s`" % worktree, self.read(self.handoff_file()))

    def test_auto_passesAndLogsError_whenHandoffDirIsAFile(self):
        self.sandbox.write(os.path.join(self.sandbox.data, "handoff"), "not a dir")
        result = self.auto()
        self.assertEqual(0, result.code)
        self.assertFired("C-handoff", "error", "handoff")

    def test_auto_usesProcessCwd_whenPayloadUnparseable(self):
        result = self.auto(raw="not json")
        self.assertEqual(0, result.code)
        self.assertTrue(os.path.exists(self.handoff_file()))


class CliModesTest(HandoffTestCase):
    def test_note_isReadBack_whenRecorded(self):
        self.cli("next: start from the repro test")
        self.assertIn("next: start from the repro test", self.cli("--read").stdout)

    def test_status_reportsResumePoint_whenNoteWrittenByPerson(self):
        self.cli("next: start from the repro test")
        status = json.loads(self.cli("--status").stdout)
        self.assertEqual({"path": self.handoff_file(), "hasResumePoint": True}, status)

    def test_status_reportsNoResumePoint_whenOnlyAutoSnapshot(self):
        self.auto()
        self.assertFalse(json.loads(self.cli("--status").stdout)["hasResumePoint"])

    def test_clear_removesFile_whenPresent(self):
        self.cli("next: x")
        self.cli("--clear")
        self.assertFalse(os.path.exists(self.handoff_file()))

    def test_path_printsHandoffLocation(self):
        self.assertEqual(self.handoff_file(), self.cli("--path").stdout.strip())

    def test_cli_failsWithUsage_whenOutsideRepo(self):
        outside = os.path.join(self.sandbox.root, "plain")
        os.makedirs(outside)
        result = self.cli("--path", cwd=outside)
        self.assertEqual(1, result.code)
        self.assertIn("inside a git repo", result.stderr)


if __name__ == "__main__":
    unittest.main()
