import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

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

export function recordedPlatformMatches(): boolean {
  return process.platform === RECORDED_PLATFORM
}

function keyOf(question: unknown, tokens: Tokens): string {
  return createHash("sha1").update(replaceTokens(JSON.stringify(question) ?? "null", tokens)).digest("hex")
}

function fixturePath(name: string): string {
  return join(FIXTURE_DIRECTORY, `${name}.json`)
}

function readFixtureText(name: string): string {
  try {
    return readFileSync(fixturePath(name), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return gunzipSync(readFileSync(`${fixturePath(name)}.gz`)).toString("utf8")
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

function withTokensRestored(value: unknown, tokens: Tokens): unknown {
  let text = JSON.stringify(value) ?? "null"
  for (const [token, actual] of Object.entries(tokens)) text = text.replaceAll(token, JSON.stringify(actual).slice(1, -1))
  return JSON.parse(text)
}
