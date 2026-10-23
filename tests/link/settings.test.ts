import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { spliceOwnedKeys } from "../../lib/link/settings_json.ts"
import { LinkSandbox, assertExit, problemKinds, writeAdoptingEveryDrop } from "./helpers.ts"

const LIVE_V1 =
  "{\n" +
  '    "model": "opus",\n' +
  '    "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "v1-stop.sh"}]}]},\n' +
  '    "statusLine": {"type":"command","command":"hud --dark"},\n' +
  '    "permissions": {\n' +
  '        "allow": ["Read"],\n' +
  '        "defaultMode": "auto"\n' +
  "    },\n" +
  '    "theme": "d\u00e9j\u00e0 vu \\u00e9",\n' +
  '    "enabledPlugins": [1,2,  3]\n' +
  "}"
const UNOWNED_SPANS = ['"opus"', '{"type":"command","command":"hud --dark"}', '"d\u00e9j\u00e0 vu \\u00e9"', "[1,2,  3]"]

describe("link settings write", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
  })
  afterEach(() => box.remove())

  const addAllowRuleByHand = () => {
    const live = JSON.parse(box.readData("settings.json"))
    live.permissions.allow = ["hand-added"]
    box.writeData("settings.json", JSON.stringify(live, null, 2))
  }
  const removeEnvFragment = () => fs.unlinkSync(path.join(box.overlay, "settings", "50-permissions.json"))

  it("write_replacesOnlyOwnedKeysAndKeepsOtherBytes_whenLiveHasV1Settings", () => {
    box.writeData("settings.json", LIVE_V1)
    const result = writeAdoptingEveryDrop(box)
    assertExit(result, 0)
    const text = box.readData("settings.json")
    for (const span of UNOWNED_SPANS) assert.ok(text.includes(span), span)
    assert.ok(text.startsWith('{\n    "model": "opus",\n    "hooks": '))
    assert.ok(text.endsWith('"enabledPlugins": [1,2,  3],\n    "env": {\n      "ACME_NOTES_DIR": "' + box.data + '/notes"\n    }\n}'))
    const live = JSON.parse(text)
    assert.deepEqual(Object.keys(live), ["model", "hooks", "statusLine", "permissions", "theme", "enabledPlugins", "env"])
    assert.equal(live.hooks.PreToolUse[0].hooks[0].command, `python3 ${box.keel}/hooks/demo.py`)
    assert.ok(!("Stop" in live.hooks))
    assert.deepEqual(live.permissions, { deny: ["Bash(git push --force:*)", "Bash(rm -rf /:*)"], ask: ["Bash(git push:*)"] })
  })

  it("write_createsSettingsWithOwnedKeysOnly_whenLiveFileIsMissing", () => {
    assertExit(box.runLink("--write"), 0)
    assert.deepEqual(Object.keys(JSON.parse(box.readData("settings.json"))), ["hooks", "permissions", "env"])
    assert.equal(fs.statSync(box.dataPath("settings.json")).mode & 0o777, 0o600)
  })

  it("write_keepsFileMode_whenLiveFileExists", () => {
    box.writeData("settings.json", "{}")
    fs.chmodSync(box.dataPath("settings.json"), 0o640)
    assertExit(box.runLink("--write"), 0)
    assert.equal(fs.statSync(box.dataPath("settings.json")).mode & 0o777, 0o640)
  })

  it("write_mergesStackFragmentInSortedOrder_whenOverlayActivatesStacks", () => {
    box.writeOverlay("stacks.txt", "# active stacks\nzeta\nalpha\n")
    box.writeKeel("stacks/alpha/settings.json", JSON.stringify({ permissions: { deny: ["alpha-rule", "Bash(git push --force:*)"] } }))
    box.writeKeel("stacks/zeta/settings.json", JSON.stringify({ permissions: { deny: ["zeta-rule"] } }))
    assertExit(box.runLink("--write"), 0)
    const deny = JSON.parse(box.readData("settings.json")).permissions.deny
    assert.deepEqual(deny, ["Bash(git push --force:*)", "alpha-rule", "zeta-rule", "Bash(rm -rf /:*)"])
  })

  it("write_letsLaterEnvWinAndWarns_whenFragmentsConflict", () => {
    box.writeOverlay("settings/90-env.json", JSON.stringify({ env: { ACME_NOTES_DIR: "/later" } }))
    const result = box.runLink("--write")
    assertExit(result, 0)
    assert.equal(JSON.parse(box.readData("settings.json")).env.ACME_NOTES_DIR, "/later")
    assert.ok(result.stderr.includes("env.ACME_NOTES_DIR is overridden by"))
    assert.ok(!result.stderr.includes("/later"))
  })

  it("write_refuses_whenFragmentHoldsANonOwnedKey", () => {
    box.writeOverlay("settings/90-bad.json", JSON.stringify({ model: "x" }))
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("fragments may hold only"))
  })

  it("write_refuses_whenFragmentUsesAnUnknownPlaceholder", () => {
    box.writeOverlay("settings/90-bad.json", JSON.stringify({ env: { X: "{{SECRET}}" } }))
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("unknown placeholder"))
  })

  it("write_refuses_whenActiveStackHasNoSettings", () => {
    box.writeOverlay("stacks.txt", "missing-stack\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("missing-stack"))
  })

  it("write_refuses_whenStackNameIsNotAPlainName", () => {
    box.writeOverlay("stacks.txt", "../escape\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("invalid stack name"))
  })

  it("write_refusesAndKeepsFile_whenLiveSettingsIsInvalidJson", () => {
    box.writeData("settings.json", "{not json")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.equal(box.readData("settings.json"), "{not json")
  })

  it("write_refuses_whenOwnedKeysWereEditedSinceTheLastWrite", () => {
    assertExit(box.runLink("--write"), 0)
    addAllowRuleByHand()
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["settings-drift"])
    assert.ok(result.json.problems[0].detail.includes("permissions changed since the last --write"))
    assert.ok(box.readData("settings.json").includes("hand-added"))
  })

  it("write_overwritesHandEdit_whenForced", () => {
    assertExit(box.runLink("--write"), 0)
    addAllowRuleByHand()
    assertExit(box.runLink("--write", "--force"), 0)
    assert.ok(!box.readData("settings.json").includes("hand-added"))
    assertExit(box.runLink("--write"), 0)
  })

  it("write_updatesWithoutForce_whenOnlyFragmentsChanged", () => {
    assertExit(box.runLink("--write"), 0)
    box.writeOverlay("settings/90-more.json", JSON.stringify({ permissions: { allow: ["Read"] } }))
    assertExit(box.runLink("--write"), 0)
    assert.deepEqual(JSON.parse(box.readData("settings.json")).permissions.allow, ["Read"])
  })

  it("write_removesLiveOwnedKey_whenNoFragmentDeclaresIt", () => {
    removeEnvFragment()
    box.writeData("settings.json", '{\n  "env": {"V1_SECRET": "x"},\n  "model": "m"\n}\n')
    assertExit(writeAdoptingEveryDrop(box), 0)
    const text = box.readData("settings.json")
    assert.ok(!text.includes("V1_SECRET"))
    assert.deepEqual(Object.keys(JSON.parse(text)), ["model", "hooks", "permissions"])
    assertExit(box.runLink("--check"), 0)
  })

  it("write_refuses_whenUndeclaredOwnedKeyWasAddedByHandSinceTheLastWrite", () => {
    removeEnvFragment()
    assertExit(box.runLink("--write"), 0)
    const live = JSON.parse(box.readData("settings.json"))
    live.env = { HAND: "added" }
    box.writeData("settings.json", JSON.stringify(live, null, 2))
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["settings-drift"])
    assert.ok(result.json.problems[0].detail.includes("env changed since the last --write"))
    assert.ok(box.readData("settings.json").includes("HAND"))
  })
})

