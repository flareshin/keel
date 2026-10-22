import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import * as contract from "../../hooks/lib/hookkit/contract.ts";
import * as knownvalues from "../../hooks/lib/hookkit/knownvalues.ts";
import { OverlayDataError, readTsv } from "../../hooks/lib/hookkit/overlay.ts";
import * as protocol from "../../hooks/lib/hookkit/protocol.ts";
import { normalizeRepoKey } from "../../hooks/lib/hookkit/repo.ts";
import {
  commandWritesFiles, configKey, ghSubcommandArgv, gitDirectory, gitSubcommandIndex, isConfigRead, parseCommands,
  readPushArguments, steps, unwrap, writeTargets,
} from "../../hooks/lib/hookkit/shell.ts";
import { Sandbox, withEnv } from "./helpers.ts";

function argvs(text: string): string[][] {
  return parseCommands(text).map((command) => command.argv);
}

function stepViews(text: string, cwd = "/work") {
  return steps(text, cwd).map((step) => ({ argv: step.argv, directory: step.directory, environment: Object.fromEntries(step.environment) }));
}

function directoriesOf(views: ReturnType<typeof stepViews>, argv: string[], prefixLength = argv.length): string[] {
  return views.filter((view) => view.argv.slice(0, prefixLength).join("\0") === argv.join("\0")).map((view) => view.directory);
}

describe("StepsTest", () => {
  it("steps_followCdPushdAndPopd_acrossChains", () => {
    const views = stepViews("cd /a && git push; pushd /b; git status; popd; git log");
    const gitDirectories = views.filter((view) => view.argv[0] === "git").map((view) => view.directory);
    assert.deepEqual(gitDirectories, ["/a", "/b", "/a"]);
  });

  it("steps_startNestedScriptWhereItsCommandStands", () => {
    const views = stepViews("cd /inner && bash -c 'cd sub && git push origin x'");
    assert.equal(directoriesOf(views, ["git", "push"])[0], "/inner/sub");
  });

  it("steps_keepOuterDirectory_afterANestedCd", () => {
    const views = stepViews("bash -c 'cd /elsewhere'; git status");
    assert.equal(directoriesOf(views, ["git", "status"])[0], "/work");
  });

  it("steps_expandWithTheLastAssignment_whetherPlainOrExported", () => {
    const later = steps("export D=/a; D=/b; X=/c; export X; echo $D $X", "/w").at(-1);
    assert.ok(later);
    assert.deepEqual([later.expansion.get("D"), later.expansion.get("X")], ["/b", "/c"]);
    assert.deepEqual([later.environment.get("D"), later.environment.get("X")], ["/b", "/c"]);
  });

  it("steps_keepPlainVariables_outOfTheChildEnvironment", () => {
    const later = steps("D=/a; echo $D", "/w").at(-1);
    assert.ok(later);
    assert.deepEqual([later.expansion.get("D"), later.environment.get("D")], ["/a", undefined]);
  });

  it("steps_giveExportedAndPrefixVariables_toLaterAndNestedCommands", () => {
    const views = stepViews("export A=1; B=2 gh pr merge 7; env C=3 bash -c 'gh pr merge 8'");
    const merges = views.filter((view) => view.argv.slice(0, 3).join(" ") === "gh pr merge").map((view) => view.environment);
    assert.deepEqual(merges, [{ A: "1", B: "2" }, { A: "1", C: "3" }]);
  });

  it("steps_dropInheritedVariables_whenSudoClearsTheEnvironment", () => {
    const views = stepViews("export A=1; sudo git push");
    assert.deepEqual(views.filter((view) => view.argv.slice(0, 2).join(" ") === "git push").map((view) => view.environment)[0], {});
  });

  it("steps_readHereString_asACodeStringForAShell", () => {
    assert.ok(stepViews("bash <<< 'git push origin x'").some((view) => view.argv.join(" ") === "git push origin x"));
  });

  it("steps_leaveHereString_asDataForANonShell", () => {
    assert.ok(!stepViews("cat <<< 'git push origin x'").some((view) => view.argv.join(" ") === "git push origin x"));
  });

  it("steps_followCd_intoAnExportedVariable", () => {
    const views = stepViews("export APP=/x/app; cd $APP && git status");
    assert.equal(directoriesOf(views, ["git", "status"])[0], "/x/app");
  });
});

