import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { TestContext } from "node:test";
import { join } from "node:path";
import { Sandbox } from "../ship-gate/helpers.ts";
import { bash, GIT_GUARD, KEEL_HOME } from "./helpers.ts";

const SETUP_TIMEOUT_MS = 120_000;
const HOOK_TIMEOUT_MS = 60_000;
const REVIEW_ROOT_RUN_ID = "rv-root-0001";
const KEPT_SANDBOX = { after: () => undefined } as unknown as TestContext;

interface ApprovedTarget {
  root: string;
  repo: string;
  target: string;
  env: Record<string, string>;
}

let approved: ApprovedTarget;

before(() => {
  const box = new Sandbox(KEPT_SANDBOX);
  const repo = box.clone("acme", "app");
  const behind = repo.head();
  repo.commit({ "src/a.py": "print(2)\n", "tests/test_a.py": "assert 2 == 2\n" });
  const target = repo.head();
  box.review(repo);
  box.testsEvidence(repo);
  repo.git("checkout", "--detach", target);
  box.approve(REVIEW_ROOT_RUN_ID);
  repo.git("checkout", "--detach", behind);
  approved = { root: box.root, repo: repo.path, target, env: box.env };
}, { timeout: SETUP_TIMEOUT_MS });

after(() => {
  if (approved) rmSync(approved.root, { recursive: true, force: true });
});

function guardInApprovedCheckout(command: string): { code: number | null; stderr: string } {
  const completed = spawnSync(process.execPath, [join(KEEL_HOME, GIT_GUARD)], {
    input: JSON.stringify(bash(command, approved.repo)), encoding: "utf8", cwd: approved.repo, timeout: HOOK_TIMEOUT_MS,
    env: { ...approved.env, KEEL_HOME: approved.repo },
  });
  return { code: completed.status, stderr: completed.stderr };
}

describe("ApprovedFastForwardTest", () => {
  it("merge_passes_whenFastForwardOnlyToTheOwnerApprovedCommit", () => {
    const result = guardInApprovedCheckout(`git merge --ff-only ${approved.target}`);
    assert.equal(result.code, 0, result.stderr);
  });

  it("merge_deniedWithCIsolation_whenNotFastForwardOnly", () => {
    const result = guardInApprovedCheckout(`git merge ${approved.target}`);
    assert.equal(result.code, 2, result.stderr);
    assert.ok(result.stderr.includes("[C-isolation]"), result.stderr);
  });

  it("merge_deniedWithCIsolation_whenFastForwardOnlyToAnUnapprovedName", () => {
    const result = guardInApprovedCheckout("git merge --ff-only main");
    assert.equal(result.code, 2, result.stderr);
    assert.ok(result.stderr.includes("[C-isolation]"), result.stderr);
  });
});
