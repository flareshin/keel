import importlib.util
import json
import os
import stat
import sys
import unittest
from unittest import mock

import helpers
from helpers import GIT_GUARD, bash, pre_tool_use
from hookkit.repo import GIT_TIMEOUT_SECONDS

ATTRIBUTION_TRAILER = "Co-Authored-By: Claude <noreply@example.invalid>"
ROBOT = "\U0001F916"
CLEAN_SCAN = '{"scanned": 1, "hits": []}'
SETTINGS_PATH = os.path.join(helpers.KEEL_HOME, "settings", "core.json")
DECISION_MARGIN_SECONDS = 0.5
RUN_YOURSELF = "Run it yourself in your terminal: "
ASK_USER = "Stop and ask the user."
PASSWORD = "hunter2" * 2  # built at run time: a literal trips the generic credential-assignment rule
TOKEN = "tok-abcdef123456"


def registered_timeout(hook_script: str) -> int:
    """The timeout settings/core.json registers for the hook whose command names `hook_script`."""
    with open(SETTINGS_PATH, encoding="utf-8") as stream:
        settings = json.load(stream)
    for entries in settings["hooks"].values():
        for entry in entries:
            for hook in entry.get("hooks", []):
                if hook_script in hook.get("command", ""):
                    return int(hook["timeout"])
    raise AssertionError("%s is not registered in %s" % (hook_script, SETTINGS_PATH))


def load_git_guard():
    spec = importlib.util.spec_from_file_location("git_guard", os.path.join(helpers.KEEL_HOME, GIT_GUARD))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve their module through sys.modules
    spec.loader.exec_module(module)
    return module


class GitGuardTestCase(helpers.SandboxTestCase):
    def setUp(self):
        super().setUp()
        self.sandbox.env["KEEL_BOUNDARY"] = self.sandbox.stub("boundary", stdout=CLEAN_SCAN)
        self.data = self.sandbox.data
        self.evidence_file = os.path.join(self.data, "state", "keel", "evidence", "review", "acme__app", "r.json")

    def guard(self, command, cwd=None):
        return self.sandbox.run_hook(GIT_GUARD, bash(command, cwd or self.sandbox.root))

    def edit(self, tool, tool_args, cwd=None):
        return self.sandbox.run_hook(GIT_GUARD, pre_tool_use(tool, tool_args, cwd or self.sandbox.root))

    def assertDenied(self, result, rule_id):
        self.assertEqual(2, result.code, result.stderr)
        self.assertIn("[%s]" % rule_id, result.stderr)
        lines = result.stderr.rstrip("\n").splitlines()
        self.assertRegex(lines[0], r"^\[[A-Za-z0-9-]+\] git-guard: ")
        self.assertTrue(RUN_YOURSELF in result.stderr or lines[-1] == ASK_USER, result.stderr)

    def assertPassed(self, result):
        self.assertEqual(0, result.code, result.stderr)


class ProtectedEditTest(GitGuardTestCase):
    def test_write_deniedWithK1_whenTargetIsEvidenceFile(self):
        # when
        result = self.edit("Write", {"file_path": self.evidence_file, "content": "{}"})
        # then
        self.assertDenied(result, "K1")
        self.assertBulletIdsSeeded(result.stderr)
        self.assertEqual(ASK_USER, result.stderr.rstrip("\n").splitlines()[-1])
        self.assertFired("K1", "deny", "git-guard")

    def test_write_denied_whenTheFilePathReachesTheStoreThroughTilde(self):
        self.sandbox.env["HOME"] = os.path.dirname(self.data)
        target = "~/%s/state/keel/x.json" % os.path.basename(self.data)
        self.assertDenied(self.edit("Write", {"file_path": target, "content": "{}"}), "K1")

    def test_notebookEdit_denied_whenNotebookPathIsProtected(self):
        target = os.path.join(self.data, "state", "keel", "x.ipynb")
        self.assertDenied(self.edit("NotebookEdit", {"notebook_path": target, "new_source": ""}), "K1")

    def test_write_passesWithoutFire_whenTargetIsOrdinaryFile(self):
        result = self.edit("Write", {"file_path": os.path.join(self.data, "notes.md"), "content": "x"})
        self.assertPassed(result)
        self.assertEqual([], self.sandbox.fires())


class ProtectedBashWriteTest(GitGuardTestCase):
    def test_bash_denied_whenCopyIntoEvidenceDir(self):
        self.assertDenied(self.guard("cp /tmp/forged.json %s" % self.evidence_file), "K1")

    def test_bash_denied_whenRelativeRedirectAfterCdIntoStore(self):
        self.assertDenied(self.guard("cd %s && echo x > y.json" % os.path.join(self.data, "state", "keel")), "K1")

    def test_bash_denied_whenRedirectTargetUsesAnExportedVariable(self):
        command = "export S=%s; echo x > $S/keel/forged.json" % os.path.join(self.data, "state")
        self.assertDenied(self.guard(command), "K1")

    def test_bash_denied_whenRedirectTargetUsesAPlainShellVariable(self):
        command = "S=%s; echo x > $S/keel/forged.json" % os.path.join(self.data, "state")
        self.assertDenied(self.guard(command), "K1")

    def test_bash_passes_whenOnlyReadingEvidence(self):
        self.assertPassed(self.guard("grep -c verdict %s | head -1" % self.evidence_file))

    def test_bash_passes_whenWritingElsewhereWhileNamingStore(self):
        self.assertPassed(self.guard("ls %s > /tmp/listing.txt" % os.path.join(self.data, "state", "keel")))

    def test_bash_endsWithTheCommand_whenDenied(self):
        result = self.guard("cp /tmp/forged.json %s" % self.evidence_file)
        self.assertTrue(result.stderr.rstrip("\n").endswith("%scd %s && cp /tmp/forged.json %s" % (RUN_YOURSELF, self.sandbox.root, self.evidence_file)), result.stderr)


