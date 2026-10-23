import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { CHECKOUT, FUTURE, PAST, charterRow, ledgerRow, readText } from "./helpers.ts"
import { SmokeHarness } from "./smoke_helpers.ts"

let harness: SmokeHarness

beforeEach(() => {
  harness = new SmokeHarness()
})
afterEach(() => harness.cleanup())

describe("smoke run", () => {
  it("smoke_passesEveryAssertion_onACleanCheckout", () => {
    const [completed, result] = harness.runSmoke()
    assert.equal(completed.status, 0)
    assert.equal(result.ok, true)
    assert.deepEqual(result.assertions.filter((item) => item.status !== "PASS"), [])
    assert.equal(result.count, result.assertions.length)
    assert.equal(result.cap, 2 * 2 + 40)
  })

  it("smoke_appendsRunLineWithWorkingTree_toSmokeLog", () => {
    const { box } = harness
    box.write("keel/uncommitted.txt", "work in progress\n")
    const [, result] = harness.runSmoke()
    const line = box.lastLogLine("keel-smoke.jsonl") as any
    assert.deepEqual([line.run_id, line.ok, line.count, line.failed], [result.run_id, true, result.count, []])
    assert.match(line.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    assert.deepEqual(Object.keys(line.trees), ["example/keel"])
    assert.notEqual(line.trees["example/keel"], box.git(box.keel, "rev-parse", "HEAD^{tree}").trim())
    assert.equal(box.git(box.keel, "status", "--porcelain"), "?? uncommitted.txt\n")
  })

  it("smoke_recordsNoTree_whenOriginHasNoOwnerSegment", () => {
    const { box } = harness
    box.git(box.keel, "remote", "set-url", "origin", "app.git")
    const completed = box.runMeasure("smoke", ["--json-only"])
    assert.deepEqual((box.lastLogLine("keel-smoke.jsonl") as any).trees, {})
    assert.ok(completed.stderr.includes("has no owner/repo origin"))
  })

  it("smoke_exitsOneAndPrintsSummary_whenAnAssertionFails", () => {
    const { box } = harness
    box.fire("C-unknown")
    const completed = box.runMeasure("smoke")
    assert.equal(completed.status, 1)
    assert.ok(completed.stderr.includes("FAIL  fires-rule-ids/all"))
    const line = box.lastLogLine("keel-smoke.jsonl") as any
    assert.deepEqual(line.failed.map((item: { check: string; scope: string }) => [item.check, item.scope]), [["fires-rule-ids", "all"]])
  })

  it("smoke_runIdHasTheStampAndSixHexDigits", () => {
    const [, result] = harness.runSmoke()
    assert.match(result.run_id, /^smoke-\d{8}T\d{6}Z-[0-9a-f]{6}$/)
  })
})

describe("ledger checks", () => {
  const assertStatus = (check: string, scope: string, status: string, detail: string = "") => harness.assertStatus(check, scope, status, detail)
  const keelRows = (...rows: Parameters<SmokeHarness["keelRows"]>) => harness.keelRows(...rows)

  it("ledgerFormat_fails_whenSkillRowLacksWhyNotStronger", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo", { layer: "skill", enforced_at: "skill:demo" }))
    assertStatus("ledger-format", "keel", "FAIL", "C-demo (line 3): layer skill needs why_not_stronger")
  })

  it("ledgerFormat_fails_whenHeaderDiffers", () => {
    harness.box.write("keel/ledger.tsv", "id\tscope\n")
    assertStatus("ledger-format", "keel", "FAIL", "header must be exactly")
  })

  it("ledgerFormat_fails_whenKeelLedgerIsMissing", () => {
    fs.rmSync(path.join(harness.box.keel, "ledger.tsv"))
    assertStatus("ledger-format", "keel", "FAIL", "no ledger")
  })

  it("ledgerFormat_passes_whenOverlayLedgerIsAbsent", () => {
    assertStatus("ledger-format", "overlay", "PASS", "no ledger")
  })

  it("ledgerFormat_fails_whenOverlayLedgerHoldsACoreRow", () => {
    harness.box.writeLedger("overlay/ledger.tsv", [ledgerRow("C-sneaky")])
    assertStatus("ledger-format", "overlay", "FAIL", "overlay rows live only in the overlay ledger")
  })

  it("ledgerFormat_passes_forTheShippedOverlayExample", () => {
    harness.box.write("overlay/ledger.tsv", readText(path.join(CHECKOUT, "examples", "ledger-smoke", "ledger.tsv")))
    assertStatus("ledger-format", "overlay", "PASS", "1 rows")
  })

  it("ledgerFormat_namesEveryViolationOfARowWithTheQuotedValue", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo", { scope: "nowhere", type: "odd", metric: "bogus" }))
    const item = harness.assertion("ledger-format", "keel")
    assert.ok(item.detail.includes('unknown scope "nowhere"'), item.detail)
    assert.ok(item.detail.includes('unknown type "odd"'), item.detail)
  })

  it("idUnique_fails_whenAnIdRepeatsAcrossLedgers", () => {
    harness.box.writeLedger("overlay/ledger.tsv", [ledgerRow("O-x", { scope: "overlay" }), ledgerRow("O-x", { scope: "overlay" })])
    assertStatus("id-unique", "all", "FAIL", "O-x")
  })

  it("coreCap_fails_whenElevenCoreRowsAreActive", () => {
    keelRows(charterRow("K1"), ...Array.from({ length: 11 }, (_, number) => ledgerRow(`C-r${number}`)))
    assertStatus("caps", "core", "FAIL", "11/10")
  })

  it("coreCap_excludesFloorAndRetiredRows", () => {
    const rows = Array.from({ length: 10 }, (_, number) => ledgerRow(`C-r${number}`))
    rows.push(ledgerRow("C-old", { status: "retired" }))
    rows.push(ledgerRow("F-demo", { type: "floor", justification: "Why.", review_by: "-" }))
    keelRows(charterRow("K1"), ...rows)
    assertStatus("caps", "core", "PASS", "10/10")
  })

  it("stacksCap_fails_whenSixStacksHaveRows", () => {
    keelRows(charterRow("K1"), ...Array.from({ length: 6 }, (_, number) => ledgerRow(`S-r${number}`, { scope: `stack:s${number}` })))
    assertStatus("caps", "stacks", "FAIL", "6/5")
    assertStatus("caps", "stack:s0", "PASS", "1/10")
  })

  it("ruleOfTwo_fails_whenOneIncidentAndGraceIsOver", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo", { incidents: "docs/incidents/one.md", grace_until: PAST }))
    assertStatus("rule-of-two", "keel", "FAIL", "C-demo: 1 of 2 incident refs")
  })

  it("ruleOfTwo_isGrace_whenOneIncidentBeforeGraceUntil", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo", { incidents: "-", grace_until: FUTURE }))
    assertStatus("rule-of-two", "keel", "GRACE", "in grace: C-demo")
  })

  it("ruleOfTwo_fails_whenAnIncidentFileIsMissing", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo", { incidents: "docs/incidents/one.md,docs/incidents/gone.md" }))
    assertStatus("rule-of-two", "keel", "FAIL", "missing incident files: docs/incidents/gone.md")
  })

  it("ruleOfTwo_fails_whenKeelLedgerCitesPrivateRefs", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo", { incidents: "private:a,private:b" }))
    assertStatus("rule-of-two", "keel", "FAIL", "private refs belong only in the overlay ledger")
  })

  it("ruleOfTwo_passes_whenOverlayRowCitesTwoPrivateRefs", () => {
    harness.box.writeLedger("overlay/ledger.tsv", [ledgerRow("O-demo", { scope: "overlay", incidents: "private:a,private:b" })])
    harness.box.fire("O-demo")
    assertStatus("rule-of-two", "overlay", "PASS", "1 rows checked")
  })

  it("ruleOfTwo_reportsFeedbackMemories_asIncidentCandidates_whenARowLacksIncidents", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo", { incidents: "-", grace_until: FUTURE }))
    harness.box.write("data/projects/p1/memory/feedback_slow_tests.md", "note\n")
    assertStatus("rule-of-two", "keel", "GRACE", "incident candidates (feedback memories): feedback_slow_tests.md")
  })

  it("ruleOfTwo_omitsFeedbackMemories_whenEveryRowHasItsIncidents", () => {
    harness.box.write("data/projects/p1/memory/feedback_slow_tests.md", "note\n")
    const item = assertStatus("rule-of-two", "keel", "PASS")
    assert.ok(!item.detail.includes("incident candidates"))
  })

  it("metrics_fail_whenRowCountsZeroAfterGrace", () => {
    keelRows(charterRow("K1"), ledgerRow("C-silent", { grace_until: PAST }))
    assertStatus("metrics", "keel", "FAIL", "C-silent: 0 items for fires:C-silent")
  })

  it("metrics_fail_whenRowHasNoMetric", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo", { metric: "-", grace_until: FUTURE }))
    assertStatus("metrics", "keel", "FAIL", "C-demo: row has no metric")
  })

  it("metrics_isGrace_whenRowCountsZeroBeforeGraceUntil", () => {
    keelRows(charterRow("K1"), ledgerRow("C-silent", { grace_until: FUTURE }))
    assertStatus("metrics", "keel", "GRACE", "C-silent")
  })

  it("expiry_warnsListingExpiredIds_whenARowIsPastReviewBy", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo"), ledgerRow("C-silent", { review_by: PAST, grace_until: FUTURE }))
    const item = assertStatus("expiry", "all", "WARN", "past review_by: C-silent (run measure/propose")
    assert.ok(!item.detail.includes("C-demo"))
  })

  it("expiry_passes_whenNoRowIsPastReviewBy", () => {
    keelRows(charterRow("K1"), ledgerRow("C-demo"))
    assertStatus("expiry", "all", "PASS", "no row past review_by")
  })
})

