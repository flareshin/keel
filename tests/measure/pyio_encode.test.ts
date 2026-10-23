import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { backslashReplaceLoneSurrogates, encodeStrict, UnicodeEncodeError } from "../../measure/lib/measurekit/pyio.ts"

const FAILURES: [string, string, string][] = [
  ["aLoneHighSurrogateInTheMiddle", "a\ud800b", "'utf-8' codec can't encode character '\\ud800' in position 1: surrogates not allowed"],
  ["aLoneLowSurrogateAfterABmpCharacter", "é\udfff", "'utf-8' codec can't encode character '\\udfff' in position 1: surrogates not allowed"],
  ["twoHighSurrogatesInARow", "\ud800\ud801", "'utf-8' codec can't encode characters in position 0-1: surrogates not allowed"],
  ["aLowSurrogateBeforeAHighSurrogate", "\ude00\ud83d", "'utf-8' codec can't encode characters in position 0-1: surrogates not allowed"],
  ["aValidPairBeforeALoneSurrogateCountsThePairOnce", "x\u{1F600}\ud800", "'utf-8' codec can't encode character '\\ud800' in position 2: surrogates not allowed"],
  ["aRunOfThreeBeforeATrailingLetter", "\ud800\ud800\ud800z", "'utf-8' codec can't encode characters in position 0-2: surrogates not allowed"],
  ["aNonBmpCharacterBeforeALoneLowSurrogate", "\u{1F600}\udfff", "'utf-8' codec can't encode character '\\udfff' in position 1: surrogates not allowed"],
]

describe("strict utf-8 encoding matches python", () => {
  for (const [name, text, message] of FAILURES) {
    it(`${name}_throwsUnicodeEncodeErrorWithPythonsMessage`, () => {
      assert.throws(
        () => encodeStrict(text),
        (error: unknown) => error instanceof UnicodeEncodeError && error.constructor.name === "UnicodeEncodeError" && error.message === message,
      )
    })
  }

  it("wellFormedTextWithNonBmpCharacters_encodesToUtf8Bytes", () => {
    assert.equal(encodeStrict("aé\u{1F600}").toString("hex"), "61c3a9f09f9880")
  })

  it("loneSurrogatesOnStderr_areEscapedLikePythonsBackslashReplace", () => {
    assert.equal(backslashReplaceLoneSurrogates("env.\ud800 and \udfff and \u{1F600}"), "env.\\ud800 and \\udfff and \u{1F600}")
  })
})