class KeelOwnedFilesTest(GitGuardTestCase):
    """keel-fires.jsonl is written by the hooks only (F-hookskip)."""

    def setUp(self):
        super().setUp()
        self.settings = os.path.join(self.data, "settings.json")
        self.fires_log = os.path.join(self.data, "logs", "keel-fires.jsonl")

    def test_write_deniedWithFHookskip_whenTargetIsFiresLog(self):
        result = self.edit("Write", {"file_path": self.fires_log, "content": "{}"})
        self.assertDenied(result, "F-hookskip")
        self.assertFired("F-hookskip", "deny", "git-guard")

    def test_write_passes_whenTargetIsDataDirSettingsWithoutDisableAllHooks(self):
        self.assertPassed(self.edit("Write", {"file_path": self.settings, "content": "{}"}))

    def test_bash_denied_whenAppendingToFiresLog(self):
        self.assertDenied(self.guard("echo '{}' >> %s" % self.fires_log), "F-hookskip")

    def test_bash_denied_whenSedEditsFiresLogInPlace(self):
        self.assertDenied(self.guard("sed -i '' 's/a/b/' %s" % self.fires_log), "F-hookskip")

    def test_bash_denied_whenRemovingFiresLog(self):
        self.assertDenied(self.guard("rm -f %s" % self.fires_log), "F-hookskip")

    def test_bash_passes_whenReadingSettings(self):
        self.assertPassed(self.guard("cat %s | jq .hooks" % self.settings))

    def test_write_passes_whenTargetIsAnotherSettingsFileWithoutDisableAllHooks(self):
        target = os.path.join(self.sandbox.root, "proj", ".claude", "settings.local.json")
        self.assertPassed(self.edit("Write", {"file_path": target, "content": '{"permissions": {"allow": ["Bash(ls)"]}}'}))


class HookSkipTest(GitGuardTestCase):
    """An agent never disables hooks: git's per-command skips, nor Claude Code's disableAllHooks."""

    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")

    def test_commit_deniedWithFHookskip_whenNoVerify(self):
        result = self.guard("git commit --no-verify -m wip", cwd=self.repo)
        self.assertDenied(result, "F-hookskip")
        self.assertBulletIdsSeeded(result.stderr)
        self.assertFired("F-hookskip", "deny", "git-guard")

    def test_commit_denied_whenShortNoVerifyFlag(self):
        self.assertDenied(self.guard("git commit -n -m wip", cwd=self.repo), "F-hookskip")
        self.assertDenied(self.guard("git commit -qn -m wip", cwd=self.repo), "F-hookskip")

    def test_commit_passes_whenNIsAMessageValue(self):
        # given `-mn`: the `n` is the message, not --no-verify
        self.assertPassed(self.guard("git commit -mn", cwd=self.repo))

    def test_pushAndMerge_denied_whenNoVerify(self):
        self.assertDenied(self.guard("git push --no-verify origin main", cwd=self.repo), "F-hookskip")
        self.assertDenied(self.guard("git merge --no-verify topic", cwd=self.repo), "F-hookskip")

    def test_push_passes_whenDashNIsADryRun(self):
        self.assertPassed(self.guard("git push -n origin main", cwd=self.repo))

    def test_git_deniedWithFHookskip_whenSudoCarriesAnOptionTheParserDoesNotRead(self):
        for command in ("sudo -i git commit --no-verify -m wip", "sudo -nE git commit --no-verify -m wip",
                        "sudo --login git config core.hooksPath /dev/null"):
            with self.subTest(command=command):
                self.assertDenied(self.guard(command, cwd=self.repo), "F-hookskip")

    def test_git_deniedWithFHookskip_whenExecNamesADashedGitProgramAsArgv0(self):
        self.assertDenied(self.guard("exec -a git-push git config core.hooksPath /dev/null", cwd=self.repo), "F-hookskip")

    def test_git_denied_whenHooksPathOverriddenForTheCommand(self):
        self.assertDenied(self.guard("git -c core.hooksPath=/dev/null commit -m wip", cwd=self.repo), "F-hookskip")

    def test_config_denied_whenSettingHooksPath(self):
        self.assertDenied(self.guard("git config core.hooksPath /tmp/hooks", cwd=self.repo), "F-hookskip")
        self.assertDenied(self.guard("git config --local core.hooksPath /tmp/hooks", cwd=self.repo), "F-hookskip")

    def test_config_passes_whenReadingHooksPath(self):
        for command in ("git config --get core.hooksPath", "git config get core.hooksPath", "git config core.hooksPath",
                        "git config --get-urlmatch core.hooksPath https://example.invalid"):
            with self.subTest(command=command):
                self.assertPassed(self.guard(command, cwd=self.repo))

    def test_config_denied_whenUnsettingHooksPath(self):
        self.assertDenied(self.guard("git config --unset core.hooksPath", cwd=self.repo), "F-hookskip")

    def test_claude_denied_whenSettingsDisableAllHooksAndToolsStayOn(self):
        result = self.guard("claude -p --settings '{\"disableAllHooks\": true}' 'hello'")
        self.assertDenied(result, "F-hookskip")
        self.assertIn("disableAllHooks", result.stderr)

    def test_claude_passes_whenWriteToolsAreDisallowed(self):
        command = "claude -p --settings '{\"disableAllHooks\": true}' --disallowedTools Bash,Edit,Write 'hello'"
        self.assertPassed(self.guard(command))
        command = "claude -p --settings '{\"disableAllHooks\": true}' --disallowedTools Bash Edit Write -- 'hello'"
        self.assertPassed(self.guard(command))

    def test_claude_passes_whenSettingsKeepHooks(self):
        self.assertPassed(self.guard("claude -p --settings '{\"disableAllHooks\": false}' 'hello'"))

    def test_write_denied_whenClaudeSettingsFileSetsDisableAllHooks(self):
        target = os.path.join(self.sandbox.root, "proj", ".claude", "settings.local.json")
        result = self.edit("Write", {"file_path": target, "content": '{"disableAllHooks": true}'})
        self.assertDenied(result, "F-hookskip")

    def test_bash_denied_whenItWritesDisableAllHooksIntoAClaudeSettingsFile(self):
        target = os.path.join(self.sandbox.root, "proj", ".claude", "settings.local.json")
        for command in ("echo '{\"disableAllHooks\": true}' > %s" % target,
                        "printf '%%s' '{\"disableAllHooks\": true}' | tee %s" % target,
                        "jq '.disableAllHooks=true' %s > /tmp/s.json && mv /tmp/s.json %s" % (target, target),
                        "cd %s && cat > settings.json <<'EOF'\n{\"disableAllHooks\": true}\nEOF" % os.path.dirname(target)):
            with self.subTest(command=command):
                result = self.guard(command)
                self.assertDenied(result, "F-hookskip")
                self.assertIn("disableAllHooks", result.stderr)

    def test_bash_denied_whenTheSettingsPathComesFromAPlainShellVariable(self):
        directory = os.path.join(self.sandbox.root, "proj", ".claude")
        result = self.guard("C=%s; echo '{\"disableAllHooks\": true}' > $C/settings.local.json" % directory)
        self.assertDenied(result, "F-hookskip")

    def test_bash_denied_whenTheSettingsPathComesFromAnExportedVariable(self):
        directory = os.path.join(self.sandbox.root, "proj", ".claude")
        result = self.guard("export C=%s; echo '{\"disableAllHooks\": true}' > $C/settings.local.json" % directory)
        self.assertDenied(result, "F-hookskip")

    def test_bash_passes_whenASettingsWriteKeepsHooksOrTheTargetIsNotASettingsFile(self):
        target = os.path.join(self.sandbox.root, "proj", ".claude", "settings.local.json")
        self.assertPassed(self.guard("echo '{\"disableAllHooks\": false}' > %s" % target))
        self.assertPassed(self.guard("echo '{\"disableAllHooks\": true}' > %s" % os.path.join(self.sandbox.root, "notes.json")))

    def test_edit_denied_whenNewStringSetsDisableAllHooks(self):
        target = os.path.join(self.sandbox.home, ".claude", "settings.json")
        result = self.edit("Edit", {"file_path": target, "old_string": "{", "new_string": '{"disableAllHooks": true,'})
        self.assertDenied(result, "F-hookskip")

    def test_edit_passes_whenNewStringTurnsDisableAllHooksOff(self):
        target = os.path.join(self.sandbox.home, ".claude", "settings.json")
        self.assertPassed(self.edit("Edit", {"file_path": target, "old_string": "true", "new_string": '"disableAllHooks": false'}))


