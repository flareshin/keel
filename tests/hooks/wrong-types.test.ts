import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import {
  AGENT_ID, bash, ENV_PREFLIGHT, GIT_GUARD, HookSandbox, KEEL_HOME, MODEL_ASSIGN, preToolUse, REPORT_GATE, SESSION_ID, SHIP_GATE, subagentStop,
} from "./helpers.ts";
import type { HookResult } from "./helpers.ts";

const DENY = 2;
const PASS = 0;
const WRITTEN_BY_CLAUDE = "git commit -m 'Written by Claude'";
const OUTSIDE_EDIT = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/elsewhere/b.py" } }] } };

let sandbox: HookSandbox;
let repo: string;

function errorFires(hook: string): string[] {
  return sandbox.fires().filter((fire) => fire.hook === hook && fire.outcome === "error").map((fire) => fire.detail ?? "");
}

function run(script: string, payload: unknown, cwd = sandbox.root): HookResult {
  return sandbox.runHook(script, { payload, cwd });
}

before(() => {
  sandbox = new HookSandbox();
  repo = sandbox.makeRepo("acmecorp", "billing");
  sandbox.useExampleOverlay("stack-data/spring-maven/jdk.tsv");
});
after(() => sandbox.close());

describe("git-guard reads a field of the wrong type as a refusal, never as a pass", () => {
  it("denies a guarded command that arrives as a list and logs why", () => {
    const result = run(GIT_GUARD, preToolUse("Bash", { command: ["git", "commit", "-m", "Written by Claude"] }, repo), repo);
    assert.equal(result.code, DENY);
    assert.match(result.stderr, /internal error on a guarded command/);
    assert.match(errorFires("git-guard").at(-1) ?? "", /^FieldTypeError: command must be a string, not list$/);
  });

  it("raises for a command that is a number and does not look guarded", () => {
    const result = run(GIT_GUARD, preToolUse("Bash", { command: 5 }, repo), repo);
    assert.equal(result.code, PASS);
    assert.match(errorFires("git-guard").at(-1) ?? "", /^FieldTypeError: command must be a string, not number$/);
  });

  for (const [label, cwd] of [["false", false], ["zero", 0], ["empty list", []], ["empty object", {}], ["number", 5], ["object", { k: "v" }]] as const) {
    it(`judges a command against the process directory when cwd is ${label}`, () => {
      const result = run(GIT_GUARD, { ...bash(`echo x > ${join(sandbox.overlay, "f")}`, repo), cwd }, repo);
      assert.equal(result.code, DENY);
      assert.match(result.stderr, /\[C-isolation\]/);
    });

    it(`raises for a command that nothing denies when cwd is ${label}`, () => {
      const result = run(GIT_GUARD, { ...bash("ls", repo), cwd }, repo);
      assert.equal(result.code, PASS);
      assert.match(errorFires("git-guard").at(-1) ?? "", /^FieldTypeError: cwd must be a string, not /);
    });
  }

  for (const [label, filePath] of [["number", 5], ["true", true], ["object", { k: "v" }], ["list", ["x"]], ["false", false], ["zero", 0], ["empty list", []], ["empty object", {}]] as const) {
    it(`denies a write whose file_path is ${label} when the call starts in the overlay`, () => {
      const result = run(GIT_GUARD, preToolUse("Write", { file_path: filePath, content: "x" }, sandbox.overlay));
      assert.equal(result.code, DENY);
      assert.match(result.stderr, /\[C-isolation\]/);
    });

    it(`raises for a write whose file_path is ${label} when nothing denies it`, () => {
      const result = run(GIT_GUARD, preToolUse("Write", { file_path: filePath, content: "x" }, repo));
      assert.equal(result.code, PASS);
      assert.match(errorFires("git-guard").at(-1) ?? "", /^FieldTypeError: file_path must be a string, not /);
    });
  }

  for (const [where, rule] of [["overlay", "C-isolation"], ["protected store", "K1"], ["live checkout", "C-isolation"]] as const) {
    const notebook = () => ({ overlay: join(sandbox.overlay, "ledger.tsv"), "protected store": join(sandbox.data, "state", "keel", "x.json"), "live checkout": join(KEEL_HOME, "README.md") })[where];
    for (const [label, filePath] of [["number", 5], ["true", true], ["object", { k: "v" }], ["list", ["x"]], ["false", false], ["zero", 0], ["empty list", []], ["empty object", {}]] as const) {
      it(`denies an Edit whose file_path is ${label} and whose notebook_path is in the ${where}, from a cwd that protects nothing`, () => {
        const result = run(GIT_GUARD, preToolUse("Edit", { file_path: filePath, notebook_path: notebook(), old_string: "a", new_string: "b" }, repo), repo);
        assert.equal(result.code, DENY);
        assert.match(result.stderr, new RegExp(`\\[${rule}\\] git-guard: blocked`));
        assert.ok(result.stderr.includes(notebook()), result.stderr);
      });
    }
  }

  it("raises for a non-text file_path beside a notebook_path that nothing denies", () => {
    const result = run(GIT_GUARD, preToolUse("Edit", { file_path: false, notebook_path: join(repo, "README.txt"), old_string: "a", new_string: "b" }, repo), repo);
    assert.equal(result.code, PASS);
    assert.match(errorFires("git-guard").at(-1) ?? "", /^FieldTypeError: file_path must be a string, not boolean$/);
  });

  it("judges the file_path when it is text, whatever the notebook_path holds", () => {
    const denied = run(GIT_GUARD, preToolUse("Edit", { file_path: join(sandbox.overlay, "ledger.tsv"), notebook_path: 5, old_string: "a", new_string: "b" }, repo), repo);
    assert.equal(denied.code, DENY);
    const errorsBefore = errorFires("git-guard").length;
    assert.equal(run(GIT_GUARD, preToolUse("Edit", { file_path: join(repo, "README.txt"), notebook_path: 5, old_string: "a", new_string: "b" }, repo), repo).code, PASS);
    assert.equal(errorFires("git-guard").length, errorsBefore);
  });

  it("still falls back to notebook_path when file_path is null or empty", () => {
    for (const filePath of [null, ""]) {
      const result = run(GIT_GUARD, preToolUse("NotebookEdit", { file_path: filePath, notebook_path: join(sandbox.overlay, "n.ipynb"), new_source: "x" }, repo));
      assert.equal(result.code, DENY);
    }
  });

  for (const [label, edits] of [["false", false], ["zero", 0], ["empty string", ""], ["empty object", {}], ["string", "text"], ["number", 5]] as const) {
    it(`raises for a MultiEdit whose edits is ${label} when nothing denies it`, () => {
      const result = run(GIT_GUARD, preToolUse("MultiEdit", { file_path: join(repo, "README.txt"), edits }, sandbox.root));
      assert.equal(result.code, PASS);
      assert.match(errorFires("git-guard").at(-1) ?? "", /^TypeError: edits is not a list: /);
    });
  }

  it("keeps null and empty list edits as no edits", () => {
    for (const edits of [null, []]) {
      const errorsBefore = errorFires("git-guard").length;
      assert.equal(run(GIT_GUARD, preToolUse("MultiEdit", { file_path: join(repo, "README.txt"), edits }, sandbox.root)).code, PASS);
      assert.equal(errorFires("git-guard").length, errorsBefore);
    }
  });

  it("reads a tool_name that is not a string as no tool", () => {
    for (const toolName of [5, true, ["Bash"], { k: "v" }]) {
      const firesBefore = sandbox.fires().length;
      assert.equal(run(GIT_GUARD, { ...bash(WRITTEN_BY_CLAUDE, repo), tool_name: toolName }, repo).code, PASS);
      assert.equal(sandbox.fires().length, firesBefore);
    }
  });
});

