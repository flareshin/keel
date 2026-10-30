import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import {
  assertBulletIdsSeeded, assertFired, bash, GIT_GUARD, HookSandbox, KEEL_HOME, preToolUse, withEnv,
} from "./helpers.ts";
import type { HookResult } from "./helpers.ts";
import { BOUNDARY_TIMEOUT_SECONDS, DROP_COMMENTS, GuardError, scanStagedSecrets } from "../../hooks/git-guard/git-guard.ts";
import { GIT_TIMEOUT_SECONDS } from "../../hooks/lib/hookkit/repo.ts";
import { MAX_JSON_DEPTH } from "../../measure/lib/measurekit/json.ts";

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

  it("multiEdit_denied_whenEditsIsNotAListAndTheTargetIsInsideTheProtectedStore", () => {
    for (const edits of ["text", { new_string: "text" }, 5, true]) {
      const result = edit("MultiEdit", { file_path: join(data, "state", "keel", "x.json"), edits });
      assertDenied(result, "K1");
      assert.ok(!result.stderr.includes("F-attribution"), result.stderr);
    }
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

  it("claude_denied_whenSettingsHoldNonFiniteNumbers", () => {
    for (const literal of ["NaN", "Infinity", "-Infinity"]) {
      const plain = guard(`claude -p hi --settings '{"disableAllHooks": true, "x": ${literal}}'`);
      assertDenied(plain, "F-hookskip");
      const escaped = guard(`claude -p hi --settings '{"disableAll\\u0048ooks": true, "x": ${literal}}'`);
      assertDenied(escaped, "F-hookskip");
    }
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

  it("multiEdit_denied_whenAnEditsEntryOnAClaudeSettingsFileSetsDisableAllHooks", () => {
    const edits = [{ new_string: "{}" }, "not an edit", { new_string: '{"disableAllHooks": true}' }];
    assertDenied(edit("MultiEdit", { file_path: writeSettings(), edits }), "F-hookskip");
  });

  it("multiEdit_passes_whenEditsIsAbsentEmptyOrNull", () => {
    for (const toolArgs of [{}, { edits: [] }, { edits: null }]) {
      assertPassed(edit("MultiEdit", { file_path: writeSettings(), ...toolArgs }));
    }
    assert.deepEqual(sandbox.fires(), []);
  });

  it("multiEdit_deniedFailClosed_whenEditsIsNotAListAndNothingElseDecides", () => {
    const expected = new Map<unknown, string>([["text", "str"], [{ new_string: "text" }, "dict"], [5, "int"], [true, "bool"], [0, "int"], [false, "bool"], ["", "str"], [{}, "dict"]]);
    for (const [edits, typeName] of expected) {
      const result = edit("MultiEdit", { file_path: join(sandbox.root, "notes.md"), content: "no-verify", edits });
      assert.equal(result.code, 2, JSON.stringify(edits));
      assert.ok(result.stderr.includes("[F-attribution]"), result.stderr);
      assert.equal(sandbox.fires().at(-1)?.detail, `TypeError: edits is not a list: '${typeName}'`);
    }
  });

  it("multiEdit_passesWithTheErrorLogged_whenEditsIsNotAListAndTheCallLooksHarmless", () => {
    assertPassed(edit("MultiEdit", { file_path: join(sandbox.root, "notes.md"), content: "x", edits: "text" }));
    assert.equal(sandbox.fires().at(-1)?.detail, "TypeError: edits is not a list: 'str'");
  });

  it("multiEdit_deniedByTheSettingsRule_whenEditsIsNotAListAndContentSetsDisableAllHooks", () => {
    for (const edits of ["text", { new_string: "text" }]) {
      assertDenied(edit("MultiEdit", { file_path: writeSettings(), content: '{"disableAllHooks": true}', edits }), "F-hookskip");
    }
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

  it("bash_passes_whenTheVariableItCdsIntoIsBuiltFromAnotherAssignedVariable", () => {
    assertPassed(guard(`S=${worktree}; D=$S/sub; mkdir -p $D; cd $D && echo x > notes.md`, live));
    assertPassed(guard(`S=${worktree} D="\${S}"; cd "$D" && echo x > notes.md`, live));
  });

  it("bash_denied_whenTheVariableItCdsIntoIsBuiltFromAVariableNamingTheLiveCheckout", () => {
    const result = guard(`S=${live}; D=$S/sub; mkdir -p $D; cd $D && echo x > notes.md`, worktree);
    assertDenied(result, "C-isolation");
    assert.ok(!result.stderr.includes("cannot resolve"), result.stderr);
  });

  it("bash_judgesACdIntoAnExportedVariableBuiltFromAnotherExportedVariable", () => {
    assertPassed(guard(`export S=${worktree}; export D=$S/sub; mkdir -p $D; cd $D && echo x > notes.md`, live));
    const result = guard(`export S=${live}; export D=$S/sub; mkdir -p $D; cd $D && echo x > notes.md`, worktree);
    assertDenied(result, "C-isolation");
    assert.ok(!result.stderr.includes("cannot resolve"), result.stderr);
  });

  it("bash_denialSaysTheCdIsUnresolved_whenTheAssignedVariableUsesAnUnknownOne", () => {
    const result = guard(`D=$KEEL_NO_SUCH_VARIABLE/sub; cd $D && echo x > notes.md`, live);
    assertDenied(result, "C-isolation");
    assert.ok(result.stderr.includes("cannot resolve"), result.stderr);
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

  describe("a worktree nested under the live checkout", () => {
    let nested: string;

    beforeEach(() => {
      nested = join(live, ".claude", "worktrees", "nested");
      sandbox.git(live, "worktree", "add", "-q", "-b", "nested", nested);
    });

    it("edit_passes_whenTargetIsInsideTheNestedWorktree", () => {
      assertPassed(edit("Edit", { file_path: join(nested, "README.md"), old_string: "live", new_string: "x" }));
      assertPassed(edit("Write", { file_path: join(nested, "new-dir", "notes.md"), content: "x" }));
    });

    it("bash_passes_whenWritingOrMovingGitStateInsideTheNestedWorktree", () => {
      for (const command of ["echo x > notes.md", "git add notes.md", "git commit -q -m x", "git checkout -b nested2"]) {
        assertPassed(guard(command, nested));
      }
    });

    it("bash_denied_whenWritingIntoTheLiveCheckoutFromTheNestedWorktree", () => {
      assertDenied(guard(`echo x > ${live}/notes.md`, nested), "C-isolation");
    });

    it("edit_denied_whenADotGitFileUnderLiveKeelIsNotOneOfItsWorktrees", () => {
      const adminDirs = join(live, ".git", "worktrees");
      const dotGitTexts = [
        `gitdir: ${join(worktree, ".git")}\n`,
        `gitdir: ${join(adminDirs, "missing")}\n`,
        `gitdir: ${join(adminDirs, "nested")}\n`,
        "gitdir: \n",
        "garbage\n",
      ];
      for (const text of dotGitTexts) {
        const fake = join(live, ".claude", "worktrees", "fake");
        sandbox.write(join(fake, ".git"), text);
        assertDenied(edit("Write", { file_path: join(fake, "notes.md"), content: "x" }), "C-isolation");
      }
    });

    it("edit_denied_whenADotGitFileUnderLiveKeelNamesAnAdminDirOutsideItsWorktrees", () => {
      const fake = join(live, ".claude", "worktrees", "fake");
      const elsewhere = join(sandbox.root, "elsewhere", "admin");
      sandbox.write(join(fake, ".git"), `gitdir: ${elsewhere}\n`);
      sandbox.write(join(elsewhere, "gitdir"), `${join(fake, ".git")}\n`);
      assertDenied(edit("Write", { file_path: join(fake, "notes.md"), content: "x" }), "C-isolation");
    });

    it("edit_denied_whenADotGitUnderLiveKeelIsASymlinkToTheNestedWorktreesDotGit", () => {
      const sub = join(live, "sub");
      mkdirSync(sub);
      symlinkSync(join(nested, ".git"), join(sub, ".git"));
      assertDenied(edit("Write", { file_path: join(sub, "notes.md"), content: "x" }), "C-isolation");
    });

    it("edit_denied_whenTheNestedWorktreesDotGitFileIsUnreadable", () => {
      chmodSync(join(nested, ".git"), 0o000);
      try {
        assertDenied(edit("Write", { file_path: join(nested, "notes.md"), content: "x" }), "C-isolation");
      } finally {
        chmodSync(join(nested, ".git"), 0o644);
      }
    });

    it("edit_denied_whenTargetIsInsideAPlainRepoInsideTheNestedWorktree", () => {
      const inner = join(nested, "inner");
      mkdirSync(inner);
      sandbox.git(inner, "init", "-q");
      assertDenied(edit("Write", { file_path: join(inner, "notes.md"), content: "x" }), "C-isolation");
    });
  });

  it("multiEdit_denied_whenEditsIsNotAListAndTheTargetIsInsideLiveKeelOrTheOverlay", () => {
    for (const target of [join(live, "PRINCIPLES.md"), join(sandbox.overlay, "ledger.tsv")]) {
      for (const edits of ["text", { new_string: "text" }, 5, true]) {
        const result = edit("MultiEdit", { file_path: target, edits });
        assertDenied(result, "C-isolation");
        assert.ok(!result.stderr.includes("F-attribution"), result.stderr);
      }
    }
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

  it("multiEdit_deniedWithFSecretsNotFailClosed_whenEditsIsNotAListAndContentHoldsAKnownValue", () => {
    for (const edits of ["text", { new_string: "text" }]) {
      const result = edit("MultiEdit", { file_path: join(repo, "report.md"), content: `password was ${PASSWORD}\n`, edits });
      assertDenied(result, "F-secrets");
      assert.ok(!result.stderr.includes("[F-attribution]"), result.stderr);
      assert.ok(!result.stderr.includes(PASSWORD));
    }
  });

  it("commit_denied_whenStagedLineHoldsAKnownValue", () => {
    sandbox.write(join(repo, "conf.py"), `x = 1\nPASS = '${PASSWORD}'\n`);
    sandbox.git(repo, "add", "conf.py");
    const result = guard("git commit -m 'Add conf'", repo);
    assertDenied(result, "F-secrets");
    assert.ok(result.stderr.includes("conf.py:2 holds the value of DB_PASSWORD"), result.stderr);
    assert.ok(!result.stderr.includes(PASSWORD));
    assert.deepEqual(assertFired(sandbox, "F-secrets", "deny", "git-guard").map((fire) => fire["kind"]), [undefined]);
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

  it("commit_denied_whenMessageFileHasTrailerAndCrlfLineEnds", () => {
    sandbox.write(join(repo, "msg.txt"), `Fix\r\n\r\n${ATTRIBUTION_TRAILER}\r\n`);
    assertDenied(guard("git commit -F msg.txt", repo), "F-attribution");
  });

  it("commit_denied_whenMessageFileWrapsAnAttributionPhraseAtACrOrCrlf", () => {
    for (const text of ["Generated with\r\nClaude Code", "Thanks to\r\nClaude", "Generated with\rClaude Code"]) {
      sandbox.write(join(repo, "msg.txt"), `Fix parser\r\n\r\n${text}\r\n`);
      assertDenied(guard("git commit -F msg.txt", repo), "F-attribution");
    }
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

describe("AttributionCaseFoldingTest", () => {
  let repo: string;

  beforeEach(() => {
    repo = sandbox.makeRepo("example", "app");
  });

  it("commit_denied_whenDottedOrDotlessIStandsForIInAttribution", () => {
    for (const message of ["Wr\u0130tten by Claude", "Wr\u0131tten by Claude", "Co-Authored-By: Anthrop\u0131c", "Generated using Opena\u0130"]) {
      assertDenied(guard(`git commit -m '${message}'`, repo), "F-attribution");
    }
  });

  it("prText_denied_whenDottedIStandsForIInAttribution", () => {
    assertDenied(guard("gh pr create --title x --body 'Generated w\u0130th Claude'", repo), "F-attribution");
  });

  it("pushedCommit_denied_whenItsMessageHasDottedIInAttribution", () => {
    sandbox.git(repo, "commit", "-q", "--allow-empty", "-m", "Wr\u0130tten by Claude");
    assertDenied(guard("git push origin main", repo), "F-attribution");
  });

  it("commit_passes_whenTheTextIsNotAnAttribution", () => {
    assertPassed(guard("git commit -m 'Written by hand \u0130 \u0131'", repo));
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
    assert.equal(sandbox.fires().at(-1)?.detail, "GuardError: boundary scanner did not run: OSError");
  });

  it("commit_deniedFailClosed_whenTheBoundaryReportHitsAreNotAList", () => {
    const typeNames = new Map([['"abc"', "str"], ['{"file": "x"}', "dict"], ["5", "int"]]);
    for (const [hits, typeName] of typeNames) {
      sandbox.env["KEEL_BOUNDARY"] = sandbox.stub("boundary-odd", { stdout: `{"scanned": 1, "hits": ${hits}}`, exitCode: 1 });
      const result = guard('git commit -m "Add config"', repo);
      assert.equal(result.code, 2, hits);
      assert.ok(result.stderr.includes("internal error"), result.stderr);
      assert.equal(sandbox.fires().at(-1)?.detail, `TypeError: hits is not a list: '${typeName}'`);
    }
  });

  it("commit_deniedFailClosed_whenTheBoundaryReportHitsAreFalsyButNotAList", () => {
    const typeNames = new Map([["false", "bool"], ["0", "int"], ['""', "str"], ["{}", "dict"]]);
    for (const [hits, typeName] of typeNames) {
      sandbox.env["KEEL_BOUNDARY"] = sandbox.stub("boundary-falsy", { stdout: `{"scanned": 1, "hits": ${hits}}`, exitCode: 1 });
      const result = guard('git commit -m "Add config"', repo);
      assert.equal(result.code, 2, hits);
      assert.ok(result.stderr.includes("internal error"), result.stderr);
      assert.equal(sandbox.fires().at(-1)?.detail, `TypeError: hits is not a list: '${typeName}'`);
    }
  });

  it("commit_deniedWithFSecrets_whenTheBoundaryReportHasNoHitsMember", () => {
    for (const report of ['{"scanned": 1}', '{"scanned": 1, "hits": null}']) {
      sandbox.env["KEEL_BOUNDARY"] = sandbox.stub("boundary-bare", { stdout: report, exitCode: 1 });
      assertDenied(guard('git commit -m "Add config"', repo), "F-secrets");
    }
  });

  it("commit_deniedFailClosed_whenAHitFieldIsNotTextOrANumber", () => {
    const hits = new Map([
      ['{"file": ["x"], "line": 1, "rule": "r"}', "hit file must be a string or number, not list"],
      ['{"file": "f", "line": null, "rule": "r"}', "hit line must be a string or number, not null"],
      ['{"file": "f", "line": 1}', "hit rule must be a string or number, not null"],
      ['{"file": "f", "line": true, "rule": "r"}', "hit line must be a string or number, not boolean"],
    ]);
    for (const [hit, message] of hits) {
      sandbox.env["KEEL_BOUNDARY"] = sandbox.stub("boundary-hit-odd", { stdout: `{"scanned": 1, "hits": [${hit}]}`, exitCode: 1 });
      const result = guard('git commit -m "Add config"', repo);
      assert.equal(result.code, 2, hit);
      assert.ok(result.stderr.includes("internal error"), result.stderr);
      assert.equal(sandbox.fires().at(-1)?.detail, `FieldTypeError: ${message}`);
    }
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

  it("commit_logsTheSameCallStagingDenyAsProcedural_notAsADetection", () => {
    guard("git add s.txt && git commit -m wip", repo);
    assert.deepEqual(assertFired(sandbox, "F-secrets", "deny", "git-guard").map((fire) => fire["kind"]), ["procedural"]);
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

  it("push_readsTheIntegrationBase_whenTheRegistryAlsoCarriesAutoMerge", () => {
    sandbox.write(join(sandbox.overlay, "gated-repos.tsv"),
      "origin\tgate\tintegration_base\trisk_rules\ttests\tpush_approval\tauto_merge\nexample/app\tcode\tdevelop\t-\trequired\ttrue\ttrue\n");
    assertDenied(guard("git push --force-with-lease origin develop", repo), "F-force-push");
    assertPassed(guard("git push --force-with-lease origin feature", repo));
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

  it("commit_deniedFailClosed_whenARepoRuleGlobHasABackwardsRange", () => {
    sandbox.write(join(sandbox.overlay, "git-guard", "repo-rules.tsv"), "origin_glob\taction\tpattern\trule_id\tmessage\nacmecorp/*\tdeny-path\t*.[z-a]\tO-files\tNo SQL.\n");
    const repo = sandbox.makeRepo("acmecorp", "storefront");
    sandbox.write(join(repo, "x.sql"), "select 1;\n");
    sandbox.git(repo, "add", "x.sql");
    const result = guard('git commit -m "Add x"', repo);
    assert.equal(result.code, 2);
    assertFired(sandbox, "F-attribution", "error", "git-guard");
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

  it("guard_denies_whenUnparseablePayloadSpellsAGuardedWordWithDottedOrDotlessI", () => {
    for (const command of ["git comm\u0130t -m x", "g\u0130t push", "git commit --no-ver\u0130fy", "d\u0131sableAllHooks"]) {
      assert.equal(sandbox.runHook(GIT_GUARD, { raw: `{"tool_input": {"command": "${command}"` }).code, 2, command);
    }
  });

  it("guard_treatsAPayloadHoldingANonFiniteNumberAsUnparseable", () => {
    for (const literal of ["NaN", "Infinity", "-Infinity"]) {
      const pushed = sandbox.runHook(GIT_GUARD, { raw: `{"tool_name": "Bash", "tool_input": {"command": "git push origin main"}, "x": ${literal}}` });
      assert.equal(pushed.code, 2, literal);
      assert.ok(pushed.stderr.includes("(JsonSyntaxError)"), pushed.stderr);
      assert.equal(lastLine(pushed.stderr), ASK_USER);
      assert.equal(sandbox.runHook(GIT_GUARD, { raw: `{"tool_name": "Bash", "tool_input": {"command": "ls"}, "x": ${literal}}` }).code, 0, literal);
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

describe("CommentWriteTest", () => {
  function assertCommentDenied(result: HookResult, line: string): void {
    assert.equal(result.code, 2, result.stderr);
    assert.ok(result.stderr.includes("[C-comments]"), result.stderr);
    assert.ok(result.stderr.includes(line), result.stderr);
    assert.equal(lastLine(result.stderr), DROP_COMMENTS);
  }

  function codeFile(name: string, content?: string): string {
    const path = join(sandbox.root, "src", name);
    mkdirSync(dirname(path), { recursive: true });
    if (content !== undefined) writeFileSync(path, content);
    return path;
  }

  it("write_denied_whenANewFileAddsADocComment", () => {
    const result = edit("Write", { file_path: codeFile("total.ts"), content: "/** Sums the cart. */\nexport const total = 1;\n" });

    assertCommentDenied(result, "/** Sums the cart. */");
    assertFired(sandbox, "C-comments", "deny", "git-guard");
  });

  it("edit_denied_whenACommentIsReworded", () => {
    const path = codeFile("Cart.java", "class Cart {\n// keeps the cart\nint n;\n}\n");
    const toolArgs = { file_path: path, old_string: "// keeps the cart\nint n;", new_string: "// keeps the basket\nint n;" };

    assertCommentDenied(edit("Edit", toolArgs), "// keeps the basket");
  });

  it("edit_passes_whenAnUnchangedCommentIsCarriedThroughTheReplacedSpan", () => {
    const toolArgs = {
      file_path: codeFile("Cart.java", "class Cart {\n    /**\n     * Legacy cart.\n     */\n    int n;\n}\n"),
      old_string: "    /**\n     * Legacy cart.\n     */\n    int n;",
      new_string: "    /**\n     * Legacy cart.\n     */\n    int count;",
    };

    assertPassed(edit("Edit", toolArgs));
  });

  it("multiEdit_denied_whenAnEditsEntryAddsALineComment", () => {
    const edits = [{ old_string: "a = 1", new_string: "a = 1" }, { old_string: "b = 2", new_string: "# set b\nb = 2" }];

    assertCommentDenied(edit("MultiEdit", { file_path: codeFile("job.py", "a = 1\nb = 2\n"), edits }), "# set b");
  });

  it("write_denied_whenAMultiLineDocstringBodyIsAdded", () => {
    const content = 'def run():\n    """\n    Run the job.\n    """\n    return 1\n';

    assertCommentDenied(edit("Write", { file_path: codeFile("job.py"), content }), "Run the job.");
  });

  it("write_denied_whenABlockCommentBodyLineHasNoLeadingStar", () => {
    const content = "/*\n  Sums the cart.\n*/\nexport const total = 1;\n";

    assertCommentDenied(edit("Write", { file_path: codeFile("total.ts"), content }), "Sums the cart.");
  });

  it("edit_denied_whenAJavadocLineIsRewordedInsideAnOpenBlock", () => {
    const path = codeFile("Cart.java", "class Cart {\n    /**\n     * Legacy cart.\n     */\n    int n;\n}\n");
    const toolArgs = { file_path: path, old_string: "     * Legacy cart.\n     */", new_string: "     * Current cart.\n     */" };

    assertCommentDenied(edit("Edit", toolArgs), "* Current cart.");
  });

  it("write_denied_whenANarrativeCommentOnlyMentionsALicenseOrTool", () => {
    const content = "// the license service returns 404 here, so retry\nexport const retry = 1;\n";

    assertCommentDenied(edit("Write", { file_path: codeFile("retry.ts"), content }), "the license service");
  });

  it("write_passes_whenAContinuationLineStartsWithMultiplication", () => {
    const content = "class Cart {\n  int total() {\n    return price\n        * quantity;\n  }\n}\n";

    assertPassed(edit("Write", { file_path: codeFile("Cart.java"), content }));
  });

  it("write_passes_whenATripleQuotedDataStringHoldsHashLines", () => {
    const content = 'QUERY = """\n# not a comment\nSELECT 1\n"""\n';

    assertPassed(edit("Write", { file_path: codeFile("query.py"), content }));
  });

  it("write_passes_whenAGlobOrRegexHoldsABlockCloserBeforeAnyOpener", () => {
    const glob = 'import x from "y";\nconst files = glob("**/*.ts");\n';
    const regex = "const stars = /a*/;\nconst n = 1;\n";

    assertPassed(edit("Write", { file_path: codeFile("files.ts"), content: glob }));
    assertPassed(edit("Write", { file_path: codeFile("stars.ts"), content: regex }));
  });

  it("write_passes_whenATripleQuotedStringIsACallArgument", () => {
    const content = 'cursor.execute(\n    """\n    SELECT id FROM item\n    """\n)\n';

    assertPassed(edit("Write", { file_path: codeFile("q.py"), content }));
  });

  it("edit_passes_whenItRewordsALineOfATripleQuotedCallArgument", () => {
    const path = codeFile("q.py", 'cursor.execute(\n    """\n    SELECT id FROM item\n    """\n)\n');
    const toolArgs = { file_path: path, old_string: '    """\n    SELECT id FROM item\n    """', new_string: '    """\n    SELECT id, name FROM item\n    """' };

    assertPassed(edit("Edit", toolArgs));
  });

  it("edit_passes_whenAGeneratorMethodLineLeadsTheFragment", () => {
    const path = codeFile("walk.ts", 'class Walk {\n  *items() {\n    return glob("*.ts");\n  }\n}\n');
    const toolArgs = { file_path: path, old_string: '  *items() {\n    return glob("*.ts");', new_string: '  *items() {\n    return glob("**/*.ts");' };

    assertPassed(edit("Edit", toolArgs));
  });

  it("edit_denied_whenReplaceAllRewordsEveryCopyOfAComment", () => {
    const path = codeFile("Cart.java", "class Cart {\n// tmp\nint a;\n// tmp\nint b;\n}\n");
    const toolArgs = { file_path: path, old_string: "// tmp", new_string: "// keeps the total", replace_all: true };

    assertCommentDenied(edit("Edit", toolArgs), "// keeps the total");
  });

  it("multiEdit_denied_whenALaterEntryMatchesOnlyAfterReplaceAll", () => {
    const path = codeFile("Cart.java", "class Cart {\n// tmp\nint a;\n// tmp\nint b;\n}\n");
    const edits = [
      { old_string: "// tmp", new_string: "// keeps the total", replace_all: true },
      { old_string: "// keeps the total\nint b;", new_string: "// keeps the total\nint count;" },
    ];

    assertCommentDenied(edit("MultiEdit", { file_path: path, edits }), "// keeps the total");
  });

  it("edit_denied_whenItAddsACommentToACrlfFile", () => {
    const path = codeFile("Crlf.java", "class Cart {\r\nint n;\r\n}\r\n");
    const toolArgs = { file_path: path, old_string: "int n;\n}", new_string: "// keeps the count\nint n;\n}" };

    assertCommentDenied(edit("Edit", toolArgs), "// keeps the count");
  });

  it("edit_passes_whenTheOldStringIsNotInTheFile", () => {
    const path = codeFile("Cart.java", "class Cart {\n}\n");
    const toolArgs = { file_path: path, old_string: "int missing;", new_string: "// note\nint missing;" };

    assertPassed(edit("Edit", toolArgs));
  });

  it("edit_denied_whenTheOldStringMatchesOnlyWithCurlyQuotesStraightened", () => {
    const path = codeFile("label.ts", "const label = “don’t”;\n");
    const toolArgs = { file_path: path, old_string: "const label = \"don't\";", new_string: "// shown on the cart\nconst label = \"don't\";" };

    assertCommentDenied(edit("Edit", toolArgs), "// shown on the cart");
  });

  it("edit_passes_whenACurlyQuotedCommentIsCarriedThroughWithStraightQuotes", () => {
    const path = codeFile("label.ts", "// don’t cache\nconst label = 1;\n");
    const toolArgs = { file_path: path, old_string: "// don't cache\nconst label = 1;", new_string: "// don't cache\nconst label = 2;" };

    assertPassed(edit("Edit", toolArgs));
  });

  it("edit_denied_whenThreeCurlyQuotesPrecedeANewPythonComment", () => {
    const path = codeFile("quote.py", "QUOTE = \"’’’\"\nx = 1\n");
    const toolArgs = { file_path: path, old_string: "x = 1", new_string: "# new note\nx = 1" };

    assertCommentDenied(edit("Edit", toolArgs), "# new note");
  });

  function notebookFile(cells: unknown[], language = "python", name = "load.ipynb"): string {
    return codeFile(name, JSON.stringify({ cells, metadata: { language_info: { name: language } }, nbformat: 4, nbformat_minor: 5 }));
  }

  const loadCell = { cell_type: "code", id: "a1", source: ["# reads the rows\n", "rows = load()\n"], metadata: {}, outputs: [] };

  it("notebookEdit_denied_whenAReplacedCodeCellAddsAComment", () => {
    const toolArgs = { notebook_path: notebookFile([loadCell]), cell_id: "a1", new_source: "# reads the rows\n# skips blanks\nrows = load()\n" };

    assertCommentDenied(edit("NotebookEdit", toolArgs), "# skips blanks");
  });

  it("notebookEdit_passes_whenTheCellKeepsItsExistingComment", () => {
    const toolArgs = { notebook_path: notebookFile([loadCell]), cell_id: "a1", new_source: "# reads the rows\nrows = load(limit=10)\n" };

    assertPassed(edit("NotebookEdit", toolArgs));
  });

  it("notebookEdit_denied_whenAnInsertedCodeCellHasAComment", () => {
    const toolArgs = { notebook_path: notebookFile([loadCell]), cell_id: "a1", edit_mode: "insert", cell_type: "code", new_source: "# count them\nlen(rows)\n" };

    assertCommentDenied(edit("NotebookEdit", toolArgs), "# count them");
  });

  it("notebookEdit_denied_whenTheCellIsNamedByIndex", () => {
    const { id: _, ...unnamedCell } = loadCell;
    const toolArgs = { notebook_path: notebookFile([unnamedCell]), cell_id: "cell-0", new_source: "# reads the rows\n# skips blanks\nrows = load()\n" };

    assertCommentDenied(edit("NotebookEdit", toolArgs), "# skips blanks");
  });

  it("notebookEdit_passes_forMarkdownCellsAndUnknownKernels", () => {
    const markdown = { notebook_path: notebookFile([loadCell], "python", "insert.ipynb"), edit_mode: "insert", cell_type: "markdown", new_source: "# Loading\n" };
    const unknownKernel = { notebook_path: notebookFile([loadCell], "r", "r.ipynb"), cell_id: "a1", new_source: "# reads the rows\n# skips blanks\nrows = load()\n" };

    assertPassed(edit("NotebookEdit", markdown));
    assertPassed(edit("NotebookEdit", unknownKernel));
  });

  it("notebookEdit_denied_whenTheKernelIsUnnamedOrMixedCase", () => {
    const newSource = "# reads the rows\n# skips blanks\nrows = load()\n";
    const unnamed = codeFile("plain.ipynb", JSON.stringify({ cells: [loadCell], metadata: {}, nbformat: 4, nbformat_minor: 5 }));

    assertCommentDenied(edit("NotebookEdit", { notebook_path: unnamed, cell_id: "a1", new_source: newSource }), "# skips blanks");
    assertCommentDenied(edit("NotebookEdit", { notebook_path: notebookFile([loadCell], "Python"), cell_id: "a1", new_source: newSource }), "# skips blanks");
  });

  it("notebookEdit_denied_whenACppKernelCellAddsASlashComment", () => {
    const cppCell = { cell_type: "code", id: "c1", source: "int x = 1;\n", metadata: {}, outputs: [] };
    const toolArgs = { notebook_path: notebookFile([cppCell], "c++"), cell_id: "c1", new_source: "// skips blanks\nint x = 1;\n" };

    assertCommentDenied(edit("NotebookEdit", toolArgs), "// skips blanks");
  });

  it("notebookEdit_passes_whenTheEditIsNotJudged", () => {
    const markdownCell = { cell_type: "markdown", id: "m1", source: "Intro\n", metadata: {} };
    const newSource = "# skips blanks\nrows = load()\n";
    const deleted = { notebook_path: notebookFile([loadCell]), cell_id: "a1", edit_mode: "delete", new_source: newSource };
    const markdownReplace = { notebook_path: notebookFile([markdownCell], "python", "markdown.ipynb"), cell_id: "m1", new_source: "# Loading\nIntro\n" };
    const unparsable = { notebook_path: codeFile("broken.ipynb", "{not json"), cell_id: "a1", new_source: newSource };

    assertPassed(edit("NotebookEdit", deleted));
    assertPassed(edit("NotebookEdit", markdownReplace));
    assertPassed(edit("NotebookEdit", unparsable));
    assert.deepEqual(sandbox.fires().filter((fire) => fire.outcome === "error"), []);
  });

  it("notebookEdit_deniedFailClosed_whenTheNotebookNestsPastTheJsonDepthLimit", () => {
    const deep = "[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1);
    const notebook = `{"cells": [${JSON.stringify(loadCell)}], "metadata": {"language_info": {"name": "python"}, "deep": ${deep}}}`;
    const toolArgs = { notebook_path: codeFile("deep.ipynb", notebook), cell_id: "a1", new_source: "# reads the rows\nrows = load(limit=10)\n" };

    const result = edit("NotebookEdit", toolArgs);

    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes("internal error"), result.stderr);
    assert.equal(sandbox.fires().at(-1)?.detail, `RecursionError: JSON nesting is deeper than ${MAX_JSON_DEPTH} levels`);
  });

  it("codexPatch_denied_whenItCopiesACommentTheFileAlreadyHas", () => {
    const toolArgs = { file_path: codeFile("keep.py", "x = 1\n# keeps x\n"), content: "# keeps x", keel_partial: true, keel_removed: "" };

    assertCommentDenied(edit("Write", toolArgs), "# keeps x");
  });

  it("codexPatch_passes_whenTheHunkKeepsTheCommentItRemoves", () => {
    const toolArgs = { file_path: codeFile("keep.py", "# keeps x\nx = 1\n"), content: "# keeps x\nx = 2", keel_partial: true, keel_removed: "# keeps x\nx = 1" };

    assertPassed(edit("Write", toolArgs));
  });

  it("codexPatch_denied_whenTheRemovedLinesAreNotInTheFile", () => {
    const toolArgs = { file_path: codeFile("keep.py", "x = 1\n"), content: "# brand new note\nx = 1", keel_partial: true, keel_removed: "# brand new note" };

    assertCommentDenied(edit("Write", toolArgs), "# brand new note");
  });

  it("codexPatch_denied_whenForgedRemovedLinesWouldHideAComment", () => {
    const repeated = { file_path: codeFile("keep.py", "# keeps x\nx = 1\n"), content: "# keeps x\n# keeps x", keel_partial: true, keel_removed: "# keeps x\n# keeps x" };
    const onEdit = { file_path: codeFile("edit.py", "x = 1\ny = 2\n"), old_string: "y = 2", new_string: "y = 2\n# new note", keel_partial: true, keel_removed: "x = 1" };
    const fromString = { file_path: codeFile("text.py", 'TEXT = """\n# not a comment\n"""\n'), content: "# not a comment", keel_partial: true, keel_removed: "# not a comment" };

    assertCommentDenied(edit("Write", repeated), "# keeps x");
    assertCommentDenied(edit("Edit", onEdit), "# new note");
    assertCommentDenied(edit("Write", fromString), "# not a comment");
  });

  it("codexPatch_passes_whenTheHunkClosesAStringInFileContext", () => {
    const source = 'def f(cur, x):\n    cur.execute("""\n        SELECT * FROM t WHERE a = %s\n    """)\n    return cur\n';
    const hunk = ["         SELECT * FROM t WHERE a = %s", '-    """)', '+    """, (x,))', "     return cur"];
    const toolArgs = { file_path: codeFile("query.py", source), content: '    """, (x,))', keel_removed: '    """)', keel_partial: true, keel_hunks: [hunk] };

    assertPassed(edit("Write", toolArgs));
  });

  it("codexPatch_denied_whenAHunkAddsADocstringUnderAContextLine", () => {
    const source = "def double(x):\n    return x * 2\n\ndef half(x):\n    return x / 2\n";
    const hunks = [[" def double(x):", "+    return x + x", "-    return x * 2"], [" def half(x):", '+    """Halves x."""', "     return x / 2"]];
    const content = '    return x + x\n    """Halves x."""';
    const toolArgs = { file_path: codeFile("math.py", source), content, keel_removed: "    return x * 2", keel_partial: true, keel_hunks: hunks };

    assertCommentDenied(edit("Write", toolArgs), '"""Halves x."""');
  });

  it("codexPatch_judgesTheAddedLinesAlone_whenTheHunkContextFitsMoreThanOnePlace", () => {
    const source = 'DOC = """\nx = 1\n"""\nx = 1\n';
    const toolArgs = { file_path: codeFile("twice.py", source), content: "y = 2  # sets y", keel_removed: "", keel_partial: true, keel_hunks: [[" x = 1", "+y = 2  # sets y"]] };

    assertCommentDenied(edit("Write", toolArgs), "# sets y");
  });

  it("codexPatch_judgesTheAddedLinesAlone_whenTheHunksDoNotFitTheCall", () => {
    const source = 'TEXT = """\n# not a comment\n"""\n';
    const forged = { file_path: codeFile("text.py", source), content: "# not a comment", keel_removed: "", keel_partial: true, keel_hunks: [[' TEXT = """']] };
    const elsewhere = { file_path: codeFile("other.py", "x = 1\n"), content: "# brand new note", keel_removed: "", keel_partial: true, keel_hunks: [[" y = 2", "+# brand new note"]] };

    assertCommentDenied(edit("Write", forged), "# not a comment");
    assertCommentDenied(edit("Write", elsewhere), "# brand new note");
  });

  it("codexPatch_passes_whenTheRemovedLinesAreNotText", () => {
    const toolArgs = { file_path: codeFile("keep.py", "x = 1\n# keeps x\n"), content: "# keeps x", keel_partial: true, keel_removed: 5 };

    assertPassed(edit("Write", toolArgs));
    assert.deepEqual(sandbox.fires().filter((fire) => fire.outcome === "error"), []);
  });

  it("write_passes_whenRemovedLinesComeWithoutThePartialFlag", () => {
    const toolArgs = { file_path: codeFile("keep.py", "x = 1\n# keeps x\n"), content: "x = 1\n# keeps x\n", keel_removed: "" };

    assertPassed(edit("Write", toolArgs));
  });

  it("bash_denied_whenAHeredocWritesACommentIntoACodeFile", () => {
    const path = codeFile("load.py");
    const viaCat = `cat > ${path} <<'EOF'\n# reads the rows\nrows = load()\nEOF`;
    const viaTee = `tee ${codeFile("save.ts")} <<'EOF' >/dev/null\n// saves the rows\nsave(rows);\nEOF`;

    assertCommentDenied(guard(viaCat), "# reads the rows");
    assertCommentDenied(guard(viaTee), "// saves the rows");
  });

  it("bash_judgesAnAppendAgainstTheFileOnDisk", () => {
    const path = codeFile("load.py", "# reads the rows\nrows = load()\n");
    const carried = `cat >> ${path} <<'EOF'\nrows.sort()\nEOF`;
    const added = `cat <<'EOF' >> ${path}\n# sorts the rows\nrows.sort()\nEOF`;

    assertPassed(guard(carried));
    assertCommentDenied(guard(added), "# sorts the rows");
  });

  it("bash_denied_whenAnAppendCopiesACommentThatAnOverwriteWouldCarry", () => {
    const path = codeFile("load.py", "# reads the rows\nrows = load()\n");

    assertPassed(guard(`cat > ${path} <<'EOF'\n# reads the rows\nEOF`));
    assertCommentDenied(guard(`cat >> ${path} <<'EOF'\n# reads the rows\nEOF`), "# reads the rows");
    assertPassed(guard(`tee ${path} <<< '# reads the rows' >/dev/null`));
    assertCommentDenied(guard(`tee -a ${path} <<< '# reads the rows' >/dev/null`), "# reads the rows");
  });

  it("bash_passes_whenTheHeredocHasNoCommentOrTheTargetIsNotCode", () => {
    const plain = `cat > ${codeFile("load.py")} <<'EOF'\nrows = load()\nEOF`;
    const notes = `cat > ${codeFile("notes.md")} <<'EOF'\n# Notes\nEOF`;

    const fromFile = `cat ${codeFile("source.py", "rows = load()\n")} <<'EOF' > ${codeFile("copy.py")}\n# ignored stdin\nEOF`;

    assertPassed(guard(plain));
    assertPassed(guard(notes));
    assertPassed(guard(fromFile));
  });

  it("bash_denied_whenAnOverwriteDropsTheDiskCommentsAndAddsOne", () => {
    const path = codeFile("load.py", "# reads the rows\nrows = load()\n");
    const command = `cat > ${path} <<'EOF'\n# loads every row\nrows = load()\nEOF`;

    assertCommentDenied(guard(command), "# loads every row");
  });

  it("bash_denied_whenAHeredocIsPipedIntoTee", () => {
    const path = codeFile("load.py");
    const piped = `cat <<'EOF' | tee ${path} >/dev/null\n# reads the rows\nEOF`;
    const redirectedAway = `cat > ${codeFile("rows.txt")} <<'EOF' | tee ${path}\n# reads the rows\nEOF`;
    const fromFile = `cat ${codeFile("source.py", "rows = load()\n")} <<'EOF' | tee ${path}\n# ignored stdin\nEOF`;

    assertCommentDenied(guard(piped), "# reads the rows");
    assertPassed(guard(redirectedAway));
    assertPassed(guard(fromFile));
  });

  it("bash_judgesEveryStdoutRedirectFormAsItsOverwriteOrAppend", () => {
    const path = codeFile("load.py", "# reads the rows\nrows = load()\n");

    for (const op of [">|", "&>"]) {
      assertPassed(guard(`cat ${op} ${path} <<'EOF'\n# reads the rows\nEOF`));
      assertCommentDenied(guard(`cat ${op} ${path} <<'EOF'\n# sorts the rows\nEOF`), "# sorts the rows");
    }
    assertPassed(guard(`cat &>> ${path} <<'EOF'\nrows.sort()\nEOF`));
    assertCommentDenied(guard(`cat &>> ${path} <<'EOF'\n# reads the rows\nEOF`), "# reads the rows");
    assertCommentDenied(guard(`tee --append ${path} <<< '# reads the rows' >/dev/null`), "# reads the rows");
  });

  it("bash_judgesEveryShellFileWriteOfStdout_asTheWriteTargetsDoes", () => {
    const path = codeFile("load.py", "rows = load()\n");

    assertCommentDenied(guard(`cat <<'EOF' >& ${path}\n# reads the rows\nEOF`), "# reads the rows");
    assertCommentDenied(guard(`cat <<'EOF' 1<> ${path}\n# reads the rows\nEOF`), "# reads the rows");
    assertPassed(guard(`cat <> ${path} <<'EOF'\n# reads the rows\nEOF`));
  });

  it("bash_judgesOnlyTheStdoutRedirect_whenStderrGoesToACodeFile", () => {
    assertPassed(guard(`cat <<'EOF' 2> ${codeFile("err.py")}\n# reads the rows\nEOF`));
    assertCommentDenied(guard(`cat <<'EOF' 1> ${codeFile("out.py")}\n# reads the rows\nEOF`), "# reads the rows");
  });

  it("bash_resolvesARelativeTargetAgainstTheDirectoryItCdsInto", () => {
    codeFile("q.py", "# reads the rows\nrows = load()\n");
    const source = join(sandbox.root, "src");

    assertPassed(guard(`cd ${source} && cat > q.py <<'EOF'\n# reads the rows\nEOF`));
    assertCommentDenied(guard(`cd ${source} && cat >> q.py <<'EOF'\n# reads the rows\nEOF`), "# reads the rows");
  });

  it("bash_judgesTheStdoutRedirect_whenAnFdRedirectComesFirst", () => {
    const path = codeFile("load.py");

    assertCommentDenied(guard(`cat <<'EOF' 2>/dev/null > ${path}\n# reads the rows\nEOF`), "# reads the rows");
    assertCommentDenied(guard(`tee 2<(true) > ${path} <<'EOF'\n# reads the rows\nEOF`), "# reads the rows");
  });

  it("bash_passes_whenThePipedProducerSendsStdoutToStderr", () => {
    const path = codeFile("load.py");

    assertPassed(guard(`cat <<'EOF' >&2 | tee ${path}\n# reads the rows\nEOF`));
    assertCommentDenied(guard(`cat <<'EOF' >&1 | tee ${path}\n# reads the rows\nEOF`), "# reads the rows");
    assertCommentDenied(guard(`cat <<'EOF' 2>&- | tee ${path}\n# reads the rows\nEOF`), "# reads the rows");
  });

  it("bash_readsTeeOperandsAfterDoubleDashAsFiles", () => {
    codeFile("-a.py", "# reads the rows\nrows = load()\n");
    const source = join(sandbox.root, "src");

    assertPassed(guard(`cd ${source} && tee -- -a.py <<< '# reads the rows' >/dev/null`));
    assertCommentDenied(guard(`cd ${source} && tee -- -a.py <<< '# sorts the rows' >/dev/null`), "# sorts the rows");
  });

  it("write_denied_whenAModuleDocstringOpensTheFile", () => {
    const content = '"""\nLoads the items.\n"""\nimport os\n';

    assertCommentDenied(edit("Write", { file_path: codeFile("load.py"), content }), "Loads the items.");
  });

  it("write_denied_whenAPythonDocstringIsAdded", () => {
    const content = 'def run():\n    """Run the job."""\n    return 1\n';

    assertCommentDenied(edit("Write", { file_path: codeFile("job.py"), content }), '"""Run the job."""');
  });

  it("write_passes_whenTheFileOnDiskAlreadyHasTheComment", () => {
    const path = codeFile("total.ts", "// SPDX-License-Identifier: MIT\n// old note\nexport const total = 1;\n");

    assertPassed(edit("Write", { file_path: path, content: "// SPDX-License-Identifier: MIT\n// old note\nexport const total = 2;\n" }));
  });

  it("write_passes_whenOnlyToolDirectivesAndNoticesAreAdded", () => {
    const shell = "#!/usr/bin/env bash\n# shellcheck disable=SC2086\necho $1\n";
    const script = "// @ts-check\n/* eslint-disable no-console */\n// Copyright 2026 Example Corp\n/// <reference types=\"node\" />\nconsole.log(1);\n";
    const python = "# -*- coding: utf-8 -*-\n# pylint: disable=invalid-name\nx = 1  # noqa: E501\n";

    assertPassed(edit("Write", { file_path: codeFile("run.sh"), content: shell }));
    assertPassed(edit("Write", { file_path: codeFile("log.js"), content: script }));
    assertPassed(edit("Write", { file_path: codeFile("names.py"), content: python }));
  });

  it("write_passes_forEachToolDirectiveAndNotice_butDeniesProseThatStartsLikeOne", () => {
    const directives: Array<[file: string, comment: string]> = [
      ["a.js", "// eslint-disable-next-line no-console"], ["a.js", "/* global window */"], ["a.js", "// prettier-ignore"],
      ["a.js", "// biome-ignore lint: reason"], ["a.ts", "// @ts-expect-error"], ["a.js", "/* istanbul ignore next */"],
      ["a.js", "/* c8 ignore next */"], ["a.js", "/* jshint esversion: 6 */"], ["a.ts", "// tslint:disable"], ["a.js", "/* #__PURE__ */"],
      ["a.ts", '/// <reference types="node" />'], ["a.py", "# noqa: E501"], ["a.py", "# type: ignore[attr]"], ["a.py", "# pylint: disable=C0103"],
      ["a.py", "# pyright: strict"], ["a.py", "# mypy: ignore-errors"], ["a.py", "# fmt: off"], ["a.py", "# isort: skip_file"],
      ["a.py", "# -*- coding: utf-8 -*-"], ["a.py", "# vim: fileencoding=utf-8"], ["a.c", "#pragma once"], ["a.go", "//nolint:errcheck"],
      ["a.go", "//go:build linux"], ["a.go", "// +build linux"], ["a.sh", "# shellcheck disable=SC2086"], ["a.java", "// NOSONAR"],
      ["a.java", "// CHECKSTYLE:OFF"], ["a.java", "//noinspection unchecked"], ["a.java", "// language=SQL"],
      ["a.ts", "// SPDX-License-Identifier: MIT"], ["a.ts", "// Copyright 2026 Example Corp"], ["a.ts", "// (c) 2026 Example Corp"],
      ["a.ts", "// © 2026 Example Corp"], ["a.rb", "# frozen_string_literal: true"], ["a.rb", "# rubocop:disable Style/Foo"],
      ["a.tsx", "/** @jsxImportSource @emotion/react */"], ["a.tsx", "/** @jsx h */"], ["a.ts", "// @vitest-environment jsdom"],
      ["a.ts", "/** @jest-environment jsdom */"], ["a.cpp", "// NOLINT"], ["a.cpp", "// NOLINTNEXTLINE(bugprone-x)"],
      ["a.sql", "--liquibase formatted sql"], ["a.sql", "--changeset dev:1"], ["a.ts", '/* webpackChunkName: "m" */'],
      ["a.swift", "// swiftlint:disable force_cast"], ["a.tsx", "/** @jsxRuntime classic */"], ["a.cpp", "// NOLINTBEGIN(bugprone-x)"],
      ["a.cpp", "// NOLINTEND(bugprone-x)"], ["a.py", "# ruff: noqa"],
      ["a.cpp", "// clang-format off"], ["a.cpp", "// clang-format on"], ["a.py", "# yapf: disable"], ["a.js", "// @flow"],
      ["a.js", "// @flow strict"], ["a.js", "/* @flow weak */"], ["a.ts", "// deno-lint-ignore no-explicit-any"],
    ];
    const prose: Array<[file: string, comment: string]> = [
      ["b.c", "// pragmatic shortcut for now"], ["b.js", "// eslintrc settings apply here"], ["b.cpp", "// NOLINTED by accident"],
      ["b.rb", "# rubocop is strict here"], ["b.swift", "// swiftlint is noisy"], ["b.sql", "-- changesets merge here"],
      ["b.py", "# noqable rows are skipped"], ["b.js", "// @flowtype is legacy"],
      ["Repo.java", "// rollback the transaction when the save fails"], ["b.java", "// comment: the cache is warm here"],
      ["b.ts", "// preconditions are checked by the caller"], ["b.cpp", "// clang-format is set in the repo root"],
      ["b.js", "// @flow control returns early here"], ["b.sql", "--precondition-sql-check expectedResult:0 SELECT 1"],
    ];

    for (const [file, comment] of directives) assertPassed(edit("Write", { file_path: codeFile(file), content: `${comment}\nx = 1\n` }));
    for (const [file, comment] of prose) assertCommentDenied(edit("Write", { file_path: codeFile(file), content: `${comment}\nx = 1\n` }), comment);
  });

  it("write_passes_whenCommentMarkersSitInsideStringsOrNonCodeFiles", () => {
    const script = 'export const url = "https://example.invalid/a";\nconst glob = "/*.ts";\n';

    assertPassed(edit("Write", { file_path: codeFile("url.ts"), content: script }));
    assertPassed(edit("Write", { file_path: codeFile("README.md"), content: "# Title\n// not code\n" }));
    assertPassed(edit("Write", { file_path: codeFile("app.yaml"), content: "# config note\nkey: 1\n" }));
  });

  it("write_denied_whenACodeLineEndsInAComment", () => {
    assertCommentDenied(edit("Write", { file_path: codeFile("count.ts"), content: "const n = 1; // counts the rows\n" }), "// counts the rows");
    assertCommentDenied(edit("Write", { file_path: codeFile("half.ts"), content: "const half = total / 2; // halves\n" }), "// halves");
    assertCommentDenied(edit("Write", { file_path: codeFile("ratio.ts"), content: "const ratio = \"4\" / 2; // ratio\n" }), "// ratio");
    assertCommentDenied(edit("Write", { file_path: codeFile("block.ts"), content: "const n = 1; /* counts */ const m = 2;\n" }), "/* counts */");
    assertCommentDenied(edit("Write", { file_path: codeFile("count.py"), content: "n = 1  # counts the rows\n" }), "# counts the rows");
    assertCommentDenied(edit("Write", { file_path: codeFile("run.sh"), content: "echo hi # greets\n" }), "# greets");
    assertCommentDenied(edit("Write", { file_path: codeFile("count.sql"), content: "SELECT 1; -- counts\n" }), "-- counts");
    assertCommentDenied(edit("Write", { file_path: codeFile("site.css"), content: "a { color: red; } /* brand */\n" }), "/* brand */");
  });

  it("write_denied_whenABlockCommentOpensAfterCodeAndSpansLines", () => {
    const content = "const n = 1; /* starts here\nstill inside\n*/\nconst m = 2;\n";

    assertCommentDenied(edit("Write", { file_path: codeFile("span.ts"), content }), "still inside");
  });

  it("edit_denied_whenATrailingCommentIsReworded", () => {
    const path = codeFile("rows.ts", "const n = rows.length; // counts the rows\n");
    const toolArgs = { file_path: path, old_string: "// counts the rows", new_string: "// counts every row" };

    assertCommentDenied(edit("Edit", toolArgs), "// counts every row");
  });

  it("edit_passes_whenTheCodeChangesAndItsTrailingCommentStays", () => {
    const path = codeFile("rows.py", "n = len(rows)  # counts the rows\n");
    const toolArgs = { file_path: path, old_string: "n = len(rows)", new_string: "n = len(items)" };

    assertPassed(edit("Edit", toolArgs));
  });

  it("write_passes_whenTrailingMarkersSitInsideStringsOrRegexes", () => {
    const script = "const url = \"https://example.invalid\"; const quote = 'it\\'s // fine';\nconst scheme = /^https?:\\/\\//; const half = total / 2 / count;\n";
    const shell = "echo \"keep # this\" ${#items[@]} ${name#pre} $#\n";

    assertPassed(edit("Write", { file_path: codeFile("strings.ts"), content: script }));
    assertPassed(edit("Write", { file_path: codeFile("strings.py"), content: "s = \"# not\" + '# not'\n" }));
    assertPassed(edit("Write", { file_path: codeFile("count.sh"), content: shell }));
    assertPassed(edit("Write", { file_path: codeFile("q.sql"), content: "SELECT '-- not', 'it''s -- not';\n" }));
    assertPassed(edit("Write", { file_path: codeFile("cdn.css"), content: "a { background: url(//cdn.example.invalid/x.png); }\n" }));
  });

  it("write_passes_whenARegexHoldsSlashesInAClassOrFollowsAKeyword", () => {
    const classed = "const R = /\\/\\.git\\/(w\\/[^/]+\\/)?m\\//;\n";
    const keyword = "function f(s) {\n  return /^https?:\\/\\//.test(s) || /\\/*/.test(s);\n}\nconst x = 1;\n";

    assertPassed(edit("Write", { file_path: codeFile("classed.ts"), content: classed }));
    assertPassed(edit("Write", { file_path: codeFile("keyword.ts"), content: keyword }));
  });

  it("write_passes_whenAStringSpansLines", () => {
    const textBlock = "String s = \"\"\"\n    see https://example.invalid\n    \"\"\";\n";
    const shell = "echo \"first\nsecond # not a comment\n\"\n";

    assertPassed(edit("Write", { file_path: codeFile("Block.java"), content: textBlock }));
    assertPassed(edit("Write", { file_path: codeFile("lines.sh"), content: shell }));
    assertPassed(edit("Write", { file_path: codeFile("lines.sql"), content: "SELECT 'first -- not a comment\nsecond -- still text';\n" }));
  });

  it("write_passes_whenABackslashIsLiteralInTheString", () => {
    assertPassed(edit("Write", { file_path: codeFile("path.sql"), content: "SELECT 'C:\\', 'a -- b';\n" }));
    assertPassed(edit("Write", { file_path: codeFile("Path.cs"), content: "var p = @\"C:\\\"; var q = \"// no\";\n" }));
    assertPassed(edit("Write", { file_path: codeFile("path.sh"), content: "echo 'C:\\' \"# no\"\n" }));
    assertCommentDenied(edit("Write", { file_path: codeFile("copy.sh"), content: "cp 'C:\\' out # copies the drive\n" }), "# copies the drive");
  });

  it("write_denied_whenAShiftOrHereStringPrecedesAComment", () => {
    assertCommentDenied(edit("Write", { file_path: codeFile("shift.sh"), content: "n=$(( 1 << shift ))\n# shifts the bit\n" }), "# shifts the bit");
    assertCommentDenied(edit("Write", { file_path: codeFile("word.sh"), content: "cat <<< word\n# reads the word\n" }), "# reads the word");
  });

  it("write_denied_whenALineStartCommentFollowsAQuoteLeftOpen", () => {
    assertCommentDenied(edit("Write", { file_path: codeFile("name.sql"), content: "INSERT INTO t VALUES ('O\\'Brien');\n-- adds a row\n" }), "-- adds a row");
    assertCommentDenied(edit("Write", { file_path: codeFile("ansi.sh"), content: "echo $'it\\'s'\n# prints it\n" }), "# prints it");
    assertCommentDenied(edit("Write", { file_path: codeFile("nested.sh"), content: "x=\"$(cmd \"it's\")\"\n# runs cmd\n" }), "# runs cmd");
    assertCommentDenied(edit("Write", { file_path: codeFile("match.rb"), content: "ok = name =~ /it's/\n# checks the name\n" }), "# checks the name");
  });

  it("write_denied_whenAKotlinRawStringEndsInABackslash", () => {
    assertCommentDenied(edit("Write", { file_path: codeFile("Path.kt"), content: "val p = \"\"\"C:\\\"\"\"\nval q = 1 // sets q\n" }), "// sets q");
  });

  it("write_skipsAHeredocAfterClosedArithmetic", () => {
    assertPassed(edit("Write", { file_path: codeFile("sum.sh"), content: "n=$((1+2)); cat <<EOF\n# Title\nEOF\n" }));
    assertPassed(edit("Write", { file_path: codeFile("quoted.sh"), content: "x=\"(( \"; cat <<EOF\n# Title\nEOF\n" }));
    assertPassed(edit("Write", { file_path: codeFile("spec.rb"), content: "expect(call(x)).to eq(<<~EOS)\n# Title\nEOS\n" }));
  });

  it("write_denied_whenALineInsideAMultiLineStringStartsWithAMarker", () => {
    const textBlock = "String s = \"\"\"\n  // not code\n  \"\"\";\n";

    assertCommentDenied(edit("Write", { file_path: codeFile("Block.java"), content: textBlock }), "// not code");
    assertCommentDenied(edit("Write", { file_path: codeFile("lines.sql"), content: "SELECT 'first\n-- not a comment\n';\n" }), "-- not a comment");
  });

  it("write_passes_whenAQuoteOrTemplateLeavesTheLineOpen", () => {
    const template = "const page = `\n  see https://example.invalid // not a comment\n`;\n";

    assertPassed(edit("Write", { file_path: codeFile("open.ts"), content: "const s = 'unterminated // x\n" }));
    assertPassed(edit("Write", { file_path: codeFile("page.ts"), content: template }));
  });

  it("write_passes_whenTrailingCommentsAreToolDirectives", () => {
    const content = "run(); // eslint-disable-line no-console\nconst x = y as any; // @ts-expect-error\n";

    assertPassed(edit("Write", { file_path: codeFile("lint.ts"), content }));
  });

  it("write_skipsHeredocBodiesInAShellScript", () => {
    const script = "cat <<'EOF' > notes.txt\nvalue # literal\nEOF\necho done # after\n";

    assertCommentDenied(edit("Write", { file_path: codeFile("notes.sh"), content: script }), "# after");
    assertPassed(edit("Write", { file_path: codeFile("quiet.sh"), content: "cat << EOF\nvalue # literal\nEOF\n" }));
  });

  it("write_denied_whenARubyAppendIsFollowedByAComment", () => {
    const content = "items << item\nputs items # prints the list\n";

    assertCommentDenied(edit("Write", { file_path: codeFile("list.rb"), content }), "# prints the list");
  });

  it("bash_denied_whenAHeredocWritesATrailingComment", () => {
    const path = codeFile("tail.ts");
    const command = `cat > ${path} <<'EOF'\nconst n = 1; // counts\nEOF`;

    assertCommentDenied(guard(command), "// counts");
  });
});
