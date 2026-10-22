import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import {
  bash, ENV_PREFLIGHT, GIT_GUARD, HookSandbox, MODEL_ASSIGN, preToolUse, REPORT_GATE, SEEDED_RULE_IDS, SHIP_GATE, subagentStop,
} from "./helpers.ts";
import { HANDBACK_TAIL } from "../../hooks/report-gate/report-gate.ts";

const FIRST_LINE = /^\[[A-Za-z0-9-]+\] (ship-gate|git-guard|report-gate|model-assign|env-preflight): \S/;
const BULLET = /^- \[[A-Za-z0-9-]+\] \S/;
const RUN_YOURSELF = "Run it yourself in your terminal: ";
const ASK_USER = "Stop and ask the user.";
const MESSAGE_LIMIT = 2000;
const NEXT_STEPS = [RUN_YOURSELF, ASK_USER, HANDBACK_TAIL];

let sandbox: HookSandbox;

beforeEach(() => {
  sandbox = new HookSandbox();
  sandbox.env["KEEL_BOUNDARY"] = sandbox.stub("boundary", { stdout: '{"scanned": 1, "hits": []}' });
  sandbox.env["KEEL_CLI"] = sandbox.stub("keel", { stdout: "{}" });
  sandbox.putStubClaudeOnPath();
});

afterEach(() => {
  sandbox.close();
});

function messageLines(message: string): string[] {
  return message.replace(/\n+$/, "").split("\n");
}

function assertDenyShape(message: string): void {
  const lines = messageLines(message);
  assert.match(lines[0] ?? "", FIRST_LINE);
  assert.ok(lines.length >= 3, message);
  for (const line of lines.slice(1, -1)) assert.match(line, BULLET);
  const last = lines[lines.length - 1] ?? "";
  assert.ok(NEXT_STEPS.some((step) => last.startsWith(step)) || message.includes(RUN_YOURSELF), message);
  assert.ok(Array.from(message.replace(/\n+$/, "")).length <= MESSAGE_LIMIT, message);
}

function assertWarnShape(message: string): void {
  const lines = messageLines(message);
  assert.match(lines[0] ?? "", FIRST_LINE);
  for (const line of lines.slice(1)) assert.ok(BULLET.test(line) || FIRST_LINE.test(line), line);
  assert.ok(Array.from(message).length <= MESSAGE_LIMIT, message);
}

function gatedFeatureRepo(): string {
  sandbox.write(join(sandbox.overlay, "gated-repos.tsv"),
    "origin\tgate\tintegration_base\trisk_rules\ttests\nacme/app\tcode\tmain\t-\trequired\n");
  const repo = sandbox.makeRepo("acme", "app");
  sandbox.git(repo, "checkout", "-q", "-b", "feature");
  sandbox.commitFile(repo, "src/a.py", "x\n", "feature work");
  return repo;
}

