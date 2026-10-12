"""DESIGN 5.9 fixture scenarios for a single-repo `git push` (1, 4-13, 15, 18 and the extras), K3 as
written (logic ships with a test in the same range) and approval at the merge (U1)."""
from __future__ import annotations

import os
import unittest

from helpers import LOGIC_WITH_TEST, PUSH_APPROVAL_REGISTRY, Repo, Sandbox

TEST_FILE = "tests/test_a.py"
HEAVY_FILE = "src/core/billing/a.py"  # matched by the heavy rule in helpers.DEFAULT_RULES
TWO_LINE_TEST = "def test_a():\n    assert True\n"
ONE_LINE_TEST = "def test_a(): assert True\n"


class PushScenarioTest(unittest.TestCase):
    def feature(self, sandbox: Sandbox, files=None) -> Repo:
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit(files or LOGIC_WITH_TEST)
        return repo

    def assertDenied(self, run, rule_id: str, text: str = "") -> None:
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [%s]" % rule_id, run.stderr)
        self.assertIn(text, run.stderr)
        self.assertIn("Run it yourself in your terminal: cd ", run.stderr.splitlines()[-1])

    def assertPassed(self, sandbox: Sandbox, run, repo_key: str = "acme/app") -> dict:
        self.assertEqual(run.rc, 0, run.stderr)
        passes = sandbox.fires("risk", "pass")
        self.assertTrue(passes, sandbox.fires())
        self.assertEqual(passes[-1]["repo"], repo_key)
        return passes[-1]

    # scenario 1
    def test_push_passes_whenReviewTestsAndApprovalCoverTheChange(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        run = sandbox.push(repo, "git push origin feature")
        line = self.assertPassed(sandbox, run)
        self.assertEqual(line["risk"], "standard")
        self.assertEqual(line["root_run_id"], "rv-root-0001")
        self.assertEqual(line["head"], repo.head())

    def test_push_deniesK3_whenTestsEvidenceMissing(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.review(repo)
        sandbox.approve("rv-root-0001")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K3", "no tests evidence")
        self.assertEqual(sandbox.fires("K3", "deny")[0]["risk"], "standard")

    # U1: approval is the merge's; a push needs review and tests only
    def test_push_passesWithoutApproval_whenReviewAndTestsCoverTheChange(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.push_bundle(repo)
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))
        self.assertEqual(line["root_run_id"], "rv-root-0001")

    def test_push_deniesK1_whenApprovalMissingAndRegistryMakesPushesDeploy(self):
        sandbox = Sandbox(self, registry=PUSH_APPROVAL_REGISTRY)
        repo = self.feature(sandbox)
        sandbox.push_bundle(repo)
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "no approval bound to chain head")
        self.assertFalse(sandbox.fires("risk", "pass"))
        sandbox.approve("rv-root-0001")
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))

    def test_push_deniesK1_whenNoReviewExists(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "no review evidence for acme/app")

    # K3 as written: changed logic ships with a test in the same range
    def test_push_deniesK3_whenLogicChangesWithoutATestInTheRange(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox, {"src/a.py": "print(1)\n"})
        sandbox.push_bundle(repo)
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K3", "logic changed with no test in the same range: src/a.py")
        self.assertEqual(sandbox.fires("K3", "deny")[0]["risk"], "standard")

    def test_push_passesWithWaiver_whenReviewerStatesNoTestReason(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox, {"src/a.py": "print(1)\n"})
        sandbox.review(repo, no_test_reason="log line wording only")
        sandbox.tests_evidence(repo)
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))
        self.assertEqual(line["detail"], "K3 waived: log line wording only")

    def test_push_deniesK3_whenOnlyAnEarlierLinkCarriesTheWaiver(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox, {"src/a.py": "print(1)\n"})
        root_tree = sandbox.keel("snapshot", repo.path).json["tree"]
        sandbox.review(repo, no_test_reason="log line wording only")
        repo.commit({"src/a.py": "print(2)\n"}, "more logic")
        sandbox.review(repo, run_id="rv-delta-0002", root_run_id="rv-root-0001", since=root_tree)
        sandbox.tests_evidence(repo)
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K3", "logic changed with no test in the same range: src/a.py")

    def test_push_keepsBaseTier_whenATestLosesLines(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app", seed={"README.md": "seed\n", "src/app.py": "x\n", TEST_FILE: TWO_LINE_TEST})
        repo.branch("feature")
        repo.commit({"src/app.py": "y\n", TEST_FILE: ONE_LINE_TEST})
        sandbox.push_bundle(repo)
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))
        self.assertEqual(line["risk"], "standard")

    def test_push_keepsBaseTier_whenATestOnlyGainsLines(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app", seed={"README.md": "seed\n", "src/app.py": "x\n", TEST_FILE: ONE_LINE_TEST})
        repo.branch("feature")
        repo.commit({"src/app.py": "y\n", TEST_FILE: ONE_LINE_TEST + "def test_b(): assert True\n"})
        sandbox.push_bundle(repo)
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))
        self.assertEqual(line["risk"], "standard")

    # scenario 4
    def test_push_passes_whenNeedsFixesRootIsFollowedByPassingDelta(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        root_tree = sandbox.keel("snapshot", repo.path).json["tree"]
        sandbox.review(repo, verdict="NEEDS_FIXES")
        repo.commit({"src/a.py": "print(2)\n"}, "fix")
        sandbox.review(repo, run_id="rv-delta-0002", root_run_id="rv-root-0001", since=root_tree)
        sandbox.tests_evidence(repo)
        sandbox.approve("rv-root-0001")
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))

    def test_push_denies_whenChainHeadIsNeedsFixes(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.review(repo, verdict="NEEDS_FIXES")
        sandbox.tests_evidence(repo)
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "ends in NEEDS_FIXES")

    # scenario 5 (approval binds at push only where the registry makes pushes deploy)
    def test_push_denies_whenDeltaMovedHeadAfterApproval_andPassesAfterNewApproval(self):
        sandbox = Sandbox(self, registry=PUSH_APPROVAL_REGISTRY)
        repo = self.feature(sandbox)
        root_tree = sandbox.keel("snapshot", repo.path).json["tree"]
        sandbox.full_bundle(repo)
        repo.commit({"src/a.py": "print(3)\n"}, "more")
        sandbox.review(repo, run_id="rv-delta-0002", root_run_id="rv-root-0001", since=root_tree)
        sandbox.tests_evidence(repo)
        self.assertDenied(sandbox.push(repo, "git push origin feature"), "K1", "no approval bound to chain head")
        sandbox.approve("rv-root-0001")
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))

    # scenario 6
    def test_push_passes_afterConflictFreeRebaseOntoAdvancedMain(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        other = sandbox.clone("acme", "app", name="other")
        other.commit({"docs/notes.md": "colleague\n"}, "upstream")
        other.git("push", "-q", "origin", "main")
        repo.git("fetch", "-q", "origin")
        repo.git("rebase", "-q", "origin/main")
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))

    # scenario 7
    def test_push_denies_namingThePath_whenFileEditedAfterReview(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        repo.commit({"src/a.py": "print('edited')\n"}, "edit after review")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "src/a.py (content or mode changed after review)")

    # scenario 8
    def test_push_denies_whenReviewBaseIsNarrowerThanMergeBase(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        repo.commit({"src/b.py": "print('second')\n"}, "second commit")
        sandbox.review(repo, review_base=repo.git("rev-parse", "HEAD~1"))
        sandbox.tests_evidence(repo)
        sandbox.approve("rv-root-0001")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "not from the merge base")

    # scenario 9
    def test_push_denies_whenReviewedFileRevertedToOlderNonBaseValue(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox, {"src/a.py": "v1\n"})
        repo.commit({"src/a.py": "v2\n"}, "v2")
        sandbox.full_bundle(repo)
        repo.commit({"src/a.py": "v1\n"}, "back to v1")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "src/a.py (content or mode changed after review)")

    # scenario 10
    def test_push_passes_whenDeletionWasReviewed(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"README.md": None}, "delete readme")
        sandbox.full_bundle(repo)
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))

    def test_push_denies_whenDeletionWasNotReviewed(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        repo.commit({"README.md": None}, "delete readme")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "README.md (not in any reviewed diff)")

    # scenario 11
    def test_push_denies_whenModeChangedAfterReview(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        repo.write("src/a.py", "print(1)\n", executable=True)
        repo.git("add", "-A")
        repo.git("commit", "-q", "-m", "chmod +x")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "src/a.py (content or mode changed after review)")

    # scenario 12
    def test_push_classesABinaryLikeAnyPath_whenNoRuleNamesIt(self):
        # given a binary file that no risk rule names, with a test
        sandbox = Sandbox(self)
        repo = self.feature(sandbox, {"assets/logo.bin": b"\x00\x01\x02binary\x00", TEST_FILE: ONE_LINE_TEST})
        sandbox.push_bundle(repo)
        # when
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))
        # then it is standard like any unmatched path, and numstat's binary marker counts no lines
        self.assertEqual((line["risk"], line["files"], line["lines"]), ("standard", 2, 1))

    def test_push_passesOnApprovalAlone_whenHeavyAndPushesDeploy(self):
        # given a heavy change in a repo whose pushes deploy, with review, tests and approval but no read ack
        sandbox = Sandbox(self, registry=PUSH_APPROVAL_REGISTRY)
        repo = self.feature(sandbox, {HEAVY_FILE: "x\n", TEST_FILE: ONE_LINE_TEST})
        sandbox.full_bundle(repo)
        # when
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))
        # then
        self.assertEqual(line["risk"], "heavy")

    # scenario 13
    def test_push_denies_whenFileRenamedAfterReview(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        repo.git("mv", "src/a.py", "src/renamed.py")
        repo.git("commit", "-q", "-m", "rename")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "src/renamed.py (not in any reviewed diff)")

    # scenario 15
    def test_push_passes_afterMergingMain_whenUpstreamTouchedDisjointFile(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        other = sandbox.clone("acme", "app", name="other")
        other.commit({"docs/other.md": "disjoint\n"}, "upstream")
        other.git("push", "-q", "origin", "main")
        repo.git("fetch", "-q", "origin")
        repo.git("merge", "-q", "--no-edit", "origin/main")
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))

    def test_push_denies_afterMergingMain_whenUpstreamTouchedTheSameFile(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app", seed={"README.md": "seed\n", "src/app.py": "l1\nl2\nl3\nl4\nl5\n"})
        repo.branch("feature")
        repo.commit({"src/app.py": "L1\nl2\nl3\nl4\nl5\n", TEST_FILE: ONE_LINE_TEST}, "top edit")
        sandbox.full_bundle(repo)
        other = sandbox.clone("acme", "app", name="other")
        other.commit({"src/app.py": "l1\nl2\nl3\nl4\nL5\n"}, "bottom edit")
        other.git("push", "-q", "origin", "main")
        repo.git("fetch", "-q", "origin")
        repo.git("merge", "-q", "--no-edit", "origin/main")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "src/app.py (content or mode changed after review)")

    # scenario 18
    def test_push_denies_whenApprovalBelongsToAnotherRoot(self):
        sandbox = Sandbox(self, registry=PUSH_APPROVAL_REGISTRY)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo, root_run_id="rv-root-0001")
        repo.commit({"src/a.py": "print('v2')\n"}, "v2")
        sandbox.review(repo, run_id="rv-root-0002")
        sandbox.tests_evidence(repo)
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "no approval bound to chain head")
        self.assertIn("rv-root-0002", run.stderr)

    # extras
    def test_push_passes_whenAHeavyChangeIsLarge(self):
        # given a heavy change of 12 files with review and tests
        sandbox = Sandbox(self)
        files = {"src/core/billing/f%d.py" % index: "x\n" for index in range(11)}
        files[TEST_FILE] = ONE_LINE_TEST
        repo = self.feature(sandbox, files)
        sandbox.push_bundle(repo)
        # when
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))
        # then no size limit applies; the size is logged
        self.assertEqual((line["risk"], line["files"]), ("heavy", 12))

    def test_push_denies_whenGateIsCodeAndEvidenceIsCorrupt(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        directory = os.path.dirname(sandbox.evidence_files("review")[0])
        with open(os.path.join(directory, "review-broken.json"), "w") as stream:
            stream.write("{not json")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "failing closed")
        self.assertEqual(sandbox.fires("K1", "error")[0]["repo"], "acme/app")

    def test_push_failsClosed_whenGateIsSmokeAndEvidenceIsCorrupt(self):
        sandbox = Sandbox(self, registry=["acme/app\tsmoke\tmain\t-\tnone"])
        repo = self.feature(sandbox)
        directory = os.path.join(sandbox.data, "state", "keel", "evidence", "smoke", "acme__app")
        os.makedirs(directory)
        with open(os.path.join(directory, "smoke-broken.json"), "w") as stream:
            stream.write("{not json")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "failing closed")
        self.assertEqual(len(sandbox.fires("K1", "error")), 1)

    def test_push_passes_whenRepoGateIsOff(self):
        sandbox = Sandbox(self, registry=["acme/app\toff\tmain\t-\tnone"])
        repo = self.feature(sandbox)
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))

    def test_push_passes_whenRepoIsUnlisted(self):
        sandbox = Sandbox(self, registry=["acme/other\tcode\tmain\tacme\trequired"])
        repo = self.feature(sandbox)
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))

    def test_push_passes_whenOutgoingChangeIsEmpty(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin main"))
        self.assertNotIn("risk", line)

    def test_push_deniesK3_whenRegistryHasNoTestsAndChangeIsStandard(self):
        sandbox = Sandbox(self, registry=["acme/app\tcode\tmain\tacme\tnone"])
        repo = self.feature(sandbox)
        sandbox.review(repo)
        sandbox.approve("rv-root-0001")
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K3", "add test infrastructure first")

    def test_push_passesWithoutTests_whenRegistryHasNoTestsAndChangeIsLight(self):
        sandbox = Sandbox(self, registry=["acme/app\tcode\tmain\tacme\tnone"])
        repo = self.feature(sandbox, {"docs/guide.md": "light\n"})
        sandbox.review(repo)
        sandbox.approve("rv-root-0001")
        line = self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature"))
        self.assertEqual(line["risk"], "light")

    def test_push_deniesRisk_whenEvenALightChangeHasOnlySingleLensReview(self):
        # given a light docs change reviewed by a single lens, in a repo without tests
        sandbox = Sandbox(self, registry=["acme/app\tcode\tmain\tacme\tnone"])
        repo = self.feature(sandbox, {"docs/guide.md": "light\n"})
        sandbox.review(repo, kind="single-lens")
        # when
        run = sandbox.push(repo, "git push origin feature")
        # then
        self.assertDenied(run, "risk", "every change needs a lens-review chain")
        self.assertEqual(sandbox.fires("risk", "deny")[0]["risk"], "light")

    def test_push_passes_whenAnotherAgentPushes(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        self.assertPassed(sandbox, sandbox.push(repo, "git push origin feature", agent_id="ag-main"))

    def test_push_ignoresExpiredReview_whenTtlPassed(self):
        sandbox = Sandbox(self)
        repo = self.feature(sandbox)
        sandbox.full_bundle(repo)
        path = sandbox.evidence_files("review")[0]
        with open(path) as stream:
            text = stream.read()
        with open(path, "w") as stream:
            stream.write(text.replace('"expires_at": "20', '"expires_at": "19'))
        run = sandbox.push(repo, "git push origin feature")
        self.assertDenied(run, "K1", "no review evidence")


if __name__ == "__main__":
    unittest.main()
