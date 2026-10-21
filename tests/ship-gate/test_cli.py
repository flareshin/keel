"""`bin/keel`: test runs, snapshots, approvals, write-review (incl. scenario 19), write-smoke, show, gc."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import unittest
from unittest import mock

from helpers import Sandbox, read_json
from test_hook_commands import load_hook_module


class KeelTestCommandTest(unittest.TestCase):
    def test_keelTest_writesEvidence_whenGreenRunReportsTests(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        run = sandbox.keel("test", "--", "bash", "-c", "echo 'Ran 7 tests'; echo OK", cwd=repo.path)
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertIn("Ran 7 tests", run.stdout)
        summary = json.loads(run.stderr.strip().splitlines()[-1].split(" ", 1)[1])
        self.assertEqual((summary["count"], summary["exit"]), (7, 0))
        evidence = read_json(sandbox.evidence_files("tests")[0])
        self.assertEqual((evidence["count"], evidence["framework"], evidence["tree"]), (7, "unittest", repo.tree()))
        self.assertEqual(evidence["cmd"], ["bash", "-c", "echo 'Ran 7 tests'; echo OK"])
        self.assertEqual(stat.S_IMODE(os.stat(sandbox.evidence_files("tests")[0]).st_mode), 0o600)

    def test_keelTest_exits4WithoutEvidence_whenNoTestsRecognized(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        run = sandbox.keel("test", "--", "bash", "-c", "echo BUILD SUCCESS", cwd=repo.path)
        self.assertEqual(run.rc, 4)
        self.assertEqual(sandbox.evidence_files("tests"), [])
        with open(os.path.join(sandbox.data, "logs", "keel-tests.jsonl")) as stream:
            self.assertEqual(json.loads(stream.readline())["evidence_id"], None)

    def test_keelTest_keepsExitCodeWithoutEvidence_whenCommandFails(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        run = sandbox.keel("test", "--", "bash", "-c", "echo 'Ran 2 tests'; exit 3", cwd=repo.path)
        self.assertEqual(run.rc, 3)
        self.assertEqual(sandbox.evidence_files("tests"), [])

    def test_keelTest_writesNoEvidence_whenCommandChangesTheTree(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        run = sandbox.keel("test", "--", "bash", "-c", "echo changed > generated.txt; echo '4 passed'", cwd=repo.path)
        self.assertEqual(run.rc, 0)
        self.assertEqual(sandbox.evidence_files("tests"), [])

    def test_keelTest_writesSubmoduleEvidence_withItsUncommittedContent(self):
        sandbox = Sandbox(self)
        parent, submodule = sandbox.clone_with_submodule()
        submodule.write("lib.py", "LIB = 2\n")
        submodule_tree = sandbox.keel("snapshot", submodule.path).json["tree"]
        run = sandbox.keel("test", "--", "bash", "-c", "echo 'Ran 2 tests'", cwd=parent.path)
        self.assertEqual(run.rc, 0, run.stderr)
        by_repo = {evidence["repo"]: evidence for evidence in map(read_json, sandbox.evidence_files("tests"))}
        self.assertEqual(sorted(by_repo), ["acme/lib", "acme/platform"])
        lib = by_repo["acme/lib"]
        self.assertEqual((lib["tree"], lib["head"], lib["count"]), (submodule_tree, submodule.head(), 2))
        self.assertEqual(lib["superproject"], "acme/platform")
        summary = json.loads(run.stderr.strip().splitlines()[-1].split(" ", 1)[1])
        self.assertEqual(summary["submodule_evidence"], {"acme/lib": lib["evidence_id"]})

    def test_keelTest_writesNoSubmoduleEvidence_whenCommandChangesTheSubmodule(self):
        sandbox = Sandbox(self)
        parent, _submodule = sandbox.clone_with_submodule()
        run = sandbox.keel("test", "--", "bash", "-c", "echo changed > lib/generated.txt; echo '4 passed'",
                           cwd=parent.path)
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual([read_json(path)["repo"] for path in sandbox.evidence_files("tests")], ["acme/platform"])

    def test_keelTest_countsTestsOnly_whenVitestOrJestAlsoSummarizesFiles(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        for output, expected in ((" Test Files  7 passed (7)\\n      Tests  67 passed (67)", 67),
                                 ("Test Suites: 2 passed, 2 total\\nTests:       9 passed, 9 total", 9)):
            run = sandbox.keel("test", "--", "bash", "-c", "printf '%s\\n'" % output, cwd=repo.path)
            self.assertEqual(run.rc, 0, run.stderr)
            summary = json.loads(run.stderr.strip().splitlines()[-1].split(" ", 1)[1])
            self.assertEqual(summary["count"], expected, output)

    def test_keelTest_recognizesSurefireTotals_whenPerClassLinesPrecede(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        output = "Tests run: 3, Failures: 0\\nTests run: 2, Failures: 0\\nResults:\\nTests run: 5, Failures: 0"
        run = sandbox.keel("test", "--", "bash", "-c", "printf '%s\\n'" % output, cwd=repo.path)
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(read_json(sandbox.evidence_files("tests")[0])["count"], 5)

    def test_keelTest_isUsageError_whenNoDoubleDash(self):
        sandbox = Sandbox(self)
        self.assertEqual(sandbox.keel("test", "echo").rc, 2)


class SnapshotTest(unittest.TestCase):
    def test_snapshot_includesUntrackedAndLeavesIndexUntouched(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.write("untracked.txt", "new\n")
        run = sandbox.keel("snapshot", repo.path)
        self.assertEqual(run.rc, 0, run.stderr)
        tree = run.json["tree"]
        self.assertNotEqual(tree, repo.tree())
        self.assertIn("untracked.txt", repo.git("ls-tree", "--name-only", tree))
        self.assertEqual(repo.git("status", "--porcelain"), "?? untracked.txt")

    def test_snapshot_isUsageError_whenPathIsNotARepo(self):
        sandbox = Sandbox(self)
        self.assertEqual(sandbox.keel("snapshot", sandbox.home).rc, 2)

    def test_snapshot_givesEachGitCallTheSnapshotTimeout_notTheHookBudget(self):
        # given git calls that record their arguments instead of running
        gitcmd = load_hook_module().gitcmd
        done = subprocess.CompletedProcess([], 0, b"tree\n", b"")
        with mock.patch.object(gitcmd.subprocess, "run", return_value=done) as git_run:
            # when
            gitcmd.snapshot_tree("/nowhere")
        # then read-tree, add -A and write-tree each run under the CLI-scale timeout
        timeouts = [call.kwargs["timeout"] for call in git_run.call_args_list]
        self.assertEqual(3, len(timeouts))
        self.assertNotIn(gitcmd.GIT_TIMEOUT_SECONDS, timeouts)
        self.assertEqual({gitcmd.SNAPSHOT_TIMEOUT_SECONDS}, set(timeouts))


class WriteReviewTest(unittest.TestCase):
    def feature(self, sandbox: Sandbox):
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "a\n", "README.md": None})
        return repo

    def test_writeReview_recomputesPathsFromGit_whenClaimIsValid(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        run = sandbox.review(repo)
        self.assertEqual(run.json["paths"], 2)
        evidence = read_json(sandbox.evidence_files("review")[0])
        paths = {entry["path"]: (entry["blob"], entry["mode"]) for entry in evidence["paths"]}
        self.assertEqual(paths["README.md"], (None, "000000"))
        self.assertEqual(paths["src/a.py"][1], "100644")
        self.assertEqual(evidence["reviewed_tree"], evidence["snapshot_tree"])
        self.assertEqual(evidence["source"]["via"], "SubagentHandback")

    def test_writeReview_isIdempotent_whenSameRunReviewsSameTree(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        first = sandbox.review(repo).json
        second = sandbox.review(repo).json
        self.assertEqual(first["evidence_id"], second["evidence_id"])
        self.assertEqual(len(sandbox.evidence_files("review")), 1)

    def test_writeReview_linksDelta_whenSinceNamesAReviewedTree(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        root_tree = sandbox.keel("snapshot", repo.path).json["tree"]
        root_id = sandbox.review(repo).json["evidence_id"]
        repo.commit({"src/b.py": "b\n"})
        delta = sandbox.review(repo, run_id="rv-delta-0002", root_run_id="rv-root-0001", since=root_tree).json
        self.assertEqual(delta["paths"], 1)
        evidence = [read_json(path) for path in sandbox.evidence_files("review")]
        delta_evidence = next(item for item in evidence if item["run_id"] == "rv-delta-0002")
        self.assertEqual((delta_evidence["since"], delta_evidence["since_tree"]), (root_id, root_tree))

    def test_writeReview_refuses_whenSinceTreeWasNeverReviewed(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.review(repo)
        request = sandbox.review_request(repo, run_id="rv-delta-0002", root_run_id="rv-root-0001", since="a" * 40)
        run = sandbox.keel("evidence", "write-review", stdin=json.dumps(request))
        self.assertEqual(run.rc, 3, run.stderr)
        self.assertEqual(len(sandbox.evidence_files("review")), 1)

    def test_writeReview_refuses_whenRootRunIdDiffersForRootReview(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        request = sandbox.review_request(repo, run_id="rv-root-0001", root_run_id="rv-root-0000")
        run = sandbox.keel("evidence", "write-review", stdin=json.dumps(request))
        self.assertEqual(run.rc, 3)

    def test_writeReview_isUsageError_whenKeysAreWrong(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        request = sandbox.review_request(repo)
        request["keel_evidence"]["paths"] = ["src/a.py"]
        self.assertEqual(sandbox.keel("evidence", "write-review", stdin=json.dumps(request)).rc, 2)
        request = sandbox.review_request(repo)
        request["keel_evidence"]["head"] = repo.head()
        self.assertEqual(sandbox.keel("evidence", "write-review", stdin=json.dumps(request)).rc, 2)
        self.assertEqual(sandbox.evidence_files("review"), [])

    def test_writeReview_checksNoTestReason_onlyForBeingNonBlank(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        blank = sandbox.review_request(repo, no_test_reason="  ")
        self.assertEqual(sandbox.keel("evidence", "write-review", stdin=json.dumps(blank)).rc, 2)
        long_reason = sandbox.review_request(repo, no_test_reason="wording only " * 30)
        self.assertEqual(sandbox.keel("evidence", "write-review", stdin=json.dumps(long_reason)).rc, 0)

    def test_writeReview_refuses_whenObjectsAreMissing(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        request = sandbox.review_request(repo)
        request["keel_evidence"]["snapshot_tree"] = "b" * 40
        self.assertEqual(sandbox.keel("evidence", "write-review", stdin=json.dumps(request)).rc, 3)

    # scenario 19
    def test_writeReview_refuses_whenAgentIdIsMissing(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        request = sandbox.review_request(repo)
        request["source"]["agent_id"] = None
        run = sandbox.keel("evidence", "write-review", stdin=json.dumps(request))
        self.assertEqual(run.rc, 3)
        self.assertIn("no agent_id", run.stderr)
        self.assertEqual(sandbox.evidence_files("review"), [])

    def test_writeReview_refuses_whenAgentTranscriptIsMissing(self):
        # given a request whose agent transcript was never written
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        request = sandbox.review_request(repo)
        request["source"]["agent_transcript_path"] = os.path.join(sandbox.data, "projects", "proj", "s1", "subagents",
                                                                  "agent-gone.jsonl")
        # when
        run = sandbox.keel("evidence", "write-review", stdin=json.dumps(request))
        # then
        self.assertEqual(run.rc, 3)
        self.assertIn("agent transcript does not exist", run.stderr)
        self.assertEqual(sandbox.evidence_files("review"), [])

    def test_writeReview_accepts_whenAgentTranscriptSitsInAWorkflowSubdirectory(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        request = sandbox.review_request(repo)
        request["source"]["agent_transcript_path"] = sandbox.agent_transcript("s1", "ag1", subdir="wf-1")
        self.assertEqual(sandbox.keel("evidence", "write-review", stdin=json.dumps(request)).rc, 0)


class ApproveTest(unittest.TestCase):
    def test_approve_refuses_whenNoChainHasThatRoot(self):
        sandbox = Sandbox(self)
        run = sandbox.keel("approve", "rv-none-0001")
        self.assertEqual(run.rc, 3)
        self.assertEqual(sandbox.evidence_files("approval"), [])

    def test_approve_refuses_whenAHeadIsNeedsFixes(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "a\n"})
        sandbox.review(repo, verdict="NEEDS_FIXES")
        run = sandbox.keel("approve", "rv-root-0001")
        self.assertEqual(run.rc, 3)
        self.assertIn("not PASS for acme/app", run.stderr)

    def test_approve_pinsHeads_andReadWritesAck(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "a\n"})
        head_id = sandbox.review(repo).json["evidence_id"]
        approval = sandbox.keel("approve", "rv-root-0001").json
        ack = sandbox.keel("approve", "rv-root-0001", "--read").json
        self.assertEqual((approval["kind"], approval["heads"]), ("approval", {"acme/app": head_id}))
        self.assertEqual(ack["kind"], "ack")
        self.assertEqual(read_json(sandbox.evidence_files("approval")[0])["source"], "cli")

    def test_approve_isUsageError_whenRootIsMalformed(self):
        sandbox = Sandbox(self)
        self.assertEqual(sandbox.keel("approve", "x").rc, 2)


class SmokeShowGcTest(unittest.TestCase):
    def test_writeSmoke_refuses_whenRunFailedOrDidNotCoverRepo(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        self.assertEqual(sandbox.smoke_evidence(repo, ok=False).rc, 3)
        other = sandbox.clone("acme", "other")
        sandbox.smoke_line(other, run_id="sm-0002")
        self.assertEqual(sandbox.keel("evidence", "write-smoke", "--repo", repo.path).rc, 3)
        self.assertEqual(sandbox.evidence_files("smoke"), [])

    def test_writeSmoke_picksNamedRun_whenRunGiven(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        sandbox.smoke_line(repo, run_id="sm-0001")
        sandbox.smoke_line(repo, ok=False, run_id="sm-0002")
        run = sandbox.keel("evidence", "write-smoke", "--repo", repo.path, "--run", "sm-0001")
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(run.json["tree"], repo.tree())

    def test_show_listsChainsTestsAndSmoke_whenEvidenceExists(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "a\n"})
        sandbox.full_bundle(repo)
        sandbox.smoke_evidence(repo)
        shown = sandbox.keel("evidence", "show", "--repo", repo.path).json
        self.assertEqual(shown["repo"], "acme/app")
        chain = shown["chains"][0]
        self.assertEqual((chain["root_run_id"], chain["verdict"], chain["paths"], chain["approved"], chain["acked"]),
                         ("rv-root-0001", "PASS", 1, True, False))
        self.assertEqual((len(shown["tests"]), len(shown["smoke"])), (1, 1))
        self.assertEqual(sandbox.keel("evidence", "show", "--repo", repo.path, "--root", "rv-x").json["chains"], [])

    def test_gc_deletesExpired_keepsLiveEvidenceEvenWhenMerged(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        merged_head = repo.commit({"src/a.py": "a\n"})
        sandbox.review(repo, head=merged_head)
        sandbox.tests_evidence(repo)
        sandbox.approve("rv-root-0001")
        expired = sandbox.evidence_files("approval")[0]
        with open(expired) as stream:
            text = stream.read()
        with open(expired, "w") as stream:
            stream.write(text.replace('"expires_at": "20', '"expires_at": "19'))
        repo.commit({"src/live.py": "live\n"})
        sandbox.review(repo, run_id="rv-root-0002")
        repo.git("push", "-q", "origin", "feature:main")
        repo.git("fetch", "-q", "origin")
        run = sandbox.keel("evidence", "gc")
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(run.json["deleted"], 1)
        self.assertEqual(len(sandbox.evidence_files("review")), 2)
        self.assertEqual(len(sandbox.evidence_files("tests")), 1)
        self.assertEqual(sandbox.evidence_files("approval"), [])


if __name__ == "__main__":
    unittest.main()