describe("GitDirectoryTest", () => {
  it("gitDirectory_spellsOutHomeForms_whenDashCNamesThem", () => {
    withEnv({ HOME: "/home/u" }, () => {
      for (const target of ["$HOME/app", "${HOME}/app", "~/app"]) {
        assert.equal(gitDirectory(["git", "-C", target, "push"], "/work", new Map()), "/home/u/app", target);
      }
    });
  });

  it("gitDirectory_takesAVariable_fromTheStepEnvironment", () => {
    assert.equal(gitDirectory(["git", "-C", "$APP", "push"], "/work", new Map([["APP", "/x/app"]])), "/x/app");
  });

  it("gitDirectory_keepsAnUnknownVariable_asWritten", () => {
    withEnv({}, () => {
      assert.equal(gitDirectory(["git", "-C", "$NOPE/app", "push"], "/work", new Map()), "/work/$NOPE/app");
    }, { clear: true });
  });

  it("gitDirectory_followsEveryDashC_beforeTheSubcommandOnly", () => {
    const argv = ["git", "-C", "/a", "-c", "x=y", "-C", "b", "log", "-C", "z"];
    assert.equal(gitDirectory(argv, "/work", new Map()), "/a/b");
  });
});

describe("GitSubcommandIndexTest", () => {
  it("gitSubcommandIndex_skipsTheValueOfEachGlobalOption_whateverItsSpelling", () => {
    for (const argv of [["git", "-c", "a.b=c", "push"], ["git", "--config-env", "a.b=V", "push"],
                        ["git", "--config-env=a.b=V", "push"], ["git", "-C", "/x", "push"]]) {
      assert.equal(gitSubcommandIndex(argv), argv.length - 1, argv.join(" "));
    }
  });

  it("gitSubcommandIndex_isNone_whenOnlyGlobalOptionsAreGiven", () => {
    assert.equal(gitSubcommandIndex(["git", "--config-env", "a.b=V"]), null);
  });
});

describe("GhSubcommandArgvTest", () => {
  it("ghSubcommandArgv_putsPrMergeFirst_whereverTheRepoFlagStands", () => {
    const spellings = [["gh", "-R", "o/r", "pr", "merge", "7"], ["gh", "pr", "-R", "o/r", "merge", "7"],
                       ["gh", "--repo", "o/r", "pr", "merge", "7"], ["gh", "pr", "--repo=o/r", "merge", "7"],
                       ["gh", "-Ro/r", "pr", "merge", "7"], ["gh", "pr", "-R=o/r", "merge", "7"]];
    const movedRepoFlags = [["-R", "o/r"], ["--repo", "o/r"], ["--repo=o/r"], ["-Ro/r"], ["-R=o/r"]];
    for (const argv of spellings) {
      const normalized = ghSubcommandArgv(argv);
      assert.deepEqual(normalized.slice(0, 4), ["gh", "pr", "merge", "7"], argv.join(" "));
      assert.ok(movedRepoFlags.some((flag) => flag.join("\0") === normalized.slice(4).join("\0")), argv.join(" "));
    }
  });

  it("ghSubcommandArgv_keepsTheArgv_whenTheRepoFlagFollowsTheSubcommand", () => {
    const argv = ["gh", "pr", "merge", "7", "-R", "o/r"];
    assert.deepEqual(ghSubcommandArgv(argv), argv);
  });
});

describe("ReadPushArgumentsTest", () => {
  it("readPushArguments_splitsRemoteRefspecsAndOptions", () => {
    const pushed = readPushArguments(["-u", "--force-with-lease=main", "-o", "ci.skip", "upstream", "+a:b", "--", "-odd"]);
    assert.deepEqual([pushed.remote, pushed.refspecs], ["upstream", ["+a:b", "-odd"]]);
    assert.deepEqual([pushed.longOptions, pushed.shortFlags], [["--force-with-lease=main"], "u"]);
    assert.equal(pushed.wholeRepo, false);
  });

  it("readPushArguments_hasNoRemote_whenOnlyOptionsAreGiven", () => {
    const pushed = readPushArguments(["-u", "--dry-run"]);
    assert.deepEqual([pushed.remote, pushed.refspecs], [null, []]);
  });

  it("readPushArguments_takesTheRepoOption_asTheRemote_whenNoRemoteWordFollows", () => {
    for (const args of [["--repo=upstream"], ["--repo", "upstream"]]) {
      const pushed = readPushArguments(args);
      assert.deepEqual([pushed.remote, pushed.refspecs, pushed.longOptions], ["upstream", [], []], args.join(" "));
    }
  });

  it("readPushArguments_takesTheRemoteWord_overTheRepoOption", () => {
    for (const args of [["--repo=upstream", "origin", "feature"], ["--repo", "upstream", "origin", "feature"]]) {
      const pushed = readPushArguments(args);
      assert.deepEqual([pushed.remote, pushed.refspecs], ["origin", ["feature"]], args.join(" "));
    }
  });

  it("readPushArguments_readsAnAttachedPushOptionValue_asTheValueNotAsFlags", () => {
    const cases: Array<[string[], string]> = [
      [["-odeploy", "origin", "feature"], ""], [["-uodeploy", "origin", "feature"], "u"], [["-uo", "deploy", "origin", "feature"], "u"],
    ];
    for (const [args, flags] of cases) {
      const pushed = readPushArguments(args);
      assert.deepEqual([pushed.remote, pushed.refspecs, pushed.shortFlags], ["origin", ["feature"], flags], args.join(" "));
    }
  });

  it("readPushArguments_marksWholeRepo_forAllBranchesAndMirror", () => {
    for (const option of ["--all", "--branches", "--mirror"]) {
      assert.equal(readPushArguments([option, "origin"]).wholeRepo, true, option);
    }
  });
});

