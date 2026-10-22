import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import {
  assertBulletIdsSeeded, assertFired, bash, GIT_GUARD, HookSandbox, KEEL_HOME, preToolUse, withEnv,
} from "./helpers.ts";
import type { HookResult } from "./helpers.ts";
import { BOUNDARY_TIMEOUT_SECONDS, GuardError, scanStagedSecrets } from "../../hooks/git-guard/git-guard.ts";
import { GIT_TIMEOUT_SECONDS } from "../../hooks/lib/hookkit/repo.ts";

const ATTRIBUTION_TRAILER = "Co-Authored-By: Claude <noreply@example.invalid>";
const ROBOT = "\u{1F916}";
const CLEAN_SCAN = '{"scanned": 1, "hits": []}';
const SETTINGS_PATH = join(KEEL_HOME, "settings", "core.json");
const DECISION_MARGIN_SECONDS = 0.5;
const RUN_YOURSELF = "Run it yourself in your terminal: ";
const ASK_USER = "Stop and ask the user.";
const PASSWORD = "hunter2".repeat(2);
const TOKEN = "tok-abcdef123456";
const FIRST_LINE = /^\[[A-Za-z0-9-]+\] git-guard: /;

let sandbox: HookSandbox;
let data: string;
let evidenceFile: string;

beforeEach(() => {
  sandbox = new HookSandbox();
  sandbox.env["KEEL_BOUNDARY"] = sandbox.stub("boundary", { stdout: CLEAN_SCAN });
  data = sandbox.data;
  evidenceFile = join(data, "state", "keel", "evidence", "review", "acme__app", "r.json");
});

afterEach(() => {
  sandbox.close();
});

function registeredTimeout(hookScript: string): number {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  for (const entries of Object.values<any[]>(settings.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if ((hook.command ?? "").includes(hookScript)) return Number(hook.timeout);
      }
    }
  }
  throw new Error(`${hookScript} is not registered in ${SETTINGS_PATH}`);
}

function guard(command: string, cwd?: string): HookResult {
  return sandbox.runHook(GIT_GUARD, { payload: bash(command, cwd ?? sandbox.root) });
}

function edit(tool: string, toolArgs: Record<string, unknown>, cwd?: string): HookResult {
  return sandbox.runHook(GIT_GUARD, { payload: preToolUse(tool, toolArgs, cwd ?? sandbox.root) });
}

function lastLine(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines[lines.length - 1] ?? "";
}

function assertDenied(result: HookResult, ruleId: string): void {
  assert.equal(result.code, 2, result.stderr);
  assert.ok(result.stderr.includes(`[${ruleId}]`), result.stderr);
  assert.match(result.stderr.split("\n")[0] ?? "", FIRST_LINE);
  assert.ok(result.stderr.includes(RUN_YOURSELF) || lastLine(result.stderr) === ASK_USER, result.stderr);
}

function assertPassed(result: HookResult): void {
  assert.equal(result.code, 0, result.stderr);
}

function writeSettings(): string {
  return join(sandbox.root, "proj", ".claude", "settings.local.json");
}

describe("ProtectedEditTest", () => {
  it("write_deniedWithK1_whenTargetIsEvidenceFile", () => {
    const result = edit("Write", { file_path: evidenceFile, content: "{}" });
    assertDenied(result, "K1");
    assertBulletIdsSeeded(result.stderr);
    assert.equal(lastLine(result.stderr), ASK_USER);
    assertFired(sandbox, "K1", "deny", "git-guard");
  });

  it("write_denied_whenTheFilePathReachesTheStoreThroughTilde", () => {
    sandbox.env["HOME"] = dirname(data);
    const target = `~/${data.slice(data.lastIndexOf("/") + 1)}/state/keel/x.json`;
    assertDenied(edit("Write", { file_path: target, content: "{}" }), "K1");
  });

  it("notebookEdit_denied_whenNotebookPathIsProtected", () => {
    const target = join(data, "state", "keel", "x.ipynb");
    assertDenied(edit("NotebookEdit", { notebook_path: target, new_source: "" }), "K1");
  });

  it("write_passesWithoutFire_whenTargetIsOrdinaryFile", () => {
    assertPassed(edit("Write", { file_path: join(data, "notes.md"), content: "x" }));
    assert.deepEqual(sandbox.fires(), []);
  });
});

describe("ProtectedBashWriteTest", () => {
  it("bash_denied_whenCopyIntoEvidenceDir", () => {
    assertDenied(guard(`cp /tmp/forged.json ${evidenceFile}`), "K1");
  });

  it("bash_denied_whenRelativeRedirectAfterCdIntoStore", () => {
    assertDenied(guard(`cd ${join(data, "state", "keel")} && echo x > y.json`), "K1");
  });

  it("bash_denied_whenRedirectTargetUsesAnExportedVariable", () => {
    assertDenied(guard(`export S=${join(data, "state")}; echo x > $S/keel/forged.json`), "K1");
  });

  it("bash_denied_whenRedirectTargetUsesAPlainShellVariable", () => {
    assertDenied(guard(`S=${join(data, "state")}; echo x > $S/keel/forged.json`), "K1");
  });

  it("bash_passes_whenOnlyReadingEvidence", () => {
    assertPassed(guard(`grep -c verdict ${evidenceFile} | head -1`));
  });

  it("bash_passes_whenWritingElsewhereWhileNamingStore", () => {
    assertPassed(guard(`ls ${join(data, "state", "keel")} > /tmp/listing.txt`));
  });

  it("bash_endsWithTheCommand_whenDenied", () => {
    const result = guard(`cp /tmp/forged.json ${evidenceFile}`);
    assert.ok(result.stderr.replace(/\n+$/, "").endsWith(`${RUN_YOURSELF}cd ${sandbox.root} && cp /tmp/forged.json ${evidenceFile}`), result.stderr);
  });
});

