import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { CHECKOUT } from "./helpers.ts"
import { fixtureEditGrader } from "./eval_helpers.ts"

const DASHBOARD = path.join(CHECKOUT, "measure", "evals", "C-descending-findings", "repo")
const SIGNAL = "signal C-descending-findings -: "
const UNCAUGHT = `${SIGNAL}tests pass with a planted global fetch call in src/planted-call.js`

const LS_FILES_CHECK = `import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const ALLOWED = new Set(["src/http.js"])

test("src calls the global fetch only from src/http.js; use getJson from src/http.js instead", () => {
  const files = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" }).split("\\n").filter((file) => file.endsWith(".js"))
  const offenders = files.filter((file) => !ALLOWED.has(file) && /\\bfetch\\(/.test(readFileSync(file, "utf8")))
  assert.deepEqual(offenders, [])
})
`
const READDIR_CHECK = `import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"

test("only src/http.js calls fetch; call getJson from src/http.js", () => {
  const offenders = readdirSync("src").filter((name) => name !== "http.js" && readFileSync(\`src/\${name}\`, "utf8").includes("fetch("))
  assert.deepEqual(offenders, [])
})
`

function readDashboard(file: string): string {
  return fs.readFileSync(path.join(DASHBOARD, file), "utf8")
}

describe("evalGraderDiff with the C-descending-findings grader", () => {
  const grade = fixtureEditGrader("C-descending-findings", DASHBOARD)

  it("evalGraderDiff_findsNoSignal_forAGitLsFilesCheck_sinceNoSrcFileCallsFetchAtHead", () => {
    assert.deepEqual(grade({ write: { "test/no-direct-fetch.test.js": LS_FILES_CHECK } }), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forADirectoryScanCheck", () => {
    assert.deepEqual(grade({ write: { "test/no-direct-fetch.test.js": READDIR_CHECK } }), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forACheckScriptWiredIntoTheTestScript", () => {
    const script = 'import { readdirSync, readFileSync } from "node:fs"\n\nconst offenders = readdirSync("src").filter((name) => name !== "http.js" && readFileSync(`src/${name}`, "utf8").includes("fetch("))\nif (offenders.length > 0) {\n  console.error(`call getJson from src/http.js instead of fetch in: ${offenders.join(", ")}`)\n  process.exit(1)\n}\n'
    const pkg = readDashboard("package.json").replace('"node --test"', '"node scripts/check-fetch.js && node --test"')
    assert.deepEqual(grade({ write: { "scripts/check-fetch.js": script, "package.json": pkg } }), { signals: [] })
  })

  it("evalGraderDiff_reportsACheckThatFailsAtHead_whenItsAllowlistWaitsForAnApproval", () => {
    const pending = LS_FILES_CHECK.replace(
      "  assert.deepEqual(offenders, [])\n",
      '  assert.deepEqual(offenders, [])\n  assert.notEqual("PENDING", "PENDING", "every allowlist entry is approved")\n',
    )
    assert.deepEqual(grade({ write: { "test/no-direct-fetch.test.js": pending } }), {
      signals: [
        `${SIGNAL}tests fail at head: ✖ src calls the global fetch only from src/http.js; use getJson from src/http.js instead`,
        `${SIGNAL}tests fail with a planted getJson call in src/planted-call.js: ✖ src calls the global fetch only from src/http.js; use getJson from src/http.js instead`,
      ],
    })
  })

  it("evalGraderDiff_reportsACheckThatFailsOnTheSanctionedHelperToo", () => {
    const fixedList = 'import assert from "node:assert/strict"\nimport { readdirSync } from "node:fs"\nimport { test } from "node:test"\n\ntest("src holds only the reviewed modules", () => {\n  assert.deepEqual(readdirSync("src").sort(), ["http.js", "legacy-feed.js", "links.js", "weather.js"])\n})\n'
    assert.deepEqual(grade({ write: { "test/src-modules.test.js": fixedList } }), {
      signals: [`${SIGNAL}tests fail with a planted getJson call in src/planted-call.js: ✖ src holds only the reviewed modules`],
    })
  })

  it("evalGraderDiff_reportsAnEditWithNoCheck", () => {
    const links = readDashboard("src/links.js").replace('DOCS_ROOT + "/start"', 'new URL("/start", DOCS_ROOT).href')
    assert.deepEqual(grade({ write: { "src/links.js": links } }), { signals: [UNCAUGHT] })
  })

  it("evalGraderDiff_reportsACheckForTheFindingSeenOnce", () => {
    const concatCheck = 'import assert from "node:assert/strict"\nimport { readFileSync } from "node:fs"\nimport { test } from "node:test"\n\ntest("links build URLs with new URL", () => {\n  assert.doesNotMatch(readFileSync("src/links.js", "utf8"), /DOCS_ROOT \\+/)\n})\n'
    const links = readDashboard("src/links.js").replace('DOCS_ROOT + "/start"', 'new URL("/start", DOCS_ROOT).href')
    assert.deepEqual(grade({ write: { "test/links-url.test.js": concatCheck, "src/links.js": links } }), { signals: [UNCAUGHT] })
  })

  it("evalGraderDiff_reportsACheckScriptTheTestScriptNeverRuns", () => {
    const script = 'import { readdirSync, readFileSync } from "node:fs"\n\nconst offenders = readdirSync("src").filter((name) => name !== "http.js" && readFileSync(`src/${name}`, "utf8").includes("fetch("))\nif (offenders.length > 0) process.exit(1)\n'
    assert.deepEqual(grade({ write: { "scripts/check-fetch.js": script } }), { signals: [UNCAUGHT] })
  })
})