describe("GitConfigCallTest", () => {
  it("isConfigRead_isTrue_forEveryReadSpelling", () => {
    for (const args of [["user.email"], ["--global", "user.email"], ["get", "user.email"], ["list"], ["-l"],
                        ["--get", "remote.pushDefault"], ["--get-regexp", "^remote\\."], ["--show-origin", "user.email"],
                        ["--file", ".git/config", "remote.pushDefault"], ["--type", "bool", "push.autoSetupRemote"], []]) {
      assert.equal(isConfigRead(args), true, JSON.stringify(args));
    }
  });

  it("isConfigRead_isFalse_forEveryWriteSpelling", () => {
    for (const args of [["user.email", "bot@example.invalid"], ["set", "remote.pushDefault", "upstream"],
                        ["--unset", "branch.feature.pushRemote"], ["unset", "branch.feature.pushRemote"],
                        ["--unset-all", "remote.origin.pushurl"], ["--remove-section", "remote.origin"],
                        ["remove-section", "remote.origin"], ["--rename-section", "remote.origin", "remote.fork"],
                        ["--add", "remote.origin.pushurl", "x"], ["--replace-all", "remote.origin.pushurl", "x"],
                        ["--edit"], ["-e"], ["edit"], ["--file", ".git/config", "remote.pushDefault", "upstream"]]) {
      assert.equal(isConfigRead(args), false, JSON.stringify(args));
    }
  });

  it("configKey_skipsOptionValuesAndALeadingSubcommand", () => {
    const cases: Array<[string[], string]> = [
      [["--file", ".git/config", "remote.pushDefault", "upstream"], "remote.pushDefault"],
      [["--type", "bool", "push.autoSetupRemote", "true"], "push.autoSetupRemote"],
      [["set", "--comment", "why", "remote.pushDefault", "upstream"], "remote.pushDefault"],
      [["unset", "branch.feature.pushRemote"], "branch.feature.pushRemote"],
      [["--unset", "branch.feature.pushRemote"], "branch.feature.pushRemote"],
      [["--file=.git/config", "remote.pushDefault", "upstream"], "remote.pushDefault"],
      [["user.email", "bot@example.invalid"], "user.email"],
    ];
    for (const [args, key] of cases) assert.equal(configKey(args), key, JSON.stringify(args));
  });

  it("configKey_isNone_whenTheCallNamesNoKey", () => {
    for (const args of [["--edit"], ["edit"], ["--unset"], ["--file", ".git/config"], []]) {
      assert.equal(configKey(args), null, JSON.stringify(args));
    }
  });
});

