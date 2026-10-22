import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import { bash, GIT_GUARD, KEEL_HOME } from "./helpers.ts";

const SETUP = join(import.meta.dirname, "approved_fast_forward_setup.py");
const SETUP_TIMEOUT_MS = 120_000;
const HOOK_TIMEOUT_MS = 60_000;

interface ApprovedTarget {
  root: string;
  repo: string;
  target: string;
  env: Record<string, string>;
}

let approved: ApprovedTarget;

before(() => {
  const setup = spawnSync("python3", [SETUP], { encoding: "utf8", timeout: SETUP_TIMEOUT_MS });
  assert.equal(setup.status, 0, setup.stderr);
  approved = JSON.parse(setup.stdout);
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
