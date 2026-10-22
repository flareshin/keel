import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { parseIsoDate } from "../../measure/lib/measurekit/pydate.ts"
import { newlineSeparatedLines, readText } from "../../measure/lib/measurekit/pyio.ts"
import { JsonDecodeError, pythonJsonDumps, pythonJsonLoads } from "../../measure/lib/measurekit/pyjson.ts"
import { expanduser, pyBasename, pyDirname, pyJoin, pyNormpath, pyRelpath, pySplitext, realpath } from "../../measure/lib/measurekit/pypath.ts"
import { compilePythonRegex, PyRegexError } from "../../measure/lib/measurekit/pyregex.ts"
import { ShlexError, shlexSplit } from "../../measure/lib/measurekit/shlex.ts"
import { codePointLength, pyInt, pyLstrip, pySplitlines, pySplitWhitespace, pyStrip, sortedByCodePoint } from "../../measure/lib/measurekit/pystr.ts"
import { PyFloat, pyFloatRepr, pyRepr, roundToFourDecimals } from "../../measure/lib/measurekit/pyvalue.ts"
import { runProcess, TimeoutExpired } from "../../measure/lib/measurekit/subprocess.ts"
import type { PyValue } from "../../measure/lib/measurekit/pyvalue.ts"

const PYTHON_ORACLE = String.raw`
import json, os, re, shlex, struct, sys, tempfile
from datetime import datetime

def regex_flags(flags):
    return (re.I if "i" in flags else 0) | (re.M if "m" in flags else 0) | (re.S if "s" in flags else 0)

def run(op, args):
    if op == "json":
        text, sort_keys, indent = args
        try:
            return json.dumps(json.loads(text), sort_keys=sort_keys, indent=indent)
        except ValueError as error:
            return "ERR " + str(error)
    if op == "repr":
        return repr(args[0])
    if op == "float":
        return repr(struct.unpack("<d", bytes.fromhex(args[0]))[0])
    if op == "round4":
        return repr(round(args[0] / args[1], 4))
    if op == "splitlines":
        return args[0].splitlines()
    if op == "fileiter":
        with tempfile.TemporaryDirectory() as directory:
            name = os.path.join(directory, "text")
            with open(name, "w", encoding="utf-8", newline="") as handle:
                handle.write(args[0])
            with open(name, encoding="utf-8") as handle:
                return [line.rstrip("\n") for line in handle]
    if op == "strip":
        return [args[0].strip(), args[0].lstrip()]
    if op == "split":
        return args[0].split()
    if op == "lower":
        return args[0].lower()
    if op == "shlex":
        try:
            return shlex.split(args[0])
        except ValueError as error:
            return "ERR " + str(error)
    if op == "regex":
        pattern, flags, text = args
        try:
            return re.search(pattern, text, regex_flags(flags)) is not None
        except re.error:
            return "ERR"
    if op == "strptime":
        try:
            return datetime.strptime(args[0], "%Y-%m-%d").date().isoformat()
        except ValueError:
            return None
    if op == "int":
        return int(args[0])
    if op == "path":
        kind, first, second = args
        if kind == "splitext": return list(os.path.splitext(first))
        if kind == "basename": return os.path.basename(first)
        if kind == "dirname": return os.path.dirname(first)
        if kind == "normpath": return os.path.normpath(first)
        if kind == "join": return os.path.join(first, second)
        if kind == "relpath": return os.path.relpath(first, second)
        if kind == "realpath": return os.path.realpath(first)
        if kind == "expanduser": return os.path.expanduser(first)
    raise SystemExit("unknown op " + op)

cases = json.load(sys.stdin)
json.dump([run(op, args) for op, args in cases], sys.stdout)
`

type Case = [string, unknown[]]

function oracle(cases: Case[], env: NodeJS.ProcessEnv = process.env): unknown[] {
  const completed = spawnSync("python3", ["-I", "-c", PYTHON_ORACLE], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 1 << 28, env })
  assert.equal(completed.status, 0, completed.stderr)
  return JSON.parse(completed.stdout)
}

