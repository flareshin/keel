import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"

import { BoundaryUsageError, loadRules } from "../../measure/lib/measurekit/boundary.ts"
import type { Rule } from "../../measure/lib/measurekit/boundary.ts"

const RECORDED_GENERIC_MATCHES = JSON.parse(
  gunzipSync(fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "measure", "boundary-generic-matches.json.gz"))).toString("utf8"),
) as [rule: string, text: string, matches: boolean][]
const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP"
const INVENTED_PRIVATE_IP = "10.250." + "3.4"
const INVENTED_PASSWORD_LINE = "PASSWORD = " + "'abcdefghij'"

function hitsOf(rules: Rule[], text: string): string[] {
  return rules.filter((rule) => rule.matches(text)).map((rule) => rule.name)
}

describe("boundary rules", () => {
  let overlay: string

  beforeEach(() => {
    overlay = fs.mkdtempSync(path.join(os.tmpdir(), "keel-boundary-rules-"))
    fs.mkdirSync(path.join(overlay, "boundary"))
    fs.writeFileSync(path.join(overlay, "boundary", "lexicon.txt"), "acmecorp\n")
  })
  afterEach(() => fs.rmSync(overlay, { recursive: true, force: true }))

  const writeRegexes = (lines: string): void => fs.writeFileSync(path.join(overlay, "boundary", "regex.txt"), lines)

  it("genericRules_matchTheRecordedTexts", () => {
    const rules = new Map(loadRules(overlay, true).map((rule) => [rule.name, rule]))
    const mismatches = RECORDED_GENERIC_MATCHES.filter(([name, text, matches]) => rules.get(`generic:${name}`)?.matches(text) !== matches)
    assert.equal(RECORDED_GENERIC_MATCHES.length, 947)
    assert.deepEqual(mismatches, [])
  })

  it("genericRules_hitASecretAndAPrivateAddress_butOnlyWithAsciiDigits", () => {
    const rules = loadRules(overlay, true)
    assert.deepEqual(hitsOf(rules, `key ${FAKE_AWS_KEY} at ${INVENTED_PRIVATE_IP}`), ["generic:aws-access-key", "generic:private-ipv4-10"])
    assert.deepEqual(hitsOf(rules, INVENTED_PASSWORD_LINE), ["generic:credential-assignment"])
    assert.deepEqual(hitsOf(rules, "10.\u0663.2.3"), [])
  })

  it("overlayRegexes_useJavaScriptSyntax_withALeadingInlineIgnoreCaseFlag", () => {
    writeRegexes("(?i)begin\\.secret\nTKT-\\d{3,}\n(?s:BEGIN.SECRET)\n")
    const rules = loadRules(overlay, false)
    assert.deepEqual(hitsOf(rules, "BEGIN.SECRET and TKT-1234"), ["regex:1", "regex:2", "regex:3"])
    assert.deepEqual(hitsOf(rules, "ACMECORP tkt-12"), ["lexicon:1"])
  })

  it("overlayRegexes_thatJavaScriptCannotCompile_areAUsageError", () => {
    for (const pattern of ["(unclosed", "(?P<name>x)", "(?x)a b"]) {
      writeRegexes(pattern + "\n")
      assert.throws(() => loadRules(overlay, false), (error) => error instanceof BoundaryUsageError && error.message.startsWith("rule regex:1 has an invalid regex: "), pattern)
    }
  })
})
