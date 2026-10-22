import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { osErrorMessage, pythonFailureMessage, ValueError } from "../lib/pyerrors.ts";
import { decodeUtf8, nameOf, parentOf, purePath, readText, resolvePath, shellQuote, translateNewlines } from "../lib/pyfs.ts";
import { JSONDecodeError, pythonFloatRepr, pythonJsonDumps, pythonJsonLoads } from "../lib/pyjson.ts";
import type { JsonValue } from "../lib/pyjson.ts";
import { pythonRepr } from "../lib/pyrepr.ts";
import { pythonValueStr } from "../lib/pystr.ts";
import { RecursionError, TOMLDecodeError, tomlEquals, tomlLoads } from "../lib/toml.ts";
import { canonicalToml, mutate, outcomeOf, pythonReference, seededRandom } from "./pyref.ts";
import type { Outcome, ReferenceCall } from "./pyref.ts";

const JSON_FUZZ_CASES = 6000;
const TOML_FUZZ_CASES = 6000;
const MISMATCHES_SHOWN = 8;

const MIN_SHARE = 0.1;

function assertBothKinds(label: string, expected: Outcome[]): void {
  const valid = expected.filter((outcome) => outcome.error === undefined).length;
  assert.ok(valid >= expected.length * MIN_SHARE, `${label}: only ${valid} of ${expected.length} documents parse`);
  assert.ok(expected.length - valid >= expected.length * MIN_SHARE, `${label}: only ${expected.length - valid} documents fail`);
}

function compare(label: string, calls: ReferenceCall[], actual: Outcome[], expected: Outcome[], withType = true): void {
  assert.equal(actual.length, expected.length);
  const mismatches: string[] = [];
  actual.forEach((outcome, index) => {
    const reference = expected[index] as Outcome;
    const same = JSON.stringify(outcome.ok) === JSON.stringify(reference.ok) && outcome.error === reference.error &&
      (!withType || outcome.type === reference.type);
    if (!same) mismatches.push(`${JSON.stringify(calls[index])}\n  ts: ${JSON.stringify(outcome)}\n  py: ${JSON.stringify(reference)}`);
  });
  console.log(`parity ${label}: ${calls.length} cases, ${mismatches.length} mismatches`);
  assert.equal(mismatches.length, 0, mismatches.slice(0, MISMATCHES_SHOWN).join("\n"));
}

const JSON_BASES = [
  '{"a": 1, "b": [true, false, null, "x\\u00e9\\ud83d\\ude00"], "c": {"d": -1.5e-7}}',
  '[1, 2.5, "s", {"k": []}]', '"plain"', "-12", "0.001", '{"nested": {"deep": [[], {}]}}', "  \n[1,\n2]\n",
  '"\\n\\t\\"\\\\\\/\\b\\f\\r"', "12345678901234567890", '{"a": NaN, "b": -Infinity, "c": [Infinity]}',
  '{"k": "v", "k": "w"}', '"\\ud83d\\ude00 \\ud83d x \\ude00"', "[[[[1]]]]", "true", "null", "{}", "[]",
];
const JSON_ALPHABET = [...'{}[]",:\\ntrufalsNI-+.eE0123456789 \t\n\r\u0001\u00e9\ud83d\ude00\ufeff/ubfrn'];

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

