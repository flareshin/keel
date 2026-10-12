"""DESIGN 5.9 scenario 17 (`gh pr merge` with a commit-range review) and 20 (smoke-only pushes)."""
from __future__ import annotations

import json
import os
import subprocess
import unittest
from datetime import date, timedelta

from helpers import KEEL_HOME, LOGIC_WITH_TEST, Repo, Sandbox

OVERLAY_REGISTRY = ["acme/overlay\tcode\tmain\toverlay\trequired"]
OFF_NOTES_REGISTRY = ["acme/app\tcode\tmain\tacme\trequired", "acme/notes\toff\tmain\t-\tnone"]
MEASURE_SMOKE = os.path.join(KEEL_HOME, "measure", "smoke")
LINK_TOOL = os.path.join(KEEL_HOME, "bin", "link")
LEDGER_HEADER = ("id\tscope\ttype\tstatement\tlayer\tenforced_at\twhy_not_stronger\tjustification\tincidents\tmetric"
                 "\treview_by\tgrace_until\tstatus")
DEMO_ROW = ("C-demo\tcore\tknowledge\tA demo rule.\thook\thook:demo\t-\t-\tdocs/incidents/one.md,docs/incidents/two.md"
            "\tfires:C-demo\t%s\t-\tactive" % (date.today() + timedelta(days=30)).isoformat())
DEMO_HOOK = (
    "import json, os, sys\n"
    "if json.load(sys.stdin)['tool_input']['command'].startswith('bad '):\n"
    "    logs = os.path.join(os.environ['KEEL_DATA_DIR'], 'logs')\n"
    "    os.makedirs(logs, exist_ok=True)\n"
    "    with open(os.path.join(logs, 'keel-fires.jsonl'), 'a') as stream:\n"
    "        stream.write(json.dumps({'rule_id': 'C-demo', 'outcome': 'deny', 'hook': 'demo'}) + '\\n')\n"
    "    sys.exit(2)\n"
)


