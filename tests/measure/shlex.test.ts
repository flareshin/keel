import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { gunzipSync } from "node:zlib"

import { ShlexError, shlexQuote, shlexSplit } from "../../measure/lib/measurekit/shlex.ts"

const SPLIT_CASES = JSON.parse(gunzipSync(fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "measure", "shlex-split.json.gz"))).toString("utf8")) as [string, string[] | string][]

const QUOTE_CASES: [string, string][] = [
  ["", "''"], ["plain", "plain"], ["with space", "'with space'"], ["it's", `'it'"'"'s'`], ["a'b'c", `'a'"'"'b'"'"'c'`],
  ["tab\there", "'tab\there'"], ["new\nline", "'new\nline'"], ["$HOME", "'$HOME'"], ["~/x", "'~/x'"], ["a=b:c,d@e%f+g./-h", "a=b:c,d@e%f+g./-h"],
  ["caf\u00e9", "'caf\u00e9'"], [`da ta's \u00e9 \u{1F600}`, `'da ta'"'"'s \u00e9 \u{1F600}'`], ["\\", "'\\'"], ['"', `'"'`], ["*", "'*'"], ["a;b|c&d", "'a;b|c&d'"],
]

function splitOrError(command: string): string[] | string {
  try {
    return shlexSplit(command)
  } catch (error) {
    if (error instanceof ShlexError) return "ERR " + error.message
    throw error
  }
}

describe("shlex", () => {
  it("shlexSplit_givesTheRecordedWordsOrError_forQuotesEscapesAndRandomCommands", () => {
    const mismatches = SPLIT_CASES.filter(([command, expected]) => JSON.stringify(splitOrError(command)) !== JSON.stringify(expected))
    assert.equal(SPLIT_CASES.length, 320)
    assert.deepEqual(mismatches, [])
  })

  it("shlexQuote_leavesSafeWordsAlone_andSingleQuotesEverythingElse", () => {
    assert.deepEqual(QUOTE_CASES.map(([text]) => shlexQuote(text)), QUOTE_CASES.map(([, quoted]) => quoted))
  })
})
