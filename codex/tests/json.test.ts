import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { asciiJson, parseHookJson, parseStateJson } from "../lib/json.ts";
import { Refusal } from "../lib/refusal.ts";
import { applySkillPlan, planSkills } from "../lib/skill_registry.ts";

const DIGIT_LIMIT = 4300;
const DEEP = 20000;

describe("hook JSON", () => {
  it("parseHookJson_refusesNaNInfinityABomAndTrailingData", () => {
    for (const text of ["NaN", "[Infinity]", '{"a": -Infinity}', "﻿{}", "{} 1", "", "  ", "{,}", '{"a": 01}', "[1,]", '{"a": "\u0001"}', "'a'"]) {
      assert.throws(() => parseHookJson(text), Refusal, JSON.stringify(text));
    }
  });

  it("parseHookJson_acceptsNumbersBeyond2To53And1e400_asDoubles", () => {
    assert.deepEqual(parseHookJson("[9007199254740993, 1e400, -1e400, 1e-400, -0.0]"), [9007199254740992, Infinity, -Infinity, 0, -0]);
  });

  it("parseHookJson_refusesAnIntegerOfMoreThan4300Digits_butNotAFloatOrAString", () => {
    const digits = "7".repeat(DIGIT_LIMIT + 1);
    assert.throws(() => parseHookJson(`{"a": [${digits}]}`), /integer exceeds 4300 digits/);
    assert.throws(() => parseHookJson(`-${digits}`), Refusal);
    assert.doesNotThrow(() => parseHookJson("7".repeat(DIGIT_LIMIT)));
    assert.doesNotThrow(() => parseHookJson(`${digits}.0`));
    assert.doesNotThrow(() => parseHookJson(`${digits}e0`));
    assert.doesNotThrow(() => parseHookJson(`"${digits}"`));
  });

  it("parseHookJson_refusesAnOversizedIntegerBeneathNestingTooDeepForTheDigitCheck", () => {
    const text = "[".repeat(DEEP) + "7".repeat(DIGIT_LIMIT + 1) + "]".repeat(DEEP);
    assert.throws(() => parseHookJson(text), /nests too deeply/);
  });

  it("parseHookJson_parsesNestingOf20000Levels_withoutALongDigitRun", () => {
    const text = "[".repeat(DEEP) + "1" + "]".repeat(DEEP);
    let depth = 0;
    for (let value = parseHookJson(text); Array.isArray(value); value = value[0] as typeof value) depth += 1;
    assert.equal(depth, DEEP);
  });

  it("parseHookJson_keepsProtoAsAnOrdinaryMember", () => {
    const parsed = parseHookJson('{"__proto__": {"x": 1}, "a": 2}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["__proto__", "a"]);
  });

  it("asciiJson_escapesEveryCharacterOutsideSpaceToTilde_asLowercaseUnicodeEscapes", () => {
    assert.equal(asciiJson({ k: "é\u{1f600}\u007f \ud800\n" }), '{"k":"\\u00e9\\ud83d\\ude00\\u007f\\u2028\\ud800\\n"}');
    assert.equal(asciiJson({ "é": "plain ~ text" }), '{"\\u00e9":"plain ~ text"}');
  });

  it("parseHookJson_readsFalsyLookingLiteralsAsTheirOwnJsonType_notAsAbsent", () => {
    const parsed = ["null", "false", "0", "0.0", "-0.0", "1e-400", '""', "[]", "{}"].map((text) => parseHookJson(text));
    assert.deepEqual(parsed.slice(0, 2), [null, false]);
    assert.deepEqual(parsed.slice(2, 6).map((value) => [typeof value, Object.is(value, -0)]), [["number", false], ["number", false], ["number", true], ["number", false]]);
    assert.deepEqual(parsed.slice(6), ["", [], {}]);
  });

  it("parseHookJson_readsNumbersAndTextThatLookTruthyAsTheirOwnJsonType", () => {
    assert.deepEqual(["true", "1", "-1", "0.5", '"0"', '"false"', "[0]", "[[]]", '{"a": 0}'].map((text) => parseHookJson(text)),
      [true, 1, -1, 0.5, "0", "false", [0], [[]], { a: 0 }]);
    assert.equal(parseHookJson("1e400"), Infinity);
    assert.equal(parseHookJson("12345678901234567890"), 12345678901234567000);
    assert.equal(typeof parseStateJson("12345678901234567890"), "object");
  });
});

describe("state JSON", () => {
  it("parseStateJson_keepsIntegersBeyond2To53Exact_whenWrittenBack", () => {
    const parsed = parseStateJson('{"n": 12345678901234567890, "m": [-9007199254740993], "f": 1.5, "s": 7}');
    assert.equal(JSON.stringify(parsed), '{"n":12345678901234567890,"m":[-9007199254740993],"f":1.5,"s":7}');
  });

  it("parseStateJson_refusesNaNAnInteger4301DigitsLongAndABom", () => {
    for (const text of ['{"a": NaN}', `{"a": ${"9".repeat(DIGIT_LIMIT + 1)}}`, "﻿{}"]) assert.throws(() => parseStateJson(text), Refusal, text.slice(0, 20));
  });

  it("applySkillPlan_rewritesTheSharedRegistryWithAnotherToolsBigIntegerUnchanged", () => {
    const agents = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-registry-")));
    try {
      const registry = join(agents, "keel-codex-skills.json");
      writeFileSync(registry, '{"version": 1, "serial": 12345678901234567890, "skills": {"demo": {"target": "/t", "managed": false, "profiles": ["/p"], "stamp": [9007199254740993, 2.5]}}}');
      const desired = new Map([[join(agents, "skills", "demo"), { kind: "link" as const, content: "/t" }]]);
      const plan = planSkills(agents, "/q", desired);
      assert.equal(plan.changed, true);
      applySkillPlan(agents, plan);
      const written = readFileSync(registry, "utf8");
      assert.match(written, /"stamp": \[\n\s+9007199254740993,\n\s+2\.5\n\s+\]/);
      assert.deepEqual(JSON.parse(written).skills.demo.profiles, ["/p", "/q"]);
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });
});