describe("ship-gate reads a field of the wrong type as a refusal, never as a pass", () => {
  it("fails closed on a push whose command is a list", () => {
    const result = run(SHIP_GATE, preToolUse("Bash", { command: ["git", "push", "origin", "main"] }, repo), repo);
    assert.equal(result.code, DENY);
    assert.match(result.stderr, /failing closed/);
  });

  it("passes a non-push command whose command is a number, with a note on stderr", () => {
    const result = run(SHIP_GATE, preToolUse("Bash", { command: 5 }, repo), repo);
    assert.equal(result.code, PASS);
    assert.match(result.stderr, /FieldTypeError: command must be a string, not number/);
  });

  for (const [label, cwd] of [["false", false], ["zero", 0], ["empty list", []], ["empty object", {}], ["number", 5]] as const) {
    it(`fails closed on a push whose cwd is ${label}`, () => {
      const result = run(SHIP_GATE, { ...bash("git push origin main", repo), cwd }, repo);
      assert.equal(result.code, DENY);
      assert.match(result.stderr, /FieldTypeError: cwd must be a string, not /);
    });
  }

  it("labels fires with - when the session is not a string", () => {
    for (const session of [5, true, ["s"], { k: "v" }, 0, false]) {
      const result = run(SHIP_GATE, { ...bash("git push origin main", repo), session_id: session }, repo);
      assert.equal(result.code, PASS);
      assert.ok(!result.stderr.includes("FieldTypeError"));
    }
  });
});

