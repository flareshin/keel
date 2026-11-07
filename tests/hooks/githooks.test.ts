import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const GITHOOKS = join(import.meta.dirname, "..", "..", "githooks");
const BLOCKED = 1;

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keel-githooks-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  mkdirSync(join(root, "empty-overlay"));
  env = { ...process.env, KEEL_OVERLAY_DIR: join(root, "empty-overlay") };
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git("add", "a.txt");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr.toString());
}

function fakeKeelHome(): string {
  const home = join(root, "fake-keel");
  mkdirSync(join(home, "measure"), { recursive: true });
  writeFileSync(join(home, "measure", "boundary"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  return home;
}

function runHook(name: string, extraEnv: NodeJS.ProcessEnv, input = ""): number | null {
  return spawnSync(join(GITHOOKS, name), [], { cwd: repo, env: { ...env, ...extraEnv }, input }).status;
}

describe("GithooksBoundaryTest", () => {
  it("preCommit_blocks_whenTheScannerCannotRun", () => {
    assert.equal(runHook("pre-commit", {}), BLOCKED);
  });

  it("preCommit_stillRunsTheRealScanner_whenTheEnvironmentNamesAnotherOne", () => {
    assert.equal(runHook("pre-commit", { KEEL_BOUNDARY: "/usr/bin/true" }), BLOCKED);
    assert.equal(runHook("pre-commit", { KEEL_HOME: fakeKeelHome() }), BLOCKED);
  });

  it("prePush_stillRunsTheRealScanner_whenTheEnvironmentNamesAnotherOne", () => {
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "first");
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
    const line = `refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`;
    assert.equal(runHook("pre-push", { KEEL_BOUNDARY: "/usr/bin/true" }, line), BLOCKED);
    assert.equal(runHook("pre-push", { KEEL_HOME: fakeKeelHome() }, line), BLOCKED);
  });

  it("prePush_passesWithoutScanning_whenTheRefIsDeleted", () => {
    const zeros = "0".repeat(40);
    assert.equal(runHook("pre-push", {}, `(delete) ${zeros} refs/heads/old ${"1".repeat(40)}\n`), 0);
    assert.equal(runHook("pre-push", {}, ""), 0);
  });
});
