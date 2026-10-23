import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { readAcceptedDrops } from "../../lib/link/cli.ts"
import { Refused } from "../../lib/link/config.ts"
import { listDroppedItems } from "../../lib/link/settings_json.ts"
import { CORE_LINKS, LinkSandbox, assertExit, backupsOf, listedDrops, ops, problemKinds, readFile, writeAdoptingEveryDrop } from "./helpers.ts"
import type { LinkResult } from "./helpers.ts"

const LIVE_V1 = {
  model: "opus",
  hooks: { Stop: [{ hooks: [{ type: "command", command: "v1-stop.sh" }] }] },
  permissions: {
    allow: ["Read"],
    deny: ["Bash(git push --force:*)", "Bash(v1-only-deny:*)"],
    ask: ["Bash(v1-only-ask:*)"],
    defaultMode: "auto",
  },
  env: { V1_TOKEN: "v1-secret-value" },
}
const CORE_LINKS_WITH_DANGLING = CORE_LINKS + "{{KEEL}}/skills/missing\tskills/missing\n"
const EXPECTED_DROPS = [
  "env V1_TOKEN (removed)",
  "hooks.Stop v1-stop.sh",
  "permissions.allow Read",
  "permissions.ask Bash(v1-only-ask:*)",
  "permissions.defaultMode auto",
  "permissions.deny Bash(v1-only-deny:*)",
]
const V1_TEXT = JSON.stringify(LIVE_V1, null, 2) + "\n"

const afterRunMarker = (result: LinkResult) => result.stderr.split("run:")[1] as string