class LiveCheckoutTest(GitGuardTestCase):
    """Edits and state-moving git commands in the live keel or overlay checkout are denied (C-isolation)."""

    def setUp(self):
        super().setUp()
        self.live = os.path.join(self.sandbox.root, "live", "keel")
        os.makedirs(self.live)
        self.sandbox.git(self.live, "init", "-q")
        self.sandbox.write(os.path.join(self.live, "README.md"), "live\n")
        self.sandbox.git(self.live, "add", "README.md")
        self.sandbox.git(self.live, "commit", "-q", "-m", "start")
        self.sandbox.env["KEEL_HOME"] = self.live
        self.worktree = os.path.join(self.sandbox.root, "live", "keel-wt", "topic")
        self.sandbox.git(self.live, "worktree", "add", "-q", "-b", "topic", self.worktree)

    def test_write_deniedWithCIsolation_whenTargetIsInsideLiveKeel(self):
        # when
        result = self.edit("Write", {"file_path": os.path.join(self.live, "PRINCIPLES.md"), "content": "x"})
        # then: the message names the worktree command and the user-run fast-forward merge
        self.assertDenied(result, "C-isolation")
        self.assertIn("worktree add", result.stderr)
        self.assertIn("merge --ff-only", result.stderr)
        self.assertFired("C-isolation", "deny", "git-guard")

    def test_bash_denied_whenAWriteFollowsACdTheHookCannotResolve(self):
        result = self.guard('cd "$(git rev-parse --show-toplevel)" && echo x > notes.md', cwd=self.live)
        self.assertDenied(result, "C-isolation")

    def test_bash_passes_whenPwdIsTheStepDirectory_notTheHookProcessDirectory(self):
        self.sandbox.env["PWD"] = self.live
        self.assertPassed(self.guard("cd %s && echo x > $PWD/notes.md" % self.worktree, cwd=self.live))

    def test_bash_denied_whenPwdNamesTheLiveCheckoutTheStepRunsIn(self):
        self.assertDenied(self.guard('echo x > "$PWD/notes.md"', cwd=self.live), "C-isolation")

    def test_bash_passes_whenOldpwdIsOnlyTheHookProcessValue(self):
        self.sandbox.env["OLDPWD"] = self.live
        self.assertPassed(self.guard("cd %s && echo x > $OLDPWD/notes.md" % self.worktree, cwd=self.worktree))

    def test_bash_denied_whenAPlainShellVariableNamesTheLiveCheckout(self):
        for command in ('L=%s; echo x > "$L/notes.md"' % self.live, 'L=%s; git -C "$L" checkout -b x' % self.live):
            with self.subTest(command=command):
                self.assertDenied(self.guard(command, cwd=self.worktree), "C-isolation")

    def test_bash_denied_whenAPlainAssignmentRepointsAnExportedVariableAtTheLiveCheckout(self):
        command = "export D=%s; D=%s; echo x > $D/notes.md" % (self.worktree, self.live)
        self.assertDenied(self.guard(command, cwd=self.worktree), "C-isolation")

    def test_bash_passes_whenAPlainShellVariableNamesTheWorktreeItCdsInto(self):
        self.assertPassed(self.guard('WT=%s; cd "$WT" && echo x > notes.md' % self.worktree, cwd=self.live))

    def test_bash_denialSaysTheCdIsUnresolved_whenItJudgesWhereTheCallStarts(self):
        result = self.guard('cd "$(git rev-parse --show-toplevel)" && echo x > notes.md', cwd=self.live)
        self.assertDenied(result, "C-isolation")
        self.assertIn("cannot resolve", result.stderr)

    def test_write_passes_whenTheFilePathStartsWithALiteralDollarWord(self):
        # the Write tool writes the path as given; the hook's KEEL_HOME (the live checkout) must not expand into it
        self.assertPassed(self.edit("Write", {"file_path": "$KEEL_HOME/notes.md", "content": "x"}, cwd=self.worktree))

    def test_write_passes_whenTargetIsInsideAWorktree(self):
        self.assertPassed(self.edit("Write", {"file_path": os.path.join(self.worktree, "PRINCIPLES.md"), "content": "x"}))

    def test_edit_denied_whenTargetIsInsideLiveOverlay(self):
        target = os.path.join(self.sandbox.overlay, "ledger.tsv")
        self.assertDenied(self.edit("Edit", {"file_path": target, "old_string": "a", "new_string": "b"}), "C-isolation")

    def test_bash_denied_whenRedirectWritesIntoLiveKeel(self):
        self.assertDenied(self.guard("echo x > %s/notes.md" % self.live), "C-isolation")

    def test_bash_denied_whenRedirectIntoLiveKeelUsesAnExportedVariable(self):
        self.assertDenied(self.guard("export L=%s; echo x > $L/notes.md" % self.live), "C-isolation")

    def test_bash_passes_whenRedirectTargetNamesAVariableTheHookCannotResolve(self):
        self.assertPassed(self.guard("echo x > $KEEL_TEST_UNSET/notes.md", cwd=self.live))

    def test_bash_denied_whenGitMovesStateInsideLiveKeel(self):
        for command in ("git -C %s checkout -b topic2" % self.live, "git -C %s pull" % self.live,
                        "git -C %s merge --ff-only topic" % self.live):
            with self.subTest(command=command):
                self.assertDenied(self.guard(command), "C-isolation")
        self.assertDenied(self.guard("git reset --hard HEAD~1", cwd=self.live), "C-isolation")

    def test_bash_denied_whenGitRewritesTheLiveCheckoutByAnyMovingSubcommand(self):
        for subcommand in ("cherry-pick HEAD", "revert HEAD", "am < /tmp/p.mbox", "apply /tmp/p.diff",
                           "restore --source=HEAD~1 README.md", "rm README.md", "mv README.md R.md", "add ."):
            with self.subTest(subcommand=subcommand):
                self.assertDenied(self.guard("git -C %s %s" % (self.live, subcommand)), "C-isolation")

    def test_bash_passes_whenWorktreeAddTargetsAWorktreeBesideLiveKeel(self):
        self.assertPassed(self.guard("git -C %s worktree add ../keel-wt/t2 -b t2" % self.live))

    def test_bash_passes_whenGitOnlyReadsOrFetchesInsideLiveKeel(self):
        self.assertPassed(self.guard("git -C %s fetch origin && git -C %s status" % (self.live, self.live)))

    def test_bash_passes_whenGitMovesStateInsideAWorktree(self):
        self.assertPassed(self.guard("git checkout -b topic3", cwd=self.worktree))


