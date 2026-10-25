import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldDottedAndDotlessI, SPACE_CLASS, testCaseFolded, WORD_BOUNDARY, WORD_CHARS } from "../../hooks/lib/hookkit/text.ts";

const SPACE = new RegExp(SPACE_CLASS, "u");
const WORD = new RegExp(`^[${WORD_CHARS}]$`, "u");
const cat = (text: string) => new RegExp(`${WORD_BOUNDARY}cat${WORD_BOUNDARY}`, "u").test(text);

describe("SPACE_CHARS", () => {
  it("holdsTheCharactersAStrippedLineEndsWith_butNotTheByteOrderMarkOrZeroWidthSpace", () => {
    for (const space of ["\t", "\n", "\r", "\x1c", "\x1f", " ", "\x85", "\xa0", " ", " ", " ", " ", " ", " ", "　"]) {
      assert.ok(SPACE.test(space), JSON.stringify(space));
    }
    for (const other of ["﻿", "​", "\x1b", "a", "-"]) assert.equal(SPACE.test(other), false, JSON.stringify(other));
  });
});

describe("WORD_CHARS", () => {
  it("holdsLettersDigitsOfAnyScriptAndUnderscore", () => {
    for (const word of ["a", "Z", "é", "я", "5", "٣", "²", "_"]) assert.ok(WORD.test(word), word);
    for (const other of ["-", ".", " ", "/", " "]) assert.equal(WORD.test(other), false, JSON.stringify(other));
  });
});

describe("WORD_BOUNDARY", () => {
  it("matchesBetweenAWordCharacterAndAnythingElse_includingTheTextEdges", () => {
    assert.ok(cat("cat"));
    assert.ok(cat("a cat."));
    assert.ok(cat("x-cat-y"));
    assert.ok(cat("я cat"));
  });

  it("doesNotMatchInsideAWord_whichIncludesDigitsUnderscoresAndNonAsciiLetters", () => {
    for (const inside of ["concat", "cats", "cat2", "_cat", "écat", "cat²"]) assert.equal(cat(inside), false, inside);
  });
});

describe("foldDottedAndDotlessI", () => {
  it("mapsTheTurkishDottedAndDotlessIToPlainI_andLeavesEveryOtherCharacterAlone", () => {
    assert.equal(foldDottedAndDotlessI("İNDEX ındex"), "iNDEX index");
    assert.equal(foldDottedAndDotlessI("éÉI\u{1F600}"), "éÉI\u{1F600}");
  });

  it("testCaseFolded_letsAnIgnoreCasePatternSeeTheDottedIAsI", () => {
    assert.equal(testCaseFolded(/index/i, "İNDEX"), true);
    assert.equal(testCaseFolded(/index/i, "ındex"), true);
    assert.equal(testCaseFolded(/index/i, "éndex"), false);
  });
});
