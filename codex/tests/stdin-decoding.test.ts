import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnv } from "../../tests/hooks/helpers.ts";
import { describe, it } from "node:test";
import { canonicalCodec, decodeWithCodec, PythonStartupFailure, PythonUncaughtError, resolveStdinEncoding, UnsupportedStdinEncoding } from "../lib/pycodecs.ts";
import { NON_TEXT_ENCODINGS, PYTHON_CODEC_ALIAS_NAMES, TEXT_ENCODING_NAMES } from "../lib/pycodec_names.ts";
import { ValueError } from "../lib/pyerrors.ts";
import { decodeStdin, stdinCodec } from "../lib/pystdin.ts";
import { pythonReference, seededRandom } from "./pyref.ts";
import { expectedStdinDeny, UNSUPPORTED_STDIN_CODECS } from "./stdin-policy.ts";
import type { Outcome, ReferenceCall } from "./pyref.ts";

const EXACT_CODECS = ["utf_8", "utf_8_sig", "ascii", "latin_1", "cp1252", "cp1251", "cp866", "koi8_r", "iso8859_2", "iso8859_5", "iso8859_7", "iso8859_15"];
const SINGLE_BYTE_CODECS = ["cp1252", "cp1251", "cp866", "koi8_r", "iso8859_2", "iso8859_5", "iso8859_7", "iso8859_15", "latin_1", "ascii"];
const PYTHON_TO_CODEC: Record<string, string> = { "utf-8": "utf_8", "utf-8-sig": "utf_8_sig", "iso8859-1": "latin_1" };
const MISMATCHES_SHOWN = 8;
const PYTHON_FATAL = "fatal";
const ASCII_PAYLOAD = Buffer.from("plain");
const INVALID_PAYLOAD = Buffer.from([0xff, 0x80, 0xfe]);
const DIVERGENT_CODECS = UNSUPPORTED_STDIN_CODECS;

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

function normalizedReference(outcome: Outcome): Outcome {
  return outcome.error === "crash" ? { error: PYTHON_FATAL } : outcome;
}

function codecPolicies(environments: Array<Record<string, string>>): Outcome[] {
  const stdin = pythonReference(process.cwd(), environments.map((env) => ({ fn: "stdin_codec", args: [env] })));
  return pythonReference(process.cwd(), environments.map((env, index) => {
    const selected = (stdin[index]?.ok as string[] | undefined)?.[0] ?? "bogus";
    const canonical = PYTHON_TO_CODEC[selected] ?? selected.replaceAll("-", "_");
    const locale = env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"];
    const localeCodeset = !EXACT_CODECS.includes(canonical) && locale?.includes(".") ? locale.slice(locale.indexOf(".") + 1).split("@")[0] : undefined;
    const encoding = (env["PYTHONIOENCODING"] ?? "").split(":")[0] || localeCodeset || selected;
    return { fn: "codec_lookup", args: [encoding] };
  }));
}

function policyExpectation(reference: Outcome, policy: Outcome): Outcome {
  if (policy.error !== undefined) return { error: PYTHON_FATAL };
  const { codec, name } = policy.ok as { codec: string; name: string };
  const exact = PYTHON_TO_CODEC[codec.replaceAll("_", "-")] ?? codec;
  return EXACT_CODECS.includes(exact) ? normalizedReference(reference) : { error: `deny: ${expectedStdinDeny(name)}` };
}