class KnownValuesTest(GitGuardTestCase):
    """Overlay-listed secret values must not reach any written file or commit; hits name keys, never values."""

    def setUp(self):
        super().setUp()
        config_dir = os.path.join(self.sandbox.home, ".config", "acmecorp")
        self.sandbox.write(os.path.join(config_dir, "prod.env"),
                           "DB_HOST=db.internal.example\nDB_PASSWORD=%s\nPIN=12345\nexport API_SECRET=\"s3cr3t-value\"\n" % PASSWORD)
        self.sandbox.write(os.path.join(self.sandbox.overlay, "git-guard", "known-values.tsv"),
                           "source\tpattern\nfile\t%s/*.env\nenv\tACME_API_TOKEN\n" % config_dir)
        self.sandbox.env["ACME_API_TOKEN"] = TOKEN
        self.repo = self.sandbox.make_repo("example", "app")

    def test_write_deniedWithFSecrets_whenContentHoldsAConfigPassword(self):
        # when
        result = self.edit("Write", {"file_path": os.path.join(self.repo, "report.md"), "content": "Rotate it:\npassword was %s\n" % PASSWORD})
        # then: the hit names file:line and key; the value is nowhere in the message or the log
        self.assertDenied(result, "F-secrets")
        self.assertIn("report.md:2 holds the value of DB_PASSWORD (prod.env)", result.stderr)
        self.assertNotIn(PASSWORD, result.stderr)
        self.assertNotIn(PASSWORD, json.dumps(self.sandbox.fires()))
        self.assertFired("F-secrets", "deny", "git-guard")

    def test_edit_denied_whenNewStringHoldsAnEnvironmentSecret(self):
        result = self.edit("Edit", {"file_path": os.path.join(self.repo, "a.py"), "old_string": "x", "new_string": "TOKEN = '%s'" % TOKEN})
        self.assertDenied(result, "F-secrets")
        self.assertIn("holds the value of ACME_API_TOKEN (env)", result.stderr)
        self.assertNotIn(TOKEN, result.stderr)

    def test_edit_denied_whenExportedQuotedSecretIsWritten(self):
        result = self.edit("Write", {"file_path": os.path.join(self.repo, "a.py"), "content": "s3cr3t-value"})
        self.assertDenied(result, "F-secrets")
        self.assertIn("API_SECRET", result.stderr)

    def test_write_passes_whenContentHoldsANonSecretValueOrAShortOne(self):
        self.assertPassed(self.edit("Write", {"file_path": os.path.join(self.repo, "a.py"), "content": "host = 'db.internal.example'\npin = 12345\n"}))

    def test_commit_denied_whenStagedLineHoldsAKnownValue(self):
        self.sandbox.write(os.path.join(self.repo, "conf.py"), "x = 1\nPASS = '%s'\n" % PASSWORD)
        self.sandbox.git(self.repo, "add", "conf.py")
        result = self.guard("git commit -m 'Add conf'", cwd=self.repo)
        self.assertDenied(result, "F-secrets")
        self.assertIn("conf.py:2 holds the value of DB_PASSWORD", result.stderr)
        self.assertNotIn(PASSWORD, result.stderr)

    def test_commit_passes_whenStagedLinesAreClean(self):
        self.sandbox.write(os.path.join(self.repo, "conf.py"), "x = 1\n")
        self.sandbox.git(self.repo, "add", "conf.py")
        self.assertPassed(self.guard("git commit -m 'Add conf'", cwd=self.repo))


class KeelCommandTest(GitGuardTestCase):
    def test_bash_deniedWithK1_whenKeelApprove(self):
        result = self.guard("keel approve rv-20261011T085500Z-7f3e21")
        self.assertDenied(result, "K1")
        self.assertFired("K1", "deny", "git-guard")

    def test_bash_denied_whenKeelApproveByDataDirPath(self):
        self.assertDenied(self.guard('"${KEEL_DATA_DIR:-$HOME/.claude}/bin/keel" approve rv-1 --read'), "K1")

    def test_bash_denied_whenKeelApproveRunsThroughAnInterpreterOrXargs(self):
        self.assertDenied(self.guard("python3 -I /x/bin/keel approve rv-1"), "K1")
        self.assertDenied(self.guard("bash /x/bin/keel approve rv-1"), "K1")
        self.assertDenied(self.guard("echo rv-1 | xargs keel approve"), "K1")

    def test_bash_denied_whenEvidenceWriteReviewFedByPipe(self):
        self.assertDenied(self.guard("echo '{}' | keel evidence write-review"), "K1")

    def test_bash_denied_whenKeelApproveInsideBashDashC(self):
        self.assertDenied(self.guard("bash -c 'keel approve rv-1'"), "K1")

    def test_bash_passes_whenKeelEvidenceShow(self):
        self.assertPassed(self.guard("keel evidence show --repo ."))


