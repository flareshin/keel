import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { asciiJson } from "./recorded-cases.ts"

const FIXTURE_DIRECTORY = join(import.meta.dirname, "fixtures", "python")
const RECORD_FLAG = "KEEL_RECORD_PYTHON"
const RECORDED_PYTHON_VERSION = "3.15.0"
const COMPRESS_ABOVE_BYTES = 5_000_000
export const RECORDED_PLATFORM = "darwin"

export interface Tokens {
  [token: string]: string
}

type TokenSource = Tokens | (() => Tokens)

function tokensOf(source: TokenSource): Tokens {
  return typeof source === "function" ? source() : source
}

interface Fixture {
  python: string
  platform: string
  answers: Record<string, unknown>
}

export function isRecording(): boolean {
  return process.env[RECORD_FLAG] === "1"
}

export function recordedAnswers<Question, Answer>(
  name: string,
  questions: readonly Question[],
  askPython: (questions: Question[]) => Answer[],
  tokenSource: TokenSource = {},
): Answer[] {
  if (isRecording()) return recordAnswers(name, questions, askPython, tokenSource)
  const tokens = tokensOf(tokenSource)
  const fixture = readFixture(name)
  const missing: number[] = []
  const answers = questions.map((question, index) => {
    const key = keyOf(question, tokens)
    if (!(key in fixture.answers)) missing.push(index)
    return withTokensRestored(fixture.answers[key], tokens) as Answer
  })
  if (missing.length > 0) {
    throw new Error(`${name}: ${missing.length} of ${questions.length} questions have no recorded Python answer, first at ${missing[0]}: ${JSON.stringify(questions[missing[0] as number]).slice(0, 200)}`)
  }
  return answers
}

function recordAnswers<Question, Answer>(name: string, questions: readonly Question[], askPython: (questions: Question[]) => Answer[], tokenSource: TokenSource): Answer[] {
  const answers = askPython([...questions])
  const tokens = tokensOf(tokenSource)
  if (answers.length !== questions.length) throw new Error(`${name}: ${answers.length} answers for ${questions.length} questions`)
  const fixture = readFixtureIfPresent(name)
  questions.forEach((question, index) => {
    fixture.answers[keyOf(question, tokens)] = withTokensReplaced(answers[index], tokens)
  })
  const sorted = Object.fromEntries(Object.entries(fixture.answers).sort(([left], [right]) => (left < right ? -1 : 1)))
  mkdirSync(FIXTURE_DIRECTORY, { recursive: true })
  writeFixture(name, asciiJson({ ...fixture, answers: sorted }) + "\n")
  return answers
}

export function recordedPlatformMatches(): boolean {
  return process.platform === RECORDED_PLATFORM
}

function keyOf(question: unknown, tokens: Tokens): string {
  return createHash("sha1").update(replaceTokens(JSON.stringify(question) ?? "null", tokens)).digest("hex")
}

function fixturePath(name: string): string {
  return join(FIXTURE_DIRECTORY, `${name}.json`)
}

function writeFixture(name: string, text: string): void {
  const plain = fixturePath(name)
  const compressed = `${plain}.gz`
  rmSync(plain, { force: true })
  rmSync(compressed, { force: true })
  if (text.length > COMPRESS_ABOVE_BYTES) writeFileSync(compressed, gzipSync(text))
  else writeFileSync(plain, text)
}

function readFixtureText(name: string): string {
  try {
    return readFileSync(fixturePath(name), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return gunzipSync(readFileSync(`${fixturePath(name)}.gz`)).toString("utf8")
  }
}

function readFixtureIfPresent(name: string): Fixture {
  try {
    return readFixture(name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return { python: RECORDED_PYTHON_VERSION, platform: process.platform, answers: {} }
  }
}

function readFixture(name: string): Fixture {
  return JSON.parse(readFixtureText(name)) as Fixture
}

function replaceTokens(text: string, tokens: Tokens): string {
  let replaced = text
  for (const [token, value] of Object.entries(tokens)) replaced = replaced.replaceAll(JSON.stringify(value).slice(1, -1), token)
  return replaced
}

function withTokensReplaced(value: unknown, tokens: Tokens): unknown {
  return JSON.parse(replaceTokens(JSON.stringify(value) ?? "null", tokens))
}

function withTokensRestored(value: unknown, tokens: Tokens): unknown {
  let text = JSON.stringify(value) ?? "null"
  for (const [token, actual] of Object.entries(tokens)) text = text.replaceAll(token, JSON.stringify(actual).slice(1, -1))
  return JSON.parse(text)
}

