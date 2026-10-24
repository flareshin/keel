import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mutate, seededRandom } from "../../tests/fuzz.ts";
import { recordedAnswers } from "../../tests/recorded.ts";
import { Refusal } from "../lib/refusal.ts";
import { RecursionError, TOMLDecodeError, TomlTemporal, tomlEquals, tomlLoads } from "../lib/toml.ts";
import type { TomlValue } from "../lib/toml.ts";

const TOML_FUZZ_CASES = 6000;
const MISMATCHES_SHOWN = 8;
const MIN_SHARE = 0.1;
const RECORDED_DOCUMENT = "codex-pyref";
const RECURSION_SEARCH_LIMIT = 4000;
const RECORDED_TYPE_NAMES: Record<string, string> = { ValueError: "Refusal" };
const FLOAT_WORDS: Record<string, number> = { nan: NaN, inf: Infinity, "-inf": -Infinity };

interface ReferenceCall {
  fn: string;
  args: unknown[];
}

interface Outcome {
  ok?: unknown;
  error?: string;
  type?: string;
}

function pythonReference(calls: ReferenceCall[]): Outcome[] {
  return recordedAnswers<ReferenceCall, Outcome>(RECORDED_DOCUMENT, calls, { "{{CWD}}": process.cwd() });
}

function outcomeOf(body: () => unknown): Outcome {
  try {
    return { ok: body() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message, type: error.name };
  }
}

function canonicalToml(value: TomlValue): unknown {
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (typeof value === "bigint") return { t: "int", v: value.toString() };
  if (typeof value === "number") return { t: "float", v: value };
  if (typeof value === "string") return { t: "str", v: value };
  if (value instanceof TomlTemporal) {
    if (value.kind === "date") return { t: "date", v: [value.year, value.month, value.day] };
    if (value.kind === "time") return { t: "time", v: [value.hour, value.minute, value.second, value.microsecond] };
    return {
      t: "datetime",
      v: [value.year, value.month, value.day, value.hour, value.minute, value.second, value.microsecond, value.offsetMinutes],
    };
  }
  if (Array.isArray(value)) return { t: "array", v: value.map(canonicalToml) };
  return { t: "table", v: Array.from(value, ([key, item]) => [key, canonicalToml(item)]) };
}

function recordedFloatsAsNumbers(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(recordedFloatsAsNumbers);
  if (typeof node !== "object" || node === null) return node;
  const record = node as { t?: string; v?: unknown };
  if (record.t === "float") return { t: "float", v: FLOAT_WORDS[record.v as string] ?? Number(record.v) };
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, recordedFloatsAsNumbers(item)]));
}

function assertBothKinds(label: string, expected: Outcome[]): void {
  const valid = expected.filter((outcome) => outcome.error === undefined).length;
  assert.ok(valid >= expected.length * MIN_SHARE, `${label}: only ${valid} of ${expected.length} documents parse`);
  assert.ok(expected.length - valid >= expected.length * MIN_SHARE, `${label}: only ${expected.length - valid} documents fail`);
}