class AttributionTest(GitGuardTestCase):
    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")

    def test_commit_deniedWithFAttribution_whenMessageHasAiTrailer(self):
        result = self.guard('git commit -m "Fix parser" -m "%s"' % ATTRIBUTION_TRAILER, cwd=self.repo)
        self.assertDenied(result, "F-attribution")
        self.assertBulletIdsSeeded(result.stderr)
        self.assertFired("F-attribution", "deny", "git-guard")

    def test_commit_denied_whenTrailerInHeredocSubstitution(self):
        command = "git commit -m \"$(cat <<'EOF'\nFix parser, don't skip\n\n%s\nEOF\n)\"" % ATTRIBUTION_TRAILER
        self.assertDenied(self.guard(command, cwd=self.repo), "F-attribution")

    def test_commit_denied_whenMessageFileHasTrailer(self):
        self.sandbox.write(os.path.join(self.repo, "msg.txt"), "Fix\n\n%s\n" % ATTRIBUTION_TRAILER)
        self.assertDenied(self.guard("git commit -F msg.txt", cwd=self.repo), "F-attribution")

    def test_commit_denied_whenMessageFilePathUsesAVariableTheHookKnows(self):
        # given a message file in a temp dir the hook's own TMPDIR names
        scratch = os.path.join(self.sandbox.root, "scratch")
        self.sandbox.write(os.path.join(scratch, "msg.txt"), "Fix\n\n%s\n" % ATTRIBUTION_TRAILER)
        self.sandbox.env["TMPDIR"] = scratch
        for command in ("git commit -F $TMPDIR/msg.txt", "git commit -F ${TMPDIR}/msg.txt",
                        "export M=%s; git commit -F $M/msg.txt" % scratch, "M=%s; git commit -F $M/msg.txt" % scratch):
            with self.subTest(command=command):
                # when / then the file is read, as for its literal path
                self.assertDenied(self.guard(command, cwd=self.repo), "F-attribution")

    def test_commit_denied_whenStdinHeredocHasRobot(self):
        self.assertDenied(self.guard("git commit -F - <<'EOF'\nFix %s\nEOF" % ROBOT, cwd=self.repo), "F-attribution")

    def test_commit_denied_whenHeredocWrittenToFileThenCommittedInSameCall(self):
        # given a message file that only exists once the call runs
        command = "cat > msg.txt <<'EOF'\nFix parser\n\n%s\nEOF\ngit commit -F msg.txt" % ATTRIBUTION_TRAILER
        # when / then
        self.assertDenied(self.guard(command, cwd=self.repo), "F-attribution")

    def test_commit_denied_whenFilePathIsAttachedToFileFlag(self):
        self.sandbox.write(os.path.join(self.repo, "msg.txt"), "Fix\n\n%s\n" % ATTRIBUTION_TRAILER)
        self.assertDenied(self.guard("git commit -Fmsg.txt", cwd=self.repo), "F-attribution")

    def test_commit_denied_whenMessageFlagClusteredAfterSignoff(self):
        self.assertDenied(self.guard('git commit -sm "Fix parser. %s"' % ATTRIBUTION_TRAILER, cwd=self.repo), "F-attribution")

    def test_commit_passes_whenClusteredMessageIsClean(self):
        self.assertPassed(self.guard('git commit -sm "Fix parser edge case"', cwd=self.repo))

    def test_commit_passes_whenHeredocInSameCallIsClean(self):
        command = "cat > msg.txt <<'EOF'\nFix parser edge case\nEOF\ngit commit -F msg.txt"
        self.assertPassed(self.guard(command, cwd=self.repo))

    def test_commit_passes_whenMessageIsClean(self):
        self.assertPassed(self.guard('git commit -m "Fix parser edge case"', cwd=self.repo))

    def test_grep_passes_whenSearchingForTrailerText(self):
        self.assertPassed(self.guard('git log --format=%%B | grep -c "%s"' % ATTRIBUTION_TRAILER, cwd=self.repo))

    def test_prCreate_denied_whenBodyHasRobot(self):
        self.assertDenied(self.guard('gh pr create --title "Fix" --body "Done %s"' % ROBOT, cwd=self.repo), "F-attribution")

    def test_prCreate_denied_whenBodyFileIsWrittenByHeredocInSameCall(self):
        # given a body file that only exists once the call runs
        command = "cat > b.md <<'EOF'\nSummary\n\n%s\nEOF\ngh pr create --title t --body-file b.md" % ATTRIBUTION_TRAILER
        # when / then
        self.assertDenied(self.guard(command, cwd=self.repo), "F-attribution")

    def test_prEdit_denied_whenBodyHasTrailer(self):
        self.assertDenied(self.guard("gh pr edit 3 --body '%s'" % ATTRIBUTION_TRAILER, cwd=self.repo), "F-attribution")

    def test_prMerge_denied_whenBodyHasTrailer(self):
        self.assertDenied(self.guard("gh pr merge 7 --squash --body '%s'" % ATTRIBUTION_TRAILER, cwd=self.repo), "F-attribution")

    def test_prMerge_denied_whenSubjectHasRobot(self):
        self.assertDenied(self.guard("gh pr merge 7 --squash --subject 'Merge %s'" % ROBOT, cwd=self.repo), "F-attribution")

    def test_prMerge_denied_whenBodyFileHasTrailer(self):
        self.sandbox.write(os.path.join(self.repo, "merge.md"), "Merge\n\n%s\n" % ATTRIBUTION_TRAILER)
        self.assertDenied(self.guard("gh pr merge 7 --squash -F merge.md", cwd=self.repo), "F-attribution")

    def test_prMerge_passes_whenSubjectAndBodyAreClean(self):
        command = "gh pr merge 7 --squash --match-head-commit abc123 --subject 'Merge feature' --body 'Adds the parser'"
        self.assertPassed(self.guard(command, cwd=self.repo))

    def test_prCreate_denied_whenRepoFlagPrecedesTheSubcommand(self):
        command = "gh -R acme/app pr create --title t --body '%s'" % ATTRIBUTION_TRAILER
        self.assertDenied(self.guard(command, cwd=self.repo), "F-attribution")

    def test_prMerge_denied_whenRepoFlagSitsBetweenPrAndMerge(self):
        command = "gh pr --repo acme/app merge 7 --squash --body '%s'" % ATTRIBUTION_TRAILER
        self.assertDenied(self.guard(command, cwd=self.repo), "F-attribution")

    def test_push_denied_whenDashCNamesTheRepoThroughAnExportedVariable(self):
        # given an attributed commit in a repo the call reaches only through a variable
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a\n\n%s" % ATTRIBUTION_TRAILER)
        # when
        result = self.guard("export R=%s; git -C $R push origin main" % self.repo)
        # then
        self.assertDenied(result, "F-attribution")

    def test_push_denied_whenDashCNamesTheRepoThroughAPlainShellVariable(self):
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a\n\n%s" % ATTRIBUTION_TRAILER)
        self.assertDenied(self.guard('R=%s; git -C "$R" push origin main' % self.repo), "F-attribution")

    def test_prCreate_passes_whenOnlyAChainedGrepNamesTheTrailer(self):
        command = 'gh pr create --title t --body clean && gh pr view --json body | grep -c "%s"' % ATTRIBUTION_TRAILER
        self.assertPassed(self.guard(command, cwd=self.repo))

    def test_prView_passes_whenPipedIntoGrepForTrailer(self):
        self.assertPassed(self.guard('gh pr view 3 --json body | grep "%s"' % ATTRIBUTION_TRAILER, cwd=self.repo))

    def test_push_denied_whenRangeHasAttributedCommit(self):
        # given
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a\n\n%s" % ATTRIBUTION_TRAILER)
        # when
        result = self.guard("git push", cwd=self.repo)
        # then
        self.assertDenied(result, "F-attribution")

    def test_push_passes_whenRangeIsClean(self):
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a")
        self.assertPassed(self.guard("git push origin main", cwd=self.repo))


