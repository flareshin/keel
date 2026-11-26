import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { countedRows, loadLedger } from "../../measure/lib/measurekit/ledger.ts";
import type { LedgerRow } from "../../measure/lib/measurekit/ledger.ts";
import { main as runHook } from "../hooks/pre-tool-use.ts";
import type { GuardRunner } from "../hooks/pre-tool-use.ts";

const ADAPTER = realpathSync(join(import.meta.dirname, ".."));
const KEEL = dirname(ADAPTER);
const STACK_SCOPE_PREFIX = "stack:";
const UNREGISTERED_SENTENCE = /Claude ([^.]*?) are not registered here\./;
const GUARDED_CALLS = [
  { tool_name: "Bash", tool_input: { command: "true" } },
  { tool_name: "Write", tool_input: { file_path: "/nonexistent/keel-ledger-probe.txt", content: "probe" } },
  { tool_name: "Edit", tool_input: { file_path: "/nonexistent/keel-ledger-probe.txt", old_string: "a", new_string: "b" } },
];

function guardsRunByCodex(): Set<string> {
  const names = new Set<string>();
  const recording: GuardRunner = (command) => {
    names.add(basename(command[1] ?? "", ".ts"));
    return { returncode: 0, stdout: "", stderr: "" };
  };
  for (const call of GUARDED_CALLS) {
    const result = runHook(() => Buffer.from(JSON.stringify(call)), recording);
    assert.equal(result.stdout, "", `${call.tool_name}: ${result.stdout}`);
  }
  return names;
}

function hookRows(): LedgerRow[] {
  return countedRows([loadLedger(join(KEEL, "ledger.tsv"), "keel")]).filter((row) => row.hookName !== null);
}

function unregisteredList(): string {
  const match = UNREGISTERED_SENTENCE.exec(readFileSync(join(ADAPTER, "AGENTS.md"), "utf8"));
  assert.ok(match?.[1], "codex/AGENTS.md has no 'Claude … are not registered here.' sentence");
  return match[1];
}

function hookDirectoriesNamedIn(text: string): string[] {
  return text.split(/[\s,]+/).filter((word) => word !== "" && existsSync(join(KEEL, "hooks", word, `${word}.ts`)));
}

describe("ledger hook rows and the Codex guard", () => {
  it("runs or names as unregistered every hook a counted ledger row is enforced by", () => {
    const run = guardsRunByCodex();
    const unregistered = unregisteredList();
    const named = new Set(hookDirectoriesNamedIn(unregistered));
    for (const row of hookRows()) {
      const hook = row.hookName ?? "";
      if (run.has(hook)) continue;
      if (row.scope.startsWith(STACK_SCOPE_PREFIX)) {
        assert.ok(unregistered.includes("stack hooks"), `${row.id}: stack hook ${hook} is neither run nor covered by "stack hooks"`);
        continue;
      }
      assert.ok(named.has(hook), `${row.id}: hook ${hook} is neither run by the Codex guard nor named as unregistered`);
    }
  });

  it("names as unregistered only hooks a counted ledger row still uses", () => {
    const inForce = new Set(hookRows().map((row) => row.hookName));
    for (const hook of hookDirectoriesNamedIn(unregisteredList())) {
      assert.ok(inForce.has(hook), `codex/AGENTS.md names ${hook}, which no counted ledger row enforces`);
    }
  });

  it("runs only hooks a counted ledger row is enforced by", () => {
    const inForce = new Set(hookRows().map((row) => row.hookName));
    for (const hook of guardsRunByCodex()) assert.ok(inForce.has(hook), hook);
  });
});