class MergeScenarioTest(unittest.TestCase):
    def pull_request(self, sandbox: Sandbox, head: str, **overrides) -> None:
        body = {"state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "statusCheckRollup": [], "baseRefName": "main", "headRefOid": head}
        body.update(overrides)
        with open(sandbox.gh_response, "w") as stream:
            json.dump(body, stream)

    def reviewed_feature(self, sandbox: Sandbox, files=None, approve: bool = True):
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        head = repo.commit(files or LOGIC_WITH_TEST)
        repo.git("push", "-q", "origin", "feature")
        sandbox.review(repo, head=head)
        sandbox.tests_evidence(repo)
        if approve:
            sandbox.approve("rv-root-0001")
        return repo, head

    def merge(self, sandbox: Sandbox, repo, head: str):
        return sandbox.push(repo, "gh pr merge 7 --squash --match-head-commit %s" % head)

    # scenario 17
    def test_merge_passes_whenMatchHeadCommitHasCommitRangeReview(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        self.pull_request(sandbox, head)
        run = self.merge(sandbox, repo, head)
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["head"], head)
        with open(sandbox.gh_log) as stream:
            self.assertIn("pr view 7 --json statusCheckRollup,baseRefName", stream.read())

    # U1: approval is the user's act at the merge
    def test_merge_deniesK1_whenApprovalMissing(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox, approve=False)
        self.pull_request(sandbox, head)
        run = self.merge(sandbox, repo, head)
        self.assertEqual(run.rc, 2, run.stderr)
        self.assertIn("- [K1] no approval bound to chain head", run.stderr)
        self.assertTrue(run.stderr.splitlines()[-1].startswith("Run it yourself in your terminal: cd "), run.stderr)
        sandbox.approve("rv-root-0001")
        self.assertEqual(self.merge(sandbox, repo, head).rc, 0)

    def test_merge_passesOnApprovalAlone_whenHeavy(self):
        # given a reviewed, tested and approved heavy change, with no read ack
        sandbox = Sandbox(self)
        files = {"src/core/billing/a.py": "x\n", "tests/test_a.py": "def test_a(): assert True\n"}
        repo, head = self.reviewed_feature(sandbox, files=files)
        self.pull_request(sandbox, head)
        # when
        run = self.merge(sandbox, repo, head)
        # then
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["risk"], "heavy")

    def test_merge_denies_whenMatchHeadCommitFlagIsMissing(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        self.pull_request(sandbox, head)
        run = sandbox.push(repo, "gh pr merge 7 --squash")
        self.assertEqual(run.rc, 2)
        self.assertIn("- [F-irreversible] gh pr merge needs --match-head-commit", run.stderr)
        self.assertFalse(os.path.exists(sandbox.gh_log))

    def test_merge_denies_whenChecksAreRed_leavingAClosedPrToGitHub(self):
        # given a closed PR whose check failed
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        self.pull_request(sandbox, head, state="CLOSED",
                          statusCheckRollup=[{"name": "ci", "conclusion": "FAILURE"}])
        # when
        run = sandbox.push(repo, "gh pr merge 7 --match-head-commit %s" % head)
        # then the red check denies; the PR state is GitHub's to refuse
        self.assertEqual(run.rc, 2)
        self.assertIn("- [F-irreversible] checks not green: ci=FAILURE", run.stderr)
        self.assertNotIn("PR is CLOSED", run.stderr)

    def test_merge_withAuto_ignoresPendingChecks_butNotFailedOnes(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        self.pull_request(sandbox, head, statusCheckRollup=[{"name": "ci", "status": "IN_PROGRESS"}])
        self.assertEqual(sandbox.push(repo, "gh pr merge 7 --auto --match-head-commit %s" % head).rc, 0)
        self.assertEqual(sandbox.push(repo, "gh pr merge 7 --match-head-commit %s" % head).rc, 2)

    def test_merge_denies_whenReviewCoversAnotherCommit(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        newer = repo.commit({"src/a.py": "print(2)\n"}, "after review")
        self.pull_request(sandbox, newer)
        run = sandbox.push(repo, "gh pr merge 7 --match-head-commit %s" % newer)
        self.assertEqual(run.rc, 2)
        self.assertIn("src/a.py (content or mode changed after review)", run.stderr)

    def test_merge_failsClosed_whenGhCannotAnswer(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        with open(sandbox.gh_response, "w") as stream:
            stream.write("not json")
        run = sandbox.push(repo, "gh pr merge 7 --match-head-commit %s" % head)
        self.assertEqual(run.rc, 2)
        self.assertIn("failing closed", run.stderr)

    def test_merge_passes_whenRepoIsOff(self):
        sandbox = Sandbox(self, registry=["acme/app\toff\tmain\t-\tnone"])
        repo = sandbox.clone("acme", "app")
        run = sandbox.push(repo, "gh pr merge 7")
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "acme/app")

    # --repo names the repo that merges; the gate keys on it, not on the cwd clone
    def test_merge_denies_whenRepoFlagNamesGatedRepoFromAnotherClone(self):
        sandbox = Sandbox(self)
        other = sandbox.clone("acme", "other")
        run = sandbox.push(other, "gh pr merge 7 --repo acme/app --squash")
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [F-irreversible] run gh pr merge from a clone of acme/app", run.stderr)
        self.assertFalse(os.path.exists(sandbox.gh_log))
        self.assertEqual(sandbox.fires("F-irreversible", "deny")[-1]["repo"], "acme/app")
        self.assertFalse(sandbox.fires("risk", "pass"))

    def test_merge_denies_whenRepoFlagNamesGatedRepoFromAnotherClone_evenWithMatchHead(self):
        sandbox = Sandbox(self)
        other = sandbox.clone("acme", "other")
        run = sandbox.push(other, "gh pr merge 7 -R acme/app --match-head-commit %s" % ("a" * 40))
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("run gh pr merge from a clone of acme/app", run.stderr)
        self.assertFalse(os.path.exists(sandbox.gh_log))

    def test_merge_passes_whenRepoFlagNamesOffOrUnlistedRepoFromGatedClone(self):
        sandbox = Sandbox(self, registry=["acme/app\tcode\tmain\tacme\trequired", "acme/other\toff\tmain\t-\tnone"])
        repo = sandbox.clone("acme", "app")
        self.assertEqual(sandbox.push(repo, "gh pr merge 7 --repo acme/other").rc, 0)
        self.assertEqual(sandbox.push(repo, "gh pr merge 7 --repo=acme/unlisted").rc, 0)
        self.assertEqual([line["repo"] for line in sandbox.fires("risk", "pass")], ["acme/other", "acme/unlisted"])

    def test_merge_gates_whenRepoFlagNamesTheCloneItself(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        self.pull_request(sandbox, head)
        run = sandbox.push(repo, "gh pr merge 7 --repo github.com/ACME/app --match-head-commit %s" % head)
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "acme/app")
        with open(sandbox.gh_log) as stream:
            self.assertIn("--repo github.com/ACME/app", stream.read())

    def test_merge_failsClosed_whenRepoFlagIsNotOwnerSlashRepo(self):
        sandbox = Sandbox(self)
        other = sandbox.clone("acme", "other")
        run = sandbox.push(other, "gh pr merge 7 --repo app --match-head-commit %s" % ("a" * 40))
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("failing closed", run.stderr)
        self.assertFalse(os.path.exists(sandbox.gh_log))

    # a PR URL or GH_REPO= names the repo that merges just as --repo does; the cwd clone must be that repo
    def assert_foreign_merge_denied(self, sandbox: Sandbox, clone, command: str):
        run = sandbox.push(clone, command)
        self.assertEqual(run.rc, 2, "%r: %s%s" % (command, run.stderr, run.stdout))
        self.assertIn("- [F-irreversible] run gh pr merge from a clone of acme/app (this clone is %s)" % clone.key, run.stderr)
        self.assertFalse(os.path.exists(sandbox.gh_log))
        self.assertEqual(sandbox.fires("F-irreversible", "deny")[-1]["repo"], "acme/app")
        self.assertFalse(sandbox.fires("risk", "pass"))

    def test_merge_denies_whenPullUrlNamesGatedRepoFromOffClone(self):
        sandbox = Sandbox(self, registry=OFF_NOTES_REGISTRY)
        notes = sandbox.clone("acme", "notes")
        self.assert_foreign_merge_denied(sandbox, notes, "gh pr merge https://github.com/acme/app/pull/7 --squash "
                                                         "--match-head-commit %s" % ("a" * 40))

    def test_merge_denies_whenGhRepoEnvNamesGatedRepoFromOffClone(self):
        sandbox = Sandbox(self, registry=OFF_NOTES_REGISTRY)
        notes = sandbox.clone("acme", "notes")
        self.assert_foreign_merge_denied(sandbox, notes, "GH_REPO=acme/app gh pr merge 7 --squash")

    def test_merge_denies_whenPullUrlNamesGatedRepoFromUnlistedClone(self):
        sandbox = Sandbox(self)
        unlisted = sandbox.clone("acme", "zzz")
        self.assert_foreign_merge_denied(sandbox, unlisted, "gh pr merge https://github.com/acme/app/pull/7 --squash")

    def test_merge_denies_whenExportedGhRepoNamesGatedRepoFromUnlistedClone(self):
        sandbox = Sandbox(self)
        unlisted = sandbox.clone("acme", "zzz")
        self.assert_foreign_merge_denied(sandbox, unlisted, "export GH_REPO=acme/app; gh pr merge 7 --squash")

    def test_merge_gates_whenPullUrlNamesTheCloneItself(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        self.pull_request(sandbox, head)
        run = sandbox.push(repo, "gh pr merge https://github.com/acme/app/pull/7 --match-head-commit %s" % head)
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "acme/app")
        with open(sandbox.gh_log) as stream:
            self.assertIn("pr view https://github.com/acme/app/pull/7 --json", stream.read())

    def test_merge_gates_whenGhRepoEnvNamesTheCloneItself(self):
        sandbox = Sandbox(self)
        repo, head = self.reviewed_feature(sandbox)
        self.pull_request(sandbox, head)
        run = sandbox.push(repo, "GH_REPO=github.com/ACME/app gh pr merge 7 --match-head-commit %s" % head)
        self.assertEqual(run.rc, 0, run.stderr)
        with open(sandbox.gh_log) as stream:
            self.assertIn("GH_REPO=github.com/ACME/app pr view 7 --json", stream.read())


class SmokeScenarioTest(unittest.TestCase):
    def overlay_change(self, sandbox: Sandbox, files):
        repo = sandbox.clone("acme", "overlay", seed={"ledger.tsv": "id\n", "settings/a.json": "{}\n", "bin/tool": "#!/bin/sh\n"})
        repo.branch("feature")
        repo.commit(files)
        return repo

    # scenario 20
    def test_smokeOnlyPush_passes_whenSmokeEvidenceCoversTheTree(self):
        sandbox = Sandbox(self, registry=OVERLAY_REGISTRY)
        repo = self.overlay_change(sandbox, {"settings/a.json": '{"x": 1}\n'})
        written = sandbox.smoke_evidence(repo)
        self.assertEqual(written.rc, 0, written.stderr)
        run = sandbox.push(repo, "git push origin feature")
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["risk"], "smoke-only")

    def test_smokeOnlyPush_denies_whenSmokeEvidenceIsMissing(self):
        sandbox = Sandbox(self, registry=OVERLAY_REGISTRY)
        repo = self.overlay_change(sandbox, {"settings/a.json": '{"x": 1}\n'})
        run = sandbox.push(repo, "git push origin feature")
        self.assertEqual(run.rc, 2)
        self.assertIn("- [risk] no smoke evidence covers this exact content", run.stderr)

    def test_smokeOnlyPush_denies_whenSmokeEvidenceCoversAnotherTree(self):
        sandbox = Sandbox(self, registry=OVERLAY_REGISTRY)
        repo = self.overlay_change(sandbox, {"settings/a.json": '{"x": 1}\n'})
        sandbox.smoke_evidence(repo, tree=repo.tree("origin/main"))
        run = sandbox.push(repo, "git push origin feature")
        self.assertEqual(run.rc, 2)
        self.assertIn("no smoke evidence covers", run.stderr)

    def test_mixedPush_needsReview_whenACodePathJoinsSmokeOnlyPaths(self):
        sandbox = Sandbox(self, registry=OVERLAY_REGISTRY)
        repo = self.overlay_change(sandbox, {"settings/a.json": '{"x": 1}\n', "bin/tool": "#!/bin/sh\necho hi\n"})
        sandbox.smoke_evidence(repo)
        run = sandbox.push(repo, "git push origin feature")
        self.assertEqual(run.rc, 2)
        self.assertIn("- [K1] no review evidence for acme/overlay", run.stderr)
        self.assertEqual(sandbox.fires("K1", "deny")[0]["risk"], "standard")

    def test_smokeGate_needsOnlySmokeEvidence_forAnyPath(self):
        sandbox = Sandbox(self, registry=["acme/overlay\tsmoke\tmain\t-\tnone"])
        repo = self.overlay_change(sandbox, {"bin/tool": "#!/bin/sh\necho hi\n"})
        self.assertEqual(sandbox.push(repo, "git push origin feature").rc, 2)
        sandbox.smoke_evidence(repo)
        run = sandbox.push(repo, "git push origin feature")
        self.assertEqual(run.rc, 0, run.stderr)


def demo_fixture(command: str, expect: str = "") -> str:
    fixture = {"payload": {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}}}
    if expect:
        fixture["expect"] = expect
    return json.dumps(fixture)


class CandidateSmokeScenarioTest(unittest.TestCase):
    """Scenario 20 from an overlay worktree: smoke --candidate, write-smoke, push, before bin/link --write."""

    def smoke_ready_keel(self, sandbox: Sandbox) -> Repo:
        """A keel checkout with one hook-layer row on which every smoke check passes; the gated push still runs this checkout's ship-gate."""
        keel = Repo(sandbox, os.path.join(sandbox.root, "keel-under-smoke"), "example/keel")
        os.makedirs(keel.path)
        keel.git("init", "-q")
        keel.git("remote", "add", "origin", "https://example.invalid/example/keel.git")
        demo_registration = {"type": "command", "command": "python3 {{KEEL}}/hooks/demo/demo.py"}
        keel.commit({
            "ledger.tsv": LEDGER_HEADER + "\n" + DEMO_ROW + "\n",
            "docs/incidents/one.md": "First incident.\n",
            "docs/incidents/two.md": "Second incident.\n",
            "PRINCIPLES.md": "# Principles\n\n- [C-demo] A demo rule.\n",
            "skills/demo/SKILL.md": "# Demo\n\n## Rules\n\n- [C-demo] Tagged.\n",
            "hooks/demo/demo.py": DEMO_HOOK,
            "tests/hooks/fixtures/C-demo.bad.json": demo_fixture("bad C-demo", expect="deny"),
            "tests/hooks/fixtures/demo.good.json": demo_fixture("ls"),
            "settings/core.json": json.dumps({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [demo_registration]}]}}),
        }, "seed keel")
        logs = os.path.join(sandbox.data, "logs")
        os.makedirs(logs, exist_ok=True)
        with open(os.path.join(logs, "keel-fires.jsonl"), "a") as stream:
            stream.write(json.dumps({"ts": date.today().isoformat() + "T09:00:00Z", "rule_id": "C-demo", "hook": "demo",
                                     "outcome": "deny", "session": "-"}) + "\n")
        return keel

    def run_tool(self, sandbox: Sandbox, argv, keel: Repo, overlay: Repo) -> subprocess.CompletedProcess:
        env = dict(sandbox.env, KEEL_HOME=keel.path, KEEL_OVERLAY_DIR=overlay.path, KEEL_LINK=LINK_TOOL,
                   KEEL_CLAUDE=self.no_plugins_claude(sandbox))
        return subprocess.run(argv, capture_output=True, text=True, env=env)

    def no_plugins_claude(self, sandbox: Sandbox) -> str:
        path = os.path.join(sandbox.root, "stubs", "claude-no-plugins")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as stream:
            stream.write("#!/bin/bash\necho '[]'\n")
        os.chmod(path, 0o755)
        return path

    def test_smokeOnlyPush_passes_fromAnOverlayWorktree_withCandidateSmokeEvidence(self):
        # given: the live data dir linked from the merged overlay, and a worktree changing a settings fragment
        sandbox = Sandbox(self, registry=OVERLAY_REGISTRY)
        keel = self.smoke_ready_keel(sandbox)
        overlay = sandbox.clone("acme", "overlay", seed={"boundary/lexicon.txt": "ACMECORP\n",
                                                         "settings/a.json": '{"env": {"EXAMPLE_MODE": "old"}}\n'})
        linked = self.run_tool(sandbox, [LINK_TOOL, "--write"], keel, overlay)
        self.assertEqual(linked.returncode, 0, linked.stderr)
        worktree = Repo(sandbox, os.path.join(sandbox.root, "repos", "overlay-wt"), overlay.key)
        overlay.git("worktree", "add", "-q", "-b", "feature", worktree.path)
        worktree.commit({"settings/a.json": '{"env": {"EXAMPLE_MODE": "new"}}\n'})
        # when
        smoke = self.run_tool(sandbox, [MEASURE_SMOKE, "--candidate"], keel, worktree)
        written = sandbox.keel("evidence", "write-smoke", "--repo", worktree.path)
        run = sandbox.push(worktree, "git push origin feature")
        # then
        self.assertEqual(smoke.returncode, 0, smoke.stderr)
        self.assertEqual(written.rc, 0, written.stderr)
        self.assertEqual(written.json["tree"], worktree.tree())
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["risk"], "smoke-only")


if __name__ == "__main__":
    unittest.main()