class PushRangeWithoutUpstreamTest(GitGuardTestCase):
    """A branch's first push has no upstream; the range is what the remote does not have yet."""

    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")
        self.assertNotIn("refs/remotes/origin/HEAD", self.sandbox.git(self.repo, "for-each-ref", "--format=%(refname)"))
        self.sandbox.git(self.repo, "checkout", "-q", "-b", "feat")

    def publish_attributed_commit_on_main(self):
        self.sandbox.git(self.repo, "checkout", "-q", "main")
        self.sandbox.commit_file(self.repo, "old.txt", "old\n", "Old\n\n%s" % ATTRIBUTION_TRAILER)
        self.sandbox.git(self.repo, "push", "-q", "origin", "main")
        self.sandbox.git(self.repo, "checkout", "-q", "-b", "feat2")

    def test_push_denied_whenNewBranchHasAttributedCommit(self):
        # given a new branch, no upstream and no origin/HEAD
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a\n\n%s" % ATTRIBUTION_TRAILER)
        # when
        result = self.guard("git push -u origin feat", cwd=self.repo)
        # then
        self.assertDenied(result, "F-attribution")

    def test_push_passes_whenNewBranchIsClean(self):
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a")
        self.assertPassed(self.guard("git push -u origin feat", cwd=self.repo))

    def test_push_passes_whenOnlyCommitsAlreadyOnRemoteAreAttributed(self):
        # given an attributed commit the remote already holds
        self.publish_attributed_commit_on_main()
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a")
        # when / then: only the new commit is in range
        self.assertPassed(self.guard("git push -u origin feat2", cwd=self.repo))

    def test_push_skipsCommitsAlreadyOnARemote_whenRemoteIsGivenAsUrl(self):
        # given a remote named by URL, so no tracking refs belong to it
        self.publish_attributed_commit_on_main()
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a")
        url = self.sandbox.git(self.repo, "remote", "get-url", "origin")
        # when / then: origin/main holds the old attributed commit, so it is out of the range
        self.assertPassed(self.guard("git push %s feat2" % url, cwd=self.repo))

    def test_push_denied_whenUrlPushCarriesNewAttributedCommit(self):
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a\n\n%s" % ATTRIBUTION_TRAILER)
        url = self.sandbox.git(self.repo, "remote", "get-url", "origin")
        self.assertDenied(self.guard("git push %s feat" % url, cwd=self.repo), "F-attribution")

    def test_push_scansWholeHistory_whenNoRemoteRefResolves(self):
        # given no remote-tracking refs at all
        self.sandbox.commit_file(self.repo, "a.txt", "a\n", "Add a\n\n%s" % ATTRIBUTION_TRAILER)
        self.sandbox.git(self.repo, "update-ref", "-d", "refs/remotes/origin/main")
        # when / then
        self.assertDenied(self.guard("git push -u origin feat", cwd=self.repo), "F-attribution")


class WholeRepoPushTest(GitGuardTestCase):
    """`git push --all|--branches|--mirror` sends every local branch, so every branch's unpushed range is scanned."""

    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")
        self.sandbox.git(self.repo, "checkout", "-q", "-b", "other")

    def other_branch_commit(self, message: str) -> None:
        self.sandbox.commit_file(self.repo, "other.txt", "other\n", message)
        self.sandbox.git(self.repo, "checkout", "-q", "main")

    def test_wholeRepoPush_denied_whenANonHeadBranchCarriesAttribution(self):
        # given HEAD on a clean main and the attribution on branch `other`
        self.other_branch_commit("Add other\n\n%s" % ATTRIBUTION_TRAILER)
        for command in ("git push --all origin", "git push origin --all", "git push --branches origin",
                        "git push --mirror origin"):
            with self.subTest(command=command):
                # when / then
                self.assertDenied(self.guard(command, cwd=self.repo), "F-attribution")

    def test_wholeRepoPush_passes_whenEveryBranchIsClean(self):
        self.other_branch_commit("Add other")
        self.assertPassed(self.guard("git push --all origin", cwd=self.repo))

    def test_branchPush_passes_whenOnlyAnotherBranchCarriesAttribution(self):
        self.other_branch_commit("Add other\n\n%s" % ATTRIBUTION_TRAILER)
        self.assertPassed(self.guard("git push origin main", cwd=self.repo))


class SecretsTest(GitGuardTestCase):
    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")

    def test_commit_deniedWithFSecrets_whenBoundaryReportsHits(self):
        hits = {"scanned": 3, "hits": [{"file": "conf.env", "line": 2, "rule": "aws-key"}]}
        self.sandbox.env["KEEL_BOUNDARY"] = self.sandbox.stub("boundary-hit", stdout=json.dumps(hits), exit_code=1)
        result = self.guard('git commit -m "Add config"', cwd=self.repo)
        self.assertDenied(result, "F-secrets")
        self.assertIn("conf.env:2 (aws-key)", result.stderr)
        self.assertEqual(["--staged", "--generic-only"], self.sandbox.stub_calls("boundary-hit")[0]["argv"])

    def test_commit_deniedFailClosed_whenBoundaryErrors(self):
        self.sandbox.env["KEEL_BOUNDARY"] = self.sandbox.stub("boundary-broken", exit_code=2)
        result = self.guard('git commit -m "Add config"', cwd=self.repo)
        self.assertEqual(2, result.code)
        self.assertIn("internal error", result.stderr)
        self.assertFired("F-attribution", "error", "git-guard")

    def test_commit_deniedFailClosed_whenBoundaryMissing(self):
        self.sandbox.env["KEEL_BOUNDARY"] = os.path.join(self.sandbox.root, "no-such-scanner")
        self.assertEqual(2, self.guard('git commit -m "Add config"', cwd=self.repo).code)


class SubprocessTimeoutTest(GitGuardTestCase):
    """Claude Code blocks the call when it kills git-guard at its registered timeout; each subprocess ends before that."""

    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")

    def slow_script(self, name: str, body: str) -> str:
        path = self.sandbox.write(os.path.join(self.sandbox.root, "slow", name), "#!/bin/bash\n" + body)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        return path

    def test_subprocessTimeouts_stayBelowTheRegisteredTimeout(self):
        # given the timeout settings/core.json registers for git-guard
        registered = registered_timeout("git-guard/git-guard.py")
        # then the boundary scan and every git call are cut off before Claude Code would kill the hook
        self.assertLess(load_git_guard().BOUNDARY_TIMEOUT_SECONDS + DECISION_MARGIN_SECONDS, registered)
        self.assertLess(GIT_TIMEOUT_SECONDS + DECISION_MARGIN_SECONDS, registered)

    def test_boundaryScan_raisesGuardError_whenTheScannerOutlastsItsTimeout(self):
        # given a scanner that runs past a shortened scan timeout
        guard = load_git_guard()
        scanner = self.slow_script("boundary", "sleep 30; echo '{}'\n")
        with mock.patch.object(guard, "BOUNDARY_TIMEOUT_SECONDS", 0.5), mock.patch.dict(os.environ, {"KEEL_BOUNDARY": scanner}):
            # when / then: the guard error is what main() turns into a fail-closed deny
            with self.assertRaises(guard.GuardError):
                guard.scan_staged_secrets(self.repo, None)