describe("KeelOwnedFilesTest", () => {
  let settings: string;
  let firesLog: string;

  beforeEach(() => {
    settings = join(data, "settings.json");
    firesLog = join(data, "logs", "keel-fires.jsonl");
  });

  it("write_deniedWithFHookskip_whenTargetIsFiresLog", () => {
    assertDenied(edit("Write", { file_path: firesLog, content: "{}" }), "F-hookskip");
    assertFired(sandbox, "F-hookskip", "deny", "git-guard");
  });

  it("write_passes_whenTargetIsDataDirSettingsWithoutDisableAllHooks", () => {
    assertPassed(edit("Write", { file_path: settings, content: "{}" }));
  });

  it("bash_denied_whenAppendingToFiresLog", () => {
    assertDenied(guard(`echo '{}' >> ${firesLog}`), "F-hookskip");
  });

  it("bash_denied_whenSedEditsFiresLogInPlace", () => {
    assertDenied(guard(`sed -i '' 's/a/b/' ${firesLog}`), "F-hookskip");
  });

  it("bash_denied_whenRemovingFiresLog", () => {
    assertDenied(guard(`rm -f ${firesLog}`), "F-hookskip");
  });

  it("bash_passes_whenReadingSettings", () => {
    assertPassed(guard(`cat ${settings} | jq .hooks`));
  });

  it("write_passes_whenTargetIsAnotherSettingsFileWithoutDisableAllHooks", () => {
    assertPassed(edit("Write", { file_path: writeSettings(), content: '{"permissions": {"allow": ["Bash(ls)"]}}' }));
  });
});

describe("HookSkipTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
  });

  it("commit_deniedWithFHookskip_whenNoVerify", () => {
    const result = guard("git commit --no-verify -m wip", repo);
    assertDenied(result, "F-hookskip");
    assertBulletIdsSeeded(result.stderr);
    assertFired(sandbox, "F-hookskip", "deny", "git-guard");
  });

  it("commit_denied_whenShortNoVerifyFlag", () => {
    assertDenied(guard("git commit -n -m wip", repo), "F-hookskip");
    assertDenied(guard("git commit -qn -m wip", repo), "F-hookskip");
  });

  it("commit_passes_whenNIsAMessageValue", () => {
    assertPassed(guard("git commit -mn", repo));
  });

  it("pushAndMerge_denied_whenNoVerify", () => {
    assertDenied(guard("git push --no-verify origin main", repo), "F-hookskip");
    assertDenied(guard("git merge --no-verify topic", repo), "F-hookskip");
  });

  it("push_passes_whenDashNIsADryRun", () => {
    assertPassed(guard("git push -n origin main", repo));
  });

  it("git_deniedWithFHookskip_whenSudoCarriesAnOptionTheParserDoesNotRead", () => {
    for (const command of ["sudo -i git commit --no-verify -m wip", "sudo -nE git commit --no-verify -m wip",
      "sudo --login git config core.hooksPath /dev/null"]) {
      assertDenied(guard(command, repo), "F-hookskip");
    }
  });

  it("git_deniedWithFHookskip_whenExecNamesADashedGitProgramAsArgv0", () => {
    assertDenied(guard("exec -a git-push git config core.hooksPath /dev/null", repo), "F-hookskip");
  });

  it("git_denied_whenHooksPathOverriddenForTheCommand", () => {
    assertDenied(guard("git -c core.hooksPath=/dev/null commit -m wip", repo), "F-hookskip");
  });

  it("config_denied_whenSettingHooksPath", () => {
    assertDenied(guard("git config core.hooksPath /tmp/hooks", repo), "F-hookskip");
    assertDenied(guard("git config --local core.hooksPath /tmp/hooks", repo), "F-hookskip");
  });

  it("config_passes_whenReadingHooksPath", () => {
    for (const command of ["git config --get core.hooksPath", "git config get core.hooksPath", "git config core.hooksPath",
      "git config --get-urlmatch core.hooksPath https://example.invalid"]) {
      assertPassed(guard(command, repo));
    }
  });

  it("config_denied_whenUnsettingHooksPath", () => {
    assertDenied(guard("git config --unset core.hooksPath", repo), "F-hookskip");
  });

  it("claude_denied_whenSettingsDisableAllHooksAndToolsStayOn", () => {
    const result = guard("claude -p --settings '{\"disableAllHooks\": true}' 'hello'");
    assertDenied(result, "F-hookskip");
    assert.ok(result.stderr.includes("disableAllHooks"), result.stderr);
  });

  it("claude_passes_whenWriteToolsAreDisallowed", () => {
    assertPassed(guard("claude -p --settings '{\"disableAllHooks\": true}' --disallowedTools Bash,Edit,Write 'hello'"));
    assertPassed(guard("claude -p --settings '{\"disableAllHooks\": true}' --disallowedTools Bash Edit Write -- 'hello'"));
  });

  it("claude_passes_whenSettingsKeepHooks", () => {
    assertPassed(guard("claude -p --settings '{\"disableAllHooks\": false}' 'hello'"));
  });

  it("write_denied_whenClaudeSettingsFileSetsDisableAllHooks", () => {
    assertDenied(edit("Write", { file_path: writeSettings(), content: '{"disableAllHooks": true}' }), "F-hookskip");
  });

  it("bash_denied_whenItWritesDisableAllHooksIntoAClaudeSettingsFile", () => {
    const target = writeSettings();
    const commands = [
      `echo '{"disableAllHooks": true}' > ${target}`,
      `printf '%s' '{"disableAllHooks": true}' | tee ${target}`,
      `jq '.disableAllHooks=true' ${target} > /tmp/s.json && mv /tmp/s.json ${target}`,
      `cd ${dirname(target)} && cat > settings.json <<'EOF'\n{"disableAllHooks": true}\nEOF`,
    ];
    for (const command of commands) {
      const result = guard(command);
      assertDenied(result, "F-hookskip");
      assert.ok(result.stderr.includes("disableAllHooks"), result.stderr);
    }
  });

  it("bash_denied_whenTheSettingsPathComesFromAPlainShellVariable", () => {
    const directory = join(sandbox.root, "proj", ".claude");
    assertDenied(guard(`C=${directory}; echo '{"disableAllHooks": true}' > $C/settings.local.json`), "F-hookskip");
  });

  it("bash_denied_whenTheSettingsPathComesFromAnExportedVariable", () => {
    const directory = join(sandbox.root, "proj", ".claude");
    assertDenied(guard(`export C=${directory}; echo '{"disableAllHooks": true}' > $C/settings.local.json`), "F-hookskip");
  });

  it("bash_passes_whenASettingsWriteKeepsHooksOrTheTargetIsNotASettingsFile", () => {
    assertPassed(guard(`echo '{"disableAllHooks": false}' > ${writeSettings()}`));
    assertPassed(guard(`echo '{"disableAllHooks": true}' > ${join(sandbox.root, "notes.json")}`));
  });

  it("edit_denied_whenNewStringSetsDisableAllHooks", () => {
    const target = join(sandbox.home, ".claude", "settings.json");
    assertDenied(edit("Edit", { file_path: target, old_string: "{", new_string: '{"disableAllHooks": true,' }), "F-hookskip");
  });

  it("edit_passes_whenNewStringTurnsDisableAllHooksOff", () => {
    const target = join(sandbox.home, ".claude", "settings.json");
    assertPassed(edit("Edit", { file_path: target, old_string: "true", new_string: '"disableAllHooks": false' }));
  });
});