let mismatches = 0
let compared = 0

function compare(cases: Case[], actual: unknown[], env?: NodeJS.ProcessEnv): void {
  const expected = oracle(cases, env)
  assert.equal(expected.length, actual.length)
  const bad: string[] = []
  expected.forEach((value, index) => {
    compared++
    if (JSON.stringify(value) !== JSON.stringify(actual[index])) {
      mismatches++
      bad.push(`${JSON.stringify(cases[index])}\n  python: ${JSON.stringify(value)}\n  ts:     ${JSON.stringify(actual[index])}`)
    }
  })
  assert.deepEqual(bad.slice(0, 40), [], `${bad.length} mismatches`)
}

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const TRICKY_CHARS = ["a", "Z", "0", " ", "\t", "\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x1f", "\x7f", "\x85", "\xa0", " ", " ", " ", " ", "　",
  "﻿", "é", "İ", "Σ", "ß", "٣", "１", "\uD55C", "\u{1F600}", "\u{10400}", "\\", "\"", "'", "/", "-", ".", ":", "#", "$", "^", "*", "(", ")", "[", "]", "{", "}", "|", "?", "+", "​"]

function randomString(random: () => number, maxLength: number): string {
  let text = ""
  const length = Math.floor(random() * maxLength)
  for (let index = 0; index < length; index++) text += TRICKY_CHARS[Math.floor(random() * TRICKY_CHARS.length)]
  return text
}

const DOTTED_DOTLESS_I_PATTERNS: [string, string][] = [
  ["i", "i"], ["I", "i"], ["(?i)i", ""], ["(?i)\u0130", ""], ["(?i)\u0131", ""], ["\u0130", "i"], ["[a-z]+x", "i"], ["(?i)[a-z]+x", ""], ["[^i]", "i"], ["[^a-z]", "i"],
  ["[\u0130]", "i"], ["[\u0100-\u0200]", "i"], ["\\u0130", "i"], ["\\x49", "i"], ["\\x69", "i"], ["\\111", "i"], ["\\\u0130", "i"], ["[\\w]", "i"], ["[\\d-]i", "i"], ["[a-]x", "i"],
  ["(?P<api>i)(?P=api)", "i"], ["(?ai)i", ""], ["API_KEY", "i"], ["(?i)[A-Z]{2}\u0130_KEY", ""],
]

const QUANTIFIER_AND_BRACKET_PATTERNS: [string, string][] = [
  ["x{,}y", ""], ["x{}y", ""], ["x{,}", ""], ["x{ ,}", ""], ["a]", ""], ["]", ""], ["[]]", ""], ["[^]]", ""], ["[a-c-e]", ""], ["[-a]", ""], ["[a-]", ""], ["[\\d-x]", ""], ["[z-a]", ""],
]

const SCOPED_FLAG_PATTERNS: [string, string][] = [
  ["(?s:a.b)", ""], ["(?s:a.b).c", ""], ["(?-s:a.b)", "s"], ["(?m:x$)", ""], ["(?m:^b)", ""], ["(?-m:x$)", "m"], ["(?i:a)b", ""], ["(?-i:a)b", "i"], ["a(?i:b)c", ""],
  ["(?i:\u0130)", ""], ["(?i-s:a.b)", "s"], ["(?is:A.B)", ""], ["(?a:\\w)", ""], ["(?u:\\w)", ""], ["(?a)(?u:\\w)", ""], ["(?L:a)", ""], ["(?i-i:a)", ""],
  ["(?-:a)", ""], ["(?-i:a)[b]", "i"], ["(?-i:a)[^b]", "i"], ["(?<n>a)", ""], ["(?<=a)b", ""], ["(?<!a)b", ""], ["(?i:a(?-i:b))c", "m"], ["((?s:a.b))+", ""], ["(?s:a.b", ""], ["a)", ""],
]

