import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Registration } from "../../measure/lib/measurekit/hook_settings.ts"

function registration(command: string): Registration {
  return new Registration("PreToolUse", "Bash", { type: "command", command })
}

describe("hook registration", () => {
  it("script_isTheFirstNonInterpreterWord_whenTheCommandRunsNodeDirectly", () => {
    const hook = registration("node /keel/hooks/git-guard/git-guard.ts")
    assert.equal(hook.script, "/keel/hooks/git-guard/git-guard.ts")
    assert.equal(hook.hookName, "git-guard")
  })

  it("script_skipsLeadingEnvironmentAssignments", () => {
    const hook = registration('NODE_COMPILE_CACHE="${KEEL_DATA_DIR:-$HOME/.claude}/state/keel/node-compile-cache" A=1 node /keel/hooks/ship-gate/ship-gate.ts')
    assert.equal(hook.script, "/keel/hooks/ship-gate/ship-gate.ts")
    assert.equal(hook.hookName, "ship-gate")
  })

  it("script_keepsAnArgumentWithAnEqualsSign_afterTheScript", () => {
    const hook = registration("node /keel/hooks/demo/demo.js A=1")
    assert.equal(hook.script, "/keel/hooks/demo/demo.js")
  })
})
