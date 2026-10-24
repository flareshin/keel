import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { decodeStrict, expandHome, firstLine, InvalidUtf8Error, readUtf8, resolveLinks, splitLines, walkEntries, words } from "../../measure/lib/measurekit/files.ts"

describe("files", () => {
  let root: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-files-")))
    fs.mkdirSync(path.join(root, "real", "sub"), { recursive: true })
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"))
    fs.symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"))
    fs.symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"))
    fs.symlinkSync("missing-target", path.join(root, "dangling"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const at = (name: string): string => path.join(root, name)

  it("decodeStrict_namesItsSource_whenBytesAreNotUtf8_andKeepsAByteOrderMark", () => {
    assert.throws(() => decodeStrict(Buffer.from([0xc3, 0x28]), "the note"), (error: Error) => error instanceof InvalidUtf8Error
      && error.message === "the note is not valid UTF-8")
    assert.equal(decodeStrict(Buffer.from("\ufeff\u00e9"), "the note"), "\ufeff\u00e9")
  })

  it("words_splitsOnRunsOfWhitespace_andReturnsNothingForBlankText", () => {
    assert.deepEqual(words(" origin \t upstream\n"), ["origin", "upstream"])
    assert.deepEqual(words(" \n "), [])
  })

  it("readUtf8_keepsCrlfAndAByteOrderMark_andRejectsInvalidBytesAnywhere", () => {
    fs.writeFileSync(at("crlf"), "\ufeffa\r\nb")
    assert.equal(readUtf8(at("crlf")), "\ufeffa\r\nb")
    fs.writeFileSync(at("bad"), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x0a, 0xff, 0x0a])]))
    assert.throws(() => readUtf8(at("bad")), (error) => error instanceof InvalidUtf8Error && error.message === `${at("bad")} is not valid UTF-8`)
  })

  it("decodeStrict_keepsAByteOrderMark_andRejectsEveryInvalidSequenceNamingItsSource", () => {
    assert.equal(decodeStrict(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), "stdin"), "\ufeffa")
    for (const bytes of [[0xff], [0xe2, 0x82], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xc3, 0x28], [0xf4, 0x90, 0x80, 0x80]]) {
      assert.throws(() => decodeStrict(Buffer.from(bytes), "stdin"), (error) => error instanceof InvalidUtf8Error && error.message === "stdin is not valid UTF-8", `${bytes}`)
    }
  })

  it("firstLine_isTheTextBeforeTheFirstLineFeed_ofAStrictlyDecodedFile", () => {
    fs.writeFileSync(at("header"), "<!-- header -->\r\nrest\n")
    assert.equal(firstLine(at("header")), "<!-- header -->\r")
    fs.writeFileSync(at("bad-later"), Buffer.concat([Buffer.from("<!-- header -->\n"), Buffer.from([0xc7, 0xd1])]))
    assert.throws(() => firstLine(at("bad-later")), InvalidUtf8Error)
  })

  it("splitLines_breaksAtCrlfCrAndLf_only_andDropsOneTrailingEmptyLine", () => {
    assert.deepEqual(splitLines("a\r\nb\rc\nd\u000be\ff\u001cg\u2028h\n"), ["a", "b", "c", "d\u000be\ff\u001cg\u2028h"])
    assert.deepEqual([splitLines("\n"), splitLines(""), splitLines("a\n\n"), splitLines("x\r\n\r\ny")], [[""], [], ["a", ""], ["x", "", "y"]])
  })

  it("resolveLinks_followsLinks_andKeepsMissingTailsDanglingLinksAndLoopsUnresolved", () => {
    assert.deepEqual(
      ["link", "link/sub", "link/../real", "link/sub/missing/tail", "nothing/at/all", "./link/./sub/.."].map((name) => resolveLinks(at(name))),
      [at("real"), at("real/sub"), at("real"), at("real/sub/missing/tail"), at("nothing/at/all"), at("real")],
    )
    assert.deepEqual(["dangling", "loop-a", "loop-a/x"].map((name) => resolveLinks(at(name))), [at("dangling"), at("loop-a"), at("loop-a/x")])
  })

  it("expandHome_replacesOnlyALeadingTildeOrTildeSlash", () => {
    const saved = process.env["HOME"]
    process.env["HOME"] = "/home/tester/"
    try {
      assert.deepEqual(["~", "~/x", "~x", "plain", "a~", "~/"].map(expandHome), ["/home/tester", "/home/tester/x", "~x", "plain", "a~", "/home/tester/"])
    } finally {
      process.env["HOME"] = saved
    }
  })

  it("walkEntries_listsEverythingBelowTheTopSorted_withoutEnteringLinkedOrSkippedDirectories", () => {
    fs.writeFileSync(at("real/sub/file"), "x")
    fs.mkdirSync(at("real/.git"))
    fs.writeFileSync(at("real/.git/config"), "x")
    fs.symlinkSync(at("real/sub"), at("real/sub-link"))
    assert.deepEqual(walkEntries(at("real"), new Set([".git"])), [at("real/sub"), at("real/sub-link"), at("real/sub/file")])
    assert.deepEqual(walkEntries(at("absent")), [])
  })
})