const ESCAPE_PATTERNS: [string, string][] = [
  ["\\012", ""], ["\\0", ""], ["\\08", ""], ["\\101", ""], ["[\\012]", ""], ["[\\101]", ""], ["[\\0]", ""], ["\\400", ""], ["[\\400]", ""], ["[\\8]", ""], ["\\1", ""],
  ["(a)\\1", ""], ["(a)\\12", ""], ["(a)\\101", ""], ["(a)\\1a", ""], ["(a)\\0", ""],
]

describe("python compatibility helpers match python3", () => {
  const random = seededRandom(20261022)

  it("pythonJson_dumpsAndLoadsAgree_onNestedNonAsciiNonBmpAndFloatFixtures", () => {
    const fixed = [
      '{"b": 1, "a": [1.0, 2.5, -0.0, 1e5, 1E+22, 1e-7, 123456789012345678901234567890, 0.1, 1e16, 12345678901234567.0, 1e15, 0.0001, 0.00001], "c": {"z": null, "y": true, "x": false}}',
      '{"é": "é\u{1F600}\\ud83d\\ude00", "\\u2028": "\\u007f\\u0000\\n\\t\\"\\\\/", "😀": []}',
      '{"b": 1, "a": 2, "a": 3}',
      '[NaN, Infinity, -Infinity, 1e400, -1e400]', '"\\ud800"', '  [1, 2]  ', '{"a": {"b": {"c": [1, [2, [3]]]}}}',
      "", "{", '{"a" 1}', '[1,]', '{"a": 1,}', '"abc', '"a\nb"', '01', '1.', '.5', '-', 'nul', '[1 2]', '{"a": 1} x', '"\\x"', '"\\u12"', "﻿[1]", "tru", "[1]\n\n",
    ]
    const cases: Case[] = []
    for (const text of fixed) {
      for (const sortKeys of [true, false]) for (const indent of [null, 2]) cases.push(["json", [text, sortKeys, indent]])
    }
    for (let index = 0; index < 300; index++) {
      const pieces = Array.from({ length: 1 + Math.floor(random() * 4) }, () => `${JSON.stringify(randomString(random, 6))}: [${JSON.stringify(randomString(random, 5))}, ${(random() * 1000).toFixed(Math.floor(random() * 5))}, ${Math.floor(random() * 100)}]`)
      cases.push(["json", [`{${pieces.join(", ")}}`, true, 2]])
    }
    const actual = cases.map(([, [text, sortKeys, indent]]) => {
      try {
        return pythonJsonDumps(pythonJsonLoads(text as string), { sortKeys: sortKeys as boolean, indent: (indent as number | null) ?? undefined })
      } catch (error) {
        if (error instanceof JsonDecodeError) return "ERR " + error.message
        throw error
      }
    })
    compare(cases, actual)
  })

  it("pyRepr_agrees_onStringsWithEveryKindOfCharacter", () => {
    const cases: Case[] = [["repr", ["it's"]], ["repr", ['say "hi"']], ["repr", ["both ' and \""]], ["repr", ["tab\there\nnew\r"]], ["repr", ["\x00\x1b\x7f\x85\xa0 ​﻿"]], ["repr", ["\u{1F600}é한"]]]
    for (let index = 0; index < 300; index++) cases.push(["repr", [randomString(random, 12)]])
    compare(cases, cases.map(([, [text]]) => pyRepr(text as string)))
  })

  it("pyFloatRepr_agrees_onRandomBitPatternsAndBoundaryValues", () => {
    const buffer = new DataView(new ArrayBuffer(8))
    const hexOf = (value: number): string => {
      buffer.setFloat64(0, value, true)
      return Array.from({ length: 8 }, (_, index) => buffer.getUint8(index).toString(16).padStart(2, "0")).join("")
    }
    const values = [0, -0, 1, 0.5, 0.1, 1e15, 1e16, 9999999999999998, 12345678901234567, 1e-4, 1e-5, 0.00012345, 1.5e300, 5e-324, 1.7976931348623157e308, 123456.789, Math.PI, 2 ** 53, 1 / 3]
    for (let index = 0; index < 400; index++) values.push((random() - 0.5) * 10 ** Math.floor(random() * 40 - 20))
    const cases: Case[] = values.map((value) => ["float", [hexOf(value)]])
    compare(cases, values.map((value) => pyFloatRepr(value)))
  })

  it("roundToFourDecimals_agrees_forEveryRatioUpToSixtyFourRuns", () => {
    const cases: Case[] = []
    const actual: string[] = []
    for (let whole = 1; whole <= 64; whole++) {
      for (let part = 0; part <= whole; part++) {
        cases.push(["round4", [part, whole]])
        actual.push(pyFloatRepr(roundToFourDecimals(part / whole)))
      }
    }
    compare(cases, actual)
  })

  it("newlineSeparatedLines_agrees_withPythonFileIterationAndDiffersFromSplitlines", () => {
    const texts = ["a\r\nb\rc\nd", "a\u2028b\fc\vd\x1ce\x85f", "\n", "", "a\n\n", "x\r\n\r\ny", "last without newline", "a\n"]
    for (let index = 0; index < 300; index++) texts.push(randomString(random, 20))
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-fileiter-"))
    try {
      const actual = texts.map((text) => {
        const file = path.join(root, "text")
        fs.writeFileSync(file, text, "utf8")
        return newlineSeparatedLines(readText(file))
      })
      compare(texts.map((text): Case => ["fileiter", [text]]), actual)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
    assert.deepEqual(newlineSeparatedLines("a\u2028b\n"), ["a\u2028b"])
    assert.deepEqual(pySplitlines("a\u2028b\n"), ["a", "b"])
  })

  it("stringHelpers_agree_onSplitlinesStripSplitAndLower", () => {
    const texts = ["a\r\nb\rc\nd\x0be\x0cf\x1cg\x1dh\x1ei\x85j k l", "\n", "", "a\n\n", "x\r\n\r\ny", "  　 mid \xa0 ", "\x1f x \x1f", "﻿x﻿", "İSTANBUL ΣΑΣ", "ǅ ß ẞ"]
    for (let index = 0; index < 400; index++) texts.push(randomString(random, 20))
    const lines: Case[] = texts.map((text) => ["splitlines", [text]])
    compare(lines, texts.map((text) => pySplitlines(text)))
    compare(texts.map((text): Case => ["strip", [text]]), texts.map((text) => [pyStrip(text), pyLstrip(text)]))
    compare(texts.map((text): Case => ["split", [text]]), texts.map((text) => pySplitWhitespace(text)))
    compare(texts.map((text): Case => ["lower", [text]]), texts.map((text) => text.toLowerCase()))
  })

  it("shlexSplit_agrees_onQuotesEscapesAndErrors", () => {
    const commands = [
      "python3 /k/hooks/x.py --auto", "bash -c 'echo hi there'", 'node "a b" c', "a\\ b c", 'a"b c"d', "''", '""x', "a '' b", '"a\\"b"', '"a\\\\b"', '"a\\nb"', "'a\\nb'",
      "unterminated 'quote", 'unterminated "quote', "trailing\\", "  spaced   out  ", "\tTab\nNew", "a#b", "x\\\ny", '"" ""',
    ]
    for (let index = 0; index < 300; index++) commands.push(randomString(random, 14))
    const cases: Case[] = commands.map((command) => ["shlex", [command]])
    compare(cases, commands.map((command) => {
      try {
        return shlexSplit(command)
      } catch (error) {
        if (error instanceof ShlexError) return "ERR " + error.message
        throw error
      }
    }))
  })

  it("compilePythonRegex_agrees_onRulesSyntaxCornersAndTexts", () => {
    const genericRules = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "measure", "boundary-generic.tsv"), "utf8")
      .split("\n").filter((line) => line && !line.startsWith("#") && !line.startsWith("name\t")).map((line) => line.split("\t")[1] as string)
    const patterns: [string, string][] = [
      ...genericRules.map((rule): [string, string] => [rule, ""]),
      ["(?i)^##\\s+Rules\\b", ""], ["^(K[1-7]|risk|[CSOF]-[a-z0-9-]+)$", ""], ["^prose:\\S+$", ""], ["(?P<q>a)(?P=q)", ""], ["a\\Z", ""], ["\\Aa", ""], ["a$", ""], ["a$", "m"], ["^a", "m"], ["a.b", ""], ["a.b", "s"],
      ["\\d+", ""], ["\\w+é", ""], ["\\bé\\b", ""], ["\\B1", ""], ["[^\\s]+x", ""], ["[\\d\\-_]x", ""], ["x{,3}y", ""], ["a{", ""], ["a{1", ""], ["a{2}b", ""], ["\\-\\_\\ ", ""], ["a|b|", ""],
      ["\\x41\\u0042", ""], ["[\\x41-\\x43]+", ""], ["\\.\\*", ""], ["(?:ab)+c", ""], ["\\q", ""], ["(unclosed", ""], ["[unclosed", ""], ["a**", ""], ["(?i:ab)c", ""],
      ["ß", "i"], ["Σ", "i"], ["σς", "i"], ["[a-z]+", "i"], ["\\s", ""], ["\\S\\s\\S", ""], ["(?i)abc", ""], ["(?s).", ""], ["(?m)^b$", ""],
      ...DOTTED_DOTLESS_I_PATTERNS, ...QUANTIFIER_AND_BRACKET_PATTERNS, ...SCOPED_FLAG_PATTERNS, ...ESCAPE_PATTERNS,
    ]
    const texts = ["", "a", "aa", "a\n", "a\r", "\na", "x\nb\nc", "b\r\nc", "##  Rules", "## rules (hard)", "K5", "K8", "prose:x", "prose: x", "10" + ".1.2.3", "10" + ".٣.2.3", "AKIA" + "ABCDEFGHIJKLMNOP", "é", "xé ", "1", "١٢٣", "abc", "ABC", "a b", "xxxy", "a{", "\x1c", "-_ ", "A", "Aa\nb",
      "i", "I", "\u0130", "\u0131", "x\u0130", "AP\u0130_KEY", "api_key", "\u212a", "a]", "]", "\0", "\n", "x\n", "xy", "TOKENNNX", "a\nb", "a\nbxc", "a\nb\nc", "ab", "aB", "Ab", "b\nx", "abc\n", "aa", "a\x08"]
    for (let index = 0; index < 40; index++) texts.push(randomString(random, 8))
    const cases: Case[] = []
    const actual: unknown[] = []
    for (const [pattern, flags] of patterns) {
      for (const text of texts) {
        cases.push(["regex", [pattern, flags, text]])
        try {
          actual.push(compilePythonRegex(pattern, flags).test(text))
        } catch (error) {
          if (!(error instanceof PyRegexError)) throw error
          actual.push("ERR")
        }
      }
    }
    compare(cases, actual)
  })

  it("compilePythonRegex_rejectsVerboseAndLocaleFlags_insteadOfScanningWithTheWrongMeaning", () => {
    for (const pattern of ["(?x)a b", "(?x:a b)", "(?L)a", "(?L:a)"]) {
      assert.throws(() => compilePythonRegex(pattern), PyRegexError, pattern)
    }
  })

  it("parseIsoDate_agrees_withStrptimeOnShapesAndCalendarEdges", () => {
    const texts = ["2026-01-05", "2026-1-5", "2026-02-30", "2024-02-29", "2023-02-29", "0001-01-01", "0000-01-01", "2026-13-01", "2026-12-32", "2026-12-31 ", " 2026-12-31", "2026-12- 1", "26-01-05", "2026/01/05", "yesterday", "", "2026-01-5x", "２０２６-01-05", "2026-00-10", "2026-10-00", "9999-12-31", "2026-04-31"]
    compare(texts.map((text): Case => ["strptime", [text]]), texts.map((text) => parseIsoDate(text)))
  })

  it("pyInt_agrees_onAsciiAndOtherScriptsDecimalDigits", () => {
    const texts = ["0", "7", "42", "٣", "٠١٢", "१२३", "１２３", "\u{1D7D8}\u{1D7D9}", "\u{1D7F6}9", "০৯"]
    compare(texts.map((text): Case => ["int", [text]]), texts.map((text) => pyInt(text)))
  })

  describe("path helpers", () => {
    let root: string

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-pypath-")))
      fs.mkdirSync(path.join(root, "real", "sub"), { recursive: true })
      fs.symlinkSync(path.join(root, "real"), path.join(root, "link"))
      fs.symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"))
      fs.symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"))
      fs.symlinkSync("missing-target", path.join(root, "dangling"))
    })
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

    it("pathFunctions_agree_withOsPath", () => {
      const names = ["a.b", ".bashrc", "..x", "a.", "a.b.c", "dir/", "/", "", "//", "a//b/", "/a/b/../c/./d", "../..", "a/../..", "/..", "///x", "x/y.tar.gz", "/a/b.d/c"]
      const cases: Case[] = []
      const actual: unknown[] = []
      for (const name of names) {
        cases.push(["path", ["splitext", name, ""]], ["path", ["basename", name, ""]], ["path", ["dirname", name, ""]], ["path", ["normpath", name, ""]])
        actual.push(pySplitext(name), pyBasename(name), pyDirname(name), pyNormpath(name))
      }
      for (const [first, second] of [["a", "b"], ["a/", "b"], ["", "b"], ["a", "/b"], ["/a", "b/c"], ["a", ""]] as [string, string][]) {
        cases.push(["path", ["join", first, second]])
        actual.push(pyJoin(first, second))
      }
      for (const [target, start] of [["/a/b", "/a"], ["/a", "/a/b/c"], ["/a/b", "/c/d"], ["/a", "/a"], ["/", "/a"]] as [string, string][]) {
        cases.push(["path", ["relpath", target, start]])
        actual.push(pyRelpath(target, start))
      }
      compare(cases, actual)
    })

    it("realpath_agrees_throughLinksLoopsDanglingLinksAndMissingTails", () => {
      const inputs = ["link", "link/sub", "link/../real", "link/sub/missing/tail", "loop-a", "loop-a/x", "dangling", "dangling/x", "real/../link", "nothing/at/all", "./link/./sub/.."].map((name) => path.join(root, name))
      compare(inputs.map((input): Case => ["path", ["realpath", input, ""]]), inputs.map((input) => realpath(input)))
    })

    it("expanduser_agrees_onTildeForms", () => {
      const env = { ...process.env, HOME: "/home/tester/" }
      const inputs = ["~", "~/x", "~x", "plain", "a~", "~/"]
      const saved = process.env["HOME"]
      process.env["HOME"] = "/home/tester/"
      try {
        compare(inputs.map((input): Case => ["path", ["expanduser", input, ""]]), inputs.map((input) => expanduser(input)), env)
      } finally {
        process.env["HOME"] = saved
      }
    })
  })

  it("sortedByCodePoint_ordersAstralCharactersAfterTheBmpUnlikeUtf16", () => {
    assert.deepEqual(sortedByCodePoint(["\u{1F600}", "￿", "a"]), ["a", "￿", "\u{1F600}"])
    assert.equal(codePointLength("a\u{1F600}"), 2)
  })

  it("runProcess_translatesCapturedNewlinesLikePythonTextMode_butKeepsPartialTimeoutOutputRaw", () => {
    const completed = runProcess(["printf", "a\\r\\nb\\rc\\n"])
    assert.equal(completed.stdout, "a\nb\nc\n")
    assert.throws(
      () => runProcess(["sh", "-c", "printf 'x\\r\\n'; sleep 5"], { timeoutSeconds: 1 }),
      (error) => error instanceof TimeoutExpired && error.partialStdout === "x\r\n",
    )
  })

  it("pyFloat_isKeptDistinctFromIntegersInJson", () => {
    assert.equal(pythonJsonDumps({ a: new PyFloat(1), b: 1 } as unknown as PyValue), '{"a": 1.0, "b": 1}')
  })

  it("zzSummary_printsTheParityCount", () => {
    console.log(`parity: ${compared} cases, ${mismatches} mismatches`)
    assert.equal(mismatches, 0)
  })
})