describe("report-gate refuses what it cannot read instead of passing it", () => {
  const brief = { type: "user", message: { role: "user", content: "[SCOPE] /work/app\nDo the task." } };
  const inScopeEdit = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/work/app/x.py" } }] } };

  function transcript(name: string, entries: unknown[]): string {
    return sandbox.write(join(sandbox.root, "report-gate-transcripts", `${name}.jsonl`), entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
  }

  function handback(message: unknown, extra: Record<string, unknown> = {}): unknown {
    const agent = join(sandbox.data, "projects", "-work-app", SESSION_ID, "subagents", `agent-${AGENT_ID}.jsonl`);
    sandbox.write(agent, [brief, inScopeEdit].map((entry) => JSON.stringify(entry) + "\n").join(""));
    sandbox.write(sandbox.mainTranscript(), "");
    return { ...preToolUse("SubagentHandback", { message }, sandbox.root, sandbox.mainTranscript(), true), ...extra };
  }

  for (const [label, message] of [["object", { a: "Ran 3 tests" }], ["list", ["x"]], ["number", 5], ["true", true], ["zero", 0], ["false", false], ["empty list", []], ["empty object", {}]] as const) {
    it(`denies a handback whose message is ${label}`, () => {
      const result = run(REPORT_GATE, handback(message));
      assert.equal(result.code, DENY);
      assert.match(result.stderr, /could not read this report/);
    });
  }

  for (const field of ["agent_id", "session_id", "transcript_path"]) {
    for (const [label, value] of [["number", 5], ["true", true], ["object", { k: "v" }], ["list", ["x"]], ["zero", 0], ["false", false], ["empty list", []], ["empty object", {}]] as const) {
      it(`denies a handback whose ${field} is ${label}`, () => {
        const result = run(REPORT_GATE, handback("Done. Ran 3 tests", { [field]: value }));
        assert.equal(result.code, DENY);
        assert.match(result.stderr, /could not read this report/);
      });
    }
  }

  for (const [label, value] of [["string", "yes"], ["number", 1], ["object", { k: 1 }], ["list", [1]], ["zero", 0], ["empty string", ""], ["empty list", []], ["empty object", {}], ["false", false]] as const) {
    it(`blocks a stop whose stop_hook_active is ${label}, since only true means a retry`, () => {
      const path = transcript("outside", [brief, OUTSIDE_EDIT]);
      const result = run(REPORT_GATE, { ...subagentStop(sandbox.root, sandbox.mainTranscript(), path, "Changed it."), stop_hook_active: value });
      assert.equal(result.code, PASS);
      assert.match(result.stdout, /"decision": "block"/);
    });
  }

  it("passes a stop that is a retry (stop_hook_active true)", () => {
    const path = transcript("outside", [brief, OUTSIDE_EDIT]);
    const result = run(REPORT_GATE, { ...subagentStop(sandbox.root, sandbox.mainTranscript(), path, "Changed it."), stop_hook_active: true });
    assert.equal(result.stdout, "");
  });

  for (const field of ["ev", "hb"] as const) {
    for (const [label, value] of [["string", "yes"], ["number", 1], ["object", { k: 1 }], ["list", [1]]] as const) {
      it(`does not let a stored ${field} of ${label} excuse the report`, () => {
        const session = `wrong-type-${field}-${label}`;
        sandbox.write(join(sandbox.data, "state", "keel", "report-gate", `${session}-${AGENT_ID}.json`), JSON.stringify({ paths: [], ev: field === "ev" ? value : false, hb: field === "hb" ? value : false }));
        const path = transcript("brief-only", [brief]);
        const stop = { ...subagentStop(sandbox.root, sandbox.mainTranscript(), path, "Done. All good, VERDICT: PASS"), session_id: session };
        const result = field === "hb" ? run(REPORT_GATE, stop) : run(REPORT_GATE, handback("Done. All good, VERDICT: PASS", { session_id: session }));
        assert.ok(result.code === DENY || result.stdout.includes('"decision": "block"'), `${result.code} ${result.stdout} ${result.stderr}`);
      });
    }
  }

  for (const [entryLabel, entry] of [
    ["a tool name that is a number", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: 5, input: {} }] } }],
    ["a Bash command that is a list", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: ["ls"] } }] } }],
    ["an Edit file_path that is a number", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: 5 } }] } }],
    ["a message role that is a number", { type: "assistant", message: { role: 5, content: [] } }],
  ] as const) {
    it(`blocks a stop whose transcript holds ${entryLabel}`, () => {
      const path = transcript(`entry-${entryLabel.replace(/\W+/g, "-")}`, [brief, entry]);
      const result = run(REPORT_GATE, subagentStop(sandbox.root, sandbox.mainTranscript(), path, "Done. Ran 3 tests"));
      assert.match(result.stdout, /could not read this report/);
    });
  }

  it("blocks a stop whose agent_transcript_path is not a string", () => {
    for (const value of [5, true, ["x"], { k: "v" }, 0, false]) {
      const result = run(REPORT_GATE, { ...subagentStop(sandbox.root, sandbox.mainTranscript(), "", "Done. Ran 3 tests"), agent_transcript_path: value });
      assert.match(result.stdout, /could not read this report/);
    }
  });
});

