"""DESIGN 5.9 scenarios across repos: one run over a submodule and its parent (2), a delta on one of two
repos (3), and the repo a push or merge reaches through a remote other than origin (5.3)."""
from __future__ import annotations

import os
import unittest

from helpers import Sandbox

MULTI_REGISTRY = ["acme/app\tcode\tmain\tacme\trequired", "acme/lib\tcode\tmain\tacme\trequired",
                  "acme/platform\tcode\tmain\tacme\trequired", "acme/tool\tcode\tmain\tacme\trequired"]
MULTI_REGISTRY_DEPLOYING_APP = ["acme/app\tcode\tmain\tacme\trequired\ttrue"] + MULTI_REGISTRY[1:]
TEST = "def test_it(): assert True\n"
APP_OFF_REGISTRY = ["acme/app\toff\tmain\t-\tnone"]
APP_URL_FORMS = ("https://example.invalid/acme/app.git", "git@example.invalid:acme/app.git",
                 "ssh://git@example.invalid/acme/app.git")


class MultiRepoScenarioTest(unittest.TestCase):
    def submodule_change(self, sandbox: Sandbox):
        parent, submodule = sandbox.clone_with_submodule()
        submodule.git("checkout", "-q", "-b", "feature")
        submodule.commit({"lib.py": "LIB = 2\n", "tests/test_lib.py": TEST}, "lib change")
        parent.git("checkout", "-q", "-b", "feature")
        parent.git("add", "lib")
        parent.git("commit", "-q", "-m", "bump lib")
        return parent, submodule

    # scenario 2
    def test_pushes_pass_whenOneRunReviewsSubmoduleAndParentWithOneApproval(self):
        sandbox = Sandbox(self, registry=MULTI_REGISTRY)
        parent, submodule = self.submodule_change(sandbox)
        sandbox.review(submodule, run_id="rv-run-0001")
        sandbox.review(parent, run_id="rv-run-0001")
        sandbox.tests_evidence(submodule)
        sandbox.tests_evidence(parent)
        approval = sandbox.approve("rv-run-0001").json
        self.assertEqual(sorted(approval["heads"]), ["acme/lib", "acme/platform"])
        self.assertEqual(sandbox.push(submodule, "git push origin feature").rc, 0)
        submodule.git("push", "-q", "origin", "feature")
        run = sandbox.push(parent, "git push origin feature")
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual([line["repo"] for line in sandbox.fires("risk", "pass")], ["acme/lib", "acme/platform"])

    def test_submodulePush_passes_whenTestsRanOnlyFromTheParent(self):
        sandbox = Sandbox(self, registry=MULTI_REGISTRY)
        parent, submodule = self.submodule_change(sandbox)
        sandbox.review(submodule, run_id="rv-run-0001")
        sandbox.tests_evidence(parent)
        sandbox.approve("rv-run-0001")
        run = sandbox.push(submodule, "git push origin feature")
        self.assertEqual(run.rc, 0, run.stderr)

    # scenario 3
    def test_pushes_pass_whenRootCoversTwoReposAndOneGetsADelta(self):
        sandbox = Sandbox(self, registry=MULTI_REGISTRY)
        app = sandbox.clone("acme", "app")
        tool = sandbox.clone("acme", "tool", seed={"tool.py": "T = 1\n"})
        for repo in (app, tool):
            repo.branch("feature")
        app.commit({"src/a.py": "a\n", "tests/test_a.py": TEST}, "app work")
        tool.commit({"tool.py": "T = 2\n", "tests/test_tool.py": TEST}, "tool work")
        app_root_tree = sandbox.keel("snapshot", app.path).json["tree"]
        sandbox.review(app, run_id="rv-run-0001")
        sandbox.review(tool, run_id="rv-run-0001")
        app.commit({"src/a.py": "a2\n"}, "app follow-up")
        sandbox.review(app, run_id="rv-run-0002", root_run_id="rv-run-0001", since=app_root_tree)
        sandbox.tests_evidence(app)
        sandbox.tests_evidence(tool)
        approval = sandbox.approve("rv-run-0001").json
        self.assertTrue(approval["heads"]["acme/app"].startswith("review-"))
        self.assertEqual(sandbox.push(app, "git push origin feature").rc, 0)
        self.assertEqual(sandbox.push(tool, "git push origin feature").rc, 0)
        self.assertEqual(len(sandbox.fires("risk", "pass")), 2)

    def test_push_denies_whenDeltaOfOtherRepoIsMissingFromApproval(self):
        sandbox = Sandbox(self, registry=MULTI_REGISTRY_DEPLOYING_APP)
        app = sandbox.clone("acme", "app")
        app.branch("feature")
        app.commit({"src/a.py": "a\n", "tests/test_a.py": TEST}, "app work")
        app_root_tree = sandbox.keel("snapshot", app.path).json["tree"]
        sandbox.review(app, run_id="rv-run-0001")
        sandbox.tests_evidence(app)
        sandbox.approve("rv-run-0001")
        app.commit({"src/a.py": "a2\n"}, "app follow-up")
        sandbox.review(app, run_id="rv-run-0002", root_run_id="rv-run-0001", since=app_root_tree)
        sandbox.tests_evidence(app)
        run = sandbox.push(app, "git push origin feature")
        self.assertEqual(run.rc, 2)
        self.assertIn("no approval bound to chain head", run.stderr)


