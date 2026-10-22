import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { assertFired, basePayload, HANDOFF, HookSandbox } from "./helpers.ts";
import type { HookResult } from "./helpers.ts";

let sandbox: HookSandbox;
let repo: string;

beforeEach(() => {
  sandbox = new HookSandbox();
  repo = sandbox.makeRepo("example", "app");
});

afterEach(() => {
  sandbox.close();
});

function handoffFile(mainRepo: string = repo): string {
  return join(sandbox.data, "handoff", mainRepo.replace(/[^A-Za-z0-9]/g, "-") + ".md");
}

function auto(options: { cwd?: string; raw?: string } = {}): HookResult {
  const cwd = options.cwd ?? repo;
  const payload = { ...basePayload("PreCompact", cwd, "/data/projects/p/s1.jsonl", false), trigger: "auto", custom_instructions: "" };
  return sandbox.runHook(HANDOFF, { payload, args: ["--auto"], cwd, raw: options.raw });
}

function cli(args: string[], cwd: string = repo): HookResult {
  return sandbox.runHook(HANDOFF, { args, cwd });
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("AutoSnapshotTest", () => {
  it("auto_writesSnapshotAndRecordsFire_whenInsideRepo", () => {
    sandbox.write(join(repo, "wip.txt"), "x\n");
    const result = auto();
    assert.equal(result.code, 0);
    const text = read(handoffFile());
    assert.ok(text.includes("(auto-snapshot before auto compaction · transcript: /data/projects/p/s1.jsonl)"), text);
    assert.ok(text.includes("- Branch: `main`"), text);
    assert.ok(text.includes("## Uncommitted (1)"), text);
    assertFired(sandbox, "C-handoff", "record", "handoff");
  });

  it("auto_passesWithoutFile_whenOutsideRepo", () => {
    const outside = join(sandbox.root, "plain");
    mkdirSync(outside);
    const result = auto({ cwd: outside });
    assert.equal(result.code, 0);
    assert.equal(existsSync(join(sandbox.data, "handoff")), false);
    assert.deepEqual(sandbox.fires(), []);
  });

  it("auto_keepsHandWrittenNote_whenSameBranch", () => {
    cli(["next: rerun the parser test"]);
    auto();
    assert.ok(read(handoffFile()).includes("next: rerun the parser test\n(auto-snapshot before auto"));
  });

  it("auto_writesNothing_whenNoteBelongsToAnotherBranch", () => {
    cli(["next: rerun the parser test"]);
    const before = read(handoffFile());
    sandbox.git(repo, "checkout", "-q", "-b", "other");
    auto();
    assert.equal(read(handoffFile()), before);
  });

  it("auto_keysOnMainRepo_whenRunInWorktree", () => {
    const worktree = join(sandbox.root, "wt-feature");
    sandbox.git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    auto({ cwd: worktree });
    assert.ok(read(handoffFile()).includes(`- Working worktree: \`${worktree}\``));
  });

  it("auto_passesAndLogsError_whenHandoffDirIsAFile", () => {
    sandbox.write(join(sandbox.data, "handoff"), "not a dir");
    const result = auto();
    assert.equal(result.code, 0);
    assertFired(sandbox, "C-handoff", "error", "handoff");
  });

  it("auto_usesProcessCwd_whenPayloadUnparseable", () => {
    const result = auto({ raw: "not json" });
    assert.equal(result.code, 0);
    assert.ok(existsSync(handoffFile()));
  });
});

describe("CliModesTest", () => {
  it("note_isReadBack_whenRecorded", () => {
    cli(["next: start from the repro test"]);
    assert.ok(cli(["--read"]).stdout.includes("next: start from the repro test"));
  });

  it("status_reportsResumePoint_whenNoteWrittenByPerson", () => {
    cli(["next: start from the repro test"]);
    assert.deepEqual(JSON.parse(cli(["--status"]).stdout), { path: handoffFile(), hasResumePoint: true });
  });

  it("status_reportsNoResumePoint_whenOnlyAutoSnapshot", () => {
    auto();
    assert.equal(JSON.parse(cli(["--status"]).stdout).hasResumePoint, false);
  });

  it("clear_removesFile_whenPresent", () => {
    cli(["next: x"]);
    cli(["--clear"]);
    assert.equal(existsSync(handoffFile()), false);
  });

  it("path_printsHandoffLocation", () => {
    assert.equal(cli(["--path"]).stdout.trim(), handoffFile());
  });

  it("cli_failsWithUsage_whenOutsideRepo", () => {
    const outside = join(sandbox.root, "plain");
    mkdirSync(outside);
    const result = cli(["--path"], outside);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("inside a git repo"), result.stderr);
  });
});