describe("LiveCheckoutTest", () => {
  let live: string;
  let worktree: string;

  beforeEach(() => {
    live = join(sandbox.root, "live", "keel");
    mkdirSync(live, { recursive: true });
    sandbox.git(live, "init", "-q");
    sandbox.write(join(live, "README.md"), "live\n");
    sandbox.git(live, "add", "README.md");
    sandbox.git(live, "commit", "-q", "-m", "start");
    sandbox.env["KEEL_HOME"] = live;
    worktree = join(sandbox.root, "live", "keel-wt", "topic");
    sandbox.git(live, "worktree", "add", "-q", "-b", "topic", worktree);
  });

  it("write_deniedWithCIsolation_whenTargetIsInsideLiveKeel", () => {
    const result = edit("Write", { file_path: join(live, "PRINCIPLES.md"), content: "x" });
    assertDenied(result, "C-isolation");
    assert.ok(result.stderr.includes("worktree add"), result.stderr);
    assert.ok(result.stderr.includes("merge --ff-only"), result.stderr);
    assertFired(sandbox, "C-isolation", "deny", "git-guard");
  });

  it("bash_passes_whenASedScriptLooksLikeAPathInTheLiveCheckout", () => {
    const target = join(sandbox.root, "scratch.txt");
    assertPassed(guard(`sed -i '' 's#^files=.*#files=x#' ${target}`, live));
  });

  it("bash_denied_whenSedEditsAFileInTheLiveCheckout", () => {
    assertDenied(guard("sed -i '' 's#^files=.*#files=x#' PRINCIPLES.md", live), "C-isolation");
  });

  it("bash_denied_whenBsdSedEditsAFileInTheLiveCheckoutWithCapitalI", () => {
    assertDenied(guard("sed -I .bak -e s/a/b/ PRINCIPLES.md", live), "C-isolation");
  });

  it("bash_denied_whenAWriteFollowsACdTheHookCannotResolve", () => {
    assertDenied(guard('cd "$(git rev-parse --show-toplevel)" && echo x > notes.md', live), "C-isolation");
  });

  it("bash_passes_whenPwdIsTheStepDirectory_notTheHookProcessDirectory", () => {
    sandbox.env["PWD"] = live;
    assertPassed(guard(`cd ${worktree} && echo x > $PWD/notes.md`, live));
  });

  it("bash_denied_whenPwdNamesTheLiveCheckoutTheStepRunsIn", () => {
    assertDenied(guard('echo x > "$PWD/notes.md"', live), "C-isolation");
  });

  it("bash_passes_whenOldpwdIsOnlyTheHookProcessValue", () => {
    sandbox.env["OLDPWD"] = live;
    assertPassed(guard(`cd ${worktree} && echo x > $OLDPWD/notes.md`, worktree));
  });

  it("bash_denied_whenAPlainShellVariableNamesTheLiveCheckout", () => {
    for (const command of [`L=${live}; echo x > "$L/notes.md"`, `L=${live}; git -C "$L" checkout -b x`]) {
      assertDenied(guard(command, worktree), "C-isolation");
    }
  });

  it("bash_denied_whenAPlainAssignmentRepointsAnExportedVariableAtTheLiveCheckout", () => {
    assertDenied(guard(`export D=${worktree}; D=${live}; echo x > $D/notes.md`, worktree), "C-isolation");
  });

  it("bash_passes_whenAPlainShellVariableNamesTheWorktreeItCdsInto", () => {
    assertPassed(guard(`WT=${worktree}; cd "$WT" && echo x > notes.md`, live));
  });

  it("bash_denialSaysTheCdIsUnresolved_whenItJudgesWhereTheCallStarts", () => {
    const result = guard('cd "$(git rev-parse --show-toplevel)" && echo x > notes.md', live);
    assertDenied(result, "C-isolation");
    assert.ok(result.stderr.includes("cannot resolve"), result.stderr);
  });

  it("write_passes_whenTheFilePathStartsWithALiteralDollarWord", () => {
    assertPassed(edit("Write", { file_path: "$KEEL_HOME/notes.md", content: "x" }, worktree));
  });

  it("write_passes_whenTargetIsInsideAWorktree", () => {
    assertPassed(edit("Write", { file_path: join(worktree, "PRINCIPLES.md"), content: "x" }));
  });

  it("edit_denied_whenTargetIsInsideLiveOverlay", () => {
    const target = join(sandbox.overlay, "ledger.tsv");
    assertDenied(edit("Edit", { file_path: target, old_string: "a", new_string: "b" }), "C-isolation");
  });

  it("bash_denied_whenRedirectWritesIntoLiveKeel", () => {
    assertDenied(guard(`echo x > ${live}/notes.md`), "C-isolation");
  });

  it("bash_denied_whenRedirectIntoLiveKeelUsesAnExportedVariable", () => {
    assertDenied(guard(`export L=${live}; echo x > $L/notes.md`), "C-isolation");
  });

  it("bash_passes_whenRedirectTargetNamesAVariableTheHookCannotResolve", () => {
    assertPassed(guard("echo x > $KEEL_TEST_UNSET/notes.md", live));
  });

  it("bash_denied_whenGitMovesStateInsideLiveKeel", () => {
    for (const command of [`git -C ${live} checkout -b topic2`, `git -C ${live} pull`, `git -C ${live} merge --ff-only topic`]) {
      assertDenied(guard(command), "C-isolation");
    }
    assertDenied(guard("git reset --hard HEAD~1", live), "C-isolation");
  });

  it("bash_denied_whenGitRewritesTheLiveCheckoutByAnyMovingSubcommand", () => {
    for (const subcommand of ["cherry-pick HEAD", "revert HEAD", "am < /tmp/p.mbox", "apply /tmp/p.diff",
      "restore --source=HEAD~1 README.md", "rm README.md", "mv README.md R.md", "add ."]) {
      assertDenied(guard(`git -C ${live} ${subcommand}`), "C-isolation");
    }
  });

  it("bash_passes_whenWorktreeAddTargetsAWorktreeBesideLiveKeel", () => {
    assertPassed(guard(`git -C ${live} worktree add ../keel-wt/t2 -b t2`));
  });

  it("bash_passes_whenGitOnlyReadsOrFetchesInsideLiveKeel", () => {
    assertPassed(guard(`git -C ${live} fetch origin && git -C ${live} status`));
  });

  it("bash_passes_whenGitMovesStateInsideAWorktree", () => {
    assertPassed(guard("git checkout -b topic3", worktree));
  });
});