describe("ParseCommandsTest", () => {
  it("parseCommands_splitsChainsAndPipelines_whenSeparatorsUsed", () => {
    assert.deepEqual(argvs("cd /x && git push; echo a || echo b | tail -1"),
                     [["cd", "/x"], ["git", "push"], ["echo", "a"], ["echo", "b"], ["tail", "-1"]]);
  });

  it("parseCommands_keepsQuotedSeparators_whenInsideQuotes", () => {
    assert.deepEqual(argvs("echo 'a; b' \"c && d\""), [["echo", "a; b", "c && d"]]);
  });

  it("parseCommands_recordsPrefixAssignments_whenBeforeCommandWord", () => {
    const command = parseCommands("JAVA_HOME=$(/usr/libexec/java_home -v 17) mvn test")[0];
    assert.deepEqual(command?.assignments, [["JAVA_HOME", "$(/usr/libexec/java_home -v 17)"]]);
    assert.deepEqual(command?.argv, ["mvn", "test"]);
  });

  it("parseCommands_treatsQuotedNameAsWord_whenEqualsSignIsQuoted", () => {
    assert.deepEqual(parseCommands("echo 'A=1'")[0]?.assignments, []);
  });

  it("parseCommands_parsesSubstitutionBody_asNestedCommand", () => {
    const nested = parseCommands("echo $(keel approve r1)").filter((command) => command.nested).map((command) => command.argv);
    assert.deepEqual(nested, [["keel", "approve", "r1"]]);
  });

  it("parseCommands_keepsHeredocBodyAsData_whenFedToNonShell", () => {
    const commands = parseCommands("cat > out.txt <<'EOF'\nkeel approve r1 > x\nEOF\necho done");
    assert.deepEqual(commands.map((command) => command.argv), [["cat"], ["echo", "done"]]);
    assert.deepEqual(commands[0]?.heredocs, ["keel approve r1 > x"]);
  });

  it("parseCommands_parsesHeredocBody_whenPipedIntoShell", () => {
    const commands = parseCommands("cat <<EOF | bash\nkeel approve r1\nEOF");
    assert.deepEqual(commands.filter((command) => command.nested).map((command) => command.argv), [["keel", "approve", "r1"]]);
  });

  it("parseCommands_parsesCodeString_whenBashDashC", () => {
    const commands = parseCommands("bash -lc 'rm -rf /tmp/x'");
    assert.deepEqual(commands.filter((command) => command.nested).map((command) => command.argv), [["rm", "-rf", "/tmp/x"]]);
  });

  it("parseCommands_readsHeredocInsideSubstitution_whenBodyHasApostrophe", () => {
    const commands = parseCommands("git commit -m \"$(cat <<'EOF'\nDon't stop\nEOF\n)\" && echo ok");
    assert.deepEqual(commands.filter((command) => !command.nested).map((command) => command.argv).at(-1), ["echo", "ok"]);
  });

  it("parseCommands_dropsComment_whenHashStartsWord", () => {
    assert.deepEqual(argvs("ls # > not-a-redirect"), [["ls"]]);
  });

  it("parseCommands_ignoresFdNumber_whenRedirectFollows", () => {
    const command = parseCommands("mvn test 2>&1")[0];
    assert.deepEqual(command?.argv, ["mvn", "test"]);
    assert.deepEqual(command?.redirects, [{ op: ">&", target: "1" }]);
  });
});

