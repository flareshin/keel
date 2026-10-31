import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { HANDOFF, HookSandbox } from "./helpers.ts";
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

const LEGACY_AUTO_SNAPSHOT_NOTE = [
  "# HANDOFF — app",
  "",
  "## Resume point",
  "(auto-snapshot before auto compaction · transcript: /data/projects/p/s1.jsonl)",
  "",
  "## Location",
  "- Branch: `main`",
  "",
].join("\n");

function handoffFile(mainRepo: string = repo): string {
  return join(sandbox.data, "handoff", mainRepo.replace(/[^A-Za-z0-9]/g, "-") + ".md");
}

function cli(args: string[], cwd: string = repo): HookResult {
  return sandbox.runHook(HANDOFF, { args, cwd });
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("CliModesTest", () => {
  it("note_isReadBack_whenRecorded", () => {
    cli(["next: start from the repro test"]);
    assert.ok(cli(["--read"]).stdout.includes("next: start from the repro test"));
  });

  it("status_reportsResumePoint_whenNoteWrittenByPerson", () => {
    cli(["next: start from the repro test"]);
    assert.deepEqual(JSON.parse(cli(["--status"]).stdout), { path: handoffFile(), hasResumePoint: true });
  });

  it("status_reportsNoResumePoint_whenOnlyAutoSnapshotFromAnOlderVersion", () => {
    sandbox.write(handoffFile(), LEGACY_AUTO_SNAPSHOT_NOTE);
    assert.equal(JSON.parse(cli(["--status"]).stdout).hasResumePoint, false);
  });

  it("status_reportsResumePoint_whenANoteStartsWithAnAutoSnapshotLineFollowedByText", () => {
    cli(["(auto-snapshot x)\nnext: real step"]);
    assert.equal(JSON.parse(cli(["--status"]).stdout).hasResumePoint, true);
  });

  it("status_reportsResumePoint_whenAnOlderVersionAppendedAnAutoSnapshotAfterAHandNote", () => {
    const note = LEGACY_AUTO_SNAPSHOT_NOTE.replace("## Resume point\n", "## Resume point\nnext: real step\n");
    sandbox.write(handoffFile(), note);
    assert.equal(JSON.parse(cli(["--status"]).stdout).hasResumePoint, true);
  });

  it("unknownMode_isRecordedAsTheNote_whenNotACommand", () => {
    const result = cli(["--auto"]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(`handoff recorded: ${handoffFile()}`), result.stdout);
    assert.ok(read(handoffFile()).includes("## Resume point\n--auto\n"));
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
