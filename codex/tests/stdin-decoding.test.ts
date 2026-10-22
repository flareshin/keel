import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalCodec, decodeWithCodec, PythonStartupFailure, PythonUncaughtError, resolveStdinEncoding, UnsupportedStdinEncoding } from "../lib/pycodecs.ts";
import { ASCII_OPAQUE_ENCODING_NAMES, NON_TEXT_ENCODINGS, TEXT_ENCODING_NAMES } from "../lib/pycodec_names.ts";
import { ValueError } from "../lib/pyerrors.ts";
import { decodeStdin, stdinCodec } from "../lib/pystdin.ts";
import { pythonReference, seededRandom } from "./pyref.ts";
import type { Outcome, ReferenceCall } from "./pyref.ts";

const EXACT_CODECS = ["utf_8", "utf_8_sig", "ascii", "latin_1", "cp1252", "cp1251", "cp866", "koi8_r", "iso8859_2", "iso8859_5", "iso8859_7", "iso8859_15"];
const SINGLE_BYTE_CODECS = ["cp1252", "cp1251", "cp866", "koi8_r", "iso8859_2", "iso8859_5", "iso8859_7", "iso8859_15", "latin_1", "ascii"];
const PYTHON_TO_CODEC: Record<string, string> = { "utf-8": "utf_8", "utf-8-sig": "utf_8_sig", "iso8859-1": "latin_1" };
const MISMATCHES_SHOWN = 8;
const PYTHON_FATAL = "fatal";
const ASCII_PAYLOAD = Buffer.from("plain");
const INVALID_PAYLOAD = Buffer.from([0xff, 0x80, 0xfe]);
const DIVERGENT_CODECS = [
  "euc_kr", "euc_jp", "shift_jis", "big5", "gbk", "gb2312", "cp949", "gb18030", "big5hkscs", "cp932", "iso2022_jp", "hz",
  "utf_16", "utf_32", "utf_7", "mac_roman", "cp037", "cp500", "koi8_u", "iso8859_4", "cp850",
];

function report(label: string, cases: number, mismatches: string[], note = ""): void {
  console.log(`parity ${label}: ${cases} cases, ${mismatches.length} mismatches${note}`);
  assert.equal(mismatches.length, 0, mismatches.slice(0, MISMATCHES_SHOWN).join("\n"));
}

function tableOutcome(decode: () => string): Outcome {
  try {
    return { ok: Array.from(decode(), (character) => character.codePointAt(0) as number) };
  } catch (error) {
    if (error instanceof UnsupportedStdinEncoding) return { error: `deny: ${error.message}` };
    if (error instanceof PythonStartupFailure || error instanceof PythonUncaughtError) return { error: PYTHON_FATAL };
    if (error instanceof ValueError) return { error: error.message };
    throw error;
  }
}

function pythonOutcome(environment: Record<string, string>, bytes: Buffer): Outcome {
  const [outcome] = pythonReference(process.cwd(), [{ fn: "stdin_decode", args: [environment, bytes.toString("hex")] }]) as [Outcome];
  return outcome.error === "crash" ? { error: PYTHON_FATAL } : outcome;
}

