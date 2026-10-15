"""measure/smoke --candidate: smoke evidence for an overlay worktree before its change is linked into the data dir."""
from __future__ import annotations

import json
import os
import subprocess
import unittest

from helpers import CHECKOUT, MeasureSandbox, read_text

LINK_TOOL = os.path.join(CHECKOUT, "bin", "link")
OVERLAY_KEY = "example/keel-overlay"
CORE_FRAGMENT = {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 {{KEEL}}/hooks/demo/demo.py"}]}]}}
CLAUDE_MD_CAP_BYTES = 4096
WORKTREE = "overlay-wt"


class CandidateSmokeTest(unittest.TestCase):
    """The live data dir is linked from the merged overlay; the candidate is an overlay worktree with a changed fragment and PERSONAL.md."""

    def setUp(self) -> None:
        self.box = MeasureSandbox()
        self.addCleanup(self.box.cleanup)
        self.box.write("keel/settings/core.json", json.dumps(CORE_FRAGMENT))
        self.box.write("keel/settings/links.tsv", "source\ttarget\n{{KEEL}}/skills/demo\tskills/demo\n")
        self.box.seed_clean_keel()
        self.box.write("overlay/PERSONAL.md", "- [K1] Old personal rule.\n")
        self.box.write("overlay/settings/personal.json", json.dumps({"env": {"EXAMPLE_MODE": "old"}}))
        self.box.write("overlay/commands/demo.md", "Demo command.\n")
        self.box.write("overlay/links.tsv", "source\ttarget\n{{OVERLAY}}/commands/demo.md\tcommands/demo.md\n")
        self.box.init_repo(self.box.overlay, "https://example.invalid/example/keel-overlay.git")
        self.box.commit_all(self.box.overlay)
        self.box.env["KEEL_LINK"] = LINK_TOOL
        os.remove(os.path.join(self.box.data, "settings.json"))
        self.run_link("--write")
        self.worktree = os.path.join(self.box.root, WORKTREE)
        self.box.git(self.box.overlay, "worktree", "add", "-q", "-b", "candidate", self.worktree)
        self.box.env["KEEL_OVERLAY_DIR"] = self.worktree
        self.change_candidate({
            "PERSONAL.md": "- [K1] New personal rule.\n",
            "settings/personal.json": json.dumps({"env": {"EXAMPLE_MODE": "new"}}),
        })

    def run_link(self, *args: str) -> None:
        completed = subprocess.run([LINK_TOOL] + list(args), capture_output=True, text=True, env=self.box.env)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def change_candidate(self, files: dict) -> None:
        for relative_path, content in files.items():
            self.box.write(os.path.join(WORKTREE, relative_path), content)
        self.box.commit_all(self.worktree, "Change the candidate")

    def run_smoke(self, *flags: str):
        completed, result = self.box.run_json("smoke", "--json-only", *flags)
        self.assertIsNotNone(result, completed.stderr)
        return completed, result

    def link_integrity(self, result: dict) -> dict:
        return [item for item in result["assertions"] if item["check"] == "link-integrity"][0]

    def test_candidateSmoke_passes_whenTheWorktreeFragmentAndPersonalDifferFromTheLiveDataDir(self) -> None:
        # when
        completed, result = self.run_smoke("--candidate")
        # then
        self.assertEqual(completed.returncode, 0, [item for item in result["assertions"] if item["status"] != "PASS"])
        self.assertEqual(self.link_integrity(result)["status"], "PASS")
        line = self.box.last_log_line("keel-smoke.jsonl")
        self.assertEqual(line["trees"][OVERLAY_KEY], self.box.git(self.worktree, "rev-parse", "HEAD^{tree}").strip())

    def test_candidateSmoke_marksItsLogLine_asCandidate(self) -> None:
        # when
        _, result = self.run_smoke("--candidate")
        # then
        line = self.box.last_log_line("keel-smoke.jsonl")
        self.assertEqual((line["run_id"], line["candidate"]), (result["run_id"], True))

    def test_liveSmoke_failsOnDriftAndKeepsItsLineShape_whenTheOverlayIsAWorktree(self) -> None:
        # when
        completed, result = self.run_smoke()
        # then
        self.assertEqual(completed.returncode, 1)
        detail = self.link_integrity(result)["detail"]
        for kind in ("link-wrong", "settings-drift", "claude-md-drift"):
            self.assertIn(kind, detail)
        line = self.box.last_log_line("keel-smoke.jsonl")
        self.assertEqual(sorted(line), ["count", "failed", "ok", "run_id", "trees", "ts"])

    def test_candidateSmoke_leavesTheLiveDataDirAndHooksPathUnchanged(self) -> None:
        # given
        before = self.data_dir_files()
        # when
        self.run_smoke("--candidate")
        # then
        self.assertEqual(self.data_dir_files(), before)

    def test_candidateSmoke_removesItsEmptyDataDir_afterTheRun(self) -> None:
        # given
        temp_root = os.path.join(self.box.root, "tmp")
        os.makedirs(temp_root)
        self.box.env["TMPDIR"] = temp_root
        # when
        self.run_smoke("--candidate")
        # then
        self.assertEqual(os.listdir(temp_root), [])

    def test_candidateSmoke_fails_whenTheGeneratedClaudeMdWouldExceedTheCap(self) -> None:
        # given
        self.change_candidate({"PERSONAL.md": "- [K1] " + "x" * CLAUDE_MD_CAP_BYTES + "\n"})
        # when
        completed, result = self.run_smoke("--candidate")
        # then
        self.assertEqual(completed.returncode, 1)
        item = self.link_integrity(result)
        self.assertEqual(item["status"], "FAIL")
        self.assertIn("over the %d-byte cap" % CLAUDE_MD_CAP_BYTES, item["detail"])

    def test_candidateSmoke_fails_whenADeclaredStackFragmentIsMissing(self) -> None:
        # given
        self.change_candidate({"stacks.txt": "demo-stack\n"})
        # when
        completed, result = self.run_smoke("--candidate")
        # then
        self.assertEqual(completed.returncode, 1)
        item = self.link_integrity(result)
        self.assertEqual(item["status"], "FAIL")
        self.assertIn("active stack 'demo-stack' has no", item["detail"])

    def test_candidateSmoke_passesLinkIntegrity_whenCandidateAddsAScheduledTask(self) -> None:
        # given a scheduled-task row, which an empty data dir always lacks as a copy
        self.change_candidate({
            "scheduled-tasks/demo/SKILL.md": "Run the demo.\n",
            "links.tsv": "source\ttarget\n{{OVERLAY}}/commands/demo.md\tcommands/demo.md\n"
                         "{{OVERLAY}}/scheduled-tasks/demo/SKILL.md\tscheduled-tasks/demo/SKILL.md\n",
        })
        # when
        _, result = self.run_smoke("--candidate")
        # then
        item = self.link_integrity(result)
        self.assertEqual(item["status"], "PASS", item["detail"])

    def test_candidateSmoke_fails_whenAnOverlayLinkSourceIsMissing(self) -> None:
        # given
        self.box.git(self.worktree, "rm", "-q", "commands/demo.md")
        self.box.git(self.worktree, "commit", "-q", "--no-verify", "-m", "Drop the demo command")
        # when
        completed, result = self.run_smoke("--candidate")
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertIn("dangling: source does not exist", self.link_integrity(result)["detail"])

    def test_candidateSmoke_failsAndSetsNothing_whenKeelHooksPathIsUnset(self) -> None:
        # given
        self.box.git(self.box.keel, "config", "--unset", "core.hooksPath")
        # when
        completed, result = self.run_smoke("--candidate")
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertIn("hookspath-drift", self.link_integrity(result)["detail"])
        unset = subprocess.run(["git", "-C", self.box.keel, "config", "--get", "core.hooksPath"], env=self.box.env, capture_output=True)
        self.assertEqual(unset.returncode, 1)

    def test_candidateSmoke_fails_whenADryRunThatExitsZeroPrintsNoProblemList(self) -> None:
        for name, stdout in (("not json", "planned"), ("no problems key", '{"actions":[]}'),
                             ("problems not a list", '{"actions":[],"problems":"none"}'),
                             ("problem not an object", '{"actions":[],"problems":["x"]}')):
            with self.subTest(output=name):
                # given
                self.box.env["KEEL_LINK"] = self.box.write("stubs/link-odd", "#!/bin/bash\necho '%s'\n" % stdout, executable=True)
                # when
                completed, result = self.run_smoke("--candidate")
                # then
                self.assertEqual(completed.returncode, 1)
                self.assertIn("link dry run exited 0", self.link_integrity(result)["detail"])

    def data_dir_files(self) -> dict:
        """Every path under the data dir except logs/, with its link target or content, plus keel's core.hooksPath."""
        files = {"core.hooksPath": self.box.git(self.box.keel, "config", "--get", "core.hooksPath")}
        for current, dir_names, file_names in os.walk(self.box.data):
            dir_names[:] = [name for name in dir_names if os.path.join(current, name) != os.path.join(self.box.data, "logs")]
            for name in dir_names + file_names:
                path = os.path.join(current, name)
                if os.path.islink(path):
                    files[path] = "-> " + os.readlink(path)
                elif os.path.isfile(path):
                    files[path] = read_text(path)
                else:
                    files[path] = "dir"
        return files


if __name__ == "__main__":
    unittest.main()
