import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"

const FIXTURE_DIRECTORY = join(import.meta.dirname, "fixtures", "python")
const PRINCIPLES_PATH = join(import.meta.dirname, "..", "PRINCIPLES.md")
export const RECORDED_PLATFORM = "darwin"

export interface Tokens {
  [token: string]: string
}

interface Fixture {
  python: string
  platform: string
  answers: Record<string, unknown>
}

export function recordedAnswers<Question, Answer>(name: string, questions: readonly Question[], callerTokens: Tokens = {}): Answer[] {
  const tokens = { "{{PRINCIPLES}}": readFileSync(PRINCIPLES_PATH, "utf8"), ...callerTokens }
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

export function recordAnswers<Question, Answer>(name: string, entries: ReadonlyArray<readonly [Question, Answer]>, callerTokens: Tokens = {}): void {
  const tokens = { "{{PRINCIPLES}}": readFileSync(PRINCIPLES_PATH, "utf8"), ...callerTokens }
  const { python, platform } = readFixture(name)
  const answers = Object.fromEntries(entries.map(([question, answer]): [string, unknown] => [
    keyOf(question, tokens), JSON.parse(replaceTokens(JSON.stringify(answer) ?? "null", tokens)) as unknown,
  ]).sort(([left], [right]) => (left < right ? -1 : 1)))
  const file = fixtureFile(name)
  const text = JSON.stringify({ python, platform, answers })
  writeFileSync(file, file.endsWith(".gz") ? gzipSync(text) : text)
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

function fixtureFile(name: string): string {
  return existsSync(fixturePath(name)) ? fixturePath(name) : `${fixturePath(name)}.gz`
}

function readFixtureText(name: string): string {
  const file = fixtureFile(name)
  const content = readFileSync(file)
  return (file.endsWith(".gz") ? gunzipSync(content) : content).toString("utf8")
}

function readFixture(name: string): Fixture {
  return JSON.parse(readFixtureText(name)) as Fixture
}

function replaceTokens(text: string, tokens: Tokens): string {
  let replaced = text
  for (const [token, value] of Object.entries(tokens)) replaced = replaced.replaceAll(JSON.stringify(value).slice(1, -1), token)
  return replaced
}

function withTokensRestored(value: unknown, tokens: Tokens): unknown {
  let text = JSON.stringify(value) ?? "null"
  for (const [token, actual] of Object.entries(tokens)) text = text.replaceAll(token, JSON.stringify(actual).slice(1, -1))
  return JSON.parse(text)
}
