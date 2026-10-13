"""Command parsing (push refspecs, -C, cd chains, heredocs, inline shells, wrappers),
delete/tag/dry-run/--all handling, the registry-absent warning, size
logging, contract-miss logging and early warnings."""
from __future__ import annotations

import importlib.util
import json
import os
import shlex
import unittest
from unittest import mock

from helpers import KEEL_HOME, LOGIC_WITH_TEST, Sandbox, read_json

HOOK_DIR = os.path.join(KEEL_HOME, "hooks", "ship-gate")
SETTINGS_PATH = os.path.join(KEEL_HOME, "settings", "core.json")
DECISION_MARGIN_SECONDS = 5  # the local git calls of one verdict, each far below a second
NOT_GATED_REGISTRY = ["acme/app\toff\tmain\t-\tnone"]


def load_hook_module():
    spec = importlib.util.spec_from_file_location("ship_gate", os.path.join(HOOK_DIR, "ship-gate.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CommandParsingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hook = load_hook_module()
        cls.shell = cls.hook.shell

    def actions(self, command: str, cwd: str = "/work"):
        return [action for step in self.shell.steps(command, cwd) for action in self.hook.actions_of(step, command)]

    def test_parsePush_readsRefspecs_whenSeveralRefspecsGiven(self):
        push, = self.actions("git push origin feature:refs/heads/feature +hotfix")
        self.assertEqual(push.refspecs, [self.hook.Refspec("feature", "refs/heads/feature"), self.hook.Refspec("hotfix", None)])
        self.assertEqual(push.sources, ["feature", "hotfix"])
        self.assertFalse(push.deletes_only or push.tags_only or push.whole_repo or push.dry_run)

    def test_parsePush_defaultsToHead_whenNoRefspecGiven(self):
        push, = self.actions("git push -u origin")
        self.assertEqual(push.refspecs, [])

    def test_parsePush_marksDeletesOnly_whenDeleteFlagOrColonRefspec(self):
        self.assertTrue(self.actions("git push --delete origin old")[0].deletes_only)
        self.assertTrue(self.actions("git push -d origin old")[0].deletes_only)
        self.assertTrue(self.actions("git push origin :old")[0].deletes_only)
        self.assertFalse(self.actions("git push origin new :old")[0].deletes_only)

    def test_parsePush_marksTagsOnly_whenTagsFlagWithoutRefspec(self):
        self.assertTrue(self.actions("git push --tags origin")[0].tags_only)
        self.assertFalse(self.actions("git push --tags origin main")[0].tags_only)

    def test_parsePush_marksWholeRepo_whenAllOrMirror(self):
        self.assertTrue(self.actions("git push --all origin")[0].whole_repo)
        self.assertTrue(self.actions("git push --mirror")[0].whole_repo)

    def test_parsePush_marksDryRun_whenShortOrLongFlag(self):
        self.assertTrue(self.actions("git push -n origin feature")[0].dry_run)
        self.assertTrue(self.actions("git push --dry-run origin feature")[0].dry_run)
        self.assertTrue(self.actions("git push -un origin feature")[0].dry_run)
        self.assertFalse(self.actions("git push -u origin feature")[0].dry_run)

    def test_parsePush_skipsValueFlags_whenPushOptionGiven(self):
        push, = self.actions("git push -o ci.skip origin feature")
        self.assertEqual(push.sources, ["feature"])

    def test_workdir_followsDashC_whenGitRunsElsewhere(self):
        push, = self.actions("git -C /repo/sub push origin main")
        self.assertEqual(push.workdir, "/repo/sub")

    def test_workdir_followsCd_acrossChainsAndNewlines(self):
        pushes = self.actions("cd /a && git push origin x; cd ../b\ngit push origin y || true")
        self.assertEqual([push.workdir for push in pushes], ["/a", "/b"])

    def test_workdir_followsPushd_untilPopd(self):
        pushes = self.actions("pushd /a && git push origin x; popd; git push origin y")
        self.assertEqual([push.workdir for push in pushes], ["/a", "/work"])

    def test_heredocBody_isNotAnInvocation_whenItMentionsPush(self):
        actions = self.actions("cat <<'EOF' > notes.txt\ngit push origin main\nEOF\nls")
        self.assertEqual(actions, [])

    def test_inlineShell_isRead_whenPushHidesInBashDashC(self):
        push, = self.actions("bash -c 'cd /inner && git push origin feature'")
        self.assertEqual((push.workdir, push.sources), ("/inner", ["feature"]))

    def test_unbalancedQuote_isReadToTheEnd_andStillGated(self):
        push, = self.actions("git push origin \"feature")
        self.assertEqual(push.sources, ["feature"])

    def test_envPrefixAndRedirection_areIgnored_whenPushHasThem(self):
        push, = self.actions("GIT_TRACE=1 git push origin feature 2>&1 | tail -n 5")
        self.assertEqual(push.sources, ["feature"])

    def test_wrappers_areStripped_whenPushRunsUnderEnvTimeoutNiceSudo(self):
        for command in ("env GIT_TRACE=1 git push origin feature", "env git push origin feature",
                        "timeout 60 git push origin feature", "timeout -s KILL 60 git push origin feature",
                        "timeout --signal TERM --kill-after 5 60 git push origin feature",
                        "nice git push origin feature", "sudo git push origin feature", "sudo -E git push origin feature"):
            with self.subTest(command=command):
                push, = self.actions(command)
                self.assertIsInstance(push, self.hook.Push)
                self.assertEqual(push.sources, ["feature"])

    def test_evalArguments_areReadAsAScript_whenPushHidesInEval(self):
        push, = self.actions("eval 'cd /inner && git push origin feature'")
        self.assertEqual((push.workdir, push.sources), ("/inner", ["feature"]))

    def test_heredocBody_isReadAsAScript_whenItFeedsAShell(self):
        push, = self.actions("cd /inner && bash <<'EOF' | tail -n 1\ngit push origin feature\nEOF\nls")
        self.assertEqual((push.workdir, push.sources), ("/inner", ["feature"]))

    def test_hereStringAndBackticks_areRead_whenTheySpellAPush(self):
        for command in ("bash <<< 'git push origin feature'", "echo `git push origin feature`"):
            with self.subTest(command=command):
                push, = self.actions(command)
                self.assertEqual(push.sources, ["feature"])

    def test_opaqueWrappers_areUnattributable_whenTheirArgumentsSpellAPushOrMerge(self):
        for command in ("xargs git push origin feature < /dev/null", "echo feature | xargs git push origin",
                        "xargs -0 git push origin feature < /dev/null", "env --chdir=/elsewhere git push origin feature",
                        "parallel -j1 gh pr merge 7 ::: x", "xargs git pu\\\nsh origin feature < /dev/null"):
            with self.subTest(command=command):
                action, = self.actions(command)
                self.assertIsInstance(action, self.hook.Unattributable)

    def test_opaqueWrappers_areUnattributable_whenTheyRunADashedGitProgramOrARunTimeName(self):
        for command in ("xargs git-push origin feature < /dev/null", "xargs $CORE/git-push origin feature < /dev/null",
                        "xargs /usr/libexec/git-core/git-push origin feature < /dev/null",
                        "xargs git send-pack ../app.git feature < /dev/null",
                        "xargs gh api -X PATCH repos/acme/app/git/refs/heads/main -f sha=abc < /dev/null",
                        "GP=\"$(git --exec-path)/git-push\"; xargs $GP origin feature < /dev/null",
                        "S=push; xargs git $S origin feature < /dev/null",
                        "R=acme/app; echo x | xargs gh api -X PATCH repos/$R/git/refs/heads/main -f sha=abc",
                        "env --chdir=$D true; echo push"):
            with self.subTest(command=command):
                action, = [action for action in self.actions(command) if isinstance(action, self.hook.Unattributable)]
                self.assertIn("wraps it", action.why)
                self.assertEqual("cd /work && " + command, action.user_command)
        for command in ("git log --format=%H | xargs echo push", "find . -name '*.orig' | xargs rm",
                        "xargs grep -l merge < files.txt", "ls .git/refs/heads | xargs -n1 git log -1"):
            with self.subTest(command=command):
                self.assertEqual(self.actions(command), [])

    def test_everyArgvForwarder_isUnattributable_whenItCarriesAnOptionTheParserDoesNotRead(self):
        for name in sorted(self.hook.ARGV_FORWARDERS):
            with self.subTest(name=name):
                action = self.actions(name + " --no-such-option git push origin feature")[0]
                self.assertIsInstance(action, self.hook.Unattributable)
                self.assertIn("`%s` wraps it" % name, action.why)

    def test_wrapperWithAnOptionTheParserDoesNotRead_isUnattributable_whenItRunsGitAShellOrARunTimeName(self):
        for command in ("sudo --chdir /tmp git push origin feature", "sudo -D /tmp git push origin feature",
                        "sudo -iu bob git push origin feature", "exec -la foo git push origin feature",
                        "sudo -iu git git push origin feature", "sudo --chdir /srv/git git push origin feature",
                        "sudo -D /srv/gh gh pr merge 7 --squash", "exec -la foo $GIT push origin feature",
                        "exec -la git sh -c 'git push origin feature'", "sudo --chdir /tmp sh -c 'git push origin feature'",
                        "sudo -i git push origin feature", "sudo -nE git push origin feature",
                        "env --chdir=/tmp git push origin feature"):
            with self.subTest(command=command):
                action = self.actions(command)[0]
                self.assertIsInstance(action, self.hook.Unattributable)
                self.assertIn("wraps it", action.why)

    def test_unwrappedProgram_staysAttributable_besideAPushOrMergeSpelling(self):
        for command in ("git merge-base main HEAD && timeout 60 cat \"$F\"",
                        "base=$(git merge-base main HEAD) && nice -n 5 make -C \"$DIR\"",
                        "git merge-base main HEAD; env FOO=1 python3 \"$SCRIPT\"", "git merge-base main HEAD; command -v git",
                        "cd /x/sg-push-spellings && timeout 120 ls hooks/git-guard",
                        "git merge-base main HEAD && timeout 60 grep git README",
                        "env LC_ALL=C grep -rn gh docs; git merge-base --is-ancestor main HEAD"):
            with self.subTest(command=command):
                self.assertEqual(self.actions(command), [])
        for command in ("command -v git && git push origin feature", "timeout 30 which git && git push origin feature"):
            with self.subTest(command=command):
                push, = self.actions(command)
                self.assertIsInstance(push, self.hook.Push)

    def test_runtimeCommandName_isUnattributable_onlyWhenTheCallSpellsAPushOrMerge(self):
        for command in ("GIT=git; $GIT push origin feature", "CMD='git push origin feature'; eval \"$CMD\"",
                        "$(which git) push origin feature", "GIT=git; S=push; $GIT $S origin feature",
                        "sh -c 'GIT=git; S=push; $GIT $S origin feature'", "GIT=git; $GIT $(echo push) origin feature"):
            with self.subTest(command=command):
                action, = self.actions(command)
                self.assertIsInstance(action, self.hook.Unattributable)
        self.assertEqual(self.actions("$EDITOR notes.md && git status"), [])
        self.assertEqual(self.actions("GIT=git; S=status; $GIT $S"), [])
        self.assertEqual(self.actions("GH=gh; $GH api repos/acme/app/pulls/7"), [])

    def test_runtimeProgramWord_isUnattributable_whenThePushOrMergeWordSitsElsewhereInTheCall(self):
        for command in ("GP=\"$(git --exec-path)/git-push\"; $GP origin main",
                        "P=push; GP=\"$(git --exec-path)/git-$P\"; $GP origin main",
                        "for GP in \"$(git --exec-path)/git-push\"; do $GP origin main; done",
                        "GH=gh; $GH api -X PATCH repos/acme/app/git/refs/heads/main -f sha=abc",
                        "GH=gh; X=refs/heads/main; $GH api -X PATCH repos/acme/app/git/$X -f sha=abc",
                        "eval \"$(ssh-agent -s)\" && git log --oneline | grep push"):
            with self.subTest(command=command):
                self.assertTrue(any(isinstance(action, self.hook.Unattributable) for action in self.actions(command)))

    def test_runtimeProgramWord_isUnattributable_whenItsOwnTextHoldsAPushOrMergeWord(self):
        for command in ("$CORE/git-push origin main", "\"$(git --exec-path)\"/git-push origin main",
                        "$X/git-merge feature"):
            with self.subTest(command=command):
                action, = self.actions(command)
                self.assertIsInstance(action, self.hook.Unattributable)
                self.assertIn("run time", action.why)
        for command in ("$EDITOR notes.md", "KEEL=k; $KEEL snapshot .", "$EDITOR notes.md && cat .git/refs/heads/main",
                        "$EDITOR x && cat docs/merges.md", "$EDITOR x && git log --merges"):
            with self.subTest(command=command):
                self.assertEqual(self.actions(command), [])

    def test_runtimeSubcommand_isUnattributable_evenWhenTheCallNeverSpellsPush(self):
        for command in ("S=push; git $S origin feature", "git $(echo push) origin feature",
                        "SUB=push\ngit \"$SUB\" origin feature", "git ${SUB:-push} origin feature",
                        "S=$(echo cHVzaA== | base64 -d); git $S origin feature", "P=pus; git ${P}h origin feature",
                        "S=status; git $S"):
            with self.subTest(command=command):
                action, = self.actions(command)
                self.assertIsInstance(action, self.hook.Unattributable)
                self.assertIn("run time", action.why)

    def test_gitPushPlumbing_isUnattributable_whenItPushesWithoutGitPush(self):
        for command in ("git send-pack ../app.git feature", "git http-push https://example.invalid/app.git feature",
                        "git subtree push --prefix=lib origin feature", "git subtree -P lib push origin feature",
                        "git-send-pack ../app.git feature"):
            with self.subTest(command=command):
                action, = self.actions(command)
                self.assertIsInstance(action, self.hook.Unattributable)
                self.assertIn("outside the gate", action.why)
        for command in ("git subtree split --prefix=lib", "git send-email x.patch"):
            with self.subTest(command=command):
                self.assertEqual(self.actions(command), [])

    def test_push_isUnattributable_whenGitIsPointedAtAnotherRepository(self):
        for command in ("git --git-dir=/x/.git --work-tree=/x push origin feature",
                        "git --git-dir /x/.git --work-tree /x push origin feature",
                        "GIT_DIR=/x/.git GIT_WORK_TREE=/x git push origin feature",
                        "export GIT_WORK_TREE=/x; git push origin feature"):
            with self.subTest(command=command):
                action, = self.actions(command)
                self.assertIsInstance(action, self.hook.Unattributable)
                self.assertIn("another repository", action.why)
        self.assertEqual(self.actions("GIT_DIR=/x/.git git status"), [])
        self.assertIsInstance(self.actions("git -C /x push origin feature")[0], self.hook.Push)

    def test_ghApiMerge_isUnattributable_whenEndpointMergesAPull(self):
        for command in ("gh api -X PUT repos/acme/app/pulls/7/merge", "gh api --method PUT /repos/acme/app/pulls/7/merge -f sha=abc"):
            with self.subTest(command=command):
                action, = self.actions(command)
                self.assertIsInstance(action, self.hook.Unattributable)
        self.assertEqual(self.actions("gh api repos/acme/app/pulls/7"), [])

    def test_ghApi_isUnattributable_whenItMergesABranchOrWritesARef(self):
        mutation = "gh api graphql -f query='mutation { %s(input: {}) { clientMutationId } }'"
        for command in ("gh api -X POST repos/acme/app/merges -f base=main -f head=feature",
                        "gh api repos/{owner}/{repo}/merges -f base=main -f head=feature",
                        "gh api -X PATCH repos/acme/app/git/refs/heads/main -f sha=abc",
                        "gh api --method=PATCH https://api.github.com/repos/acme/app/git/refs/heads/main -F force=true",
                        "gh api repos/acme/app/git/refs -f ref=refs/heads/x -f sha=abc",
                        "gh api -XDELETE repos/acme/app/git/refs/heads/x", "gh api --method=DELETE repos/acme/app/git/refs/heads/x",
                        "gh api -X GET -X PATCH repos/acme/app/git/refs/heads/main --input body.json",
                        "R=acme/app; gh api -X PATCH repos/$R/git/refs/heads/main -f sha=abc",
                        "R=acme/app; gh api repos/$R/merges -f base=main -f head=feature",
                        "N=7; gh api -X PUT repos/acme/app/pulls/$N/merge",
                        "GH=gh; X=git/refs/heads/main; $GH api -X PATCH repos/acme/app/$X -f sha=abc",
                        "GH=gh; X=merges; $GH api repos/acme/app/$X -f base=main -f head=feature",
                        "X=git/refs/heads/main; gh api -X PATCH repos/acme/app/$X -f sha=abc",
                        "gh api -X PATCH \"$E\" -f sha=abc", "M=merge; gh api -X PUT repos/acme/app/pulls/7/$M",
                        "X=merges; gh api repos/acme/app/$X -f base=main -f head=feature",
                        "Q='mutation { updateRefs(input: {}) { clientMutationId } }'; gh api graphql -f query=\"$Q\"",
                        "KV='query=mutation { mergeBranch(input: {}) { clientMutationId } }'; gh api graphql -f \"$KV\"",
                        "gh api graphql -F \"$KV\"", "gh api graphql --raw-field=\"$KV\"", "gh api graphql -f\"$K=$V\"",
                        "gh api -H 'Accept: application/json' -X PATCH \"$E\" -f sha=abc",
                        "gh api -f sha=abc -X PATCH \"$E\"", "gh api --jq .sha repos/acme/app/$X -f base=main -f head=feature",
                        "gh api graphql -F=\"$KV\"", "gh api graphql -if \"$KV\"", "gh api graphql $F", "gh api $F graphql",
                        "gh api $F repos/acme/app/git/refs/heads/main",
                        "gh api graphql \"${ARGS[@]}\"", "gh api -iX PATCH repos/acme/app/git/refs/heads/main -f sha=abc",
                        "gh api -iXPATCH repos/acme/app/git/refs/heads/main",
                        mutation % "updateRefs", mutation % "createRef", mutation % "mergeBranch",
                        mutation % "enablePullRequestAutoMerge"):
            with self.subTest(command=command):
                action, = self.actions(command)
                self.assertIsInstance(action, self.hook.Unattributable)
        for command in ("gh api repos/acme/app/git/refs/heads/main", "gh api -X GET repos/acme/app/git/refs -f per_page=1",
                        "gh api repos/acme/app/git/refs/heads/main --jq .object.sha",
                        "gh api -X HEAD repos/acme/app/git/refs/heads/main", "gh api -X get repos/acme/app/git/refs/heads/main",
                        "gh api \"$E\"", "gh api graphql -f query='query { viewer { login } }' -F owner=\"$O\"",
                        "T=x; gh api -f title=\"$T\" -X POST repos/acme/app/issues",
                        "gh api -i repos/acme/app/git/refs/heads/main", "gh api -X=GET repos/acme/app/git/refs -f per_page=1",
                        "gh api --jq .object.sha \"$E\"", "gh api -q .sha \"$E\"", "gh api -H 'Accept: application/json' \"$E\"",
                        "gh api --header 'Accept: application/json' \"$E\""):
            with self.subTest(command=command):
                self.assertEqual(self.actions(command), [])

    def test_otherCommands_produceNoAction_whenPushIsOnlyAWordOrInsideOneWord(self):
        self.assertEqual(self.actions("grep -n 'git push' notes.md; git stash push; git config push.default simple"), [])
        self.assertEqual(self.actions("echo 'git push' > notes.md && git log --oneline | grep merge"), [])

    def test_assignments_reachTheCommand_whenPrefixedExportedOrInherited(self):
        merges = self.actions("GH_REPO=acme/app gh pr merge 7; export GH_REPO=acme/lib; gh pr merge 8; "
                              "env GH_REPO=acme/x bash -c 'gh pr merge 9'")
        self.assertEqual([merge.repo_env for merge in merges], ["acme/app", "acme/lib", "acme/x"])

    def test_parseMerge_readsMatchHeadAndRepo_whenGiven(self):
        merge, = self.actions("gh pr merge 12 --repo acme/app --auto --match-head-commit abc123 --body 'merge it'")
        self.assertEqual((merge.selector, merge.repo_flag, merge.auto, merge.match_head), ("12", "acme/app", True, "abc123"))

    def test_mergeTargetKey_prefersAnyNamedRepo_overTheCwdClone(self):
        by_url, = self.actions("gh pr merge https://github.com/ACME/app/pull/7 --squash")
        by_env, = self.actions("GH_REPO=github.com/acme/app gh pr merge 7")
        by_number, = self.actions("gh pr merge 7")
        self.assertEqual(self.hook.merge_target_key(by_url), "acme/app")
        self.assertEqual(self.hook.merge_target_key(by_env), "acme/app")
        self.assertIsNone(self.hook.merge_target_key(by_number))

    def test_parseMerge_readsEqualsForm_whenMatchHeadUsesEquals(self):
        merge, = self.actions("gh pr merge --match-head-commit=abc123")
        self.assertEqual((merge.selector, merge.match_head), (None, "abc123"))

    def test_parseMerge_readsTheRepoFlag_beforeOrBetweenTheSubcommandWords(self):
        for command in ("gh -R acme/app pr merge 7 --squash", "gh pr -R acme/app merge 7 --squash",
                        "gh --repo=acme/app pr merge 7 --squash", "gh pr --repo acme/app merge 7 --squash"):
            with self.subTest(command=command):
                merge, = self.actions(command)
                self.assertIsInstance(merge, self.hook.Merge)
                self.assertEqual((merge.selector, merge.repo_flag), ("7", "acme/app"))

    def test_parsePush_readsTheRemote_whenOneIsGiven(self):
        self.assertEqual(self.actions("git push upstream feature")[0].remote, "upstream")
        self.assertEqual(self.actions("git push --all origin")[0].remote, "origin")
        self.assertIsNone(self.actions("git push -u")[0].remote)

    def test_workdir_followsDashC_throughHomeFormsAndExportedVariables(self):
        with mock.patch.dict(os.environ, {"HOME": "/home/u"}):
            for command in ("git -C $HOME/app push origin x", "git -C ${HOME}/app push origin x",
                            "git -C ~/app push origin x", "export APP=/home/u/app; git -C $APP push origin x"):
                with self.subTest(command=command):
                    push, = self.actions(command)
                    self.assertEqual((push.workdir, push.words), ("/home/u/app", ["git", "push", "origin", "x"]))

    def test_mayPushOrMerge_isFalse_whenTheCallHasNoPushOrMergeWordAndNoRunTimeGit(self):
        for call in ("gh pr create --title t --body b", "git status && git log --oneline", "echo $HOME", "",
                     "cat .git/refs/heads/main", "cat docs/merges.md"):
            with self.subTest(call=call):
                self.assertFalse(self.hook.may_push_or_merge(call))

    def test_otherGitCommands_produceNoAction_whenNotDecisionPoints(self):
        self.assertEqual(self.actions("git checkout main && git merge feature && git status"), [])


class HookBehaviorTest(unittest.TestCase):
    def test_hook_passesQuietly_whenCommandIsNotADecisionPoint(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        run = sandbox.push(repo, "git status && ls -la")
        self.assertEqual((run.rc, run.stdout, run.stderr), (0, "", ""))
        self.assertEqual(sandbox.fires(), [])

    def test_hook_passesSilently_whenTheEventIsNotPreToolUseBash(self):
        # given an unreviewed feature branch, and a push seen after it ran plus a tool call that is not Bash
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit(LOGIC_WITH_TEST)
        after_push = sandbox.bash_payload(repo, "git push origin feature")
        after_push["hook_event_name"] = "PostToolUse"
        read = sandbox.bash_payload(repo, "")
        read.update({"tool_name": "Read", "tool_input": {"file_path": "README.md"}})
        for payload in (after_push, read):
            with self.subTest(event=payload["hook_event_name"], tool=payload["tool_name"]):
                # when
                run = sandbox.hook(payload)
                # then
                self.assertEqual((run.rc, run.stdout, run.stderr), (0, "", ""))
        self.assertEqual(sandbox.fires(), [])

    # DESIGN 5.2: `git -C` resolves like `cd`; an unresolvable directory denies only while a repo is gated (5.7)
    def test_push_isJudgedAsThatClone_whenDashCNamesItThroughHome(self):
        # given an unreviewed feature branch in a clone under HOME, and a call made from elsewhere
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit(LOGIC_WITH_TEST)
        sandbox.env["HOME"] = os.path.dirname(repo.path)
        for target in ("$HOME/app", "${HOME}/app", "~/app"):
            with self.subTest(target=target):
                payload = sandbox.bash_payload(repo, "git -C %s push origin feature" % target)
                payload["cwd"] = sandbox.root
                # when
                run = sandbox.hook(payload)
                # then
                self.assertEqual(run.rc, 2, run.stderr + run.stdout)
                self.assertIn("- [K1] no review evidence for acme/app", run.stderr)
                self.assertEqual(run.stderr.splitlines()[-1],
                                 "Run it yourself in your terminal: cd %s && git push origin feature" % repo.path)

    # DESIGN 5.7: the deny's last line is a command the user can run as written
    def test_runtimeSpellings_endWithTheWholeCallAsTheUserCommand(self):
        # given a gated clone and calls whose remote, subcommand or program the shell resolves only at run time
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        for command in ("R=origin; git push $R feature", "R=origin; git push \"$R\" feature",
                        "S=push; git $S origin feature", "GIT=git; $GIT push origin feature"):
            with self.subTest(command=command):
                # when
                run = sandbox.push(repo, command)
                # then the assignments and the unquoted variables reach the user's terminal unchanged
                self.assertEqual(run.rc, 2, run.stderr + run.stdout)
                self.assertEqual(run.stderr.splitlines()[-1],
                                 "Run it yourself in your terminal: cd %s && %s" % (shlex.quote(repo.path), command))

    def test_configOverrideSpellings_endWithTheWholeCallAsTheUserCommand(self):
        # given a gated clone and calls that change, for this call only, the config a push is routed by
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        for command in ("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.pushDefault GIT_CONFIG_VALUE_0=origin git push",
                        "git config remote.pushDefault origin && git push"):
            with self.subTest(command=command):
                # when
                run = sandbox.push(repo, command)
                # then it is denied as unattributable, and the config change reaches the user's terminal with the push
                self.assertEqual(run.rc, 2, run.stderr + run.stdout)
                self.assertIn("changes git config the gate reads from the clone", run.stderr)
                self.assertEqual(run.stderr.splitlines()[-1],
                                 "Run it yourself in your terminal: cd %s && %s" % (shlex.quote(repo.path), command))

    def test_push_passesWithAnErrorLine_whenDashCCannotBeResolvedAndNoRepoIsGated(self):
        for registry in (NOT_GATED_REGISTRY, None):
            with self.subTest(registry=registry):
                # given a registry that gates no repo, or none at all
                sandbox = Sandbox(self, registry=registry)
                if registry is None:
                    sandbox.remove_registry()
                repo = sandbox.clone("acme", "app")
                # when
                run = sandbox.push(repo, "git -C $NO_SUCH_VARIABLE/app push origin main")
                # then
                self.assertEqual(run.rc, 0, run.stderr + run.stdout)
                self.assertIn("not a git repository", sandbox.fires("K1", "error")[0]["detail"])

    def test_push_failsClosed_whenDashCCannotBeResolvedAndARepoIsGated(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        run = sandbox.push(repo, "git -C $NO_SUCH_VARIABLE/app push origin main")
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("failing closed", run.stderr)

    def test_push_passesTagsDeletesAndDryRuns_butGatesATagPushedAsABranch(self):
        # given an unreviewed commit on feature, tagged
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        head = repo.commit({"src/a.py": "x\n"})
        repo.git("tag", "v1")
        # when / then: tags, deletions and dry runs pass with the commit on the pass line
        for command in ("git push --delete origin feature", "git push origin :feature", "git push origin v1",
                        "git push origin refs/tags/v1", "git push origin v1:refs/tags/v1", "git push --tags origin",
                        "git push -n origin feature"):
            with self.subTest(command=command):
                self.assertEqual(sandbox.push(repo, command).rc, 0)
        self.assertEqual(len(sandbox.fires("risk", "pass")), 7)
        self.assertEqual(sandbox.fires("risk", "pass")[2]["head"], head)
        # and a tag whose destination is a branch ships that commit, so it is gated
        for command in ("git push origin v1:feature", "git push origin refs/tags/v1:refs/heads/feature"):
            with self.subTest(command=command):
                run = sandbox.push(repo, command)
                self.assertEqual(run.rc, 2, run.stderr)
                self.assertIn("- [K1] no review evidence", run.stderr)
        self.assertEqual(len(sandbox.fires("risk", "pass")), 7)

    def test_push_deniesWholeRepoPush_whenRepoIsGated(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        run = sandbox.push(repo, "git push --all origin")
        self.assertEqual(run.rc, 2)
        self.assertIn("- [F-irreversible] git push --all/--mirror", run.stderr)

    def test_push_isStillGated_whenQuotesAreUnbalanced(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        for command in ("git push origin \"feature", "git pu''sh origin \"feature"):
            with self.subTest(command=command):
                run = sandbox.push(repo, command)
                self.assertEqual(run.rc, 2, run.stderr + run.stdout)
                self.assertNotIn("Traceback", run.stderr)

    # DESIGN 5.2/5.7: a push behind a wrapper is still a push; one the parser cannot attribute denies
    def unreviewed_feature_push(self, command: str, registry=None):
        sandbox = Sandbox(self, registry=registry)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "x\n"})
        return sandbox, sandbox.push(repo, command)

    def assert_push_denied(self, command: str, reason: str, registry=None):
        sandbox, run = self.unreviewed_feature_push(command, registry)
        self.assertEqual(run.rc, 2, "%r: %s%s" % (command, run.stderr, run.stdout))
        self.assertIn(reason, run.stderr)
        self.assertEqual(sandbox.fires(outcome="deny")[0]["rule_id"], "K1")
        self.assertFalse(sandbox.fires("risk", "pass"))
        return run

    def test_push_denies_whenWrappedInEnv(self):
        self.assert_push_denied("env GIT_TRACE=1 git push origin feature", "- [K1] no review evidence")

    def test_push_denies_whenWrappedInTimeout(self):
        self.assert_push_denied("timeout 60 git push origin feature", "- [K1] no review evidence")

    def test_push_denies_whenWrappedInNice(self):
        self.assert_push_denied("nice git push origin feature", "- [K1] no review evidence")

    def test_push_denies_whenWrappedInSudo(self):
        self.assert_push_denied("sudo git push origin feature", "- [K1] no review evidence")

    def test_push_denies_whenWrappedInEval(self):
        self.assert_push_denied("eval 'git push origin feature'", "- [K1] no review evidence")

    def test_push_denies_whenFedToBashByHeredoc(self):
        self.assert_push_denied("bash <<'EOF'\ngit push origin feature\nEOF", "- [K1] no review evidence")

    def test_push_denies_whenSubcommandIsQuoted(self):
        self.assert_push_denied("git pu''sh origin feature", "- [K1] no review evidence")

    def test_push_denies_whenXargsRunsIt(self):
        self.assert_push_denied("xargs -0 git push origin feature < /dev/null", "- [K1] cannot attribute this push or merge")
        self.assert_push_denied("echo feature | xargs git push origin", "- [K1] cannot attribute this push or merge")

    def test_merge_denies_whenGhApiMergesThePull(self):
        run = self.assert_push_denied("gh api -X PUT repos/acme/app/pulls/7/merge", "- [K1] cannot attribute this push or merge")
        self.assertIn("gh api", run.stderr)

    def test_unattributablePush_denies_evenWhenCwdRepoIsOff(self):
        self.assert_push_denied("xargs git push origin feature < /dev/null", "- [K1] cannot attribute this push or merge",
                                registry=["acme/app\toff\tmain\t-\tnone"])

    def test_push_passes_whenWrappedInEnvAndBundleIsComplete(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit(LOGIC_WITH_TEST)
        sandbox.full_bundle(repo)
        run = sandbox.push(repo, "env GIT_TRACE=1 timeout 60 git push origin feature")
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertEqual(sandbox.fires("risk", "pass")[-1]["repo"], "acme/app")

    def test_push_logsFilesAndLines_onPassAndOnDeny(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit(LOGIC_WITH_TEST)
        denied = sandbox.push(repo, "git push origin feature")
        self.assertEqual(denied.rc, 2)
        sandbox.push_bundle(repo)
        passed = sandbox.push(repo, "git push origin feature")
        self.assertEqual(passed.rc, 0, passed.stderr)
        deny_line, pass_line = sandbox.fires("K1", "deny")[0], sandbox.fires("risk", "pass")[-1]
        self.assertEqual((deny_line["files"], deny_line["lines"]), (2, 3))
        self.assertEqual((pass_line["files"], pass_line["lines"]), (2, 3))

    def test_push_failsClosed_whenRefspecSourceNamesNoCommit(self):
        # given a gated clone without the branch the push names
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        # when
        run = sandbox.push(repo, "git push origin no-such-branch")
        # then
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("failing closed", run.stderr)
        self.assertIn("refspec source no-such-branch does not name a commit", run.stderr)
        self.assertEqual(sandbox.fires("K1", "error")[0]["repo"], "acme/app")

    def test_push_failsClosed_whenWorkdirIsNotARepo(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        run = sandbox.push(repo, "cd /nonexistent-dir && git push origin feature")
        self.assertEqual(run.rc, 2)
        self.assertIn("not a git repository", run.stderr)

    # DESIGN 5.7: a fires log that cannot be written is a gate error, never a traceback with exit 1
    def test_push_failsClosed_whenFiresLogIsUnwritableInGatedRepo(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        sandbox.make_logs_unwritable()
        run = sandbox.push(repo, "git push origin main")  # an empty outgoing change: would pass otherwise
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("failing closed", run.stderr)
        self.assertIn("keel-fires.jsonl", run.stderr)
        self.assertNotIn("Traceback", run.stderr)
        self.assertIn("Run it yourself in your terminal: git push origin main", run.stderr)

    def test_mergeSpellings_failClosed_whenFiresLogIsUnwritableInGatedRepo(self):
        for command in ("gh pr merge 7 --squash", "gh api -X PUT repos/acme/app/pulls/7/merge",
                        "S=push; git $S origin main", "git -c remote.pushDefault=origin push",
                        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.pushDefault GIT_CONFIG_VALUE_0=origin git push"):
            with self.subTest(command=command):
                # given a gated clone whose fires log cannot be written, so the verdict crashes
                sandbox = Sandbox(self)
                repo = sandbox.clone("acme", "app")
                sandbox.make_logs_unwritable()
                # when
                run = sandbox.push(repo, command)
                # then
                self.assertEqual(run.rc, 2, run.stderr + run.stdout)
                self.assertIn("failing closed", run.stderr)
                self.assertNotIn("Traceback", run.stderr)

    def test_push_failsClosed_whenFiresLogIsUnwritableEvenIfRepoIsOff(self):
        sandbox = Sandbox(self, registry=["acme/app\toff\tmain\t-\tnone"])
        repo = sandbox.clone("acme", "app")
        sandbox.make_logs_unwritable()
        run = sandbox.push(repo, "git push origin main")
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertIn("keel-fires.jsonl", run.stderr)
        self.assertNotIn("Traceback", run.stderr)

    def test_nonPushCommand_passes_whenFiresLogIsUnwritable(self):
        # given a gated feature branch and an unwritable fires log
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "print(1)\n"})
        sandbox.make_logs_unwritable()
        # when a warning-only command cannot log its warning
        run = sandbox.push(repo, "gh pr create --title t --body b")
        # then it passes with a note on stderr
        self.assertEqual(run.rc, 0, run.stderr + run.stdout)
        self.assertIn("internal error on a command that is not a push or merge", run.stderr)

    def test_hook_failsClosed_whenPayloadIsUnreadableAndNamesAPush(self):
        sandbox = Sandbox(self)
        run = sandbox.hook_raw('{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin main"')
        self.assertEqual(run.rc, 2, run.stderr + run.stdout)
        self.assertTrue(run.stderr.startswith("[K1] ship-gate: internal error"), run.stderr)
        self.assertNotIn("Traceback", run.stderr)

    def test_hook_logsContractMissAndPasses_whenToolInputIsNotAnObject(self):
        # given a Bash payload whose tool_input is a string, a shape Claude Code does not send
        sandbox = Sandbox(self)
        sandbox.stub_claude()
        # when
        run = sandbox.hook_raw(json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Bash",
                                           "tool_input": "gh pr merge 7 --squash"}))
        # then
        self.assertEqual((run.rc, run.stderr), (0, ""))
        self.assertIn("missing tool_input.command", sandbox.fires(outcome="contract-miss")[0]["detail"])

    def test_hook_passes_whenPayloadIsUnreadableAndHarmless(self):
        sandbox = Sandbox(self)
        run = sandbox.hook_raw("not json")
        self.assertEqual(run.rc, 0, run.stderr + run.stdout)
        self.assertNotIn("Traceback", run.stderr)

    def test_hook_logsContractMiss_whenBashPayloadLacksCommand(self):
        # given a payload whose tool_input has no command (a Claude Code contract drift)
        sandbox = Sandbox(self)
        sandbox.stub_claude()
        repo = sandbox.clone("acme", "app")
        payload = sandbox.bash_payload(repo, "git status")
        del payload["tool_input"]["command"]
        # when
        run = sandbox.hook(payload)
        # then: logged with the field names and the claude version, otherwise a pass as before
        self.assertEqual((run.rc, run.stderr), (0, ""))
        line, = sandbox.fires(outcome="contract-miss")
        self.assertEqual(line["rule_id"], "K1")
        self.assertIn("missing tool_input.command;", line["detail"])
        self.assertIn("cc_version=9.9.9", line["detail"])

    def test_hook_logsNoContractMiss_whenOnlyCwdIsMissing(self):
        # given a Bash payload without cwd: the hook falls back to its own working directory
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        payload = sandbox.bash_payload(repo, "git status")
        del payload["cwd"]
        # when
        run = sandbox.hook(payload)
        # then
        self.assertEqual((run.rc, run.stderr), (0, ""))
        self.assertEqual(sandbox.fires(outcome="contract-miss"), [])

    def test_hook_logsNoContractMiss_whenPayloadIsComplete(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        sandbox.push(repo, "git status")
        self.assertEqual(sandbox.fires(outcome="contract-miss"), [])

    def test_push_warnsOncePerSession_whenRegistryIsAbsent(self):
        sandbox = Sandbox(self)
        sandbox.remove_registry()
        repo = sandbox.clone("acme", "app")
        first = sandbox.push(repo, "git push origin main")
        second = sandbox.push(repo, "git push origin main")
        self.assertIn("every repo is off", first.context)
        self.assertEqual(second.context, "")
        self.assertEqual(len(sandbox.fires("K1", "warn")), 1)
        self.assertEqual(len(sandbox.fires("risk", "pass")), 2)

    def test_prCreate_warnsWhatIsMissing_whenBranchLacksEvidence(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit({"src/a.py": "x\n"})
        run = sandbox.push(repo, "gh pr create --title t --body b")
        self.assertEqual(run.rc, 0, run.stderr)
        self.assertIn("not ready to ship feature of acme/app (risk standard)", run.context)
        self.assertIn("- [K1] no review evidence", run.context)
        self.assertIn("- [K3] no tests evidence", run.context)
        self.assertEqual({line["rule_id"] for line in sandbox.fires(outcome="warn")}, {"K1", "K3"})

    def test_gc_runsOncePerDay_whenAPushIsJudged(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone("acme", "app")
        sandbox.push(repo, "git push origin main")
        sandbox.push(repo, "git push origin main")
        self.assertEqual(len([line for line in sandbox.fires("K1", "record") if "gc" in line["detail"]]), 1)
        self.assertTrue(os.path.exists(os.path.join(sandbox.data, "state", "keel", "gc.stamp")))


class EarlyWarningTest(unittest.TestCase):
    def feature_with_test(self, sandbox: Sandbox):
        repo = sandbox.clone("acme", "app")
        repo.branch("feature")
        repo.commit(LOGIC_WITH_TEST)
        return repo

    def test_prCreate_saysReady_whenBundleIsComplete(self):
        sandbox = Sandbox(self)
        repo = self.feature_with_test(sandbox)
        sandbox.full_bundle(repo)
        run = sandbox.push(repo, "gh pr create --title t --body b")
        self.assertIn("ready to ship feature of acme/app (risk standard)", run.context)
        self.assertEqual(sandbox.fires("K1", "warn")[0]["root_run_id"], "rv-root-0001")

    def test_prCreate_namesTheApproval_whenOnlyTheMergeApprovalIsMissing(self):
        # given a branch a push would accept (review + tests), which a merge still cannot take
        sandbox = Sandbox(self)
        repo = self.feature_with_test(sandbox)
        sandbox.push_bundle(repo)
        run = sandbox.push(repo, "gh pr create --title t --body b")
        self.assertIn("- [K1] no approval bound to chain head", run.context)


class SubprocessBudgetTest(unittest.TestCase):
    """Claude Code blocks the call with no keel message when it kills ship-gate at its registered timeout."""

    def test_subprocessTimeouts_fitUnderTheRegisteredTimeout(self):
        # given the timeout settings/core.json registers for ship-gate
        registered, = [registration["timeout"] for entry in read_json(SETTINGS_PATH)["hooks"]["PreToolUse"]
                       for registration in entry["hooks"] if "ship-gate.py" in registration["command"]]
        hook = load_hook_module()
        # then one git call, and the merge path's two fetches plus its `gh pr view`, end before that
        self.assertLess(hook.gitcmd.GIT_TIMEOUT_SECONDS + DECISION_MARGIN_SECONDS, registered)
        merge_network = 2 * hook.gitcmd.FETCH_TIMEOUT_SECONDS + hook.GH_TIMEOUT_SECONDS
        self.assertLess(merge_network + DECISION_MARGIN_SECONDS, registered)


if __name__ == "__main__":
    unittest.main()
