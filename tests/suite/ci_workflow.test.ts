import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const workflow = readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8")
const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts as Record<string, string>

function runSteps(): string[] {
  return [...workflow.matchAll(/^\s+- run: (.+)$/gm)].map((match) => (match[1] ?? "").trim())
}

describe("ci workflow", () => {
  it("runsTheSameTypecheckAndSuiteAsTheNpmScripts", () => {
    const steps = runSteps()
    assert.ok(steps.includes(`npx ${scripts["typecheck"]}`), steps.join("\n"))
    assert.ok(steps.includes(scripts["test"] as string), steps.join("\n"))
  })

  it("givesTheSuiteStepADataDirUnderTheRunnerTemp", () => {
    const suiteStep = `- run: ${scripts["test"]}\n        env:\n          KEEL_DATA_DIR: \${{ runner.temp }}/keel-data\n`
    assert.ok(workflow.includes(suiteStep), workflow)
    assert.doesNotMatch(workflow, /^    env:/m)
  })

  it("runsOnPullRequestsAndPushesToMain", () => {
    assert.match(workflow, /^\s+pull_request:/m)
    assert.match(workflow, /push:\n\s+branches: \[main\]/)
  })
})
