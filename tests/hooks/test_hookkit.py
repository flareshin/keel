import os
import unittest
from unittest import mock

import helpers  # noqa: F401 - puts hooks/lib on sys.path
from hookkit import contract, knownvalues, protocol
from hookkit.overlay import OverlayDataError, read_tsv
from hookkit.repo import normalize_repo_key
from hookkit.shell import (command_writes_files, config_key, gh_subcommand_argv, git_directory, git_subcommand_index,
                           is_config_read, parse_commands, read_push_arguments, steps, unwrap, write_targets)


def argvs(text):
    return [command.argv for command in parse_commands(text)]


def step_views(text, cwd="/work"):
    return [(step.argv, step.directory, step.environment) for step in steps(text, cwd)]


class StepsTest(unittest.TestCase):
    def test_steps_followCdPushdAndPopd_acrossChains(self):
        # given / when
        views = step_views("cd /a && git push; pushd /b; git status; popd; git log")
        # then
        git_directories = [directory for argv, directory, _ in views if argv[0] == "git"]
        self.assertEqual(["/a", "/b", "/a"], git_directories)

    def test_steps_startNestedScriptWhereItsCommandStands(self):
        views = step_views("cd /inner && bash -c 'cd sub && git push origin x'")
        self.assertEqual("/inner/sub", [directory for argv, directory, _ in views if argv[:2] == ["git", "push"]][0])

    def test_steps_keepOuterDirectory_afterANestedCd(self):
        views = step_views("bash -c 'cd /elsewhere'; git status")
        self.assertEqual("/work", [directory for argv, directory, _ in views if argv == ["git", "status"]][0])

    def test_steps_expandWithTheLastAssignment_whetherPlainOrExported(self):
        later = steps("export D=/a; D=/b; X=/c; export X; echo $D $X", "/w")[-1]
        self.assertEqual((later.expansion["D"], later.expansion["X"]), ("/b", "/c"))
        self.assertEqual((later.environment["D"], later.environment["X"]), ("/b", "/c"))

    def test_steps_keepPlainVariables_outOfTheChildEnvironment(self):
        later = steps("D=/a; echo $D", "/w")[-1]
        self.assertEqual((later.expansion.get("D"), later.environment.get("D")), ("/a", None))

    def test_steps_giveExportedAndPrefixVariables_toLaterAndNestedCommands(self):
        views = step_views("export A=1; B=2 gh pr merge 7; env C=3 bash -c 'gh pr merge 8'")
        merges = [environment for argv, _, environment in views if argv[:3] == ["gh", "pr", "merge"]]
        self.assertEqual([{"A": "1", "B": "2"}, {"A": "1", "C": "3"}], merges)

    def test_steps_dropInheritedVariables_whenSudoClearsTheEnvironment(self):
        views = step_views("export A=1; sudo git push")
        self.assertEqual({}, [environment for argv, _, environment in views if argv[:2] == ["git", "push"]][0])

    def test_steps_readHereString_asACodeStringForAShell(self):
        self.assertIn(["git", "push", "origin", "x"], [argv for argv, _, _ in step_views("bash <<< 'git push origin x'")])

    def test_steps_leaveHereString_asDataForANonShell(self):
        self.assertNotIn(["git", "push", "origin", "x"], [argv for argv, _, _ in step_views("cat <<< 'git push origin x'")])

    def test_steps_followCd_intoAnExportedVariable(self):
        views = step_views("export APP=/x/app; cd $APP && git status")
        self.assertEqual("/x/app", [directory for argv, directory, _ in views if argv == ["git", "status"]][0])