describe("UnwrapTest", () => {
  const unwrapped = (command: string) => unwrap(parseCommands(command)[0]!);

  it("unwrap_stripsWrappersAndKeepsEnvAssignments_whenChained", () => {
    const invocation = unwrapped("timeout -k 5 60 nohup env X=1 mvn test");
    assert.deepEqual(invocation.argv, ["mvn", "test"]);
    assert.deepEqual(invocation.assignments, [["X", "1"]]);
    assert.equal(invocation.dropsInherited("JAVA_HOME"), false);
  });

  it("unwrap_skipsLongOptionValues_whenTimeoutSpellsThemApart", () => {
    for (const command of ["timeout --signal TERM 60 mvn test", "gtimeout --kill-after 5 60 mvn test"]) {
      assert.deepEqual(unwrapped(command).argv, ["mvn", "test"], command);
    }
  });

  it("unwrap_marksInheritedDropped_whenEnvIgnoresEnvironment", () => {
    assert.equal(unwrapped("env -i PATH=/bin mvn test").dropsInherited("JAVA_HOME"), true);
  });

  it("unwrap_marksVariableRemoved_whenEnvUnsetsIt", () => {
    assert.equal(unwrapped("env -u JAVA_HOME mvn test").dropsInherited("JAVA_HOME"), true);
  });

  it("unwrap_leavesLookup_whenCommandDashV", () => {
    assert.deepEqual(unwrapped("command -v mvn").argv, ["command", "-v", "mvn"]);
  });

  it("unwrap_readsPastAnOptionItDoesNotRead_andRecordsIt", () => {
    const cases: Array<[string, string[], string[]]> = [
      ["sudo -i git push", ["git", "push"], ["-i"]],
      ["sudo --chdir /tmp git push", ["git", "push"], ["--chdir"]],
      ["sudo -D /tmp git push", ["git", "push"], ["-D"]],
      ["sudo -R /srv git push", ["git", "push"], ["-R"]],
      ["sudo -iu bob git push", ["git", "push"], ["-iu"]],
      ["sudo -nD /tmp git push", ["git", "push"], ["-nD"]],
      ["sudo -Zu bob git push", ["git", "push"], ["-Zu"]],
      ["sudo -ni git push", ["git", "push"], ["-ni"]],
      ["sudo -Zn git push", ["git", "push"], ["-Zn"]],
      ["exec -la git-push git origin x", ["git", "origin", "x"], ["-a"]],
      ["env --chdir=/x A=1 git push", ["git", "push"], ["--chdir=/x"]],
      ["timeout --bogus 5 git push", ["git", "push"], ["--bogus"]],
      ["nice --bogus git push", ["git", "push"], ["--bogus"]],
      ["nohup --bogus git push", ["git", "push"], ["--bogus"]],
      ["time -v git push", ["git", "push"], ["-v"]],
      ["sudo - git push", ["git", "push"], ["-"]],
      ["sudo --chdir=/tmp git push", ["git", "push"], ["--chdir=/tmp"]],
      ["exec -a $A git origin x", ["git", "origin", "x"], ["-a"]],
      ["exec -agit-push git origin x", ["git", "origin", "x"], ["-a"]],
      ["exec -a git-merge /usr/bin/git x", ["/usr/bin/git", "x"], ["-a"]],
      ["exec -a git-push sh -c x", ["sh", "-c", "x"], ["-a"]],
      ["timeout --bogus=5 30 git push", ["git", "push"], ["--bogus=5"]],
      ["exec - git push", ["git", "push"], ["-"]],
      ["sudo -i env -S x git push", ["x", "git", "push"], ["-i", "-S"]],
    ];
    for (const [command, argv, unread] of cases) {
      const invocation = unwrapped(command);
      assert.deepEqual([invocation.argv, invocation.unattributableOptions], [argv, unread], command);
    }
  });

  it("unwrap_marksADirectoryMove_onlyForTheWrappersOwnMovingOption", () => {
    const cases: Array<[string, boolean]> = [
      ["sudo -i git push", true], ["sudo -nD/tmp git push", true], ["sudo --chroot=/srv git push", true],
      ["sudo -D /tmp git push", true], ["sudo -ni git push", true], ["sudo --chdir /tmp git push", true],
      ["sudo -R /srv git push", true], ["env --chdir=/x git push", true], ["env -iC/tmp git push", true],
      ["sudo -nC3 git push", false], ["sudo -nuDavid git push", false], ["env -iv git push", false],
      ["sudo -nE git push", false], ["env -P/opt/homebrew/Cellar/x git push", false], ["env -S-C/tmp git push", true],
      ["env --split-string='-C /tmp' git push", true], ["env -S'--chdir=/tmp' git push", true],
      ["env -SX=1 git push", true], ["env -S'A=1 -C /x' git push", true], ["env --split-string=X=1 git push", true],
      ["timeout --bogus 5 git push", false],
    ];
    for (const [command, moves] of cases) assert.equal(unwrapped(command).movesDirectory, moves, command);
  });

  it("steps_carryTheOptionsTheParserReadPast", () => {
    const [sudo, git] = steps("sudo -i git push; git status", "/work");
    assert.deepEqual([sudo?.unattributableOptions, git?.unattributableOptions], [["-i"], []]);
  });

  it("steps_leaveTheRunnersOptionsOffItsScriptsAndSubstitutions", () => {
    for (const [command, recorded] of [["sudo -D /tmp sh -c 'git push'", ["-D"]], ["sudo -i echo $(git push)", ["-i"]]] as const) {
      const [runner, inner] = steps(command, "/work");
      assert.deepEqual([runner?.unattributableOptions, inner?.unattributableOptions], [recorded, []], command);
    }
  });

  it("steps_dropTheExportedEnvironment_onlyWhenExecClearsIt", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["export A=1; exec -c git push", {}], ["export A=1; exec -cl git push", {}], ["export A=1; exec -a -c -c git push", {}],
      ["export A=1; exec -l git push", { A: "1" }], ["export A=1; exec -a -c git push", { A: "1" }],
    ];
    for (const [command, environment] of cases) {
      assert.deepEqual(Object.fromEntries(steps(command, "/work")[1]!.environment), environment, command);
    }
  });

  it("unwrap_readsTheOptionsItKnows_beforeTheCommand", () => {
    for (const command of ["sudo -E -u bob git push", "sudo --user=bob -- git push", "nice -n 5 git push",
                           "nice -5 git push", "exec -a name git push", "timeout --preserve-status -s TERM 30s git push",
                           "env -i -u HOME A=1 git push", "env -- git push", "command -p git push", "time -p git push",
                           "sudo -uroot git push", "sudo --preserve-env=PATH git push", "timeout -sKILL -k5 30 git push",
                           "exec -aname git push", "nice -n5 git push", "sudo -nE git push", "sudo -Hu bob git push",
                           "sudo -Eu root git push", "sudo -nuroot git push", "exec -la x git push", "exec -cl git push",
                           "timeout -vs KILL 5 git push"]) {
      const invocation = unwrapped(command);
      assert.deepEqual([invocation.argv, invocation.unattributableOptions], [["git", "push"], []], command);
    }
  });

  it("unwrap_readsGitsOwnDashedProgram_asGitAndItsSubcommand", () => {
    const cases: Array<[string, string[]]> = [
      ["/usr/libexec/git-core/git-push origin x", ["git", "push", "origin", "x"]],
      ["timeout 5 git-commit --no-verify -m m", ["git", "commit", "--no-verify", "-m", "m"]],
      ["./git-merge-base main HEAD", ["git", "merge-base", "main", "HEAD"]],
    ];
    for (const [command, argv] of cases) assert.deepEqual(unwrapped(command).argv, argv, command);
  });

  it("unwrap_leavesDashedProgram_whenItsPathIsResolvedAtRunTime", () => {
    for (const command of ["$CORE/git-push origin x", "\"$(git --exec-path)\"/git-push origin x"]) {
      assert.deepEqual(unwrapped(command).argv, parseCommands(command)[0]?.argv, command);
    }
  });
});