describe("stdin decoding follows Python's locale, UTF-8 mode and PYTHONIOENCODING rules", () => {
  const LOCALES = [undefined, "", "C", "POSIX", "C.UTF-8", "C.utf8", "UTF-8", "en_US.UTF-8", "xx_YY.UTF-8", "en_US.ISO8859-1", "en_US.US-ASCII", "en_US", "ko_KR.eucKR",
    "ko_KR.CP949", "ru_RU.KOI8-R", "ru_RU.CP1251", "el_GR.ISO8859-7", "be_BY.CP1131", "sr_RS.UTF-8@latin"];
  const CHOICES: Record<string, Array<string | undefined>> = {
    LC_ALL: LOCALES, LC_CTYPE: LOCALES, LANG: LOCALES,
    PYTHONUTF8: [undefined, undefined, "0", "0", "1", ""],
    PYTHONCOERCECLOCALE: [undefined, undefined, "0", "1"],
    PYTHONIOENCODING: [undefined, undefined, undefined, "utf-8", "UTF8", ":strict", ":replace", ":ignore", ":backslashreplace", ":surrogateescape", "ascii", "ascii:replace", "latin-1", "utf-8:surrogateescape",
      "utf-8:strict", ":", "bogus", "u8", "cp65001", "cp1252", "utf-8-sig", ":surrogatepass", "utf-8:surrogatepass", "cp819", "windows-1252:replace", "euc-kr", "koi8-r:ignore",
      "iso-8859-15:backslashreplace", "ascii:surrogatepass", "utf-8:xmlcharrefreplace", "utf-8:namereplace", "utf-8:bogus", "cp1251:surrogateescape", "windows-1252:strict", "utf",
      "UTF 8", "latin1:strict", "cp949", "gb18030", "utf-16", "utf-32:replace", "mac-roman", "hex", "rot13", "iso8859.1"],
  };
  const INPUTS = ["", Buffer.from("plain ascii").toString("hex"), "c3a9", "ff", "e282", "c328", "6162ff63", "e282ac41ff", "f09f9880", "80", "c3a9c3", "6162e28241",
    "eda080", "eda080ff", "6162eda0", "eda0c3", "efbbbf6162", "efbbbfff", "6162efbbbf", "6162819d98", "b0a1", "6162b0a1"];

  function samples(count: number): Array<Record<string, string>> {
    const random = seededRandom(20261024);
    const environments: Array<Record<string, string>> = [
      {}, { PYTHONUTF8: "0" }, { PYTHONUTF8: "0", LANG: "C" }, { PYTHONUTF8: "0", LC_CTYPE: "C.UTF-8" }, { PYTHONUTF8: "0", LANG: "C", LC_CTYPE: "C.UTF-8" },
      { PYTHONUTF8: "0", LC_ALL: "C" }, { PYTHONUTF8: "0", LC_ALL: "en_US.UTF-8", LC_CTYPE: "C" }, { PYTHONUTF8: "0", LANG: "en_US.UTF-8" },
      { PYTHONUTF8: "0", LC_ALL: "ko_KR.CP949" }, { PYTHONUTF8: "0", LC_ALL: "ko_KR.eucKR" }, { PYTHONUTF8: "0", LC_ALL: "be_BY.CP1131" }, { PYTHONIOENCODING: "bogus" },
    ];
    for (let index = 0; index < count; index += 1) {
      const chosen: Record<string, string> = {};
      for (const [name, options] of Object.entries(CHOICES)) {
        const value = options[Math.floor(random() * options.length)];
        if (value !== undefined) chosen[name] = value;
      }
      environments.push(chosen);
    }
    return environments;
  }

  it("picks the same codec class and error handler as sys.stdin for every variable combination", () => {
    const environments = samples(500);
    const calls = environments.map((environment) => ({ fn: "stdin_codec", args: [environment] }));
    const wrong: string[] = [];
    pythonReference(process.cwd(), calls).forEach((outcome, index) => {
      const environment = environments[index] as Record<string, string>;
      let expected: string;
      if (outcome.error !== undefined) expected = PYTHON_FATAL;
      else {
        const [name, errors] = outcome.ok as [string, string];
        const codec = PYTHON_TO_CODEC[name] ?? name.replaceAll("-", "_");
        expected = EXACT_CODECS.includes(codec) ? `${codec}/${errors}` : "unsupported";
      }
      let actual: string;
      try {
        const { name, errors } = stdinCodec(environment);
        const encoding = resolveStdinEncoding(name);
        actual = encoding.kind === "exact" ? `${encoding.codec}/${errors}` : "unsupported";
      } catch (error) {
        if (!(error instanceof PythonStartupFailure)) throw error;
        actual = PYTHON_FATAL;
      }
      if (actual !== expected) wrong.push(`${JSON.stringify(environment)}\n  ts: ${actual}\n  py: ${expected}`);
    });
    report("stdin codec", calls.length, wrong);
  });

  it("decodes valid and invalid bytes like sys.stdin.read() wherever the codec is exact, and fails closed elsewhere", () => {
    const pairs = samples(80).flatMap((environment) => INPUTS.map((hex) => [environment, hex] as const));
    const calls = pairs.map(([environment, hex]) => ({ fn: "stdin_decode", args: [environment, hex] }));
    const expected = pythonReference(process.cwd(), calls);
    const wrong: string[] = [];
    let failedClosed = 0;
    pairs.forEach(([environment, hex], index) => {
      const actual = tableOutcome(() => decodeStdin(Buffer.from(hex, "hex"), environment));
      const reference = (expected[index] as Outcome).error === "crash" ? { error: PYTHON_FATAL } : (expected[index] as Outcome);
      if (typeof actual.error === "string" && actual.error.startsWith("deny: ")) {
        failedClosed += 1;
        return;
      }
      if (JSON.stringify(actual) !== JSON.stringify(reference)) wrong.push(`${JSON.stringify(calls[index])}\n  ts: ${JSON.stringify(actual)}\n  py: ${JSON.stringify(reference)}`);
    });
    report("stdin decode", calls.length, wrong, ` (${failedClosed} failed closed)`);
    assert.ok(failedClosed > 0 && failedClosed < calls.length);
  });

  it("matches Python's outcome for every PYTHONIOENCODING name on ASCII input, crashes included", () => {
    const [table] = pythonReference(process.cwd(), [{ fn: "codec_table", args: [] }]) as [Outcome];
    const { accepted, nonText } = table.ok as { accepted: string[]; nonText: Record<string, string> };
    const names = [...accepted, ...Object.keys(nonText), "bogus", "utf-99", "", "-", "UTF-8@latin", "iso8859.1", "ISO8859.15", "x".repeat(40)].filter((name) => name !== "");
    const calls: ReferenceCall[] = names.map((name) => ({ fn: "stdin_decode", args: [{ PYTHONIOENCODING: name }, ASCII_PAYLOAD.toString("hex")] }));
    const expected = pythonReference(process.cwd(), calls);
    const wrong: string[] = [];
    let failedClosed = 0;
    names.forEach((name, index) => {
      const actual = tableOutcome(() => decodeStdin(ASCII_PAYLOAD, { PYTHONIOENCODING: name }));
      const reference = (expected[index] as Outcome).error === "crash" ? { error: PYTHON_FATAL } : (expected[index] as Outcome);
      if (typeof actual.error === "string" && actual.error.startsWith("deny: ")) failedClosed += 1;
      else if (JSON.stringify(actual) !== JSON.stringify(reference)) wrong.push(`${name}\n  ts: ${JSON.stringify(actual)}\n  py: ${JSON.stringify(reference)}`);
    });
    report("stdin ascii names", names.length, wrong, ` (${failedClosed} failed closed)`);
  });

  it("pins the embedded codec name tables to the live Python", () => {
    const [table] = pythonReference(process.cwd(), [{ fn: "codec_table", args: [] }]) as [Outcome];
    const live = table.ok as { accepted: string[]; opaque: string[]; nonText: Record<string, string> };
    assert.deepEqual([...TEXT_ENCODING_NAMES], live.accepted);
    assert.deepEqual([...ASCII_OPAQUE_ENCODING_NAMES], live.opaque);
    assert.deepEqual(NON_TEXT_ENCODINGS, live.nonText);
  });

  it("resolves Python's aliases for the exact codecs, however the name is spelled", () => {
    const [table] = pythonReference(process.cwd(), [{ fn: "codec_table", args: [] }]) as [Outcome];
    const { aliases } = table.ok as { aliases: Record<string, string> };
    const wrong: string[] = [];
    let checked = 0;
    for (const [alias, target] of Object.entries({ ...aliases, ...Object.fromEntries(EXACT_CODECS.map((name) => [name, name])) })) {
      if (!EXACT_CODECS.includes(target)) continue;
      for (const spelling of [alias, alias.toUpperCase(), ` ${alias.replaceAll("_", "-")} `, alias.replaceAll("_", " ")]) {
        checked += 1;
        if (canonicalCodec(spelling) !== target) wrong.push(`${spelling} -> ${canonicalCodec(spelling)} (python: ${target})`);
      }
    }
    assert.equal(canonicalCodec("utf-8-sig"), "utf_8_sig");
    assert.equal(canonicalCodec("UTF8 SIG"), "utf_8_sig");
    assert.equal(canonicalCodec("iso8859.1"), "latin_1");
    assert.equal(canonicalCodec("ISO8859.15"), "iso8859_15");
    report("codec aliases", checked, wrong);
  });

  it("decodes every byte of each exact single-byte codec like Python", () => {
    const references = pythonReference(process.cwd(), SINGLE_BYTE_CODECS.map((name) => ({ fn: "codec_bytes", args: [name] })));
    const wrong: string[] = [];
    SINGLE_BYTE_CODECS.forEach((name, index) => {
      ((references[index] as Outcome).ok as Array<string | null>).forEach((character, byte) => {
        let actual: string | null = null;
        try {
          actual = decodeWithCodec(name, Buffer.from([byte]), "strict");
        } catch (error) {
          if (!(error instanceof ValueError)) throw error;
        }
        if (actual !== character) wrong.push(`${name} 0x${byte.toString(16)}: ${JSON.stringify(actual)} vs python ${JSON.stringify(character)}`);
      });
    });
    report("single-byte codecs", SINGLE_BYTE_CODECS.length * 256, wrong);
  });

  it("lists every codec where TypeScript denies instead of decoding as Python does", () => {
    const samples = pythonReference(process.cwd(), DIVERGENT_CODECS.map((name) => ({ fn: "codec_sample", args: [name] })));
    const rows: Array<{ codec: string; input: string; python: string; typescript: string }> = [];
    const unexpected: string[] = [];
    DIVERGENT_CODECS.forEach((codec, index) => {
      const sample = (samples[index] as Outcome).ok as string;
      const inputs: Array<[string, Buffer]> = [["ascii", ASCII_PAYLOAD], ["valid text", Buffer.from(sample, "hex")], ["invalid bytes", INVALID_PAYLOAD]];
      for (const [input, bytes] of inputs) {
        const environment = { PYTHONIOENCODING: codec };
        const python = pythonOutcome(environment, bytes);
        const typescript = tableOutcome(() => decodeStdin(bytes, environment));
        const denied = typeof typescript.error === "string" && typescript.error.startsWith("deny: ");
        const summarize = (outcome: Outcome): string => (outcome.error === undefined ? "decodes" : outcome.error.slice(0, 60));
        if (denied) {
          rows.push({ codec, input, python: summarize(python), typescript: (typescript.error as string).slice(6) });
          if (typescript.error !== `deny: stdin encoding ${codec} is not supported; set PYTHONUTF8=1`) unexpected.push(`${codec} ${input}: ${typescript.error}`);
        } else if (JSON.stringify(typescript) !== JSON.stringify(python)) {
          unexpected.push(`${codec} ${input}: ts ${JSON.stringify(typescript)} vs python ${JSON.stringify(python)}`);
        }
      }
    });
    console.log("divergences from Python (codec, input, Python outcome, TypeScript outcome):");
    for (const row of rows) console.log(`  ${row.codec} | ${row.input} | python: ${row.python} | typescript: deny "${row.typescript}"`);
    console.log(`parity stdin divergences: ${rows.length} listed, ${unexpected.length} unexpected`);
    assert.deepEqual(unexpected, []);
    assert.ok(rows.some((row) => row.codec === "euc_kr" && row.input === "valid text"));
    assert.ok(rows.some((row) => row.codec === "utf_16" && row.input === "ascii"));
  });

  it("fails closed with a fixed reason rather than crashing or allowing", () => {
    for (const [environment, name] of [
      [{ PYTHONIOENCODING: "euc-kr" }, "euc_kr"], [{ PYTHONUTF8: "0", LC_ALL: "ko_KR.CP949" }, "cp949"], [{ PYTHONIOENCODING: "UTF-16" }, "utf_16"],
    ] as const) {
      assert.throws(() => decodeStdin(Buffer.from([0xb0, 0xa1, 0x20]), { ...environment }), { name: "UnsupportedStdinEncoding", message: `stdin encoding ${name} is not supported; set PYTHONUTF8=1` });
    }
    assert.equal(decodeStdin(Buffer.from("plain"), { PYTHONIOENCODING: "euc-kr" }), "plain");
    assert.throws(() => decodeStdin(Buffer.from("plain"), { PYTHONIOENCODING: "bogus" }), (error: unknown) => error instanceof PythonStartupFailure &&
      error.stderr.startsWith("Fatal Python error: init_stdio_encoding: failed to get the Python codec name of the stdio encoding\nPython runtime state: core initialized\nLookupError: unknown encoding: bogus\n"));
    assert.throws(() => decodeStdin(Buffer.from("plain"), { PYTHONIOENCODING: "hex" }), (error: unknown) => error instanceof PythonStartupFailure &&
      error.stderr.includes("LookupError: 'hex' is not a text encoding"));
  });
});