describe("pyjson parity with python json", () => {
  it("loads malformed and valid documents like json.loads", () => {
    const random = seededRandom(20261022);
    const documents = [...JSON_BASES];
    for (let index = 0; index < JSON_FUZZ_CASES; index += 1) {
      documents.push(mutate(JSON_BASES[index % JSON_BASES.length] as string, JSON_ALPHABET, random));
    }
    documents.push("", " ", "\ufeff{}", "1".repeat(4301), "-" + "1".repeat(4300), "[" + "1,".repeat(50) + "1]");
    const calls = documents.map((text) => ({ fn: "json_loads", args: [text] }));
    const actual = documents.map((text) => outcomeOf(() => pythonJsonDumps(pythonJsonLoads(text), { sortKeys: true })));
    const expected = pythonReference(process.cwd(), calls);
    assertBothKinds("json loads", expected);
    compare("json loads", calls, actual, expected);
  });

  it("dumps nested, non-ASCII and non-BMP values like json.dumps", () => {
    const values: JsonValue[] = [
      null, true, false, 0, -7, 1.5, 0.1, 1e-7, 1.5e300, 123456789012345.6, "", "plain", "caf\u00e9", "\ud83d\ude00", "\ud800",
      "\u0000\u001f\u007f\u0080\u2028", 'quote"back\\slash', "tab\tnl\ncr\rff\fbs\b", [], {}, [[], {}], { a: [], b: {} },
      { b: 1, a: [1, { d: "\u00e9", c: ["\ud83d\ude00"] }], "\u00e9": { z: null } }, [1, [2, [3, [4]]]],
    ];
    const calls: ReferenceCall[] = [];
    const actual: Outcome[] = [];
    for (const value of values) {
      for (const indent of [undefined, 2, 4]) {
        for (const sortKeys of [false, true]) {
          for (const ensureAscii of [true, false]) {
            calls.push({ fn: "json_dumps", args: [value, indent ?? null, sortKeys, ensureAscii] });
            actual.push(outcomeOf(() => pythonJsonDumps(value, { indent, sortKeys, ensureAscii })));
          }
        }
      }
    }
    compare("json dumps", calls, actual, pythonReference(process.cwd(), calls));
  });

  it("formats floats like repr", () => {
    const texts = ["0.1", "0.5", "1e-7", "1e-5", "0.0001", "0.00001234", "5e-324", "1.7976931348623157e308", "1e16", "1.5e16", "123456789012345678.5",
      "1e22", "-2.5e-10", "3.141592653589793", "100000000000000.5", "1e300", "-1e-300", "9007199254740993.5", "0.30000000000000004"];
    const calls = texts.map((text) => ({ fn: "float_repr", args: [text] }));
    const actual = texts.map((text) => outcomeOf(() => pythonFloatRepr(Number(text))));
    compare("float repr", calls, actual, pythonReference(process.cwd(), calls));
  });

  it("keeps big integers exact", () => {
    assert.equal(pythonJsonDumps(pythonJsonLoads("[12345678901234567890, -9007199254740993]")), "[12345678901234567890, -9007199254740993]");
  });

  it("reports the position of an error in code points", () => {
    assert.throws(() => pythonJsonLoads('"\ud83d\ude00" x'), (error: unknown) =>
      error instanceof JSONDecodeError && error.message === "Extra data: line 1 column 5 (char 4)");
  });
});