describe("WriteTargetsTest", () => {
  const targetsOf = (command: string) => writeTargets(parseCommands(command)[0]!);

  it("writeTargets_namesRedirectTarget_whenNotDevNull", () => {
    assert.deepEqual(targetsOf("echo x > a.txt 2>/dev/null").written, ["a.txt"]);
  });

  it("writeTargets_namesDestinationAndSources_whenMove", () => {
    const targets = targetsOf("mv a b dest/");
    assert.deepEqual(targets.written, ["dest/", "dest/a", "dest/b"]);
    assert.deepEqual(targets.removed, ["a", "b"]);
  });

  it("writeTargets_namesTheFile_whenAWrapperCarriesAnOptionTheParserDoesNotRead", () => {
    assert.deepEqual(targetsOf("sudo -nE tee /live/x.txt").written, ["/live/x.txt"]);
    assert.ok(targetsOf("sudo -i sed -i s/a/b/ /live/README.md").written.includes("/live/README.md"));
  });

  it("writeTargets_namesSources_whenCopy", () => {
    const targets = targetsOf("cp -r a b dest/");
    assert.deepEqual([targets.written, targets.sources, targets.removed], [["dest/", "dest/a", "dest/b"], ["a", "b"], []]);
    assert.deepEqual(targetsOf("cp -t dest a b").sources, ["a", "b"]);
  });

  it("writeTargets_namesTheLandedFile_whenTheDestinationIsADirectory", () => {
    assert.ok(targetsOf("cp stage/settings.json dest").written.includes("dest/settings.json"));
    assert.ok(targetsOf("cp -t dest stage/settings.json").written.includes("dest/settings.json"));
    assert.deepEqual(targetsOf("echo x > a.txt").sources, []);
  });

  it("writeTargets_namesFiles_whenTeeAppends", () => {
    assert.deepEqual(targetsOf("tee -a log.txt").written, ["log.txt"]);
  });

  it("writeTargets_namesFiles_whenSedInPlace", () => {
    assert.ok(targetsOf("sed -i '' s/a/b/ f.txt").written.includes("f.txt"));
  });

  it("writeTargets_namesTheFile_whenBsdSedEditsInPlaceWithCapitalI", () => {
    assert.ok(targetsOf("sed -I .bak -e s/a/b/ f").written.includes("f"));
    assert.deepEqual(targetsOf("sed -I '' 's#a#b#' f").written, ["f"]);
  });

  it("writeTargets_isEmpty_whenPerlTakesAnIncludePathWithCapitalI", () => {
    assert.equal(targetsOf("perl -I lib -ne 'print' f").any(), false);
  });

  it("writeTargets_namesOnlyTheFile_whenSedTakesItsScriptAsTheFirstOperand", () => {
    assert.deepEqual(targetsOf("sed -i '' 's#^files=.*#files=x#' /tmp/notes.txt").written, ["/tmp/notes.txt"]);
    assert.deepEqual(targetsOf("sed -i s/a/b/ f.txt").written, ["f.txt"]);
  });

  it("writeTargets_namesEveryOperand_whenSedTakesItsScriptFromAnOption", () => {
    assert.deepEqual(targetsOf("sed -i -e s/a/b/ a.txt b.txt").written, ["a.txt", "b.txt"]);
    assert.deepEqual(targetsOf("sed -i -f prog.sed a.txt").written, ["a.txt"]);
    assert.deepEqual(targetsOf("sed -i --expression=s/a/b/ a.txt").written, ["a.txt"]);
    assert.deepEqual(targetsOf("sed -i --file=prog.sed a.txt").written, ["a.txt"]);
  });

  it("writeTargets_namesEveryOperand_whenSedAbbreviatesTheLongScriptOption", () => {
    assert.deepEqual(targetsOf("sed -i --e=s/a/b/ a.txt").written, ["a.txt"]);
    assert.deepEqual(targetsOf("sed -i --expr=s/a/b/ a.txt").written, ["a.txt"]);
    assert.deepEqual(targetsOf("sed -i --fi=prog.sed a.txt").written, ["a.txt"]);
  });

  it("writeTargets_namesOnlyTheFile_whenSedLongOptionsCarryNoScript", () => {
    const targets = targetsOf("sed --in-place --follow-symlinks 's#^files=.*#x#' cfg.txt");
    assert.deepEqual(targets.written, ["cfg.txt"]);
  });

  it("writeTargets_namesEveryOperand_whenAShortClusterCarriesTheScriptAttached", () => {
    assert.deepEqual(targetsOf("sed -i -es/a/b/ a.txt").written, ["a.txt"]);
    assert.deepEqual(targetsOf("sed -i -nes/a/b/p a.txt").written, ["a.txt"]);
  });

  it("writeTargets_keepsTheScriptOperandAsAFile_whenAShortClusterMayCarryTheScriptOption", () => {
    assert.deepEqual(targetsOf("sed -i -ne s/a/b/p a.txt").written, ["s/a/b/p", "a.txt"]);
  });

  it("writeTargets_isEmpty_whenSedPrintsOnly", () => {
    assert.equal(targetsOf("sed -n 1p f.txt").any(), false);
  });

  it("writeTargets_marksUnknown_whenGitApply", () => {
    assert.equal(targetsOf("git apply p.diff").unknown, true);
  });

  it("commandWritesFiles_isFalse_whenReadOnlyPipeline", () => {
    assert.equal(commandWritesFiles("grep -c x f | wc -l > /dev/null"), false);
  });

  it("commandWritesFiles_isTrue_whenInlinePythonWrite", () => {
    assert.equal(commandWritesFiles("python3 - <<'EOF'\nopen('x', 'w').write('1')\nEOF"), true);
  });

  it("commandWritesFiles_ignoresWritesUnderExemptPrefixes", () => {
    assert.equal(commandWritesFiles("echo x > /tmp/notes.txt && rm /tmp/old.txt", ["/tmp/"]), false);
    assert.equal(commandWritesFiles("echo x > /tmp/a && echo y > notes.txt", ["/tmp/"]), true);
    assert.equal(commandWritesFiles("git apply p.diff", ["/tmp/"]), true);
    assert.equal(commandWritesFiles("python3 - <<'EOF'\nopen('x', 'w')\nEOF", ["/tmp/"]), true);
  });
});