describe("file checks", () => {
  const assertStatus = (check: string, scope: string, status: string, detail: string = "") => harness.assertStatus(check, scope, status, detail)

  function writeSettings(scripts: string[]): void {
    const groups = scripts.map((name) => ({ matcher: "Bash", hooks: [{ type: "command", command: `node /k/hooks/${name}.js --flag` }] }))
    harness.box.write("data/settings.json", JSON.stringify({ model: "x", hooks: { PreToolUse: groups } }))
  }

  it("hookScriptCap_fails_whenNineDistinctScriptsAreRegistered", () => {
    writeSettings(Array.from({ length: 9 }, (_, number) => `h${number}`))
    assertStatus("caps", "hook-scripts", "FAIL", "9/8")
  })

  it("hookScriptCap_countsAScriptOnce_whenRegisteredForSeveralEvents", () => {
    writeSettings(Array(9).fill("same"))
    assertStatus("caps", "hook-scripts", "PASS", "1/8: /k/hooks/same.js")
  })

  it("hookScriptCap_fails_whenSettingsJsonIsNotJson", () => {
    harness.box.write("data/settings.json", "{oops")
    assertStatus("caps", "hook-scripts", "FAIL", "settings.json unreadable: ")
  })

  it("memoryIndexCap_warns_whenAnIndexExceeds8192Bytes", () => {
    harness.box.write("data/projects/p1/memory/MEMORY.md", "x".repeat(8193))
    assertStatus("caps", "memory-index", "WARN", "8193 bytes")
  })

  it("memoryIndexCap_passes_whenAnIndexIsExactly8192Bytes", () => {
    harness.box.write("data/projects/p1/memory/MEMORY.md", "x".repeat(8192))
    assertStatus("caps", "memory-index", "PASS", "1 indexes within 8192 bytes")
  })

  it("idTagging_fails_whenAPrinciplesBulletHasNoId", () => {
    harness.box.write("keel/PRINCIPLES.md", "- [K1] Tagged.\n- Untagged rule.\n")
    assertStatus("id-tagging", "principles", "FAIL", "line 2: bullet without [ID]")
  })

  it("idTagging_failsOnABulletAfterALoneCarriageReturn", () => {
    harness.box.write("keel/PRINCIPLES.md", "# Principles\n\n- [K1] Tagged.\r- untagged bullet\n")
    assertStatus("id-tagging", "principles", "FAIL", "line 4: bullet without [ID]")
  })

  it("idTagging_keepsAUnicodeLineSeparatorOrFormFeedInsideTheLine", () => {
    harness.box.write("keel/PRINCIPLES.md", "# Principles\n\n- [K1] Tagged.\u2028- more\f- text\n")
    assertStatus("id-tagging", "principles", "PASS", "3 lines checked")
  })

  it("idTagging_numbersTheRulesSectionOfASkillByCrlfLines", () => {
    harness.box.write("keel/skills/demo/SKILL.md", "# Demo\r\n\r\n## Rules\r\n\r\n- [K1] Tagged.\r\n- untagged bullet\r\n")
    assertStatus("id-tagging", "skill:demo", "FAIL", "line 6: bullet without [ID]")
  })

  it("idTagging_fails_whenATagNamesNoLedgerRow", () => {
    harness.box.write("keel/PRINCIPLES.md", "1. [C-ghost] Unknown.\n")
    assertStatus("id-tagging", "principles", "FAIL", "line 1: unknown id [C-ghost]")
  })

  it("idTagging_acceptsK5SubchecksAndSkipsFencedCode", () => {
    harness.box.write("keel/PRINCIPLES.md", "- [K5.16] Tests read as a spec.\n```\n- not a rule\n```\n")
    assertStatus("id-tagging", "principles", "PASS")
  })

  it("idTagging_warns_whenPrinciplesIsAbsent", () => {
    fs.rmSync(path.join(harness.box.keel, "PRINCIPLES.md"))
    assertStatus("id-tagging", "principles", "WARN", "absent")
  })

  it("idTagging_checksOnlyTheRulesSectionOfASkill", () => {
    harness.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n- free bullet\n\n## Rules\n\n- [K1] Tagged.\n- Untagged.\n\n## Usage\n\n- free again\n")
    assertStatus("id-tagging", "skill:demo", "FAIL", "line 8: bullet without [ID]")
  })

  it("idTagging_checksTheRulesSection_whenTheHeadingCarriesAQualifier", () => {
    harness.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n## Rules (hard)\n\n- [K1] Tagged.\n- Untagged.\n")
    assertStatus("id-tagging", "skill:demo", "FAIL", "line 6: bullet without [ID]")
  })

  it("idTagging_checksTheRulesSection_whenTheHeadingEndsWithAColon", () => {
    harness.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n## Rules:\n\n- Untagged.\n")
    assertStatus("id-tagging", "skill:demo", "FAIL", "line 5: bullet without [ID]")
  })

  it("idTagging_checksTheRulesSection_whenTheHeadingIsLowercase", () => {
    harness.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n## rules\n\n- Untagged.\n")
    assertStatus("id-tagging", "skill:demo", "FAIL", "line 5: bullet without [ID]")
  })

  it("idTagging_failsTheSkillsTotal_whenNoSkillHasARuleBullet", () => {
    harness.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n## Rule list\n\n- Untagged.\n")
    assertStatus("id-tagging", "skill:demo", "PASS")
    assertStatus("id-tagging", "skills", "FAIL", "0 rule bullets")
  })

  it("idTagging_passesTheSkillsTotal_whenOneSkillHasATaggedRule", () => {
    harness.box.write("keel/skills/other/SKILL.md", "# Other\n\nNo rules here.\n")
    assertStatus("id-tagging", "skills", "PASS", "1 rule bullets across 2 skills")
  })

  it("idTagging_checksPersonalFromTheOverlay", () => {
    harness.box.write("overlay/PERSONAL.md", "* plain preference\n")
    assertStatus("id-tagging", "personal", "FAIL", "line 1")
  })

  it("firesRuleIds_fails_whenALogLineNamesAnUnknownId", () => {
    harness.box.fire("-")
    assertStatus("fires-rule-ids", "all", "FAIL", "unknown rule_ids: -")
  })

  it("firesRuleIds_acceptsOverlayRepoRuleIds", () => {
    harness.box.write("overlay/git-guard/repo-rules.tsv", "origin_glob\taction\tpattern\trule_id\tmessage\nacmecorp/*\tdeny-path\t*.sql\tO-files\tNo SQL.\n")
    harness.box.fire("O-files")
    assertStatus("fires-rule-ids", "all", "PASS")
  })

  it("boundary_fails_whenATrackedFileHitsTheLexicon", () => {
    harness.box.write("keel/docs/leak.md", "Built for AcmeCorp.\n")
    harness.box.commitAll(harness.box.keel)
    assertStatus("boundary", "keel", "FAIL", "docs/leak.md:1 lexicon:1")
  })

  it("boundary_ignoresUntrackedFiles", () => {
    harness.box.write("keel/scratch.md", "acmecorp\n")
    assertStatus("boundary", "keel", "PASS")
  })

  it("boundary_fails_whenOverlayLexiconIsAbsent", () => {
    fs.rmSync(path.join(harness.box.overlay, "boundary", "lexicon.txt"))
    assertStatus("boundary", "keel", "FAIL", "overlay lexicon absent")
  })

  it("boundary_fails_whenOverlayLexiconHasNoTerms", () => {
    harness.box.write("overlay/boundary/lexicon.txt", "# none yet\n")
    assertStatus("boundary", "keel", "FAIL", "has no terms")
  })

  it("linkIntegrity_fails_whenLinkCheckReportsProblems", () => {
    harness.box.write("stubs/link", '#!/bin/bash\necho \'{"actions":[],"problems":[{"kind":"dangling","path":"skills/x","detail":"-"}]}\'\nexit 1\n', true)
    assertStatus("link-integrity", "all", "FAIL", "dangling skills/x")
  })

  it("linkIntegrity_fails_whenLinkToolIsMissing", () => {
    fs.rmSync(harness.box.linkStub)
    assertStatus("link-integrity", "all", "FAIL", "link tool not executable")
  })

  it("dangling_fails_whenALinkedSkillPointsNowhere", () => {
    const { box } = harness
    fs.mkdirSync(path.join(box.data, "skills", "real"), { recursive: true })
    fs.symlinkSync(path.join(box.root, "gone"), path.join(box.data, "skills", "real", "SKILL.md"))
    fs.symlinkSync(box.keel, path.join(box.data, "skills", "alive"))
    assertStatus("dangling", "data", "FAIL", "1 dangling links: skills/real/SKILL.md")
  })

  it("dangling_listsEachDirectorysLinksBeforeItsSubdirectories", () => {
    const { box } = harness
    const skills = path.join(box.data, "skills")
    fs.mkdirSync(path.join(skills, "a"), { recursive: true })
    for (const link of ["a/z", "a-b", "c"]) fs.symlinkSync(path.join(box.root, "gone"), path.join(skills, link))
    assertStatus("dangling", "data", "FAIL", "3 dangling links: skills/a-b; skills/c; skills/a/z")
  })

  it("dangling_recursesIntoSubdirectoriesInUtf16Order_likeTheBaseWalk", () => {
    const { box } = harness
    const skills = path.join(box.data, "skills")
    for (const [directory, name] of [["\u{1F600}", "x"], ["\uFF10", "y"]]) {
      fs.mkdirSync(path.join(skills, directory), { recursive: true })
      fs.symlinkSync(path.join(box.root, "gone"), path.join(skills, directory, name))
    }
    assertStatus("dangling", "data", "FAIL", "2 dangling links: skills/\u{1F600}/x; skills/\uFF10/y")
  })

  it("assertionCap_fails_whenSkillsOutgrowTheAllowance", () => {
    for (let number = 0; number < 30; number++) harness.box.write(`keel/skills/s${number}/SKILL.md`, "## Rules\n\n- [K1] Tagged.\n")
    const [completed, result] = harness.runSmoke()
    const capItem = result.assertions.find((item) => item.check === "assertion-cap")
    assert.deepEqual([capItem?.status, result.cap, completed.status], ["FAIL", 44, 1])
    assert.ok(result.count > 44)
  })
})