describe("splice owned keys", () => {
  it("splice_insertsAbsentKeysAfterLastMember_whenObjectIsMinified", () => {
    assert.equal(spliceOwnedKeys('{"a":1,"b":[2]}', { env: { K: "v" } }), '{"a":1,"b":[2],\n"env": {\n  "K": "v"\n}}')
  })

  it("splice_insertsIndentedKeys_whenObjectIsEmpty", () => {
    assert.equal(spliceOwnedKeys("{}\n", { hooks: {}, env: { K: "v" } }), '{\n  "hooks": {},\n  "env": {\n    "K": "v"\n  }\n}\n')
  })

  it("splice_replacesValueInPlace_whenOwnedKeyIsInTheMiddle", () => {
    assert.equal(spliceOwnedKeys('{ "a" : 1 , "env" : {"OLD": "x"} , "z":true }', { env: {} }), '{ "a" : 1 , "env" : {} , "z":true }')
  })

  it("splice_keepsUnownedKeyNamedLikeANestedOwnedKey", () => {
    assert.equal(spliceOwnedKeys('{"nested": {"env": 1}, "env": 2}', { env: 3 }), '{"nested": {"env": 1}, "env": 3}')
  })

  it("splice_removesOwnedMember_whenItIsInTheMiddle", () => {
    assert.equal(spliceOwnedKeys('{"a": 1, "env": {"X": 1}, "z": 2}', {}), '{"a": 1, "z": 2}')
  })

  it("splice_removesOwnedMember_whenItIsFirst", () => {
    assert.equal(spliceOwnedKeys('{"env": 1, "a": 2}', {}), '{"a": 2}')
  })

  it("splice_removesTrailingOwnedMembers_whenTheyAreLast", () => {
    assert.equal(spliceOwnedKeys('{\n  "a": 1,\n  "hooks": {},\n  "env": 2\n}\n', {}), '{\n  "a": 1\n}\n')
  })

  it("splice_leavesEmptyObject_whenTheOnlyMemberIsRemoved", () => {
    assert.equal(spliceOwnedKeys('{\n  "env": 1\n}\n', {}), "{}\n")
  })

  it("splice_removesAndInserts_whenLiveAndMergedDeclareDifferentOwnedKeys", () => {
    assert.equal(spliceOwnedKeys('{\n  "env": 1\n}', { hooks: {} }), '{\n  "hooks": {}\n}')
  })
})