describe("stdin decoding follows Python's locale, UTF-8 mode and PYTHONIOENCODING rules", () => {
  const LOCALES = [undefined, "", "C", "POSIX", "C.UTF-8", "C.utf8", "UTF-8", "en_US.UTF-8", "xx_YY.UTF-8", "en_US.ISO8859-1", "en_US.US-ASCII", "en_US", "ko_KR.eucKR",
    "ko_KR.CP949", "ru_RU.KOI8-R", "ru_RU.CP1251", "el_GR.ISO8859-7", "be_BY.CP1131", "sr_RS.UTF-8@latin", "en_US.UTF-8@euro", "xx_YY.UTF-8@euro"];
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
    const environments = samples(80);
    const policies = codecPolicies(environments);
    const pairs = environments.flatMap((environment) => INPUTS.map((hex) => [environment, hex] as const));
    const calls = pairs.map(([environment, hex]) => ({ fn: "stdin_decode", args: [environment, hex] }));
    const expected = pythonReference(process.cwd(), calls);
    const wrong: string[] = [];
    let failedClosed = 0;
    pairs.forEach(([environment, hex], index) => {
      const actual = tableOutcome(() => decodeStdin(Buffer.from(hex, "hex"), environment));
      const reference = policyExpectation(expected[index] as Outcome, policies[Math.floor(index / INPUTS.length)] as Outcome);
      if (typeof actual.error === "string" && actual.error.startsWith("deny: ")) failedClosed += 1;
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
    const policies = pythonReference(process.cwd(), names.map((name) => ({ fn: "codec_lookup", args: [name] })));
    const wrong: string[] = [];
    let failedClosed = 0;
    names.forEach((name, index) => {
      const actual = tableOutcome(() => decodeStdin(ASCII_PAYLOAD, { PYTHONIOENCODING: name }));
      const reference = policyExpectation(expected[index] as Outcome, policies[index] as Outcome);
      if (typeof actual.error === "string" && actual.error.startsWith("deny: ")) failedClosed += 1;
      if (JSON.stringify(actual) !== JSON.stringify(reference)) wrong.push(`${name}\n  ts: ${JSON.stringify(actual)}\n  py: ${JSON.stringify(reference)}`);
    });
    report("stdin ascii names", names.length, wrong, ` (${failedClosed} failed closed)`);
  });

  it("pins the embedded codec name tables to the live Python", () => {
    const [table] = pythonReference(process.cwd(), [{ fn: "codec_table", args: [] }]) as [Outcome];
    const live = table.ok as { accepted: string[]; aliases: Record<string, string>; nonText: Record<string, string> };
    assert.deepEqual([...TEXT_ENCODING_NAMES], live.accepted);
    assert.deepEqual([...PYTHON_CODEC_ALIAS_NAMES], Object.keys(live.aliases).sort());
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
    assert.equal(canonicalCodec("ISO8859.15"), null);
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

  it("matches Python accept and reject behavior for every exact codec and error handler", () => {
    const errors = ["strict", "replace", "ignore", "backslashreplace", "surrogateescape", "surrogatepass", "bogus", "xmlcharrefreplace", "namereplace"];
    const inputs = ["", "706c61696e", "ff", "819d98", "c328", "e282", "eda080", "efbbbf6162", "f09f9880", "0080ff"];
    const cases = EXACT_CODECS.flatMap((codec) => errors.flatMap((handler) => inputs.map((hex) => ({ codec, handler, hex }))));
    const reference = pythonReference(process.cwd(), cases.map(({ codec, handler, hex }) => ({ fn: "codec_decode", args: [codec, hex, handler] })));
    const wrong: string[] = [];
    for (const [index, { codec, handler, hex }] of cases.entries()) {
      let actual: Outcome;
      try {
        actual = { ok: decodeWithCodec(codec, Buffer.from(hex, "hex"), handler) };
      } catch (error) {
        if (error instanceof PythonUncaughtError) actual = { error: "uncaught" };
        else if (error instanceof ValueError) actual = { error: error.message };
        else throw error;
      }
      const python = reference[index] as Outcome;
      const expected = python.error === "LookupError" || python.error === "TypeError" ? { error: "uncaught" } : python;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) wrong.push(`${codec}:${handler} ${hex}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
    }
    report("exact codec errors", cases.length, wrong);
  });

  it("lists every codec where TypeScript denies instead of decoding as Python does", () => {
    const [table] = pythonReference(process.cwd(), [{ fn: "codec_table", args: [] }]) as [Outcome];
    const { accepted } = table.ok as { accepted: string[] };
    const policies = pythonReference(process.cwd(), accepted.map((name) => ({ fn: "codec_lookup", args: [name] })));
    const unsupported = new Set(policies.flatMap((policy) => {
      const { codec } = policy.ok as { codec: string };
      const exact = PYTHON_TO_CODEC[codec.replaceAll("_", "-")] ?? codec;
      return EXACT_CODECS.includes(exact) ? [] : [codec];
    }));
    assert.deepEqual([...unsupported].sort(), [...DIVERGENT_CODECS]);
    const samples = pythonReference(process.cwd(), DIVERGENT_CODECS.map((name) => ({ fn: "codec_sample", args: [name] })));
    const rows = DIVERGENT_CODECS.flatMap((codec, index) => {
      const sample = (samples[index] as Outcome).ok;
      const inputs: Array<[string, Buffer]> = [["ascii", ASCII_PAYLOAD], ["invalid bytes", INVALID_PAYLOAD]];
      if (typeof sample === "string") inputs.push(["valid text", Buffer.from(sample, "hex")]);
      return inputs.map(([input, bytes]) => ({ codec, input, bytes }));
    });
    const python = pythonReference(process.cwd(), rows.map(({ codec, bytes }) => ({ fn: "stdin_decode", args: [{ PYTHONIOENCODING: codec }, bytes.toString("hex")] })));
    const unexpected: string[] = [];
    for (const [index, { codec, input, bytes }] of rows.entries()) {
      const typescript = tableOutcome(() => decodeStdin(bytes, { PYTHONIOENCODING: codec }));
      if (typescript.error !== `deny: ${expectedStdinDeny(codec)}`) unexpected.push(`${codec} ${input}: ${JSON.stringify(typescript)}`);
      const reference = normalizedReference(python[index] as Outcome);
      console.log(`  ${codec} | ${input} | python: ${reference.error ?? "decodes"} | typescript: deny "${expectedStdinDeny(codec)}"`);
    }
    console.log(`parity stdin divergences: ${rows.length} listed, ${unexpected.length} unexpected (${DIVERGENT_CODECS.length} codecs)`);
    assert.deepEqual(unexpected, []);
  });

  it("handles incomplete UTF-8 signatures like sys.stdin.read rather than bytes.decode", () => {
    const pairs = ["utf-8-sig", "utf-8"].flatMap((codec) => ["strict", "replace", "surrogateescape"].flatMap((handler) => ["ef", "efbb"].map((hex) => ({ codec, handler, hex }))));
    const reference = pythonReference(process.cwd(), pairs.map(({ codec, handler, hex }) => ({ fn: "stdin_decode", args: [{ PYTHONIOENCODING: `${codec}:${handler}` }, hex] })));
    for (const [index, { codec, handler, hex }] of pairs.entries()) {
      assert.deepEqual(tableOutcome(() => decodeStdin(Buffer.from(hex, "hex"), { PYTHONIOENCODING: `${codec}:${handler}` })), reference[index], `${codec}:${handler} ${hex}`);
    }
  });

  it("rejects unsupported codecs before inspecting even ASCII or empty input", () => {
    for (const codec of DIVERGENT_CODECS) {
      for (const bytes of [Buffer.alloc(0), ASCII_PAYLOAD, Buffer.from([0x1b, 0x24, 0x42, 0x43, 0x66]), INVALID_PAYLOAD]) {
        assert.throws(() => decodeStdin(bytes, { PYTHONIOENCODING: codec }), {
          name: "UnsupportedStdinEncoding", message: `stdin encoding ${codec} is not supported; set PYTHONUTF8=1`,
        });
      }
    }
  });

  it("fails closed with a fixed reason rather than crashing or allowing", () => {
    for (const [environment, name] of [
      [{ PYTHONIOENCODING: "euc-kr" }, "euc_kr"], [{ PYTHONUTF8: "0", LC_ALL: "ko_KR.CP949" }, "cp949"], [{ PYTHONIOENCODING: "UTF-16" }, "utf_16"],
    ] as const) {
      assert.throws(() => decodeStdin(Buffer.from([0xb0, 0xa1, 0x20]), { ...environment }), { name: "UnsupportedStdinEncoding", message: `stdin encoding ${name} is not supported; set PYTHONUTF8=1` });
    }
    assert.throws(() => decodeStdin(Buffer.from("plain"), { PYTHONIOENCODING: "euc-kr" }), UnsupportedStdinEncoding);
    assert.throws(() => decodeStdin(Buffer.from("plain"), { PYTHONIOENCODING: "bogus" }), (error: unknown) => error instanceof PythonStartupFailure &&
      error.stderr.startsWith("Fatal Python error: init_stdio_encoding: failed to get the Python codec name of the stdio encoding\nPython runtime state: core initialized\nLookupError: unknown encoding: bogus\n"));
    assert.throws(() => decodeStdin(Buffer.from("plain"), { PYTHONIOENCODING: "hex" }), (error: unknown) => error instanceof PythonStartupFailure &&
      error.stderr.includes("LookupError: 'hex' is not a text encoding"));
  });
});

it("extracts Linux locale codesets without their modifiers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keel-locale-modifier-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  try {
    const commands = join(directory, "commands");
    mkdirSync(commands);
    writeFileSync(join(commands, "locale"), "#!/bin/sh\nprintf '%s\\n' 'en_US.UTF-8@euro' 'ko_KR.CP949@custom'\n");
    chmodSync(join(commands, "locale"), 0o755);
    Object.defineProperty(process, "platform", { value: "linux" });
    const { stdinCodec: linuxCodec } = await import(new URL("../lib/pystdin.ts?linux-locale-test", import.meta.url).href);
    withEnv({ PATH: commands }, () => {
      assert.deepEqual(linuxCodec({ PYTHONUTF8: "0", LC_ALL: "en_US.UTF-8@euro" }), { name: "UTF-8", errors: "strict" });
      assert.deepEqual(linuxCodec({ PYTHONUTF8: "0", LC_ALL: "ko_KR.CP949@custom" }), { name: "CP949", errors: "strict" });
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(directory, { recursive: true, force: true });
  }
});
