import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { basePayload, HookSandbox, KEEL_HOME, PRINCIPLES } from "./helpers.ts";
import type { HookResult } from "./helpers.ts";
import { buildClaudeMd, HEADER } from "../../lib/link/claude_md.ts";

let sandbox: HookSandbox;
let pluginRoot: string;

beforeEach(() => {
  sandbox = new HookSandbox();
  pluginRoot = join(sandbox.root, "plugin");
  sandbox.env["KEEL_HOME"] = pluginRoot;
});

afterEach(() => {
  sandbox.close();
});

function start(event: string, extra: Record<string, unknown> = {}): HookResult {
  return sandbox.runHook(PRINCIPLES, { payload: { ...basePayload(event, sandbox.root, "/dev/null", false), ...extra } });
}

function injected(result: HookResult): Record<string, unknown> {
  return result.json().hookSpecificOutput;
}

describe("PrinciplesInjectionTest", () => {
  it("sessionStart_injectsPrinciplesThenPersonal_afterCompaction", () => {
    sandbox.write(join(pluginRoot, "PRINCIPLES.md"), "# keel principles\n");
    sandbox.write(join(sandbox.overlay, "PERSONAL.md"), "## Owner\n");
    const result = start("SessionStart", { source: "compact" });
    assert.deepEqual(injected(result), { hookEventName: "SessionStart", additionalContext: "# keel principles\n\n## Owner\n" });
  });

  it("subagentStart_injectsPrinciplesAlone_whenOverlayHasNoPersonal", () => {
    sandbox.write(join(pluginRoot, "PRINCIPLES.md"), "# keel principles");
    const result = start("SubagentStart", { agent_type: "keel:auditor" });
    assert.deepEqual(injected(result), { hookEventName: "SubagentStart", additionalContext: "# keel principles\n" });
  });

  it("injection_tellsTheSessionWhichFileIsMissing_whenPrinciplesAreAbsent", () => {
    const context = String(injected(start("SessionStart"))["additionalContext"]);
    assert.ok(context.includes(join(pluginRoot, "PRINCIPLES.md")), context);
  });

  it("injection_writesNoFires_becauseNoLedgerRowOwnsIt", () => {
    sandbox.write(join(pluginRoot, "PRINCIPLES.md"), "# keel principles\n");
    start("SessionStart");
    start("SubagentStart");
    assert.deepEqual(sandbox.fires(), []);
  });

  it("otherEvents_passWithoutOutput", () => {
    sandbox.write(join(pluginRoot, "PRINCIPLES.md"), "# keel principles\n");
    assert.equal(start("Stop").stdout, "");
  });

  it("injection_matchesTheLinkedClaudeMdBody", () => {
    sandbox.env["KEEL_HOME"] = KEEL_HOME;
    sandbox.write(join(sandbox.overlay, "PERSONAL.md"), "## Owner\nTalk to the owner in Korean.");
    const claudeMd = buildClaudeMd({ keelHome: KEEL_HOME, overlayDir: sandbox.overlay, dataDir: sandbox.data });
    assert.equal(injected(start("SessionStart"))["additionalContext"], claudeMd.slice(HEADER.length + 1));
  });
});