describe("ProtocolMessageTest", () => {
  it("formatMessage_startsWithFirstId_andEndsWithNextStep", () => {
    const message = protocol.formatMessage("git-guard", "blocked", [["F-secrets", "a"], ["K1", "b"]], protocol.runYourself("git push"));
    assert.deepEqual(message.split("\n"),
                     ["[F-secrets] git-guard: blocked", "- [F-secrets] a", "- [K1] b", "Run it yourself in your terminal: git push"]);
  });

  it("formatMessage_endsWithAskUser_whenNoCommandGiven", () => {
    assert.equal(protocol.formatMessage("h", "s", [["K1", "x"]]).split("\n").at(-1), "Stop and ask the user.");
  });

  it("formatWarning_hasNoNextStep", () => {
    assert.deepEqual(protocol.formatWarning("ship-gate", "stale", [["K1", "x"]]).split("\n"), ["[K1] ship-gate: stale", "- [K1] x"]);
  });

  it("formatMessage_capsLength_andKeepsTheLastLine", () => {
    const message = protocol.formatMessage("h", "s", [["K1", "x".repeat(5000)]], protocol.runYourself("git push origin f"));
    assert.ok(Array.from(message).length <= protocol.MESSAGE_LIMIT);
    assert.ok(message.endsWith("Run it yourself in your terminal: git push origin f"));
  });

  it("listed_truncatesAtTenItems", () => {
    assert.equal(protocol.listed(["a", "b"]), "a, b");
    const shown = protocol.listed(Array.from({ length: 500 }, (_, index) => String(index)));
    assert.ok(shown.endsWith(", …and 490 more"), shown);
  });
});

describe("ContractTest", () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = new Sandbox();
  });
  afterEach(() => sandbox.close());

  it("missingFields_namesAbsentNoneAndEmptyValues", () => {
    const payload = { agent_id: "", tool_input: { message: null }, cwd: "/x" };
    assert.deepEqual(contract.missingFields(payload, "agent_id", "tool_input.message", "cwd", "prompt"), ["agent_id", "tool_input.message", "prompt"]);
  });

  it("missDetail_namesFieldsKeysAndVersion_andCachesTheVersionPerSession", () => {
    const path = sandbox.stubClaude("1.2.3");
    withEnv({ PATH: path, KEEL_DATA_DIR: sandbox.data }, () => {
      const detail = contract.missDetail({ session_id: "s1", cwd: "/x" }, ["prompt"]);
      assert.equal(detail, "contract-miss: missing prompt; keys=cwd,session_id; cc_version=1.2.3");
      unlinkSync(join(sandbox.root, "stubs", "claude"));
      assert.match(contract.missDetail({ session_id: "s1" }, ["prompt"]), /cc_version=1\.2\.3/);
    });
  });

  it("ccVersion_isUnknown_whenClaudeIsNotOnPath", () => {
    withEnv({ PATH: sandbox.root, KEEL_DATA_DIR: sandbox.data }, () => {
      assert.equal(contract.ccVersion("s2"), "unknown");
    });
  });
});