class SameCallStagingTest(GitGuardTestCase):
    """The index is read before the call runs, so staging inside the commit's own call hides files."""

    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")
        self.sandbox.write(os.path.join(self.repo, "s.txt"), "SECRET\n")

    def assertDeniedForSameCallStaging(self, result):
        self.assertDenied(result, "F-secrets")
        self.assertIn("stage in a separate call, then commit", result.stderr)

    def test_commit_deniedWithFSecrets_whenAddChainedBeforeIt(self):
        # given an unstaged file and a scanner that sees nothing staged yet
        # when the agent stages and commits in one call
        result = self.guard("git add s.txt && git commit -m wip", cwd=self.repo)
        # then the commit is refused instead of committing unscanned content
        self.assertDeniedForSameCallStaging(result)

    def test_commit_denied_whenAddAllChainedBeforeIt(self):
        self.assertDeniedForSameCallStaging(self.guard("git add -A && git commit -m wip", cwd=self.repo))

    def test_commit_denied_whenAddChainedAfterCdIntoRepo(self):
        result = self.guard("cd %s; git add s.txt; git commit -m wip" % self.repo)
        self.assertDeniedForSameCallStaging(result)

    def test_commit_denied_whenAPlainShellVariableNamesTheRepoForAddAndCommit(self):
        result = self.guard('R=%s; git -C "$R" add s.txt && git -C "$R" commit -m wip' % self.repo)
        self.assertDeniedForSameCallStaging(result)

    def test_commit_passes_whenRmChainedBeforeIt(self):
        self.assertPassed(self.guard("cd %s; git rm -q README.txt; git commit -m wip" % self.repo))

    def test_commit_denied_whenAllFlagClusteredWithMessage(self):
        self.assertDeniedForSameCallStaging(self.guard("git commit -am wip", cwd=self.repo))

    def test_commit_denied_whenLongAllFlag(self):
        self.assertDeniedForSameCallStaging(self.guard("git commit --all -m wip", cwd=self.repo))

    def test_commit_denied_whenPathspecOperand(self):
        self.assertDeniedForSameCallStaging(self.guard("git commit -m wip -- s.txt", cwd=self.repo))

    def test_commit_denied_whenIncludeWithPathspec(self):
        self.assertDeniedForSameCallStaging(self.guard("git commit -i s.txt -m wip", cwd=self.repo))

    def test_commit_passes_whenMessageValueIsAttachedToFlag(self):
        # given `-ma`: the `a` is the message, not --all
        self.assertPassed(self.guard("git commit -ma", cwd=self.repo))

    def test_commit_passes_whenFilesWereStagedInEarlierCall(self):
        self.sandbox.git(self.repo, "add", "s.txt")
        self.assertPassed(self.guard('git commit -m "Add s" --author "A <a@example.invalid>"', cwd=self.repo))

    def test_commit_passes_whenAddRunsAfterCommit(self):
        self.assertPassed(self.guard("git commit --amend --no-edit && git add s.txt", cwd=self.repo))

    def test_commit_passes_whenEarlierAddIsInAnotherRepo(self):
        other = self.sandbox.make_repo("example", "other")
        self.sandbox.write(os.path.join(other, "o.txt"), "o\n")
        self.assertPassed(self.guard("git -C %s add o.txt && git commit -m wip" % other, cwd=self.repo))


class ForcePushTest(GitGuardTestCase):
    def setUp(self):
        super().setUp()
        self.repo = self.sandbox.make_repo("example", "app")

    def test_push_deniedWithFForcePush_whenForceFlag(self):
        result = self.guard("git push --force origin feature", cwd=self.repo)
        self.assertDenied(result, "F-force-push")
        self.assertFired("F-force-push", "deny", "git-guard")

    def test_push_denied_whenShortFlagCombined(self):
        self.assertDenied(self.guard("git push -fu origin feature", cwd=self.repo), "F-force-push")

    def test_push_denied_whenGitsOwnDashedPushProgramForces(self):
        self.assertDenied(self.guard("/usr/libexec/git-core/git-push --force origin feature", cwd=self.repo), "F-force-push")

    def test_push_deniedWithFForcePush_whenSudoCarriesAnOptionTheParserDoesNotRead(self):
        for command in ("sudo -i git push --force origin feature", "sudo -nE git push --force origin feature",
                        "sudo --login git push --force origin feature", "sudo -nE bash -c 'git push --force origin feature'"):
            with self.subTest(command=command):
                self.assertDenied(self.guard(command, cwd=self.repo), "F-force-push")

    def test_push_deniedWithFForcePush_whenAWrapperCarriesALoneDash(self):
        for command in ("sudo - git push --force origin feature", "exec - git push --force origin feature"):
            with self.subTest(command=command):
                self.assertDenied(self.guard(command, cwd=self.repo), "F-force-push")

    def test_push_deniedWithFForcePush_whenExecNamesGitsPushProgramAsArgv0(self):
        for command in ("exec -a git-push git push --force origin feature", "exec -a \"$A\" git push --force origin feature"):
            with self.subTest(command=command):
                self.assertDenied(self.guard(command, cwd=self.repo), "F-force-push")

    def test_push_deniedWithFForcePush_whenEnvSplitsItOrMovesIt(self):
        for command in ("env -S'git push --force origin feature'", "env -C /tmp git push --force origin feature"):
            with self.subTest(command=command):
                self.assertDenied(self.guard(command, cwd=self.repo), "F-force-push")

    def test_push_denied_whenPlusRefspec(self):
        self.assertDenied(self.guard("git push origin +feature", cwd=self.repo), "F-force-push")

    def test_push_passes_whenLeaseOntoFeatureBranch(self):
        self.assertPassed(self.guard("git push --force-with-lease origin feature", cwd=self.repo))

    def test_push_denied_whenLeaseOntoMain(self):
        self.assertDenied(self.guard("git push --force-with-lease origin HEAD:main", cwd=self.repo), "F-force-push")

    def test_push_denied_whenLeaseOntoRegisteredIntegrationBase(self):
        self.sandbox.write(os.path.join(self.sandbox.overlay, "gated-repos.tsv"),
                           "origin\tgate\tintegration_base\trisk_rules\ttests\nexample/app\tcode\tdevelop\t-\trequired\n")
        self.assertDenied(self.guard("git push --force-with-lease origin develop", cwd=self.repo), "F-force-push")

    def test_push_denied_whenLeaseOntoIntegrationBaseOfARegistryWithPushApproval(self):
        self.sandbox.write(os.path.join(self.sandbox.overlay, "gated-repos.tsv"),
                           "origin\tgate\tintegration_base\trisk_rules\ttests\tpush_approval\nexample/app\tcode\tdevelop\t-\trequired\ttrue\n")
        self.assertDenied(self.guard("git push --force-with-lease origin develop", cwd=self.repo), "F-force-push")

    def test_push_passes_whenDeletingRemoteBranch(self):
        self.assertPassed(self.guard("git push origin --delete old-feature", cwd=self.repo))