describe("deeply nested documents", () => {
  const nestingOf = (value: JsonValue): number => {
    let depth = 0;
    let current: JsonValue | undefined = value;
    while (Array.isArray(current) || (typeof current === "object" && current !== null)) {
      depth += 1;
      current = Array.isArray(current) ? current[0] : Object.values(current)[0];
    }
    return depth;
  };

  for (const depth of [3000, 20000]) {
    it(`loads and dumps JSON nested ${depth} levels deep like json (no stack overflow)`, () => {
      const arrays = "[".repeat(depth) + "]".repeat(depth);
      const objects = '{"a": '.repeat(depth) + "1" + "}".repeat(depth);
      assert.equal(nestingOf(pythonJsonLoads(arrays)), depth);
      assert.equal(nestingOf(pythonJsonLoads(objects)), depth);
      assert.equal(pythonJsonDumps(pythonJsonLoads(arrays)), arrays);
      assert.equal(pythonJsonDumps(pythonJsonLoads(objects)), objects);
    });
  }

  it("reports a malformed deep document at the same position as json", () => {
    const text = "[".repeat(3000) + "1,]" + "]".repeat(2999);
    assert.throws(() => pythonJsonLoads(text), (error: unknown) => error instanceof JSONDecodeError &&
      error.message === "Illegal trailing comma before end of array: line 1 column 3002 (char 3001)");
  });

  const SHAPES = ["array", "inline", "array_of_inline"] as const;
  const SHAPE_TEXT: Record<(typeof SHAPES)[number], (depth: number) => string> = {
    array: (depth) => "a = " + "[".repeat(depth) + "]".repeat(depth) + "\n",
    inline: (depth) => "a = " + "{a=".repeat(depth) + "1" + "}".repeat(depth) + "\n",
    array_of_inline: (depth) => "a = " + "[{a=".repeat(depth) + "1" + "}]".repeat(depth) + "\n",
  };

  function firstRecursionDepth(shape: (typeof SHAPES)[number], callerFrames: number, load: typeof tomlLoads = tomlLoads): number {
    let low = 1;
    let high = 4000;
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

  it("raises RecursionError for deeply nested TOML at the depth where tomllib does", () => {
    tomlLoads("a = 1");
    const calls: ReferenceCall[] = SHAPES.flatMap((shape) => [0, 1, 2, 3, 4, 5, 6, 7].map((extra) => ({ fn: "toml_recursion_threshold", args: [shape, extra] })));
    const references = pythonReference(process.cwd(), calls);
    const found = calls.map((call, index) => {
      const reference = (references[index] as Outcome).ok as { threshold: number; callerFrames: number };
      return { shape: call.args[0], extra: call.args[1], python: reference.threshold, typescript: firstRecursionDepth(call.args[0] as (typeof SHAPES)[number], reference.callerFrames) };
    });
    const wrong = found.filter((item) => item.python !== item.typescript);
    console.log(`parity toml recursion: ${found.length} cases, ${wrong.length} mismatches`);
    assert.deepEqual(wrong, []);
  });

  const SCALAR_SHAPE_TEXT: Record<(typeof SHAPES)[number], (depth: number) => string> = {
    array: (depth) => "a = " + "[".repeat(depth) + "1" + "]".repeat(depth) + "\n",
    inline: SHAPE_TEXT.inline,
    array_of_inline: SHAPE_TEXT.array_of_inline,
  };

  it("charges Python 3.15's deferred regex import to the first scalar parsed in a fresh interpreter", async () => {
    const calls: ReferenceCall[] = SHAPES.flatMap((shape) => [0, 1, 2, 3, 4].map((extra) => ({ fn: "toml_cold_recursion_threshold", args: [shape, extra] })));
    const references = pythonReference(process.cwd(), calls);
    const found: Array<{ shape: unknown; extra: unknown; python: number; typescript: number }> = [];
    for (const [index, call] of calls.entries()) {
      const reference = (references[index] as Outcome).ok as { threshold: number; callerFrames: number; lazy: boolean };
      if (!reference.lazy) return;
      const fresh = (await import(`../lib/toml.ts?cold=${index}`)) as { tomlLoads: typeof tomlLoads; RecursionError: typeof RecursionError };
      let low = 1;
      let high = 4000;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const isolated = (await import(`../lib/toml.ts?cold=${index}-${middle}`)) as typeof fresh;
        try {
          isolated.tomlLoads(SCALAR_SHAPE_TEXT[call.args[0] as (typeof SHAPES)[number]](middle), reference.callerFrames);
          low = middle + 1;
        } catch (error) {
          if (!(error instanceof isolated.RecursionError)) throw error;
          high = middle;
        }
      }
      found.push({ shape: call.args[0], extra: call.args[1], python: reference.threshold, typescript: low });
    }
    const wrong = found.filter((item) => item.python !== item.typescript);
    console.log(`parity toml cold recursion: ${found.length} cases, ${wrong.length} mismatches`);
    assert.deepEqual(wrong, []);
  });

  it("makes the TOML recursion failure a crash, not a refusal", () => {
    assert.ok(!(new RecursionError() instanceof ValueError));
    assert.throws(() => tomlLoads(SHAPE_TEXT.array(2000)), RecursionError);
  });
});