function compareToRecorded(label: string, calls: ReferenceCall[], actual: Outcome[], expected: Outcome[]): void {
  assert.equal(actual.length, expected.length);
  const mismatches: string[] = [];
  actual.forEach((outcome, index) => {
    const reference = expected[index] as Outcome;
    const sameValue = Object.is(outcome.ok, reference.ok) || (outcome.ok !== undefined && reference.ok !== undefined && isDeepEqual(outcome.ok, recordedFloatsAsNumbers(reference.ok)));
    if (!sameValue || outcome.type !== (RECORDED_TYPE_NAMES[reference.type ?? ""] ?? reference.type)) {
      mismatches.push(`${JSON.stringify(calls[index])}\n  now: ${JSON.stringify(outcome)}\n  recorded: ${JSON.stringify(reference)}`);
    }
  });
  console.log(`recorded ${label}: ${calls.length} cases, ${mismatches.length} mismatches`);
  assert.equal(mismatches.length, 0, mismatches.slice(0, MISMATCHES_SHOWN).join("\n"));
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

const TOML_BASES = [
  '# comment\ntitle = "TOML \\u00e9"\n[owner]\nname = \'Tom\'\ndob = 1979-05-27T07:32:00-08:00\n',
  '[features]\nhooks = true\n[hooks]\nenabled = [1, 2.5, "x"]\n',
  'a.b.c = 1\na.b.d = { x = 1, y = [1, 2], z = { w = "q" } }\n[t.u]\nk = "v"\n[[arr]]\nn = 1\n[[arr]]\nn = 2\n[arr.sub]\nm = 3\n',
  's = """\nmulti \\\n   line\\n"""\nl = \'\'\'\nraw \\n\'\'\'\nq = "a\\"b"\ne = "\\e\\x41\\U0001F600"\n',
  "n = [0x1F, 0o17, 0b101, 1_000, +5, -0, 6.02e23, inf, -inf, nan]\nt = [07:32:00, 07:32, 1979-05-27, 1979-05-27 07:32:00.123456789, 1979-05-27T07:32Z]\n",
  '"quoted key" = 1\n\'lit\' = 2\n[ spaced . table ]\nx = 1\n',
  "a = []\nb = {}\nc = [\n  1, # one\n  2,\n]\nd = { e = 1, }\n",
  'x = 2024-02-30\ny = 0000-01-01\nz = 24:00:00\n',
  "[a]\nb = 1\n[a.c]\nd = 2\n[a]\n",
  "t = true\nf = false\nstr = 'a\tb'\n",
];
const TOML_ALPHABET = [...'[]{}=".,\'#\n\\ _-+:0123456789abtrufalsenidTZxuUeE\t\r\u00e9\ud83d\ude00\u0000\u007f'];

const SHAPES = ["array", "inline", "array_of_inline"] as const;
type Shape = (typeof SHAPES)[number];

const SHAPE_TEXT: Record<Shape, (depth: number) => string> = {
  array: (depth) => "a = " + "[".repeat(depth) + "]".repeat(depth) + "\n",
  inline: (depth) => "a = " + "{a=".repeat(depth) + "1" + "}".repeat(depth) + "\n",
  array_of_inline: (depth) => "a = " + "[{a=".repeat(depth) + "1" + "}]".repeat(depth) + "\n",
};

const SCALAR_SHAPE_TEXT: Record<Shape, (depth: number) => string> = {
  array: (depth) => "a = " + "[".repeat(depth) + "1" + "]".repeat(depth) + "\n",
  inline: SHAPE_TEXT.inline,
  array_of_inline: SHAPE_TEXT.array_of_inline,
};

function firstRecursionDepth(shape: Shape, callerFrames: number, load: typeof tomlLoads = tomlLoads): number {
  let low = 1;
  let high = RECURSION_SEARCH_LIMIT;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try {
      load(SHAPE_TEXT[shape](middle), callerFrames);
      low = middle + 1;
    } catch (error) {
      if (!(error instanceof RecursionError)) throw error;
      high = middle;
    }
  }
  return low;
}

describe("tomllib port accepts and refuses what tomllib did", () => {
  it("parses malformed and valid documents to the recorded values, or fails with the recorded error type", () => {
    const random = seededRandom(20261023);
    const documents = [...TOML_BASES];
    for (let index = 0; index < TOML_FUZZ_CASES; index += 1) {
      documents.push(mutate(TOML_BASES[index % TOML_BASES.length] as string, TOML_ALPHABET, random));
    }
    documents.push("", "\r\n", "a = 1\r\nb = 2\r\n", "a = '\u00e9\ud83d\ude00' x", "\ud83d\ude00 = 1", "a = 1\n\ud83d\ude00", "x = " + "1".repeat(4301));
    const calls = documents.map((text) => ({ fn: "toml_loads", args: [text] }));
    const actual = documents.map((text) => outcomeOf(() => canonicalToml(tomlLoads(text))));
    const expected = pythonReference(calls);
    assertBothKinds("toml loads", expected);
    compareToRecorded("toml loads", calls, actual, expected);
  });

  it("compares values like python equality", () => {
    const pairs: Array<[string, string]> = [
      ["a = 1", "a = true"], ["a = 1", "a = 1.0"], ["a = 0", "a = false"], ["a = 2", "a = true"], ["a = nan", "a = nan"], ["a = inf", "a = inf"],
      ["a = 9007199254740993", "a = 9007199254740992.0"], ["a = 1979-05-27T00:00:00Z", "a = 1979-05-26T19:00:00-05:00"],
      ["a = 1979-05-27T00:00:00", "a = 1979-05-27T00:00:00Z"], ["a = 1979-05-27", "a = 1979-05-27T00:00:00"], ["a = 07:32:00", "a = 07:32"],
      ["a = [1, 2]", "a = [1, 2]"], ["a = [1, 2]", "a = [2, 1]"], ["a = [1]", "a = [true]"], ["a = {x = 1, y = 2}", "a = {y = 2, x = 1}"],
      ["[a]\nx = 1\n[b]\ny = 2", "b.y = 2\na.x = 1"], ["a = 'x'", "a = \"x\""], ["a = 'x'", "a = 1"], ["a = {}", "a = []"], ["a = {}", "b = {}"],
      ["", ""], ["", "a = 1"], ["a = 1.5", "a = 1.5"], ["a = 1979-05-27T00:00:00.5", "a = 1979-05-27T00:00:00.500000"], ["a = 2", "a = 2.5"],
    ];
    const calls = pairs.map((pair) => ({ fn: "toml_equals", args: pair }));
    const actual = pairs.map(([left, right]) => outcomeOf(() => tomlEquals(tomlLoads(left), tomlLoads(right))));
    compareToRecorded("toml equality", calls, actual, pythonReference(calls));
  });

  it("raises TOMLDecodeError with the position tomllib reported", () => {
    assert.throws(() => tomlLoads("a = 1\nb = $"), (error: unknown) =>
      error instanceof TOMLDecodeError && error.message === "Invalid value (at line 2, column 5)");
  });

  it("quotes the offending character in JSON form", () => {
    assert.throws(() => tomlLoads('a = "x\u0001y"'), (error: unknown) =>
      error instanceof TOMLDecodeError && error.message === 'Illegal character "\\u0001" (at line 1, column 7)');
  });

  it("refuses a document with an integer of more than 4300 digits and accepts 4300", () => {
    assert.throws(() => tomlLoads("x = " + "1".repeat(4301)), Refusal);
    assert.equal(tomlLoads("x = " + "1".repeat(4300)).get("x"), BigInt("1".repeat(4300)));
  });
});

