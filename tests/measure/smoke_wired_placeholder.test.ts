import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { withPluginRoot } from "../../measure/lib/measurekit/smoke_wired.ts"

describe("withPluginRoot", () => {
  it("insertsTheRootAsWritten_whenItHoldsReplacementPatterns", () => {
    const hooks = { hooks: { PreToolUse: [{ hooks: [{ command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/x.ts" }] }] } }
    for (const root of ["/k/$&/keel", "/k/$'/keel", "/k/$$/keel", "/k/\"q\"/keel"]) {
      assert.deepEqual(withPluginRoot(hooks, root), { hooks: { PreToolUse: [{ hooks: [{ command: `node ${root}/hooks/x.ts` }] }] } })
    }
  })
})