describe("tomllib port parity with python tomllib", () => {
  it("parses malformed and valid documents like tomllib.loads", () => {
    const random = seededRandom(20261023);
    const documents = [...TOML_BASES];
    for (let index = 0; index < TOML_FUZZ_CASES; index += 1) {
      documents.push(mutate(TOML_BASES[index % TOML_BASES.length] as string, TOML_ALPHABET, random));
    }
    documents.push("", "\r\n", "a = 1\r\nb = 2\r\n", "a = '\u00e9\ud83d\ude00' x", "\ud83d\ude00 = 1", "a = 1\n\ud83d\ude00", "x = " + "1".repeat(4301));
    const calls = documents.map((text) => ({ fn: "toml_loads", args: [text] }));
    const actual = documents.map((text) => outcomeOf(() => canonicalToml(tomlLoads(text))));
    const expected = pythonReference(process.cwd(), calls);
    assertBothKinds("toml loads", expected);
    compare("toml loads", calls, actual, expected);
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
    compare("toml equality", calls, actual, pythonReference(process.cwd(), calls));
  });

  it("raises TOMLDecodeError with python positions", () => {
    assert.throws(() => tomlLoads("a = 1\nb = $"), (error: unknown) =>
      error instanceof TOMLDecodeError && error.message === "Invalid value (at line 2, column 5)");
  });
});