describe("link swap safety", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
    box.writeData("settings.json", V1_TEXT)
  })
  afterEach(() => box.remove())

  const acceptFile = (lines: string[]) => {
    const file = path.join(box.root, "accepted-drops.txt")
    fs.writeFileSync(file, "# reviewed drops\n" + lines.map((line) => line + "\n").join(""))
    return file
  }
  const adopt = () => box.runLink("--write", "--adopt", "--accept-drops", acceptFile(EXPECTED_DROPS))
  const backups = () => backupsOf(box, "settings.json")
  const addMore = () => box.writeOverlay("settings/90-more.json", JSON.stringify({ permissions: { allow: ["Glob"] } }))

  describe("adopt", () => {
    it("write_exitsThreeAndKeepsSettings_whenNoLinkStateAndLiveOwnedKeysDiffer", () => {
      const result = box.runLink("--write")
      assertExit(result, 3)
      assert.ok(problemKinds(result).includes("settings-unadopted"))
      assert.equal(box.readData("settings.json"), V1_TEXT)
    })

    it("write_exitsThree_whenForcedWithoutAdopt", () => {
      const result = box.runLink("--write", "--force")
      assertExit(result, 3)
      assert.equal(box.readData("settings.json"), V1_TEXT)
    })

    it("adopt_listsEveryDroppedItemWithoutEnvValuesAndRefuses_whenNoAcceptFileIsGiven", () => {
      const result = box.runLink("--write", "--adopt")
      assertExit(result, 3)
      assert.deepEqual(listedDrops(result), EXPECTED_DROPS)
      assert.ok(!(result.stdout + result.stderr).includes("v1-secret-value"))
      assert.equal(box.readData("settings.json"), V1_TEXT)
    })

    it("adopt_refusesAndNamesTheItem_whenOneDropIsMissingFromTheAcceptFile", () => {
      const accepted = acceptFile(EXPECTED_DROPS.filter((item) => item !== "permissions.deny Bash(v1-only-deny:*)"))
      const result = box.runLink("--write", "--adopt", "--accept-drops", accepted)
      assertExit(result, 3)
      assert.ok(result.stderr.includes("not accepted: permissions.deny Bash(v1-only-deny:*)"))
      assert.equal(box.readData("settings.json"), V1_TEXT)
    })

    it("adopt_writesSettings_whenEveryDropIsAccepted", () => {
      assertExit(adopt(), 0)
      const live = JSON.parse(box.readData("settings.json"))
      assert.ok(!("V1_TOKEN" in live.env))
      assert.equal(live.model, "opus")
      assertExit(box.runLink("--write"), 0)
    })

    it("write_proceedsWithoutAdopt_whenLiveHoldsNoOwnedKey", () => {
      box.writeData("settings.json", '{"model": "opus"}\n')
      assertExit(box.runLink("--write"), 0)
    })

    it("adopt_listsALivePromptHookAndRefuses_whenNoAcceptFileIsGiven", () => {
      const promptHook = { type: "prompt", prompt: "Check the reply." }
      box.writeData("settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [promptHook] }] } }) + "\n")
      const result = box.runLink("--write", "--adopt")
      assertExit(result, 3)
      assert.ok(result.stderr.includes('adopt drops: hooks.Stop {"prompt": "Check the reply.", "type": "prompt"}'))
    })

    it("cli_exitsWithUsageError_whenAcceptDropsIsGivenWithoutAdopt", () => {
      assertExit(box.runLink("--write", "--accept-drops", acceptFile([])), 2)
    })
  })

  describe("drop listing", () => {
    const writeV1ClaudeMd = () => box.writeData("CLAUDE.md", "# v1 rules\n")

    it("dryRun_listsEveryDropWithoutEnvValues_whenNoLinkStateAndLiveOwnedKeysDiffer", () => {
      writeV1ClaudeMd()
      const result = box.runLink()
      assertExit(result, 0)
      assert.deepEqual([...result.json.dropped].sort(), EXPECTED_DROPS)
      assert.ok(!(result.stdout + result.stderr).includes("v1-secret-value"))
    })

    it("dryRun_listsNoDrops_whenKeelHasWrittenTheSettingsBefore", () => {
      assertExit(adopt(), 0)
      assert.deepEqual(box.runLink().json.dropped, [])
    })

    it("adopt_listsTheDropsAndHintsForce_whenTheV1ClaudeMdIsInTheWay", () => {
      writeV1ClaudeMd()
      const result = box.runLink("--write", "--adopt")
      assertExit(result, 3)
      assert.deepEqual(problemKinds(result), ["target-occupied"])
      assert.deepEqual(listedDrops(result), EXPECTED_DROPS)
      assert.ok(result.stderr.includes("run: bin/link --write --adopt --force --accept-drops <file>"))
      assert.equal(box.readData("CLAUDE.md"), "# v1 rules\n")
    })

    it("adopt_hintsForceInTheAcceptDropsRefusal_whenTheV1ClaudeMdIsInTheWay", () => {
      writeV1ClaudeMd()
      const result = box.runLink("--write", "--adopt", "--force")
      assertExit(result, 3)
      assert.ok(result.stderr.includes("run: bin/link --write --adopt --force --accept-drops <file>"))
      assert.equal(box.readData("CLAUDE.md"), "# v1 rules\n")
    })

    it("adopt_hintsNoForceInTheAcceptDropsRefusal_whenNothingIsInTheWay", () => {
      const result = box.runLink("--write", "--adopt")
      assertExit(result, 3)
      assert.ok(result.stderr.includes("run: bin/link --write --adopt --accept-drops <file>"))
    })

    it("write_hintsOnlyForce_whenSettingsAreAdoptedAndAHandWrittenClaudeMdIsInTheWay", () => {
      assertExit(adopt(), 0)
      box.writeData("CLAUDE.md", "# hand-written rules\n")
      const result = box.runLink("--write")
      assertExit(result, 3)
      assert.ok(result.stderr.includes("run: bin/link --write --force"))
      const hints = result.stderr.split("\n").filter((line) => line.includes("run: bin/link"))
      assert.equal(hints.length, 1)
      assert.ok(!hints[0]?.includes("--adopt"))
      assert.ok(!hints[0]?.includes("--accept-drops"))
    })

    it("write_reportsOnlyTheForceLiftedProblemAsForced_whenAdoptAndForceBothLiftProblems", () => {
      writeV1ClaudeMd()
      const result = box.runLink("--write", "--adopt", "--force", "--accept-drops", acceptFile(EXPECTED_DROPS))
      assertExit(result, 0)
      const forced = result.stderr.split("\n").filter((line) => line.startsWith("link: forced: "))
      assert.equal(forced.length, 1, forced.join("\n"))
      assert.ok(forced[0]?.includes(box.dataPath("CLAUDE.md")))
    })

    it("write_printsNoCommandHint_whenAProblemNoFlagLifts", () => {
      box.writeKeel("settings/links.tsv", CORE_LINKS_WITH_DANGLING)
      const result = box.runLink("--write", "--adopt")
      assertExit(result, 3)
      assert.ok(problemKinds(result).includes("dangling"))
      assert.ok(!result.stderr.includes("run: bin/link"))
    })
  })

  describe("settings backup", () => {
    it("adopt_copiesLiveSettingsToAPrivateBackup_beforeWriting", () => {
      assertExit(adopt(), 0)
      const [backup, ...others] = backups()
      assert.equal(others.length, 0)
      assert.equal(readFile(backup as string), V1_TEXT)
      assert.equal(fs.statSync(backup as string).mode & 0o777, 0o600)
    })

    it("write_backsUpSettingsAgain_whenALaterWriteChangesThem", () => {
      assertExit(adopt(), 0)
      addMore()
      assertExit(box.runLink("--write"), 0)
      assert.equal(backups().length, 2)
    })
  })

  describe("unlink restore", () => {
    const savedLivePath = (result: LinkResult): string =>
      result.json.actions.find((action: { op: string }) => action.op === "restore-settings").live_saved_to

    it("unlink_restoresThePreKeelSettings_afterSeveralWrites", () => {
      assertExit(adopt(), 0)
      addMore()
      assertExit(box.runLink("--write"), 0)
      const result = box.runLink("--unlink")
      assertExit(result, 0)
      assert.equal(box.readData("settings.json"), V1_TEXT)
      assert.ok(ops(result).includes("restore-settings"))
      assert.ok(!afterRunMarker(result).includes("settings.json"))
    })

    it("unlink_keepsPostSwapEditsToKeysKeelDoesNotOwn_whileRestoringTheOwnedKeys", () => {
      assertExit(adopt(), 0)
      const edited = box.readData("settings.json").replace('"model": "opus"', '"statusLine": "user-edit",\n  "model": "sonnet"')
      box.writeData("settings.json", edited)
      const result = box.runLink("--unlink")
      assertExit(result, 0)
      const expected = { statusLine: "user-edit", ...LIVE_V1, model: "sonnet" }
      assert.equal(box.readData("settings.json"), JSON.stringify(expected, null, 2) + "\n")
      assert.ok(ops(result).includes("restore-settings"))
    })

    it("unlink_keepsAKeyKeelDoesNotOwnRemoved_whenTheUserRemovedItAfterTheSwap", () => {
      assertExit(adopt(), 0)
      const live = JSON.parse(box.readData("settings.json"))
      delete live.model
      box.writeData("settings.json", JSON.stringify(live, null, 2) + "\n")
      assertExit(box.runLink("--unlink"), 0)
      const { model: _removed, ...expected } = LIVE_V1
      assert.deepEqual(JSON.parse(box.readData("settings.json")), expected)
    })

    it("unlink_removesAnOwnedKey_whenThePreKeelSettingsLackedIt", () => {
      const { env: _env, ...withoutEnv } = LIVE_V1
      box.writeData("settings.json", JSON.stringify(withoutEnv, null, 2) + "\n")
      assertExit(writeAdoptingEveryDrop(box), 0)
      assert.ok("env" in JSON.parse(box.readData("settings.json")))
      assertExit(box.runLink("--unlink"), 0)
      assert.deepEqual(JSON.parse(box.readData("settings.json")), withoutEnv)
    })

    it("unlink_restoresTheWholePreKeelSettings_whenTheLiveFileIsNotAJsonObject", () => {
      assertExit(adopt(), 0)
      box.writeData("settings.json", "[]\n")
      const result = box.runLink("--unlink")
      assertExit(result, 0)
      assert.equal(box.readData("settings.json"), V1_TEXT)
      assert.ok(ops(result).includes("restore-settings"))
    })

    it("unlink_leavesSettingsMissingAndNamesThemInTheV1Command_whenTheUserDeletedTheLiveFile", () => {
      assertExit(adopt(), 0)
      fs.unlinkSync(box.dataPath("settings.json"))
      const result = box.runLink("--unlink")
      assertExit(result, 0)
      assert.equal(fs.existsSync(box.dataPath("settings.json")), false)
      assert.ok(!ops(result).includes("restore-settings"))
      assert.ok(afterRunMarker(result).includes("settings.json"))
    })

    it("unlink_leavesSettingsAndListsThemInTheV1Command_whenNoLinkStateIsRecorded", () => {
      assertExit(adopt(), 0)
      const written = box.readData("settings.json")
      fs.unlinkSync(box.dataPath("state/keel/link-state.json"))
      const result = box.runLink("--unlink")
      assertExit(result, 0)
      assert.equal(box.readData("settings.json"), written)
      assert.ok(!ops(result).includes("restore-settings"))
      assert.ok(afterRunMarker(result).includes("settings.json"))
    })

    it("unlink_savesTheLiveSettingsToANewPrivateBackup_beforeRestoring", () => {
      assertExit(adopt(), 0)
      const edited = box.readData("settings.json").replace('"model"', '"statusLine": "user-edit",\n  "model"')
      box.writeData("settings.json", edited)
      const result = box.runLink("--unlink")
      assertExit(result, 0)
      const saved = savedLivePath(result)
      assert.equal(readFile(saved), edited)
      assert.equal(fs.statSync(saved).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(saved)).mode & 0o777, 0o700)
    })

    it("unlink_keepsThePreKeelSettings_whenRunTwice", () => {
      assertExit(adopt(), 0)
      assertExit(box.runLink("--unlink"), 0)
      assertExit(box.runLink("--unlink"), 0)
      assert.equal(box.readData("settings.json"), V1_TEXT)
    })

    it("unlink_keepsThePreKeelSettings_whenRunTwiceAfterTwoWrites", () => {
      assertExit(adopt(), 0)
      addMore()
      assertExit(box.runLink("--write"), 0)
      assertExit(box.runLink("--unlink"), 0)
      assertExit(box.runLink("--unlink"), 0)
      assert.equal(box.readData("settings.json"), V1_TEXT)
    })

    it("unlink_restoresTheSettingsFromBeforeKeelsFirstSettingsWrite_whenAnEarlierWriteLeftSettingsAlone", () => {
      box.writeData("settings.json", "{}\n")
      assertExit(box.runLink("--write"), 0)
      const preKeel = box.readData("settings.json")
      fs.unlinkSync(box.dataPath("state/keel/link-state.json"))
      assertExit(box.runLink("--write"), 0)
      addMore()
      assertExit(box.runLink("--write"), 0)
      assertExit(box.runLink("--unlink"), 0)
      assert.equal(box.readData("settings.json"), preKeel)
    })

    it("unlink_restoresTheWholePreKeelSettings_whenTheLiveFileIsNotValidJson", () => {
      assertExit(adopt(), 0)
      box.writeData("settings.json", "{ broken")
      const result = box.runLink("--unlink")
      assertExit(result, 0)
      assert.equal(box.readData("settings.json"), V1_TEXT)
      assert.equal(readFile(savedLivePath(result)), "{ broken")
    })

    it("unlink_leavesSettingsAndPrintsTheV1Command_whenNoBackupExists", () => {
      box.writeData("settings.json", '{"model": "opus"}\n')
      assertExit(box.runLink("--write"), 0)
      const written = box.readData("settings.json")
      for (const backup of backups()) fs.unlinkSync(backup)
      const result = box.runLink("--unlink")
      assertExit(result, 0)
      assert.equal(box.readData("settings.json"), written)
      assert.ok(afterRunMarker(result).includes("settings.json"))
    })
  })
})