describe("KnownValuesTest", () => {
  let repo: string;

  beforeEach(() => {
    const configDir = join(sandbox.home, ".config", "acmecorp");
    sandbox.write(join(configDir, "prod.env"),
      `DB_HOST=db.internal.example\nDB_PASSWORD=${PASSWORD}\nPIN=12345\nexport API_SECRET="s3cr3t-value"\n`);
    sandbox.write(join(sandbox.overlay, "git-guard", "known-values.tsv"), `source\tpattern\nfile\t${configDir}/*.env\nenv\tACME_API_TOKEN\n`);
    sandbox.env["ACME_API_TOKEN"] = TOKEN;
    repo = sandbox.makeRepo("example", "app");
  });

  it("write_deniedWithFSecrets_whenContentHoldsAConfigPassword", () => {
    const result = edit("Write", { file_path: join(repo, "report.md"), content: `Rotate it:\npassword was ${PASSWORD}\n` });
    assertDenied(result, "F-secrets");
    assert.ok(result.stderr.includes("report.md:2 holds the value of DB_PASSWORD (prod.env)"), result.stderr);
    assert.ok(!result.stderr.includes(PASSWORD));
    assert.ok(!JSON.stringify(sandbox.fires()).includes(PASSWORD));
    assertFired(sandbox, "F-secrets", "deny", "git-guard");
  });

  it("edit_denied_whenNewStringHoldsAnEnvironmentSecret", () => {
    const result = edit("Edit", { file_path: join(repo, "a.py"), old_string: "x", new_string: `TOKEN = '${TOKEN}'` });
    assertDenied(result, "F-secrets");
    assert.ok(result.stderr.includes("holds the value of ACME_API_TOKEN (env)"), result.stderr);
    assert.ok(!result.stderr.includes(TOKEN));
  });

  it("edit_denied_whenExportedQuotedSecretIsWritten", () => {
    const result = edit("Write", { file_path: join(repo, "a.py"), content: "s3cr3t-value" });
    assertDenied(result, "F-secrets");
    assert.ok(result.stderr.includes("API_SECRET"), result.stderr);
  });

  it("write_passes_whenContentHoldsANonSecretValueOrAShortOne", () => {
    assertPassed(edit("Write", { file_path: join(repo, "a.py"), content: "host = 'db.internal.example'\npin = 12345\n" }));
  });

  it("commit_denied_whenStagedLineHoldsAKnownValue", () => {
    sandbox.write(join(repo, "conf.py"), `x = 1\nPASS = '${PASSWORD}'\n`);
    sandbox.git(repo, "add", "conf.py");
    const result = guard("git commit -m 'Add conf'", repo);
    assertDenied(result, "F-secrets");
    assert.ok(result.stderr.includes("conf.py:2 holds the value of DB_PASSWORD"), result.stderr);
    assert.ok(!result.stderr.includes(PASSWORD));
  });

  it("commit_passes_whenStagedLinesAreClean", () => {
    sandbox.write(join(repo, "conf.py"), "x = 1\n");
    sandbox.git(repo, "add", "conf.py");
    assertPassed(guard("git commit -m 'Add conf'", repo));
  });
});

describe("KeelCommandTest", () => {
  it("bash_deniedWithK1_whenKeelApprove", () => {
    assertDenied(guard("keel approve rv-20261011T085500Z-7f3e21"), "K1");
    assertFired(sandbox, "K1", "deny", "git-guard");
  });

  it("bash_denied_whenKeelApproveByDataDirPath", () => {
    assertDenied(guard('"${KEEL_DATA_DIR:-$HOME/.claude}/bin/keel" approve rv-1 --read'), "K1");
  });

  it("bash_denied_whenKeelApproveRunsThroughAnInterpreterOrXargs", () => {
    assertDenied(guard("python3 -I /x/bin/keel approve rv-1"), "K1");
    assertDenied(guard("bash /x/bin/keel approve rv-1"), "K1");
    assertDenied(guard("echo rv-1 | xargs keel approve"), "K1");
  });

  it("bash_denied_whenEvidenceWriteReviewFedByPipe", () => {
    assertDenied(guard("echo '{}' | keel evidence write-review"), "K1");
  });

  it("bash_denied_whenKeelApproveInsideBashDashC", () => {
    assertDenied(guard("bash -c 'keel approve rv-1'"), "K1");
  });

  it("bash_passes_whenKeelEvidenceShow", () => {
    assertPassed(guard("keel evidence show --repo ."));
  });
});