describe("TOML nesting", () => {
  it("raises RecursionError for deeply nested TOML at the depth where tomllib did", () => {
    tomlLoads("a = 1");
    const calls: ReferenceCall[] = SHAPES.flatMap((shape) => [0, 1, 2, 3, 4, 5, 6, 7].map((extra) => ({ fn: "toml_recursion_threshold", args: [shape, extra] })));
    const references = pythonReference(calls);
    const found = calls.map((call, index) => {
      const reference = (references[index] as Outcome).ok as { threshold: number; callerFrames: number };
      return { shape: call.args[0], extra: call.args[1], recorded: reference.threshold, now: firstRecursionDepth(call.args[0] as Shape, reference.callerFrames) };
    });
    const wrong = found.filter((item) => item.recorded !== item.now);
    console.log(`recorded toml recursion: ${found.length} cases, ${wrong.length} mismatches`);
    assert.deepEqual(wrong, []);
  });

  it("charges Python 3.15's deferred regex import to the first scalar parsed in a fresh interpreter", async () => {
    const calls: ReferenceCall[] = SHAPES.flatMap((shape) => [0, 1, 2, 3, 4].map((extra) => ({ fn: "toml_cold_recursion_threshold", args: [shape, extra] })));
    const references = pythonReference(calls);
    const found: Array<{ shape: unknown; extra: unknown; recorded: number; now: number }> = [];
    for (const [index, call] of calls.entries()) {
      const reference = (references[index] as Outcome).ok as { threshold: number; callerFrames: number; lazy: boolean };
      if (!reference.lazy) return;
      let low = 1;
      let high = RECURSION_SEARCH_LIMIT;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const isolated = (await import(`../lib/toml.ts?cold=${index}-${middle}`)) as { tomlLoads: typeof tomlLoads; RecursionError: typeof RecursionError };
        try {
          isolated.tomlLoads(SCALAR_SHAPE_TEXT[call.args[0] as Shape](middle), reference.callerFrames);
          low = middle + 1;
        } catch (error) {
          if (!(error instanceof isolated.RecursionError)) throw error;
          high = middle;
        }
      }
      found.push({ shape: call.args[0], extra: call.args[1], recorded: reference.threshold, now: low });
    }
    const wrong = found.filter((item) => item.recorded !== item.now);
    console.log(`recorded toml cold recursion: ${found.length} cases, ${wrong.length} mismatches`);
    assert.deepEqual(wrong, []);
  });

  it("makes the TOML recursion failure a crash, not a refusal", () => {
    assert.ok(!(new RecursionError() instanceof Refusal));
    assert.throws(() => tomlLoads(SHAPE_TEXT.array(2000)), RecursionError);
  });
});