describe("list dropped items", () => {
  it("listDroppedItems_labelsAnEnvKeyValueChangedWithoutItsValue_whenTheMergeChangesTheValue", () => {
    assert.deepEqual(listDroppedItems({ env: { TOKEN: "old-secret" } }, { env: { TOKEN: "new" } }), ["env TOKEN (value changed)"])
  })

  it("listDroppedItems_labelsAnEnvKeyRemoved_whenTheMergeDoesNotDeclareIt", () => {
    assert.deepEqual(listDroppedItems({ env: { TOKEN: "old-secret" } }, { env: {} }), ["env TOKEN (removed)"])
  })

  it("listDroppedItems_keepsNothing_whenMergedHoldsEveryLiveItem", () => {
    const live = { permissions: { deny: ["a"], defaultMode: "auto" }, hooks: { Stop: [{ hooks: [{ command: "x" }] }] } }
    assert.deepEqual(listDroppedItems(live, JSON.parse(JSON.stringify(live))), [])
  })

  it("listDroppedItems_namesACommandHook_whenTheMergeMovesItToAnotherMatcher", () => {
    const live = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] } }
    const merged = { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "x" }] }] } }
    assert.deepEqual(listDroppedItems(live, merged), ["hooks.PreToolUse x"])
  })

  it("listDroppedItems_namesACommandHook_whenTheMergeChangesItsTimeout", () => {
    const live = { hooks: { Stop: [{ hooks: [{ type: "command", command: "x", timeout: 5 }] }] } }
    const merged = { hooks: { Stop: [{ hooks: [{ type: "command", command: "x", timeout: 60 }] }] } }
    assert.deepEqual(listDroppedItems(live, merged), ["hooks.Stop x"])
  })

  it("listDroppedItems_keepsAPromptHook_whenMergedHoldsTheSameHook", () => {
    const live = { hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "p" }] }] } }
    assert.deepEqual(listDroppedItems(live, JSON.parse(JSON.stringify(live))), [])
  })

  it("listDroppedItems_namesTheWholeKey_whenALiveOwnedKeyIsNotAnObject", () => {
    assert.deepEqual(listDroppedItems({ permissions: ["Read"] }, { permissions: {} }), ["permissions (not an object)"])
  })

  it("readAcceptedDrops_refuses_whenTheFileCannotBeRead", () => {
    assert.throws(() => readAcceptedDrops("/nonexistent/accepted.txt"), Refused)
  })
})
