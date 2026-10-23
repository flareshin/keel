import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { canonicalJson } from "../../lib/link/config.ts"
import { readLiveSettings } from "../../lib/link/settings_json.ts"
import type { JsonValue } from "../../measure/lib/measurekit/json.ts"

const SETTINGS: JsonValue = {
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node /k/hooks/x.ts", timeout: 10, onFailure: "block" }] }] },
  permissions: { allow: ["Read", "Bash(echo \u00e9:*)"], deny: [] },
  env: { Z: "1", "10": "a", A_B: "\n\t\"\\\u001f\u007f\u2028\u{1F600}" },
}

const PYTHON_DUMPS: [name: string, value: JsonValue | undefined, text: string, sha256: string][] = [
  [
    "Settings",
    SETTINGS,
    '{"env": {"10": "a", "A_B": "\\n\\t\\"\\\\\\u001f\u007f\u2028\u{1F600}", "Z": "1"}, "hooks": {"PreToolUse": [{"hooks": [{"command": "node /k/hooks/x.ts", "onFailure": "block", "timeout": 10, "type": "command"}], "matcher": "Bash"}]}, "permissions": {"allow": ["Read", "Bash(echo \u00e9:*)"], "deny": []}}',
    "84838bf255abb84f8e34ee7bf04f95c4e62f7a0bef2b86a9911f49db6176c3f5",
  ],
  ["AnAbsentKey", undefined, "null", "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
  ["Scalars", [true, false, 0, -7, "x"], '[true, false, 0, -7, "x"]', "dd79e6368534f2b22888ecb8cc36db3d3cc6d48151397a4bf6daa5abf8b3a75f"],
  [
    "KeysOutsideTheBasicPlane",
    { "": 1, "\u{1F600}": 2, "\ue000": 3, "\uffff": 4, "\uff10": 5, a: 6 },
    '{"": 1, "a": 6, "\ue000": 3, "\uff10": 5, "\uffff": 4, "\u{1F600}": 2}',
    "947f6e307d149a3d4fc14d2d5c74e484c86b9bcf0b7eed35874965144811ff11",
  ],
]

const SETTINGS_WITH_A_HUGE_TIMEOUT = '{"timeout": 12345678901234567890}'

describe("canonicalJson", () => {
  it("canonicalJson_ofAnIntegerBeyondDoublePrecision_readFromSettingsJson_keepsEveryDigit", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "keel-canonical-"))
    try {
      fs.writeFileSync(path.join(directory, "settings.json"), SETTINGS_WITH_A_HUGE_TIMEOUT)
      const live = readLiveSettings(path.join(directory, "settings.json"))
      assert.equal(canonicalJson(live.values), SETTINGS_WITH_A_HUGE_TIMEOUT)
      assert.equal(createHash("sha256").update(canonicalJson(live.values), "utf8").digest("hex"), "11f9864b5e9459dcc29d67a2f374f52b5ac70f836ade37a93352005771eee2c1")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  for (const [name, value, text, sha256] of PYTHON_DUMPS) {
    it(`canonicalJson_of${name}_isTheTextAndDigestPythonJsonDumpsGave`, () => {
      assert.equal(canonicalJson(value), text)
      assert.equal(createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"), sha256)
    })
  }
})