describe("model-assign applies a model and an effort only to fields it can read", () => {
  const script = "agent({ prompt: 'x' })";

  for (const [label, value] of [["true", true], ["object", { k: 1 }], ["number", 5], ["list", [1]], ["string", "yes"]] as const) {
    it(`denies a workflow script with no opts when resumeFromRunId is ${label}`, () => {
      const result = run(MODEL_ASSIGN, preToolUse("Workflow", { script, resumeFromRunId: value }, sandbox.root));
      assert.equal(result.code, label === "string" ? PASS : DENY);
    });
  }

  it("passes a workflow resume that names a run", () => {
    assert.equal(run(MODEL_ASSIGN, preToolUse("Workflow", { script, resumeFromRunId: "run-1" }, sandbox.root)).code, PASS);
  });

  it("leaves out a scriptPath that is not text from the deny message", () => {
    const result = run(MODEL_ASSIGN, preToolUse("Workflow", { script, scriptPath: 5 }, sandbox.root));
    assert.equal(result.code, DENY);
    assert.ok(!result.stderr.includes("Edit 5"));
  });

  for (const key of ["subagent_type", "prompt", "description", "model", "effort"]) {
    it(`logs an error and rewrites nothing when ${key} is a list`, () => {
      const input = { description: "Find", prompt: "Look around.", [key]: ["x"] };
      const result = run(MODEL_ASSIGN, preToolUse("Agent", input, sandbox.root));
      assert.equal(result.stdout, "");
      assert.match(errorFires("model-assign").at(-1) ?? "", new RegExp(`^FieldTypeError: ${key} must be a string, not list$`));
    });
  }
});

describe("env-preflight judges a mvn command it can read", () => {
  const mvn = "JAVA_HOME=/opt/jdk-11 mvn test";

  for (const [label, cwd] of [["false", false], ["zero", 0], ["empty list", []], ["empty object", {}], ["number", 5], ["true", true], ["object", { k: "v" }], ["list", ["x"]]] as const) {
    it(`judges the process directory when cwd is ${label}`, () => {
      const result = run(ENV_PREFLIGHT, { ...bash(mvn, repo), cwd }, repo);
      assert.equal(result.code, DENY);
      assert.match(result.stderr, /\[S-jdk\]/);
    });
  }

  it("logs an error when the command is not text", () => {
    const result = run(ENV_PREFLIGHT, preToolUse("Bash", { command: ["mvn", "test"] }, repo), repo);
    assert.equal(result.code, PASS);
    assert.match(errorFires("env-preflight").at(-1) ?? "", /^FieldTypeError: command must be a string, not list$/);
  });
});