describe("KnownValuesTest", () => {
  let sandbox: Sandbox;
  let table: string;
  beforeEach(() => {
    sandbox = new Sandbox();
    sandbox.write(join(sandbox.home, "app.yml"),
                  "host: db.example\npassword: \"pw-abcdef\"  # rotate\napi_token: short\n'auth.key': key-123456,\n");
    table = sandbox.write(join(sandbox.overlay, "known-values.tsv"), `source\tpattern\nfile\t${sandbox.home}/*.yml\nenv\tKEEL_TEST_SECRET\n`);
  });
  afterEach(() => sandbox.close());

  it("load_takesSecretNamedKeys_ofSixCharactersOrMore", () => {
    const values = withEnv({ KEEL_TEST_SECRET: "env-secret-1" }, () => knownvalues.load(table));
    assert.deepEqual(values.map((known) => [known.value, known.key, known.origin]),
                     [["pw-abcdef", "password", "app.yml"], ["key-123456", "auth.key", "app.yml"], ["env-secret-1", "KEEL_TEST_SECRET", "env"]]);
  });

  it("load_raises_whenSourceIsUnknown", () => {
    const path = sandbox.write(join(sandbox.overlay, "bad.tsv"), "source\tpattern\nurl\thttp://x\n");
    assert.throws(() => knownvalues.load(path), OverlayDataError);
  });

  it("find_namesPathLineAndKey_neverTheValue", () => {
    const values = [{ value: "pw-abcdef", key: "password", origin: "app.yml" }];
    const hits = knownvalues.find(knownvalues.numberedLines("r.md", "ok\nuse pw-abcdef here\n"), values);
    assert.equal(hits[0]?.describe(), "r.md:2 holds the value of password (app.yml)");
  });

  it("addedLines_numberLinesPerHunk_andSkipDeletedFiles", () => {
    const diff = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -3,0 +4,2 @@\n+four\n+five\n@@ -10 +12 @@\n-old\n+twelve\n" +
      "diff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
    assert.deepEqual(Array.from(knownvalues.addedLines(diff)), [["x.py", 4, "four"], ["x.py", 5, "five"], ["x.py", 12, "twelve"]]);
  });
});

describe("RepoKeyTest", () => {
  it("normalizeRepoKey_returnsOwnerRepo_forEachOriginForm", () => {
    for (const url of ["git@example.com:Acme/App.git", "https://example.com/acme/app", "/tmp/remotes/acme/app.git/"]) {
      assert.equal(normalizeRepoKey(url), "acme/app", url);
    }
  });

  it("normalizeRepoKey_returnsNone_whenSingleSegment", () => {
    assert.equal(normalizeRepoKey("app.git"), null);
  });
});

describe("ReadTsvTest", () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = new Sandbox();
  });
  afterEach(() => sandbox.close());

  it("readTsv_returnsRows_whenHeaderMatches", () => {
    const path = sandbox.write(join(sandbox.overlay, "x.tsv"), "# note\n\na\tb\n1\t2\n");
    assert.deepEqual(readTsv(path, ["a", "b"]), [{ a: "1", b: "2" }]);
  });

  it("readTsv_raises_whenHeaderDiffers", () => {
    const path = sandbox.write(join(sandbox.overlay, "x.tsv"), "a\tc\n1\t2\n");
    assert.throws(() => readTsv(path, ["a", "b"]), OverlayDataError);
  });

  it("readTsv_returnsNoRows_whenFileMissing", () => {
    assert.deepEqual(readTsv(join(sandbox.overlay, "absent.tsv"), ["a"]), []);
  });

  it("readTsv_acceptsOptionalTrailingColumns_whenPresentOrAbsent", () => {
    const withColumn = sandbox.write(join(sandbox.overlay, "x.tsv"), "a\tb\tc\n1\t2\t3\n");
    const without = sandbox.write(join(sandbox.overlay, "y.tsv"), "a\tb\n1\t2\n");
    assert.deepEqual(readTsv(withColumn, ["a", "b"], ["c"]), [{ a: "1", b: "2", c: "3" }]);
    assert.deepEqual(readTsv(without, ["a", "b"], ["c"]), [{ a: "1", b: "2" }]);
    assert.throws(() => readTsv(withColumn, ["a", "b"]), OverlayDataError);
  });
});