describe("AttributionTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
  });

  it("commit_deniedWithFAttribution_whenMessageHasAiTrailer", () => {
    const result = guard(`git commit -m "Fix parser" -m "${ATTRIBUTION_TRAILER}"`, repo);
    assertDenied(result, "F-attribution");
    assertBulletIdsSeeded(result.stderr);
    assertFired(sandbox, "F-attribution", "deny", "git-guard");
  });

  it("commit_denied_whenTrailerInHeredocSubstitution", () => {
    const command = `git commit -m "$(cat <<'EOF'\nFix parser, don't skip\n\n${ATTRIBUTION_TRAILER}\nEOF\n)"`;
    assertDenied(guard(command, repo), "F-attribution");
  });

  it("commit_denied_whenMessageFileHasTrailer", () => {
    sandbox.write(join(repo, "msg.txt"), `Fix\n\n${ATTRIBUTION_TRAILER}\n`);
    assertDenied(guard("git commit -F msg.txt", repo), "F-attribution");
  });

  it("commit_denied_whenMessageFilePathUsesAVariableTheHookKnows", () => {
    const scratch = join(sandbox.root, "scratch");
    sandbox.write(join(scratch, "msg.txt"), `Fix\n\n${ATTRIBUTION_TRAILER}\n`);
    sandbox.env["TMPDIR"] = scratch;
    for (const command of ["git commit -F $TMPDIR/msg.txt", "git commit -F ${TMPDIR}/msg.txt",
      `export M=${scratch}; git commit -F $M/msg.txt`, `M=${scratch}; git commit -F $M/msg.txt`]) {
      assertDenied(guard(command, repo), "F-attribution");
    }
  });

  it("commit_denied_whenStdinHeredocHasRobot", () => {
    assertDenied(guard(`git commit -F - <<'EOF'\nFix ${ROBOT}\nEOF`, repo), "F-attribution");
  });

  it("commit_denied_whenHeredocWrittenToFileThenCommittedInSameCall", () => {
    const command = `cat > msg.txt <<'EOF'\nFix parser\n\n${ATTRIBUTION_TRAILER}\nEOF\ngit commit -F msg.txt`;
    assertDenied(guard(command, repo), "F-attribution");
  });

  it("commit_denied_whenFilePathIsAttachedToFileFlag", () => {
    sandbox.write(join(repo, "msg.txt"), `Fix\n\n${ATTRIBUTION_TRAILER}\n`);
    assertDenied(guard("git commit -Fmsg.txt", repo), "F-attribution");
  });

  it("commit_denied_whenMessageFlagClusteredAfterSignoff", () => {
    assertDenied(guard(`git commit -sm "Fix parser. ${ATTRIBUTION_TRAILER}"`, repo), "F-attribution");
  });

  it("commit_passes_whenClusteredMessageIsClean", () => {
    assertPassed(guard('git commit -sm "Fix parser edge case"', repo));
  });

  it("commit_passes_whenHeredocInSameCallIsClean", () => {
    assertPassed(guard("cat > msg.txt <<'EOF'\nFix parser edge case\nEOF\ngit commit -F msg.txt", repo));
  });

  it("commit_passes_whenMessageIsClean", () => {
    assertPassed(guard('git commit -m "Fix parser edge case"', repo));
  });

  it("grep_passes_whenSearchingForTrailerText", () => {
    assertPassed(guard(`git log --format=%B | grep -c "${ATTRIBUTION_TRAILER}"`, repo));
  });

  it("prCreate_denied_whenBodyHasRobot", () => {
    assertDenied(guard(`gh pr create --title "Fix" --body "Done ${ROBOT}"`, repo), "F-attribution");
  });

  it("prCreate_denied_whenBodyFileIsWrittenByHeredocInSameCall", () => {
    const command = `cat > b.md <<'EOF'\nSummary\n\n${ATTRIBUTION_TRAILER}\nEOF\ngh pr create --title t --body-file b.md`;
    assertDenied(guard(command, repo), "F-attribution");
  });

  it("prEdit_denied_whenBodyHasTrailer", () => {
    assertDenied(guard(`gh pr edit 3 --body '${ATTRIBUTION_TRAILER}'`, repo), "F-attribution");
  });

  it("prMerge_denied_whenBodyHasTrailer", () => {
    assertDenied(guard(`gh pr merge 7 --squash --body '${ATTRIBUTION_TRAILER}'`, repo), "F-attribution");
  });

  it("prMerge_denied_whenSubjectHasRobot", () => {
    assertDenied(guard(`gh pr merge 7 --squash --subject 'Merge ${ROBOT}'`, repo), "F-attribution");
  });

  it("prMerge_denied_whenBodyFileHasTrailer", () => {
    sandbox.write(join(repo, "merge.md"), `Merge\n\n${ATTRIBUTION_TRAILER}\n`);
    assertDenied(guard("gh pr merge 7 --squash -F merge.md", repo), "F-attribution");
  });

  it("prMerge_passes_whenSubjectAndBodyAreClean", () => {
    const command = "gh pr merge 7 --squash --match-head-commit abc123 --subject 'Merge feature' --body 'Adds the parser'";
    assertPassed(guard(command, repo));
  });

  it("prCreate_denied_whenRepoFlagPrecedesTheSubcommand", () => {
    assertDenied(guard(`gh -R acme/app pr create --title t --body '${ATTRIBUTION_TRAILER}'`, repo), "F-attribution");
  });

  it("prMerge_denied_whenRepoFlagSitsBetweenPrAndMerge", () => {
    assertDenied(guard(`gh pr --repo acme/app merge 7 --squash --body '${ATTRIBUTION_TRAILER}'`, repo), "F-attribution");
  });

  it("push_denied_whenDashCNamesTheRepoThroughAnExportedVariable", () => {
    sandbox.commitFile(repo, "a.txt", "a\n", `Add a\n\n${ATTRIBUTION_TRAILER}`);
    assertDenied(guard(`export R=${repo}; git -C $R push origin main`), "F-attribution");
  });

  it("push_denied_whenDashCNamesTheRepoThroughAPlainShellVariable", () => {
    sandbox.commitFile(repo, "a.txt", "a\n", `Add a\n\n${ATTRIBUTION_TRAILER}`);
    assertDenied(guard(`R=${repo}; git -C "$R" push origin main`), "F-attribution");
  });

  it("prCreate_passes_whenOnlyAChainedGrepNamesTheTrailer", () => {
    const command = `gh pr create --title t --body clean && gh pr view --json body | grep -c "${ATTRIBUTION_TRAILER}"`;
    assertPassed(guard(command, repo));
  });

  it("prView_passes_whenPipedIntoGrepForTrailer", () => {
    assertPassed(guard(`gh pr view 3 --json body | grep "${ATTRIBUTION_TRAILER}"`, repo));
  });

  it("push_denied_whenRangeHasAttributedCommit", () => {
    sandbox.commitFile(repo, "a.txt", "a\n", `Add a\n\n${ATTRIBUTION_TRAILER}`);
    assertDenied(guard("git push", repo), "F-attribution");
  });

  it("push_passes_whenRangeIsClean", () => {
    sandbox.commitFile(repo, "a.txt", "a\n", "Add a");
    assertPassed(guard("git push origin main", repo));
  });
});

describe("PushRangeWithoutUpstreamTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
    assert.ok(!sandbox.git(repo, "for-each-ref", "--format=%(refname)").includes("refs/remotes/origin/HEAD"));
    sandbox.git(repo, "checkout", "-q", "-b", "feat");
  });

  function publishAttributedCommitOnMain(): void {
    sandbox.git(repo, "checkout", "-q", "main");
    sandbox.commitFile(repo, "old.txt", "old\n", `Old\n\n${ATTRIBUTION_TRAILER}`);
    sandbox.git(repo, "push", "-q", "origin", "main");
    sandbox.git(repo, "checkout", "-q", "-b", "feat2");
  }

  it("push_denied_whenNewBranchHasAttributedCommit", () => {
    sandbox.commitFile(repo, "a.txt", "a\n", `Add a\n\n${ATTRIBUTION_TRAILER}`);
    assertDenied(guard("git push -u origin feat", repo), "F-attribution");
  });

  it("push_passes_whenNewBranchIsClean", () => {
    sandbox.commitFile(repo, "a.txt", "a\n", "Add a");
    assertPassed(guard("git push -u origin feat", repo));
  });

  it("push_passes_whenOnlyCommitsAlreadyOnRemoteAreAttributed", () => {
    publishAttributedCommitOnMain();
    sandbox.commitFile(repo, "a.txt", "a\n", "Add a");
    assertPassed(guard("git push -u origin feat2", repo));
  });

  it("push_skipsCommitsAlreadyOnARemote_whenRemoteIsGivenAsUrl", () => {
    publishAttributedCommitOnMain();
    sandbox.commitFile(repo, "a.txt", "a\n", "Add a");
    const url = sandbox.git(repo, "remote", "get-url", "origin");
    assertPassed(guard(`git push ${url} feat2`, repo));
  });

  it("push_denied_whenUrlPushCarriesNewAttributedCommit", () => {
    sandbox.commitFile(repo, "a.txt", "a\n", `Add a\n\n${ATTRIBUTION_TRAILER}`);
    const url = sandbox.git(repo, "remote", "get-url", "origin");
    assertDenied(guard(`git push ${url} feat`, repo), "F-attribution");
  });

  it("push_scansWholeHistory_whenNoRemoteRefResolves", () => {
    sandbox.commitFile(repo, "a.txt", "a\n", `Add a\n\n${ATTRIBUTION_TRAILER}`);
    sandbox.git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    assertDenied(guard("git push -u origin feat", repo), "F-attribution");
  });
});

describe("WholeRepoPushTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
    sandbox.git(repo, "checkout", "-q", "-b", "other");
  });

  function otherBranchCommit(message: string): void {
    sandbox.commitFile(repo, "other.txt", "other\n", message);
    sandbox.git(repo, "checkout", "-q", "main");
  }

  it("wholeRepoPush_denied_whenANonHeadBranchCarriesAttribution", () => {
    otherBranchCommit(`Add other\n\n${ATTRIBUTION_TRAILER}`);
    for (const command of ["git push --all origin", "git push origin --all", "git push --branches origin", "git push --mirror origin"]) {
      assertDenied(guard(command, repo), "F-attribution");
    }
  });

  it("wholeRepoPush_passes_whenEveryBranchIsClean", () => {
    otherBranchCommit("Add other");
    assertPassed(guard("git push --all origin", repo));
  });

  it("branchPush_passes_whenOnlyAnotherBranchCarriesAttribution", () => {
    otherBranchCommit(`Add other\n\n${ATTRIBUTION_TRAILER}`);
    assertPassed(guard("git push origin main", repo));
  });
});

describe("SecretsTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
  });

  it("commit_deniedWithFSecrets_whenBoundaryReportsHits", () => {
    const hits = { scanned: 3, hits: [{ file: "conf.env", line: 2, rule: "aws-key" }] };
    sandbox.env["KEEL_BOUNDARY"] = sandbox.stub("boundary-hit", { stdout: JSON.stringify(hits), exitCode: 1 });
    const result = guard('git commit -m "Add config"', repo);
    assertDenied(result, "F-secrets");
    assert.ok(result.stderr.includes("conf.env:2 (aws-key)"), result.stderr);
    assert.deepEqual(sandbox.stubCalls("boundary-hit")[0]?.argv, ["--staged", "--generic-only"]);
  });

  it("commit_deniedFailClosed_whenBoundaryErrors", () => {
    sandbox.env["KEEL_BOUNDARY"] = sandbox.stub("boundary-broken", { exitCode: 2 });
    const result = guard('git commit -m "Add config"', repo);
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes("internal error"), result.stderr);
    assertFired(sandbox, "F-attribution", "error", "git-guard");
  });

  it("commit_deniedFailClosed_whenBoundaryMissing", () => {
    sandbox.env["KEEL_BOUNDARY"] = join(sandbox.root, "no-such-scanner");
    assert.equal(guard('git commit -m "Add config"', repo).code, 2);
  });
});

describe("SubprocessTimeoutTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
  });

  function slowScript(name: string, body: string): string {
    const path = sandbox.write(join(sandbox.root, "slow", name), "#!/bin/bash\n" + body);
    chmodSync(path, 0o755);
    return path;
  }

  it("subprocessTimeouts_stayBelowTheRegisteredTimeout", () => {
    const registered = registeredTimeout("git-guard/git-guard");
    assert.ok(BOUNDARY_TIMEOUT_SECONDS + DECISION_MARGIN_SECONDS < registered);
    assert.ok(GIT_TIMEOUT_SECONDS + DECISION_MARGIN_SECONDS < registered);
  });

  it("boundaryScan_raisesGuardError_whenTheScannerOutlastsItsTimeout", () => {
    const scanner = slowScript("boundary", "sleep 30; echo '{}'\n");
    withEnv({ KEEL_BOUNDARY: scanner }, () => {
      assert.throws(() => scanStagedSecrets(repo, null, 0.5), GuardError);
    });
  });
});