describe("MessageContractTest", () => {
  it("shipGate_deny_followsTheContract", () => {
    const repo = gatedFeatureRepo();
    const result = sandbox.runHook(SHIP_GATE, { payload: bash("git push origin feature", repo) });
    assert.equal(result.code, 2, result.stderr);
    assertDenyShape(result.stderr);
    assert.ok(messageLines(result.stderr).pop()?.startsWith(RUN_YOURSELF + "cd "), result.stderr);
  });

  it("shipGate_warn_followsTheContract", () => {
    const repo = gatedFeatureRepo();
    const result = sandbox.runHook(SHIP_GATE, { payload: bash("gh pr create --title t --body b", repo) });
    assert.equal(result.code, 0, result.stderr);
    assertWarnShape(result.json().hookSpecificOutput.additionalContext);
  });

  it("shipGate_failClosed_followsTheContract", () => {
    const result = sandbox.runHook(SHIP_GATE, {
      raw: '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin x"',
    });
    assert.equal(result.code, 2);
    assertDenyShape(result.stderr);
  });

  it("gitGuard_bashDeny_followsTheContract", () => {
    const repo = sandbox.makeRepo("example", "app");
    const result = sandbox.runHook(GIT_GUARD, { payload: bash("git push --force origin main", repo) });
    assert.equal(result.code, 2, result.stderr);
    assertDenyShape(result.stderr);
    assert.ok(result.stderr.replace(/\n+$/, "").endsWith(`${RUN_YOURSELF}cd ${repo} && git push --force origin main`));
  });

  it("gitGuard_editDeny_followsTheContract", () => {
    const target = join(sandbox.data, "state", "keel", "evidence", "x.json");
    const result = sandbox.runHook(GIT_GUARD, { payload: preToolUse("Write", { file_path: target, content: "{}" }, sandbox.root) });
    assert.equal(result.code, 2);
    assertDenyShape(result.stderr);
    assert.equal(messageLines(result.stderr).pop(), ASK_USER);
  });

  it("gitGuard_failClosed_followsTheContract", () => {
    const result = sandbox.runHook(GIT_GUARD, { raw: '{"tool_input": {"command": "git push"' });
    assert.equal(result.code, 2);
    assertDenyShape(result.stderr);
  });

  it("reportGate_handbackDeny_followsTheContract", () => {
    sandbox.agentTranscript("[SCOPE] /work/app\nDo it.");
    const payload = preToolUse("SubagentHandback", { message: "Done, VERDICT: PASS" }, sandbox.root, sandbox.mainTranscript(), true);
    const result = sandbox.runHook(REPORT_GATE, { payload });
    assert.equal(result.code, 2);
    assertDenyShape(result.stderr);
  });

  it("reportGate_stopBlock_followsTheContract", () => {
    const transcript = sandbox.agentTranscript("[SCOPE] /work/app\nDo it.", [["Edit", { file_path: "/elsewhere/x.py" }]]);
    const payload = subagentStop(sandbox.root, sandbox.mainTranscript(), transcript, "Done.");
    const result = sandbox.runHook(REPORT_GATE, { payload });
    assert.equal(result.json().decision, "block");
    assertDenyShape(result.json().reason);
  });

  it("modelAssign_deny_followsTheContract", () => {
    const payload = preToolUse("Workflow", { script: "await agent('probe', {effort: 'medium'})" }, sandbox.root);
    const result = sandbox.runHook(MODEL_ASSIGN, { payload });
    assert.equal(result.code, 2);
    assertDenyShape(result.stderr);
  });

  it("envPreflight_deny_followsTheContract", () => {
    sandbox.useExampleOverlay("stack-data/spring-maven/jdk.tsv");
    const repo = sandbox.makeRepo("acmecorp", "billing");
    const result = sandbox.runHook(ENV_PREFLIGHT, { payload: bash("mvn -q test", repo) });
    assert.equal(result.code, 2, result.stderr);
    assertDenyShape(result.stderr);
  });

  it("longDeny_isCappedAndKeepsItsLastLine", () => {
    const repo = sandbox.makeRepo("example", "app");
    const paths = Array.from({ length: 400 }, (_, index) => `f${String(index).padStart(3, "0")}.sql`);
    for (const path of paths) sandbox.write(join(repo, path), "select 1;\n");
    sandbox.git(repo, "add", ...paths);
    sandbox.write(join(sandbox.overlay, "git-guard", "repo-rules.tsv"),
      "origin_glob\taction\tpattern\trule_id\tmessage\nexample/*\tdeny-path\t*.sql\tO-files\tNo SQL.\n");
    const result = sandbox.runHook(GIT_GUARD, { payload: bash("git commit -m 'Add sql'", repo) });
    assert.equal(result.code, 2);
    assertDenyShape(result.stderr);
    assert.ok(result.stderr.includes("…and 390 more"), result.stderr);
  });

  it("everyFiresLine_namesASeededRuleId", () => {
    gatedFeatureRepo();
    for (const fire of sandbox.fires()) assert.ok(SEEDED_RULE_IDS.has(fire.rule_id), JSON.stringify(fire));
  });
});