class GitDirectoryTest(unittest.TestCase):
    def test_gitDirectory_spellsOutHomeForms_whenDashCNamesThem(self):
        # given a home directory the hook process knows
        with mock.patch.dict(os.environ, {"HOME": "/home/u"}):
            for target in ("$HOME/app", "${HOME}/app", "~/app"):
                with self.subTest(target=target):
                    # when / then
                    self.assertEqual("/home/u/app", git_directory(["git", "-C", target, "push"], "/work", {}))

    def test_gitDirectory_takesAVariable_fromTheStepEnvironment(self):
        self.assertEqual("/x/app", git_directory(["git", "-C", "$APP", "push"], "/work", {"APP": "/x/app"}))

    def test_gitDirectory_keepsAnUnknownVariable_asWritten(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual("/work/$NOPE/app", git_directory(["git", "-C", "$NOPE/app", "push"], "/work", {}))

    def test_gitDirectory_followsEveryDashC_beforeTheSubcommandOnly(self):
        self.assertEqual("/a/b", git_directory(["git", "-C", "/a", "-c", "x=y", "-C", "b", "log", "-C", "z"], "/work", {}))


class GitSubcommandIndexTest(unittest.TestCase):
    def test_gitSubcommandIndex_skipsTheValueOfEachGlobalOption_whateverItsSpelling(self):
        for argv in (["git", "-c", "a.b=c", "push"], ["git", "--config-env", "a.b=V", "push"],
                     ["git", "--config-env=a.b=V", "push"], ["git", "-C", "/x", "push"]):
            with self.subTest(argv=argv):
                self.assertEqual(len(argv) - 1, git_subcommand_index(argv))

    def test_gitSubcommandIndex_isNone_whenOnlyGlobalOptionsAreGiven(self):
        self.assertIsNone(git_subcommand_index(["git", "--config-env", "a.b=V"]))


class GhSubcommandArgvTest(unittest.TestCase):
    def test_ghSubcommandArgv_putsPrMergeFirst_whereverTheRepoFlagStands(self):
        for argv in (["gh", "-R", "o/r", "pr", "merge", "7"], ["gh", "pr", "-R", "o/r", "merge", "7"],
                     ["gh", "--repo", "o/r", "pr", "merge", "7"], ["gh", "pr", "--repo=o/r", "merge", "7"],
                     ["gh", "-Ro/r", "pr", "merge", "7"], ["gh", "pr", "-R=o/r", "merge", "7"]):
            with self.subTest(argv=argv):
                normalized = gh_subcommand_argv(argv)
                self.assertEqual(["gh", "pr", "merge", "7"], normalized[:4])
                self.assertIn(normalized[4:], (["-R", "o/r"], ["--repo", "o/r"], ["--repo=o/r"], ["-Ro/r"], ["-R=o/r"]))

    def test_ghSubcommandArgv_keepsTheArgv_whenTheRepoFlagFollowsTheSubcommand(self):
        argv = ["gh", "pr", "merge", "7", "-R", "o/r"]
        self.assertEqual(argv, gh_subcommand_argv(argv))


class ReadPushArgumentsTest(unittest.TestCase):
    def test_readPushArguments_splitsRemoteRefspecsAndOptions(self):
        # when
        pushed = read_push_arguments(["-u", "--force-with-lease=main", "-o", "ci.skip", "upstream", "+a:b", "--", "-odd"])
        # then
        self.assertEqual(("upstream", ["+a:b", "-odd"]), (pushed.remote, pushed.refspecs))
        self.assertEqual((["--force-with-lease=main"], "u"), (pushed.long_options, pushed.short_flags))
        self.assertFalse(pushed.whole_repo)

    def test_readPushArguments_hasNoRemote_whenOnlyOptionsAreGiven(self):
        pushed = read_push_arguments(["-u", "--dry-run"])
        self.assertEqual((None, []), (pushed.remote, pushed.refspecs))

    def test_readPushArguments_takesTheRepoOption_asTheRemote_whenNoRemoteWordFollows(self):
        for args in (["--repo=upstream"], ["--repo", "upstream"]):
            with self.subTest(args=args):
                pushed = read_push_arguments(args)
                self.assertEqual(("upstream", [], []), (pushed.remote, pushed.refspecs, pushed.long_options))

    def test_readPushArguments_takesTheRemoteWord_overTheRepoOption(self):
        for args in (["--repo=upstream", "origin", "feature"], ["--repo", "upstream", "origin", "feature"]):
            with self.subTest(args=args):
                pushed = read_push_arguments(args)
                self.assertEqual(("origin", ["feature"]), (pushed.remote, pushed.refspecs))

    def test_readPushArguments_readsAnAttachedPushOptionValue_asTheValueNotAsFlags(self):
        # given push options whose value is attached to -o, alone or after other short flags
        cases = {("-odeploy", "origin", "feature"): "", ("-uodeploy", "origin", "feature"): "u",
                 ("-uo", "deploy", "origin", "feature"): "u"}
        for args, flags in cases.items():
            with self.subTest(args=args):
                # when
                pushed = read_push_arguments(list(args))
                # then the value's letters (d = delete, f = force) are no flags and the remote is still read
                self.assertEqual(("origin", ["feature"], flags), (pushed.remote, pushed.refspecs, pushed.short_flags))

    def test_readPushArguments_marksWholeRepo_forAllBranchesAndMirror(self):
        for option in ("--all", "--branches", "--mirror"):
            with self.subTest(option=option):
                self.assertTrue(read_push_arguments([option, "origin"]).whole_repo)


class GitConfigCallTest(unittest.TestCase):
    """The words after `git config`: whether the call only reads, and the key it names."""

    def test_isConfigRead_isTrue_forEveryReadSpelling(self):
        for args in (["user.email"], ["--global", "user.email"], ["get", "user.email"], ["list"], ["-l"],
                     ["--get", "remote.pushDefault"], ["--get-regexp", "^remote\\."], ["--show-origin", "user.email"],
                     ["--file", ".git/config", "remote.pushDefault"], ["--type", "bool", "push.autoSetupRemote"], []):
            with self.subTest(args=args):
                self.assertTrue(is_config_read(args))

    def test_isConfigRead_isFalse_forEveryWriteSpelling(self):
        for args in (["user.email", "bot@example.invalid"], ["set", "remote.pushDefault", "upstream"],
                     ["--unset", "branch.feature.pushRemote"], ["unset", "branch.feature.pushRemote"],
                     ["--unset-all", "remote.origin.pushurl"], ["--remove-section", "remote.origin"],
                     ["remove-section", "remote.origin"], ["--rename-section", "remote.origin", "remote.fork"],
                     ["--add", "remote.origin.pushurl", "x"], ["--replace-all", "remote.origin.pushurl", "x"],
                     ["--edit"], ["-e"], ["edit"], ["--file", ".git/config", "remote.pushDefault", "upstream"]):
            with self.subTest(args=args):
                self.assertFalse(is_config_read(args))

    def test_configKey_skipsOptionValuesAndALeadingSubcommand(self):
        cases = [(["--file", ".git/config", "remote.pushDefault", "upstream"], "remote.pushDefault"),
                 (["--type", "bool", "push.autoSetupRemote", "true"], "push.autoSetupRemote"),
                 (["set", "--comment", "why", "remote.pushDefault", "upstream"], "remote.pushDefault"),
                 (["unset", "branch.feature.pushRemote"], "branch.feature.pushRemote"),
                 (["--unset", "branch.feature.pushRemote"], "branch.feature.pushRemote"),
                 (["--file=.git/config", "remote.pushDefault", "upstream"], "remote.pushDefault"),
                 (["user.email", "bot@example.invalid"], "user.email")]
        for args, key in cases:
            with self.subTest(args=args):
                self.assertEqual(key, config_key(args))

    def test_configKey_isNone_whenTheCallNamesNoKey(self):
        for args in (["--edit"], ["edit"], ["--unset"], ["--file", ".git/config"], []):
            with self.subTest(args=args):
                self.assertIsNone(config_key(args))


class ParseCommandsTest(unittest.TestCase):
    def test_parseCommands_splitsChainsAndPipelines_whenSeparatorsUsed(self):
        # given / when
        result = argvs("cd /x && git push; echo a || echo b | tail -1")
        # then
        self.assertEqual([["cd", "/x"], ["git", "push"], ["echo", "a"], ["echo", "b"], ["tail", "-1"]], result)

    def test_parseCommands_keepsQuotedSeparators_whenInsideQuotes(self):
        result = argvs("echo 'a; b' \"c && d\"")
        self.assertEqual([["echo", "a; b", "c && d"]], result)

    def test_parseCommands_recordsPrefixAssignments_whenBeforeCommandWord(self):
        command = parse_commands("JAVA_HOME=$(/usr/libexec/java_home -v 17) mvn test")[0]
        self.assertEqual([("JAVA_HOME", "$(/usr/libexec/java_home -v 17)")], command.assignments)
        self.assertEqual(["mvn", "test"], command.argv)

    def test_parseCommands_treatsQuotedNameAsWord_whenEqualsSignIsQuoted(self):
        command = parse_commands("echo 'A=1'")[0]
        self.assertEqual([], command.assignments)

    def test_parseCommands_parsesSubstitutionBody_asNestedCommand(self):
        commands = parse_commands("echo $(keel approve r1)")
        nested = [command.argv for command in commands if command.nested]
        self.assertEqual([["keel", "approve", "r1"]], nested)

    def test_parseCommands_keepsHeredocBodyAsData_whenFedToNonShell(self):
        commands = parse_commands("cat > out.txt <<'EOF'\nkeel approve r1 > x\nEOF\necho done")
        self.assertEqual([["cat"], ["echo", "done"]], [command.argv for command in commands])
        self.assertEqual(["keel approve r1 > x"], commands[0].heredocs)

    def test_parseCommands_parsesHeredocBody_whenPipedIntoShell(self):
        commands = parse_commands("cat <<EOF | bash\nkeel approve r1\nEOF")
        self.assertIn(["keel", "approve", "r1"], [command.argv for command in commands if command.nested])

    def test_parseCommands_parsesCodeString_whenBashDashC(self):
        commands = parse_commands("bash -lc 'rm -rf /tmp/x'")
        self.assertIn(["rm", "-rf", "/tmp/x"], [command.argv for command in commands if command.nested])

    def test_parseCommands_readsHeredocInsideSubstitution_whenBodyHasApostrophe(self):
        commands = parse_commands("git commit -m \"$(cat <<'EOF'\nDon't stop\nEOF\n)\" && echo ok")
        self.assertEqual(["echo", "ok"], [command.argv for command in commands if not command.nested][-1])

    def test_parseCommands_dropsComment_whenHashStartsWord(self):
        self.assertEqual([["ls"]], argvs("ls # > not-a-redirect"))

    def test_parseCommands_ignoresFdNumber_whenRedirectFollows(self):
        command = parse_commands("mvn test 2>&1")[0]
        self.assertEqual(["mvn", "test"], command.argv)
        self.assertEqual([(">&", "1")], [(redirect.op, redirect.target) for redirect in command.redirects])


class UnwrapTest(unittest.TestCase):
    def test_unwrap_stripsWrappersAndKeepsEnvAssignments_whenChained(self):
        invocation = unwrap(parse_commands("timeout -k 5 60 nohup env X=1 mvn test")[0])
        self.assertEqual(["mvn", "test"], invocation.argv)
        self.assertEqual([("X", "1")], invocation.assignments)
        self.assertFalse(invocation.drops_inherited("JAVA_HOME"))

    def test_unwrap_skipsLongOptionValues_whenTimeoutSpellsThemApart(self):
        for command in ("timeout --signal TERM 60 mvn test", "gtimeout --kill-after 5 60 mvn test"):
            with self.subTest(command=command):
                self.assertEqual(["mvn", "test"], unwrap(parse_commands(command)[0]).argv)

    def test_unwrap_marksInheritedDropped_whenEnvIgnoresEnvironment(self):
        invocation = unwrap(parse_commands("env -i PATH=/bin mvn test")[0])
        self.assertTrue(invocation.drops_inherited("JAVA_HOME"))

    def test_unwrap_marksVariableRemoved_whenEnvUnsetsIt(self):
        invocation = unwrap(parse_commands("env -u JAVA_HOME mvn test")[0])
        self.assertTrue(invocation.drops_inherited("JAVA_HOME"))

    def test_unwrap_leavesLookup_whenCommandDashV(self):
        self.assertEqual(["command", "-v", "mvn"], unwrap(parse_commands("command -v mvn")[0]).argv)

    def test_unwrap_readsPastAnOptionItDoesNotRead_andRecordsIt(self):
        for command, argv, unread in (("sudo -i git push", ["git", "push"], ["-i"]),
                                      ("sudo -nE git push", ["git", "push"], ["-nE"]),
                                      ("sudo --chdir /tmp git push", ["/tmp", "git", "push"], ["--chdir"]),
                                      ("sudo -iu bob git push", ["bob", "git", "push"], ["-iu"]),
                                      ("exec -la foo git push", ["foo", "git", "push"], ["-la"]),
                                      ("env --chdir=/x A=1 git push", ["git", "push"], ["--chdir=/x"]),
                                      ("timeout --bogus 5 git push", ["git", "push"], ["--bogus"]),
                                      ("nice --bogus git push", ["git", "push"], ["--bogus"]),
                                      ("nohup --bogus git push", ["git", "push"], ["--bogus"]),
                                      ("time -v git push", ["git", "push"], ["-v"]),
                                      ("sudo - git push", ["git", "push"], ["-"]),
                                      ("sudo --chdir=/tmp git push", ["git", "push"], ["--chdir=/tmp"]),
                                      ("exec -a $A git origin x", ["git", "origin", "x"], ["-a"]),
                                      ("exec -agit-push git origin x", ["git", "origin", "x"], ["-a"]),
                                      ("exec -a git-merge /usr/bin/git x", ["/usr/bin/git", "x"], ["-a"]),
                                      ("timeout --bogus=5 30 git push", ["git", "push"], ["--bogus=5"]),
                                      ("exec - git push", ["git", "push"], ["-"]),
                                      ("sudo -i env -S x git push", ["x", "git", "push"], ["-i", "-S"])):
            with self.subTest(command=command):
                invocation = unwrap(parse_commands(command)[0])
                self.assertEqual((argv, unread), (invocation.argv, invocation.unattributable_options))

    def test_steps_carryTheOptionsTheParserReadPast(self):
        sudo, git = steps("sudo -i git push; git status", "/work")
        self.assertEqual((["-i"], []), (sudo.unattributable_options, git.unattributable_options))

    def test_steps_dropTheExportedEnvironment_onlyWhenExecClearsIt(self):
        for command, environment in (("export A=1; exec -c git push", {}),
                                     ("export A=1; exec -a -c -c git push", {}),
                                     ("export A=1; exec -l git push", {"A": "1"}),
                                     ("export A=1; exec -a -c git push", {"A": "1"})):
            with self.subTest(command=command):
                self.assertEqual(environment, steps(command, "/work")[1].environment)

    def test_unwrap_readsTheOptionsItKnows_beforeTheCommand(self):
        for command in ("sudo -E -u bob git push", "sudo --user=bob -- git push", "nice -n 5 git push",
                        "nice -5 git push", "exec -a name git push", "timeout --preserve-status -s TERM 30s git push",
                        "env -i -u HOME A=1 git push", "env -- git push", "command -p git push", "time -p git push",
                        "sudo -uroot git push", "sudo --preserve-env=PATH git push", "timeout -sKILL -k5 30 git push",
                        "exec -aname git push", "nice -n5 git push"):
            with self.subTest(command=command):
                invocation = unwrap(parse_commands(command)[0])
                self.assertEqual((["git", "push"], []), (invocation.argv, invocation.unattributable_options))

    def test_unwrap_readsGitsOwnDashedProgram_asGitAndItsSubcommand(self):
        for command, argv in (("/usr/libexec/git-core/git-push origin x", ["git", "push", "origin", "x"]),
                              ("timeout 5 git-commit --no-verify -m m", ["git", "commit", "--no-verify", "-m", "m"]),
                              ("./git-merge-base main HEAD", ["git", "merge-base", "main", "HEAD"])):
            with self.subTest(command=command):
                self.assertEqual(argv, unwrap(parse_commands(command)[0]).argv)

    def test_unwrap_leavesDashedProgram_whenItsPathIsResolvedAtRunTime(self):
        for command in ("$CORE/git-push origin x", "\"$(git --exec-path)\"/git-push origin x"):
            with self.subTest(command=command):
                self.assertEqual(parse_commands(command)[0].argv, unwrap(parse_commands(command)[0]).argv)


class WriteTargetsTest(unittest.TestCase):
    def test_writeTargets_namesRedirectTarget_whenNotDevNull(self):
        targets = write_targets(parse_commands("echo x > a.txt 2>/dev/null")[0])
        self.assertEqual(["a.txt"], targets.written)

    def test_writeTargets_namesDestinationAndSources_whenMove(self):
        targets = write_targets(parse_commands("mv a b dest/")[0])
        self.assertEqual(["dest/", "dest/a", "dest/b"], targets.written)
        self.assertEqual(["a", "b"], targets.removed)

    def test_writeTargets_namesTheFile_whenAWrapperCarriesAnOptionTheParserDoesNotRead(self):
        self.assertEqual(["/live/x.txt"], write_targets(parse_commands("sudo -nE tee /live/x.txt")[0]).written)
        self.assertIn("/live/README.md", write_targets(parse_commands("sudo -i sed -i s/a/b/ /live/README.md")[0]).written)

    def test_writeTargets_namesSources_whenCopy(self):
        targets = write_targets(parse_commands("cp -r a b dest/")[0])
        self.assertEqual((["dest/", "dest/a", "dest/b"], ["a", "b"], []), (targets.written, targets.sources, targets.removed))
        self.assertEqual(["a", "b"], write_targets(parse_commands("cp -t dest a b")[0]).sources)

    def test_writeTargets_namesTheLandedFile_whenTheDestinationIsADirectory(self):
        self.assertIn("dest/settings.json", write_targets(parse_commands("cp stage/settings.json dest")[0]).written)
        self.assertIn("dest/settings.json", write_targets(parse_commands("cp -t dest stage/settings.json")[0]).written)
        self.assertEqual([], write_targets(parse_commands("echo x > a.txt")[0]).sources)

    def test_writeTargets_namesFiles_whenTeeAppends(self):
        self.assertEqual(["log.txt"], write_targets(parse_commands("tee -a log.txt")[0]).written)

    def test_writeTargets_namesFiles_whenSedInPlace(self):
        self.assertIn("f.txt", write_targets(parse_commands("sed -i '' s/a/b/ f.txt")[0]).written)

    def test_writeTargets_isEmpty_whenSedPrintsOnly(self):
        self.assertFalse(write_targets(parse_commands("sed -n 1p f.txt")[0]).any())

    def test_writeTargets_marksUnknown_whenGitApply(self):
        self.assertTrue(write_targets(parse_commands("git apply p.diff")[0]).unknown)

    def test_commandWritesFiles_isFalse_whenReadOnlyPipeline(self):
        self.assertFalse(command_writes_files("grep -c x f | wc -l > /dev/null"))

    def test_commandWritesFiles_isTrue_whenInlinePythonWrite(self):
        self.assertTrue(command_writes_files("python3 - <<'EOF'\nopen('x', 'w').write('1')\nEOF"))

    def test_commandWritesFiles_ignoresWritesUnderExemptPrefixes(self):
        self.assertFalse(command_writes_files("echo x > /tmp/notes.txt && rm /tmp/old.txt", except_under=("/tmp/",)))
        self.assertTrue(command_writes_files("echo x > /tmp/a && echo y > notes.txt", except_under=("/tmp/",)))
        self.assertTrue(command_writes_files("git apply p.diff", except_under=("/tmp/",)))
        self.assertTrue(command_writes_files("python3 - <<'EOF'\nopen('x', 'w')\nEOF", except_under=("/tmp/",)))


class ProtocolMessageTest(unittest.TestCase):
    def test_formatMessage_startsWithFirstId_andEndsWithNextStep(self):
        message = protocol.format_message("git-guard", "blocked", [("F-secrets", "a"), ("K1", "b")], protocol.run_yourself("git push"))
        self.assertEqual(["[F-secrets] git-guard: blocked", "- [F-secrets] a", "- [K1] b", "Run it yourself in your terminal: git push"],
                         message.splitlines())

    def test_formatMessage_endsWithAskUser_whenNoCommandGiven(self):
        self.assertEqual("Stop and ask the user.", protocol.format_message("h", "s", [("K1", "x")]).splitlines()[-1])

    def test_formatWarning_hasNoNextStep(self):
        self.assertEqual(["[K1] ship-gate: stale", "- [K1] x"], protocol.format_warning("ship-gate", "stale", [("K1", "x")]).splitlines())

    def test_formatMessage_capsLength_andKeepsTheLastLine(self):
        message = protocol.format_message("h", "s", [("K1", "x" * 5000)], protocol.run_yourself("git push origin f"))
        self.assertLessEqual(len(message), protocol.MESSAGE_LIMIT)
        self.assertTrue(message.endswith("Run it yourself in your terminal: git push origin f"))

    def test_listed_truncatesAtTenItems(self):
        self.assertEqual("a, b", protocol.listed(["a", "b"]))
        shown = protocol.listed([str(index) for index in range(500)])
        self.assertTrue(shown.endswith(", …and 490 more"), shown)


class ContractTest(helpers.SandboxTestCase):
    def test_missingFields_namesAbsentNoneAndEmptyValues(self):
        payload = {"agent_id": "", "tool_input": {"message": None}, "cwd": "/x"}
        self.assertEqual(["agent_id", "tool_input.message", "prompt"], contract.missing_fields(payload, "agent_id", "tool_input.message", "cwd", "prompt"))

    def test_missDetail_namesFieldsKeysAndVersion_andCachesTheVersionPerSession(self):
        # given a claude stub on PATH
        self.sandbox.stub_claude("1.2.3")
        with mock.patch.dict(os.environ, {"PATH": self.sandbox.env["PATH"], "KEEL_DATA_DIR": self.sandbox.data}):
            # when
            detail = contract.miss_detail({"session_id": "s1", "cwd": "/x"}, ["prompt"])
            # then
            self.assertEqual("contract-miss: missing prompt; keys=cwd,session_id; cc_version=1.2.3", detail)
            os.unlink(os.path.join(self.sandbox.root, "stubs", "claude"))
            self.assertIn("cc_version=1.2.3", contract.miss_detail({"session_id": "s1"}, ["prompt"]))

    def test_ccVersion_isUnknown_whenClaudeIsNotOnPath(self):
        with mock.patch.dict(os.environ, {"PATH": self.sandbox.root, "KEEL_DATA_DIR": self.sandbox.data}):
            self.assertEqual("unknown", contract.cc_version("s2"))


class KnownValuesTest(helpers.SandboxTestCase):
    def setUp(self):
        super().setUp()
        self.config = self.sandbox.write(os.path.join(self.sandbox.home, "app.yml"),
                                         "host: db.example\npassword: \"pw-abcdef\"  # rotate\napi_token: short\n'auth.key': key-123456,\n")
        self.table = self.sandbox.write(os.path.join(self.sandbox.overlay, "known-values.tsv"),
                                        "source\tpattern\nfile\t%s/*.yml\nenv\tKEEL_TEST_SECRET\n" % self.sandbox.home)

    def test_load_takesSecretNamedKeys_ofSixCharactersOrMore(self):
        with mock.patch.dict(os.environ, {"KEEL_TEST_SECRET": "env-secret-1"}):
            values = knownvalues.load(self.table)
        self.assertEqual([("pw-abcdef", "password", "app.yml"), ("key-123456", "auth.key", "app.yml"), ("env-secret-1", "KEEL_TEST_SECRET", "env")],
                         [tuple(value) for value in values])

    def test_load_raises_whenSourceIsUnknown(self):
        path = self.sandbox.write(os.path.join(self.sandbox.overlay, "bad.tsv"), "source\tpattern\nurl\thttp://x\n")
        with self.assertRaises(OverlayDataError):
            knownvalues.load(path)

    def test_find_namesPathLineAndKey_neverTheValue(self):
        values = [knownvalues.KnownValue("pw-abcdef", "password", "app.yml")]
        hits = knownvalues.find(knownvalues.numbered_lines("r.md", "ok\nuse pw-abcdef here\n"), values)
        self.assertEqual("r.md:2 holds the value of password (app.yml)", hits[0].describe())

    def test_addedLines_numberLinesPerHunk_andSkipDeletedFiles(self):
        diff = ("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -3,0 +4,2 @@\n+four\n+five\n@@ -10 +12 @@\n-old\n+twelve\n"
                "diff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n")
        self.assertEqual([("x.py", 4, "four"), ("x.py", 5, "five"), ("x.py", 12, "twelve")], list(knownvalues.added_lines(diff)))


class RepoKeyTest(unittest.TestCase):
    def test_normalizeRepoKey_returnsOwnerRepo_forEachOriginForm(self):
        for url in ("git@example.com:Acme/App.git", "https://example.com/acme/app", "/tmp/remotes/acme/app.git/"):
            self.assertEqual("acme/app", normalize_repo_key(url), url)

    def test_normalizeRepoKey_returnsNone_whenSingleSegment(self):
        self.assertIsNone(normalize_repo_key("app.git"))


class ReadTsvTest(helpers.SandboxTestCase):
    def test_readTsv_returnsRows_whenHeaderMatches(self):
        path = self.sandbox.write(os.path.join(self.sandbox.overlay, "x.tsv"), "# note\n\na\tb\n1\t2\n")
        self.assertEqual([{"a": "1", "b": "2"}], read_tsv(path, ("a", "b")))

    def test_readTsv_raises_whenHeaderDiffers(self):
        path = self.sandbox.write(os.path.join(self.sandbox.overlay, "x.tsv"), "a\tc\n1\t2\n")
        with self.assertRaises(OverlayDataError):
            read_tsv(path, ("a", "b"))

    def test_readTsv_returnsNoRows_whenFileMissing(self):
        self.assertEqual([], read_tsv(os.path.join(self.sandbox.overlay, "absent.tsv"), ("a",)))

    def test_readTsv_acceptsOptionalTrailingColumns_whenPresentOrAbsent(self):
        with_column = self.sandbox.write(os.path.join(self.sandbox.overlay, "x.tsv"), "a\tb\tc\n1\t2\t3\n")
        without = self.sandbox.write(os.path.join(self.sandbox.overlay, "y.tsv"), "a\tb\n1\t2\n")
        self.assertEqual([{"a": "1", "b": "2", "c": "3"}], read_tsv(with_column, ("a", "b"), optional=("c",)))
        self.assertEqual([{"a": "1", "b": "2"}], read_tsv(without, ("a", "b"), optional=("c",)))
        with self.assertRaises(OverlayDataError):
            read_tsv(with_column, ("a", "b"))


if __name__ == "__main__":
    unittest.main()