describe("SameCallStagingTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
    sandbox.write(join(repo, "s.txt"), "SECRET\n");
  });

  function assertDeniedForSameCallStaging(result: HookResult): void {
    assertDenied(result, "F-secrets");
    assert.ok(result.stderr.includes("stage in a separate call, then commit"), result.stderr);
  }

  it("commit_deniedWithFSecrets_whenAddChainedBeforeIt", () => {
    assertDeniedForSameCallStaging(guard("git add s.txt && git commit -m wip", repo));
  });

  it("commit_denied_whenAddAllChainedBeforeIt", () => {
    assertDeniedForSameCallStaging(guard("git add -A && git commit -m wip", repo));
  });

  it("commit_denied_whenAddChainedAfterCdIntoRepo", () => {
    assertDeniedForSameCallStaging(guard(`cd ${repo}; git add s.txt; git commit -m wip`));
  });

  it("commit_denied_whenAPlainShellVariableNamesTheRepoForAddAndCommit", () => {
    assertDeniedForSameCallStaging(guard(`R=${repo}; git -C "$R" add s.txt && git -C "$R" commit -m wip`));
  });

  it("commit_passes_whenRmChainedBeforeIt", () => {
    assertPassed(guard(`cd ${repo}; git rm -q README.txt; git commit -m wip`));
  });

  it("commit_denied_whenAllFlagClusteredWithMessage", () => {
    assertDeniedForSameCallStaging(guard("git commit -am wip", repo));
  });

  it("commit_denied_whenLongAllFlag", () => {
    assertDeniedForSameCallStaging(guard("git commit --all -m wip", repo));
  });

  it("commit_denied_whenPathspecOperand", () => {
    assertDeniedForSameCallStaging(guard("git commit -m wip -- s.txt", repo));
  });

  it("commit_denied_whenIncludeWithPathspec", () => {
    assertDeniedForSameCallStaging(guard("git commit -i s.txt -m wip", repo));
  });

  it("commit_passes_whenMessageValueIsAttachedToFlag", () => {
    assertPassed(guard("git commit -ma", repo));
  });

  it("commit_passes_whenFilesWereStagedInEarlierCall", () => {
    sandbox.git(repo, "add", "s.txt");
    assertPassed(guard('git commit -m "Add s" --author "A <a@example.invalid>"', repo));
  });

  it("commit_passes_whenAddRunsAfterCommit", () => {
    assertPassed(guard("git commit --amend --no-edit && git add s.txt", repo));
  });

  it("commit_passes_whenEarlierAddIsInAnotherRepo", () => {
    const other = sandbox.makeRepo("example", "other");
    sandbox.write(join(other, "o.txt"), "o\n");
    assertPassed(guard(`git -C ${other} add o.txt && git commit -m wip`, repo));
  });
});

describe("ForcePushTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
  });

  it("push_deniedWithFForcePush_whenForceFlag", () => {
    assertDenied(guard("git push --force origin feature", repo), "F-force-push");
    assertFired(sandbox, "F-force-push", "deny", "git-guard");
  });

  it("push_denied_whenShortFlagCombined", () => {
    assertDenied(guard("git push -fu origin feature", repo), "F-force-push");
  });

  it("push_denied_whenGitsOwnDashedPushProgramForces", () => {
    assertDenied(guard("/usr/libexec/git-core/git-push --force origin feature", repo), "F-force-push");
  });

  it("push_deniedWithFForcePush_whenSudoCarriesAnOptionTheParserDoesNotRead", () => {
    for (const command of ["sudo -i git push --force origin feature", "sudo -nE git push --force origin feature",
      "sudo --login git push --force origin feature", "sudo -nE bash -c 'git push --force origin feature'"]) {
      assertDenied(guard(command, repo), "F-force-push");
    }
  });

  it("push_deniedWithFForcePush_whenAWrapperCarriesALoneDash", () => {
    for (const command of ["sudo - git push --force origin feature", "exec - git push --force origin feature"]) {
      assertDenied(guard(command, repo), "F-force-push");
    }
  });

  it("push_deniedWithFForcePush_whenExecNamesGitsPushProgramAsArgv0", () => {
    for (const command of ["exec -a git-push git push --force origin feature", 'exec -a "$A" git push --force origin feature']) {
      assertDenied(guard(command, repo), "F-force-push");
    }
  });

  it("git_deniedWithItsFloor_whenSudoRunsItInAnotherDirectoryOrRoot", () => {
    const cases: Array<[string, string]> = [
      ["sudo -D /tmp git push --force origin feature", "F-force-push"],
      ["sudo --chdir /tmp git push --force origin feature", "F-force-push"],
      ["sudo --chroot /srv git commit --no-verify -m wip", "F-hookskip"],
      ["sudo -D git git push --force origin feature", "F-force-push"],
    ];
    for (const [command, floor] of cases) assertDenied(guard(command, repo), floor);
  });

  it("git_deniedWithItsFloor_whenAWrapperClusterEndsInAValueLetter", () => {
    const cases: Array<[string, string]> = [
      ["sudo -iu bob git push --force origin feature", "F-force-push"],
      ["sudo -Hu bob git commit --no-verify -m wip", "F-hookskip"],
      ["sudo -Eu root git push --force origin feature", "F-force-push"],
      ["exec -la x git push --force origin feature", "F-force-push"],
      ["exec -la x git config core.hooksPath /dev/null", "F-hookskip"],
    ];
    for (const [command, floor] of cases) assertDenied(guard(command, repo), floor);
  });

  it("push_denied_whenPlusRefspec", () => {
    assertDenied(guard("git push origin +feature", repo), "F-force-push");
  });

  it("push_passes_whenLeaseOntoFeatureBranch", () => {
    assertPassed(guard("git push --force-with-lease origin feature", repo));
  });

  it("push_denied_whenLeaseOntoMain", () => {
    assertDenied(guard("git push --force-with-lease origin HEAD:main", repo), "F-force-push");
  });

  it("push_denied_whenLeaseOntoRegisteredIntegrationBase", () => {
    sandbox.write(join(sandbox.overlay, "gated-repos.tsv"),
      "origin\tgate\tintegration_base\trisk_rules\ttests\nexample/app\tcode\tdevelop\t-\trequired\n");
    assertDenied(guard("git push --force-with-lease origin develop", repo), "F-force-push");
  });

  it("push_denied_whenLeaseOntoIntegrationBaseOfARegistryWithPushApproval", () => {
    sandbox.write(join(sandbox.overlay, "gated-repos.tsv"),
      "origin\tgate\tintegration_base\trisk_rules\ttests\tpush_approval\nexample/app\tcode\tdevelop\t-\trequired\ttrue\n");
    assertDenied(guard("git push --force-with-lease origin develop", repo), "F-force-push");
  });

  it("push_passes_whenDeletingRemoteBranch", () => {
    assertPassed(guard("git push origin --delete old-feature", repo));
  });
});