class RemoteTargetTest(unittest.TestCase):
    """A push is keyed on the remote it reaches; a merge naming no repo on the repo gh resolves."""

    def fork_clone(self, sandbox: Sandbox):
        """(clone, unreviewed feature commit) of me/app, an ungated fork whose `upstream` is the gated acme/app."""
        sandbox.clone("acme", "app")
        fork = sandbox.clone("me", "app", name="fork")
        fork.git("remote", "add", "upstream", sandbox.remote("acme", "app"))
        fork.branch("feature")
        head = fork.commit({"src/a.py": "a\n", "tests/test_a.py": TEST}, "fork work")
        return fork, head

    @staticmethod
    def feature_clone(sandbox: Sandbox):
        """A clone of acme/app on an unreviewed `feature` commit."""
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "a\n", "tests/test_a.py": TEST}, "work")
        return repo

    @staticmethod
    def add_origin_push_urls(repo, *urls: str) -> None:
        """git pushes to every `remote.origin.pushurl`, and no longer to origin's url."""
        for url in urls:
            repo.git("config", "--add", "remote.origin.pushurl", url)

    def test_barePush_deniedAsForeignClone_whenThePushRemoteIsTheGatedUpstream(self):
        for setting in ("branch.feature.pushRemote", "remote.pushDefault", "branch.feature.remote"):
            with self.subTest(setting=setting):
                # given a fork clone whose feature branch pushes to the gated upstream through `setting`
                sandbox = Sandbox(self)
                fork, _ = self.fork_clone(sandbox)
                fork.git("config", setting, "upstream")
                # when
                run = sandbox.push(fork, "git push")
                # then
                self.assertEqual(run.rc, 2, run.stderr + run.stdout)
                self.assertIn("- [F-irreversible] run git push from a clone of acme/app (this clone is me/app)", run.stderr)

    def test_barePush_followsRemotePushDefault_overTheBranchRemote(self):
        # given a fork clone whose feature branch tracks origin while remote.pushDefault names the gated upstream
        sandbox = Sandbox(self)
        fork, _ = self.fork_clone(sandbox)
        fork.git("config", "branch.feature.remote", "origin")
        fork.git("config", "remote.pushDefault", "upstream")
        # when
        run = sandbox.push(fork, "git push")
        # then git pushes to upstream, so the push is judged on acme/app
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [F-irreversible] run git push from a clone of acme/app (this clone is me/app)", run.stderr)

    def test_barePush_followsTheBranchPushRemote_overRemotePushDefault(self):
        # given a fork clone whose remote.pushDefault names the gated upstream and whose feature pushRemote is origin
        sandbox = Sandbox(self)
        fork, _ = self.fork_clone(sandbox)
        fork.git("config", "remote.pushDefault", "upstream")
        fork.git("config", "branch.feature.pushRemote", "origin")
        # when
        run = sandbox.push(fork, "git push")
        # then git pushes to origin, the ungated fork
        self.assertEqual(run.rc, 0, run.stderr + run.stdout)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "me/app")

    def test_push_isJudgedOnTheUrlRepo_whenOriginIsAUrlFormOfTheGatedRepo(self):
        for url in APP_URL_FORMS:
            with self.subTest(url=url):
                # given a gated clone whose origin is an https, scp-like or ssh URL of acme/app
                sandbox = Sandbox(self)
                repo = self.feature_clone(sandbox)
                repo.git("remote", "set-url", "origin", url)
                # when
                run = sandbox.push(repo, "git push origin feature")
                # then
                self.assertEqual(run.rc, 2, run.stderr + run.stdout)
                self.assertIn("- [K1] no review evidence for acme/app", run.stderr)
                self.assertNotIn("cannot attribute", run.stderr)

    def test_push_passes_whenOriginIsAUrlFormOfAnUngatedRepo(self):
        for url in APP_URL_FORMS:
            with self.subTest(url=url):
                # given the same clone with acme/app switched off in the registry
                sandbox = Sandbox(self, registry=APP_OFF_REGISTRY)
                repo = self.feature_clone(sandbox)
                repo.git("remote", "set-url", "origin", url)
                # when
                run = sandbox.push(repo, "git push origin feature")
                # then
                self.assertEqual(run.rc, 0, run.stderr + run.stdout)
                self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "acme/app")

    def test_push_deniedAsForeignClone_whenThePushUrlsReachTheClonesGatedRepoAndAnotherGatedRepo(self):
        # given a gated clone of acme/app whose origin pushes to acme/app first and to the gated acme/lib second
        sandbox = Sandbox(self, registry=MULTI_REGISTRY)
        repo = self.feature_clone(sandbox)
        self.add_origin_push_urls(repo, sandbox.remote("acme", "app"), sandbox.remote("acme", "lib"))
        # when
        run = sandbox.push(repo, "git push origin feature")
        # then the other gated repo is judged first
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [F-irreversible] run git push from a clone of acme/lib (this clone is acme/app)", run.stderr)

    def test_push_passes_whenTheRemoteIsAnUngatedMirror(self):
        # given a gated clone with a second remote for an unlisted repo
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.git("remote", "add", "mirror", sandbox.remote("me", "mirror"))
        repo.branch("feature")
        repo.commit({"src/a.py": "a\n", "tests/test_a.py": TEST}, "work")
        # when
        run = sandbox.push(repo, "git push mirror feature")
        # then
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "me/mirror")

    def test_push_isJudged_whenTheRemoteIsGivenAsTheGatedRepoUrl(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "a\n", "tests/test_a.py": TEST}, "work")
        run = sandbox.push(repo, "git push %s feature" % sandbox.remote("acme", "app"))
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [K1] no review evidence for acme/app", run.stderr)

    def test_push_isJudgedOnTheClonesOwnRepo_whenALaterPushUrlOfTheRemoteIsIt(self):
        # given a gated clone whose origin pushes to an ungated mirror first and to acme/app second
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        self.add_origin_push_urls(repo, sandbox.remote("me", "mirror"), sandbox.remote("acme", "app"))
        repo.branch("feature")
        repo.commit({"src/a.py": "a\n", "tests/test_a.py": TEST}, "work")
        # when
        run = sandbox.push(repo, "git push origin feature")
        # then
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [K1] no review evidence for acme/app", run.stderr)

    def test_push_deniedAsForeignClone_whenAPushUrlOfTheRemoteIsAnotherGatedRepo(self):
        # given a fork clone whose origin pushes to the fork and to the gated acme/app
        sandbox = Sandbox(self)
        fork, _ = self.fork_clone(sandbox)
        self.add_origin_push_urls(fork, sandbox.remote("me", "app"), sandbox.remote("acme", "app"))
        # when
        run = sandbox.push(fork, "git push origin feature")
        # then
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [F-irreversible] run git push from a clone of acme/app (this clone is me/app)", run.stderr)

    def test_push_passes_whenNoPushUrlOfTheRemoteIsGated(self):
        # given a fork clone whose origin pushes to the fork and to an ungated mirror
        sandbox = Sandbox(self)
        fork, _ = self.fork_clone(sandbox)
        self.add_origin_push_urls(fork, sandbox.remote("me", "app"), sandbox.remote("me", "mirror"))
        # when
        run = sandbox.push(fork, "git push origin feature")
        # then
        self.assertEqual(run.rc, 0, run.stderr + run.stdout)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "me/app")

    def test_merge_deniedWithTheRepoFlagToAdd_whenRemotesNameSeveralReposAndOneIsGated(self):
        # given a fork clone with no default remote for gh
        sandbox = Sandbox(self)
        fork, head = self.fork_clone(sandbox)
        command = "gh pr merge 7 --squash --match-head-commit %s" % head
        # when
        run = sandbox.push(fork, command)
        # then
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [K1] cannot attribute this push or merge", run.stderr)
        self.assertIn("acme/app, me/app", run.stderr)
        self.assertEqual(run.stderr.splitlines()[-1],
                         "Run it yourself in your terminal: cd %s && %s --repo acme/app" % (fork.path, command))
        self.assertFalse(os.path.exists(sandbox.gh_log))

    def test_merge_followsTheGhDefaultRemote_whenOneIsSet(self):
        # given a fork clone where gh's default remote is the gated upstream
        sandbox = Sandbox(self)
        fork, head = self.fork_clone(sandbox)
        command = "gh pr merge 7 --squash --match-head-commit %s" % head
        fork.git("config", "remote.upstream.gh-resolved", "base")
        # when / then: the merge reaches acme/app, which this clone cannot judge
        run = sandbox.push(fork, command)
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [F-irreversible] run gh pr merge from a clone of acme/app (this clone is me/app)", run.stderr)
        # and with the fork as gh's default the merge is the fork's own, which is not gated
        fork.git("config", "--unset", "remote.upstream.gh-resolved")
        fork.git("config", "remote.origin.gh-resolved", "base")
        self.assertEqual(sandbox.push(fork, command).rc, 0)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "me/app")

    def test_merge_deniedAsForeignClone_whenGhStoredTheGatedRepoAsTheDefault(self):
        # given a fork clone where `gh repo set-default acme/app` stored that repo on origin
        sandbox = Sandbox(self)
        fork, head = self.fork_clone(sandbox)
        fork.git("config", "remote.origin.gh-resolved", "acme/app")
        # when
        run = sandbox.push(fork, "gh pr merge 7 --squash --match-head-commit %s" % head)
        # then the merge reaches acme/app, which this clone cannot judge
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("- [F-irreversible] run gh pr merge from a clone of acme/app (this clone is me/app)", run.stderr)

    def test_merge_isUnattributable_whenTheCallChangesGhsDefaultRepoFirst(self):
        # given a single-remote fork clone of me/app, whose upstream acme/app is gated
        sandbox = Sandbox(self)
        sandbox.clone("acme", "app")
        fork = sandbox.clone("me", "app", name="solo")
        fork.branch("feature")
        head = fork.commit({"src/a.py": "a\n", "tests/test_a.py": TEST}, "fork work")
        for change in ("gh repo set-default acme/app", "/usr/local/bin/gh repo set-default acme/app",
                       "git config remote.origin.gh-resolved acme/app"):
            with self.subTest(change=change):
                # when gh's default moves to acme/app earlier in the same call
                run = sandbox.push(fork, "%s && gh pr merge 7 --squash --match-head-commit %s" % (change, head))
                # then the gate, which read the default before the call, cannot attribute the merge
                self.assertEqual(run.rc, 2, run.stderr + run.stdout)
                self.assertIn("cannot attribute this push or merge", run.stderr)

    def test_merge_isJudgedOnItsOwnRepo_whenItNamesOne_evenAfterTheCallChangesGhsDefault(self):
        sandbox = Sandbox(self)
        fork = sandbox.clone("me", "app", name="solo")
        for command in ("gh repo set-default acme/app && gh pr merge 7 --squash --repo me/app",
                        "gh repo set-default acme/app && GH_REPO=me/app gh pr merge 7 --squash",
                        "gh repo set-default acme/app && gh pr merge https://github.com/me/app/pull/7 --squash"):
            with self.subTest(command=command):
                run = sandbox.push(fork, command)
                self.assertEqual(run.rc, 0, run.stderr + run.stdout)
                self.assertNotIn("cannot attribute", run.stderr)

    def test_merge_passes_whenTheRepoFlagNamesNoRepoAndNothingIsGated(self):
        sandbox = Sandbox(self, registry=[])
        fork = sandbox.clone("me", "app", name="solo")
        run = sandbox.push(fork, "gh repo set-default acme/app && gh pr merge 7 --squash --repo not-a-repo")
        self.assertEqual(run.rc, 0, run.stderr + run.stdout)

    def test_merge_passes_whenTheCallOnlyViewsGhsDefaultRepo(self):
        sandbox = Sandbox(self)
        fork = sandbox.clone("me", "app", name="solo")
        run = sandbox.push(fork, "gh repo set-default --view && gh pr merge 7 --squash")
        self.assertEqual(run.rc, 0, run.stderr + run.stdout)

    def test_merge_failsClosed_whenGhsStoredDefaultNamesNoRepo(self):
        # given an ungated fork, so only the unreadable default can deny
        sandbox = Sandbox(self)
        sandbox.clone("acme", "app")
        fork = sandbox.clone("me", "app", name="solo")
        fork.git("config", "remote.origin.gh-resolved", "garbage")
        # when
        run = sandbox.push(fork, "gh pr merge 7 --squash")
        # then
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("names no owner/repo", run.stderr)

    def test_merge_passes_whenSeveralRemotesNameNoGatedRepo(self):
        sandbox = Sandbox(self)
        clone = sandbox.clone("me", "app")
        clone.git("remote", "add", "upstream", sandbox.remote("other", "app"))
        run = sandbox.push(clone, "gh pr merge 7 --squash")
        self.assertEqual(run.rc, 0, run.stderr + run.stdout)


if __name__ == "__main__":
    unittest.main()