class RepoRulesTest(GitGuardTestCase):
    def setUp(self):
        super().setUp()
        self.sandbox.use_example_overlay("git-guard/repo-rules.tsv")

    def test_commit_deniedWithRowId_whenRepoForbidsCommits(self):
        repo = self.sandbox.make_repo("acmecorp", "platform-root")
        result = self.guard('git commit -m "Bump"', cwd=repo)
        self.assertDenied(result, "O-parent")
        self.assertBulletIdsSeeded(result.stderr, overlay_ids={"O-parent"})
        self.assertFired("O-parent", "deny", "git-guard")

    def test_commit_denied_whenStagedPathMatchesRule(self):
        repo = self.sandbox.make_repo("acmecorp", "storefront")
        self.sandbox.write(os.path.join(repo, "db", "patch.sql"), "select 1;\n")
        self.sandbox.git(repo, "add", "db/patch.sql")
        result = self.guard('git commit -m "Add patch"', cwd=repo)
        self.assertDenied(result, "O-files")
        self.assertIn("db/patch.sql", result.stderr)

    def test_commit_denied_whenMatchingPathIsAddedInSameCall(self):
        repo = self.sandbox.make_repo("acmecorp", "storefront")
        self.sandbox.write(os.path.join(repo, "a.sql"), "select 1;\n")
        result = self.guard("git add a.sql && git commit -m wip", cwd=repo)
        self.assertDenied(result, "F-secrets")
        self.assertIn("stage in a separate call, then commit", result.stderr)

    def test_commit_denied_whenTrackedMatchingPathIsCommittedWithAllFlag(self):
        repo = self.sandbox.make_repo("acmecorp", "storefront")
        self.sandbox.commit_file(repo, "a.sql", "select 1;\n", "Add a")
        self.sandbox.write(os.path.join(repo, "a.sql"), "select 2;\n")
        self.assertDenied(self.guard("git commit -am wip", cwd=repo), "F-secrets")

    def test_commit_passes_whenStagedPathDoesNotMatch(self):
        repo = self.sandbox.make_repo("acmecorp", "storefront")
        self.sandbox.write(os.path.join(repo, "src", "a.py"), "x = 1\n")
        self.sandbox.git(repo, "add", "src/a.py")
        self.assertPassed(self.guard('git commit -m "Add a"', cwd=repo))

    def test_push_denied_whenRangeCarriesMatchingPath(self):
        repo = self.sandbox.make_repo("acmecorp", "storefront")
        self.sandbox.commit_file(repo, "db/patch.sql", "select 1;\n", "Add patch")
        self.assertDenied(self.guard("git push", cwd=repo), "O-files")

    def test_push_denied_whenNewBranchWithoutUpstreamCarriesMatchingPath(self):
        repo = self.sandbox.make_repo("acmecorp", "storefront")
        self.sandbox.git(repo, "checkout", "-q", "-b", "feat")
        self.sandbox.commit_file(repo, "db/patch.sql", "select 1;\n", "Add patch")
        self.assertDenied(self.guard("git push -u origin feat", cwd=repo), "O-files")

    def test_commit_passes_whenRepoOutsideRuleGlob(self):
        repo = self.sandbox.make_repo("example", "other")
        self.sandbox.write(os.path.join(repo, "x.sql"), "select 1;\n")
        self.sandbox.git(repo, "add", "x.sql")
        self.assertPassed(self.guard('git commit -m "Add x"', cwd=repo))

    def test_commit_deniedFailClosed_whenRepoRulesHeaderIsWrong(self):
        self.sandbox.write(os.path.join(self.sandbox.overlay, "git-guard", "repo-rules.tsv"), "origin\taction\n")
        repo = self.sandbox.make_repo("acmecorp", "storefront")
        result = self.guard('git commit -m "Add a"', cwd=repo)
        self.assertEqual(2, result.code)
        self.assertFired("F-attribution", "error", "git-guard")


class FailClosedTest(GitGuardTestCase):
    def test_guard_denies_whenPayloadUnparseableAndLooksLikePush(self):
        result = self.sandbox.run_hook(GIT_GUARD, raw='{"tool_input": {"command": "git push"')
        self.assertEqual(2, result.code)
        self.assertEqual(ASK_USER, result.stderr.rstrip("\n").splitlines()[-1])

    def test_guard_denies_whenPayloadUnparseableAndLooksLikeAHookSkip(self):
        self.assertEqual(2, self.sandbox.run_hook(GIT_GUARD, raw='{"tool_input": {"command": "git commit --no-verify"').code)

    def test_guard_denies_whenPayloadUnparseableAndLooksLikeAPrMerge(self):
        for command in ("gh pr merge 7 --body x", "gh -R acme/app pr merge 7"):
            with self.subTest(command=command):
                self.assertEqual(2, self.sandbox.run_hook(GIT_GUARD, raw='{"tool_input": {"command": "%s"' % command).code)

    def test_guard_passes_whenPayloadUnparseableAndHarmless(self):
        self.assertEqual(0, self.sandbox.run_hook(GIT_GUARD, raw='{"tool_input": {"command": "ls -la"').code)

    def test_guard_denies_whenPayloadUnparseableAndLooksLikeKeelApprove(self):
        self.assertEqual(2, self.sandbox.run_hook(GIT_GUARD, raw='{"tool_input": {"command": "/x/bin/keel approve rv-1"').code)

    def test_guard_passes_whenPayloadUnparseableAndOnlyNamesAKeelPath(self):
        self.assertEqual(0, self.sandbox.run_hook(GIT_GUARD, raw='{"tool_input": {"command": "ls ~/git/keel-wt/core"').code)

    def test_guard_passesWithoutFire_whenCommandIsNotADecisionPoint(self):
        self.assertPassed(self.guard("ls -la && echo done"))
        self.assertEqual([], self.sandbox.fires())


if __name__ == "__main__":
    unittest.main()