describe("RepoRulesTest", () => {
  beforeEach(() => {
    sandbox.useExampleOverlay("git-guard/repo-rules.tsv");
  });

  it("commit_deniedWithRowId_whenRepoForbidsCommits", () => {
    const repo = sandbox.makeRepo("acmecorp", "platform-root");
    const result = guard('git commit -m "Bump"', repo);
    assertDenied(result, "O-parent");
    assertBulletIdsSeeded(result.stderr, ["O-parent"]);
    assertFired(sandbox, "O-parent", "deny", "git-guard");
  });

  it("commit_denied_whenStagedPathMatchesRule", () => {
    const repo = sandbox.makeRepo("acmecorp", "storefront");
    sandbox.write(join(repo, "db", "patch.sql"), "select 1;\n");
    sandbox.git(repo, "add", "db/patch.sql");
    const result = guard('git commit -m "Add patch"', repo);
    assertDenied(result, "O-files");
    assert.ok(result.stderr.includes("db/patch.sql"), result.stderr);
  });

  it("commit_denied_whenMatchingPathIsAddedInSameCall", () => {
    const repo = sandbox.makeRepo("acmecorp", "storefront");
    sandbox.write(join(repo, "a.sql"), "select 1;\n");
    const result = guard("git add a.sql && git commit -m wip", repo);
    assertDenied(result, "F-secrets");
    assert.ok(result.stderr.includes("stage in a separate call, then commit"), result.stderr);
  });

  it("commit_denied_whenTrackedMatchingPathIsCommittedWithAllFlag", () => {
    const repo = sandbox.makeRepo("acmecorp", "storefront");
    sandbox.commitFile(repo, "a.sql", "select 1;\n", "Add a");
    sandbox.write(join(repo, "a.sql"), "select 2;\n");
    assertDenied(guard("git commit -am wip", repo), "F-secrets");
  });

  it("commit_passes_whenStagedPathDoesNotMatch", () => {
    const repo = sandbox.makeRepo("acmecorp", "storefront");
    sandbox.write(join(repo, "src", "a.py"), "x = 1\n");
    sandbox.git(repo, "add", "src/a.py");
    assertPassed(guard('git commit -m "Add a"', repo));
  });

  it("push_denied_whenRangeCarriesMatchingPath", () => {
    const repo = sandbox.makeRepo("acmecorp", "storefront");
    sandbox.commitFile(repo, "db/patch.sql", "select 1;\n", "Add patch");
    assertDenied(guard("git push", repo), "O-files");
  });

  it("push_denied_whenNewBranchWithoutUpstreamCarriesMatchingPath", () => {
    const repo = sandbox.makeRepo("acmecorp", "storefront");
    sandbox.git(repo, "checkout", "-q", "-b", "feat");
    sandbox.commitFile(repo, "db/patch.sql", "select 1;\n", "Add patch");
    assertDenied(guard("git push -u origin feat", repo), "O-files");
  });

  it("commit_passes_whenRepoOutsideRuleGlob", () => {
    const repo = sandbox.makeRepo("example", "other");
    sandbox.write(join(repo, "x.sql"), "select 1;\n");
    sandbox.git(repo, "add", "x.sql");
    assertPassed(guard('git commit -m "Add x"', repo));
  });

  it("commit_deniedFailClosed_whenRepoRulesHeaderIsWrong", () => {
    sandbox.write(join(sandbox.overlay, "git-guard", "repo-rules.tsv"), "origin\taction\n");
    const repo = sandbox.makeRepo("acmecorp", "storefront");
    const result = guard('git commit -m "Add a"', repo);
    assert.equal(result.code, 2);
    assertFired(sandbox, "F-attribution", "error", "git-guard");
  });
});

describe("FailClosedTest", () => {
  it("guard_denies_whenPayloadUnparseableAndLooksLikePush", () => {
    const result = sandbox.runHook(GIT_GUARD, { raw: '{"tool_input": {"command": "git push"' });
    assert.equal(result.code, 2);
    assert.equal(lastLine(result.stderr), ASK_USER);
  });

  it("guard_denies_whenPayloadUnparseableAndLooksLikeAHookSkip", () => {
    assert.equal(sandbox.runHook(GIT_GUARD, { raw: '{"tool_input": {"command": "git commit --no-verify"' }).code, 2);
  });

  it("guard_denies_whenPayloadUnparseableAndLooksLikeAPrMerge", () => {
    for (const command of ["gh pr merge 7 --body x", "gh -R acme/app pr merge 7"]) {
      assert.equal(sandbox.runHook(GIT_GUARD, { raw: `{"tool_input": {"command": "${command}"` }).code, 2);
    }
  });

  it("guard_passes_whenPayloadUnparseableAndHarmless", () => {
    assert.equal(sandbox.runHook(GIT_GUARD, { raw: '{"tool_input": {"command": "ls -la"' }).code, 0);
  });

  it("guard_denies_whenPayloadUnparseableAndLooksLikeKeelApprove", () => {
    assert.equal(sandbox.runHook(GIT_GUARD, { raw: '{"tool_input": {"command": "/x/bin/keel approve rv-1"' }).code, 2);
  });

  it("guard_passes_whenPayloadUnparseableAndOnlyNamesAKeelPath", () => {
    assert.equal(sandbox.runHook(GIT_GUARD, { raw: '{"tool_input": {"command": "ls ~/git/keel-wt/core"' }).code, 0);
  });

  it("guard_passesWithoutFire_whenCommandIsNotADecisionPoint", () => {
    assertPassed(guard("ls -la && echo done"));
    assert.deepEqual(sandbox.fires(), []);
  });
});