describe("python text and path helpers", () => {
  let sandbox: string;
  const startDirectory = process.cwd();

  before(() => {
    sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-pycompat-")));
    mkdirSync(join(sandbox, "real/inner"), { recursive: true });
    writeFileSync(join(sandbox, "real/file.txt"), "x");
    symlinkSync(join(sandbox, "real"), join(sandbox, "alias"));
    symlinkSync("real/inner", join(sandbox, "relative-link"));
    symlinkSync(join(sandbox, "missing-target"), join(sandbox, "dangling"));
    symlinkSync("loop-b", join(sandbox, "loop-a"));
    symlinkSync("loop-a", join(sandbox, "loop-b"));
    writeFileSync(join(sandbox, "secret.txt"), "x");
    chmodSync(join(sandbox, "secret.txt"), 0);
    writeFileSync(join(sandbox, "bad.txt"), Buffer.from([0x61, 0xff, 0x62]));
    process.chdir(sandbox);
  });

  after(() => {
    process.chdir(startDirectory);
    chmodSync(join(sandbox, "secret.txt"), 0o600);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("repr matches python for printable, control, format and astral characters", () => {
    const random = seededRandom(7);
    const pool = [..."ab '\"\\\n\r\t\u0000\u0007\u007f\u0080\u00a0\u00ad\u00e9\u0378\u200b\u2028\u3000\ufeff\ue000\ud800\udc00", "\ud83d\ude00", "\u{10ffff}", "\u{e0001}"];
    const texts = pool.map((character) => character);
    for (let index = 0; index < 600; index += 1) {
      const length = Math.floor(random() * 8);
      texts.push(Array.from({ length }, () => pool[Math.floor(random() * pool.length)]).join(""));
    }
    const calls = texts.map((text) => ({ fn: "py_repr", args: [text] }));
    compare("repr", calls, texts.map((text) => outcomeOf(() => pythonRepr(text))), pythonReference(sandbox, calls));
  });

  it("utf-8 decoding fails with the same message as python", () => {
    const random = seededRandom(11);
    const interesting = [0x00, 0x41, 0x7f, 0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xed, 0xef, 0xf0, 0xf1, 0xf4, 0xf5, 0xff, 0xa0, 0x9f, 0x8f, 0x90];
    const inputs: string[] = [];
    for (let index = 0; index < 3000; index += 1) {
      const length = 1 + Math.floor(random() * 5);
      inputs.push(Buffer.from(Array.from({ length }, () => interesting[Math.floor(random() * interesting.length)] ?? 0)).toString("hex"));
    }
    inputs.push("", "e282ac", "f09f9880", "efbbbf41");
    const calls = inputs.map((hex) => ({ fn: "decode_utf8", args: [hex] }));
    const actual = inputs.map((hex) => outcomeOf(() => decodeUtf8(Buffer.from(hex, "hex"))));
    compare("utf8 decode", calls, actual, pythonReference(sandbox, calls), false);
  });

  it("renders values inside containers like str(), including control and no-break characters", () => {
    const documents = [
      '["a\\u0001"]', '["a", "b"]', '{"k": ["x\\u00a0y", null, true, false, 12, 1.5, -2.5e-7, 1e22, 0.1]}', "[[], {}, [[]]]",
      '["it\'s", "say \\"hi\\"", "both \' \\"", "\\ud83d\\ude00", "\\u200b\\ud800", "\\u0000\\u007f\\u0085\\u2028"]', '"plain"', "null", "true",
      "12345678901234567890", "[NaN, Infinity, -Infinity]", '{"a": {"b": [1, {"c": "\\n\\t\\r\\\\"}]}}', "[" + "[".repeat(2999) + "]".repeat(2999) + "]",
    ];
    const calls = documents.map((text) => ({ fn: "py_str", args: [text] }));
    const actual = documents.map((text) => outcomeOf(() => pythonValueStr(pythonJsonLoads(text))));
    compare("container str", calls, actual, pythonReference(process.cwd(), calls), false);
  });

  it("shell quoting matches shlex.quote", () => {
    const texts = ["", "plain", "with space", "it's", "a\"b", "$HOME", "~/x", "a=b", "a,b:c@d%e+f", "\u00e9", "line\nbreak", "/usr/bin/node", "-x", "a b'c"];
    const calls = texts.map((text) => ({ fn: "shell_quote", args: [text] }));
    compare("shell quote", calls, texts.map((text) => outcomeOf(() => shellQuote(text))), pythonReference(sandbox, calls));
  });

  it("resolve and pure-path helpers match pathlib", () => {
    const paths = [
      "", ".", "..", "/", "//", "///x", "//x//y", "a//b/./c/", "real", "real/", "real/../real/file.txt", "alias", "alias/inner", "alias/../alias",
      "relative-link", "relative-link/..", "relative-link/../file.txt", "dangling", "dangling/child", "loop-a", "loop-a/x", "nope/../real",
      "real/file.txt/child", "/nonexistent/a/b", "real/inner/../../alias/inner", "\u00e9/\ud83d\ude00", "a\u0000b", "/tmp/../tmp", "/private/../etc",
      "\ud800", "real/x\ud800.txt", "real/\ud800\ud801y/z", "a\udc80/b", "\udc80\ud800", "real/\udfff", "\ud800\u0000", "\u0000\ud800", "real/inner/../\ud800",
    ];
    const resolveCalls = paths.map((path) => ({ fn: "resolve", args: [path] }));
    compare("resolve", resolveCalls, paths.map((path) => outcomeOf(() => resolvePath(path))), pythonReference(sandbox, resolveCalls));
    const pureCalls = paths.map((path) => ({ fn: "pure", args: [path] }));
    compare("pure path", pureCalls, paths.map((path) => outcomeOf(() => [purePath(path), parentOf(path), nameOf(path)])), pythonReference(sandbox, pureCalls));
  });

  it("OS and decoding failures read like python exceptions", () => {
    const paths = ["missing.txt", "real", "secret.txt", "bad.txt", "real/file.txt/child", "dangling", "loop-a", "a\u0000b", "\ud800", "real/\ud800\ud801", "\udc80x", "\udc80\ud800x"];
    const calls = paths.map((path) => ({ fn: "os_error", args: [path] }));
    const actual = paths.map((path) => outcomeOf(() => {
      try {
        readText(path);
      } catch (error) {
        const message = pythonFailureMessage(error);
        if (message === null) throw error;
        throw new ValueError(message);
      }
      return null;
    }));
    compare("os errors", calls, actual, pythonReference(sandbox, calls), false);
  });

  it("formats errno messages and normalises newlines", () => {
    assert.equal(osErrorMessage("ENOENT", "/x", "/y"), "[Errno 2] No such file or directory: '/x' -> '/y'");
    assert.equal(translateNewlines("a\r\nb\rc\n"), "a\nb\nc\n");
  });
});
