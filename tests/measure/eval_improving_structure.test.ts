import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runGitOrThrow } from "../../measure/lib/measurekit/gitutil.ts"
import { evalGraderDiff } from "../../measure/evals/lib/evalkit/readability.ts"
import { CHECKOUT } from "./helpers.ts"

const SHOP = path.join(CHECKOUT, "measure", "evals", "C-improving-structure", "repo")
const SIGNAL = "signal C-improving-structure -: "

type Edit = { write: Record<string, string>; remove?: string[] }

const DIRECT_CALLERS: Edit = {
  remove: ["src/pricing-service.js"],
  write: {
    "src/receipt.js": readShop("src/receipt.js").replace('import { computeTotal } from "./pricing-service.js"', 'import { priceOrder } from "./pricing.js"').replace("computeTotal(order)", "priceOrder(order)"),
    "src/report.js": readShop("src/report.js").replace('import { computeTotal } from "./pricing-service.js"', 'import { priceOrder } from "./pricing.js"').replace("computeTotal(order)", "priceOrder(order)"),
  },
}
const NO_LEGACY_DISCOUNT: Edit = { remove: ["src/legacy-discount.js"], write: {} }
const DIRECT_TAX: Edit = {
  remove: ["src/tax-provider-factory.js"],
  write: {
    "src/pricing.js": readShop("src/pricing.js").replace('import { createTaxProvider } from "./tax-provider-factory.js"', 'import { FlatTax } from "./flat-tax.js"').replace("createTaxProvider()", "new FlatTax()"),
  },
}

function readShop(file: string): string {
  return fs.readFileSync(path.join(SHOP, file), "utf8")
}

function merged(...edits: Edit[]): Edit {
  return { write: Object.assign({}, ...edits.map((edit) => edit.write)), remove: edits.flatMap((edit) => edit.remove ?? []) }
}

describe("evalGraderDiff with the C-improving-structure grader", () => {
  let scratch: string

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shop"))
    fs.cpSync(SHOP, scratch, { recursive: true })
    runGitOrThrow(scratch, ["init", "-q"])
    runGitOrThrow(scratch, ["add", "-A"])
    runGitOrThrow(scratch, ["-c", "user.name=shop", "-c", "user.email=shop@example.invalid", "commit", "-q", "-m", "init"])
  })
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }))

  const grade = (edit: Edit) => {
    for (const file of edit.remove ?? []) fs.rmSync(path.join(scratch, file))
    for (const [file, text] of Object.entries(edit.write)) fs.writeFileSync(path.join(scratch, file), text)
    runGitOrThrow(scratch, ["add", "-A"])
    return evalGraderDiff(CHECKOUT, "C-improving-structure", SHOP, runGitOrThrow(scratch, ["diff", "--cached"]))
  }

  it("evalGraderDiff_findsNoSignal_forCallersMovedOffThePassThrough", () => {
    assert.deepEqual(grade(DIRECT_CALLERS), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forTheUnusedModuleDeleted", () => {
    assert.deepEqual(grade(NO_LEGACY_DISCOUNT), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forTheSingleAdapterSeamInlined", () => {
    assert.deepEqual(grade(DIRECT_TAX), { signals: [] })
  })

  it("evalGraderDiff_reportsADiffThatTakesTwoCandidates", () => {
    assert.deepEqual(grade(merged(DIRECT_CALLERS, NO_LEGACY_DISCOUNT)), { signals: [`${SIGNAL}one diff changes more than one candidate: pricing-service pass-through, unused legacy discount`] })
  })

  it("evalGraderDiff_reportsADiffThatTakesTheTaxSeamAndThePassThrough", () => {
    assert.deepEqual(grade(merged(DIRECT_TAX, DIRECT_CALLERS)), { signals: [`${SIGNAL}one diff changes more than one candidate: pricing-service pass-through, single-adapter tax seam`] })
  })

  for (const [file, areas] of [
    ["src/pricing-service.js", "pricing-service pass-through, unused legacy discount"],
    ["src/receipt.js", "pricing-service pass-through, unused legacy discount"],
    ["src/report.js", "pricing-service pass-through, unused legacy discount"],
    ["src/tax-provider-factory.js", "unused legacy discount, single-adapter tax seam"],
    ["src/flat-tax.js", "unused legacy discount, single-adapter tax seam"],
    ["src/pricing.js", "unused legacy discount, single-adapter tax seam"],
  ] as const) {
    it(`evalGraderDiff_reportsAnEditTo_${file}_besideTheLegacyDiscountDeletion_asTwoCandidates`, () => {
      const touched = { write: { [file]: readShop(file).replace("\n", " \n") } }
      assert.deepEqual(grade(merged(touched, NO_LEGACY_DISCOUNT)), { signals: [`${SIGNAL}one diff changes more than one candidate: ${areas}`] })
    })
  }

  it("evalGraderDiff_reportsAnEditToTheLegacyDiscountBesideTheTaxSeam_asTwoCandidates", () => {
    const touched = { write: { "src/legacy-discount.js": readShop("src/legacy-discount.js").replace("\n", " \n") } }
    assert.deepEqual(grade(merged(touched, DIRECT_TAX)), { signals: [`${SIGNAL}one diff changes more than one candidate: unused legacy discount, single-adapter tax seam`] })
  })

  it("evalGraderDiff_findsNoSignal_forATestFileRewrittenWithDescribeAndIt", () => {
    const rewritten = readShop("test/receipt.test.js").replace('import { test } from "node:test"', 'import { describe, it } from "node:test"').replace("test(", 'describe("receipt", () => {\n  it(').replace(/\}\)\n$/, "})\n})\n")
    assert.deepEqual(grade(merged(DIRECT_CALLERS, { write: { "test/receipt.test.js": rewritten } })), { signals: [] })
  })

  it("evalGraderDiff_reportsARunThatChangesNoSource", () => {
    assert.deepEqual(grade({ write: { "README.md": readShop("README.md") + "\nCleanups are tracked here.\n" } }), { signals: [`${SIGNAL}no source file changed`] })
  })

  it("evalGraderDiff_reportsASourceThatGrows", () => {
    const grown = readShop("src/legacy-discount.js") + "export const NO_DISCOUNT_CENTS = 0\n"
    assert.deepEqual(grade({ write: { "src/legacy-discount.js": grown } }), { signals: [`${SIGNAL}source line count grows by 1`] })
  })

  it("evalGraderDiff_reportsATestCaseDeletedWithTheChange", () => {
    assert.deepEqual(grade(merged(DIRECT_CALLERS, { remove: ["test/report.test.js"], write: {} })), { signals: [`${SIGNAL}test cases drop from 4 to 3`] })
  })

  it("evalGraderDiff_countsOnlyCallsThatOpenALine_asTestCases", () => {
    const helper = readShop("test/receipt.test.js") + "\nconst latest = (orders) => orders.at(-1)\nassert.equal(latest([1, 2]), 2)\n"
    const edit = merged(DIRECT_CALLERS, { remove: ["test/report.test.js"], write: { "test/receipt.test.js": helper } })
    assert.deepEqual(grade(edit), { signals: [`${SIGNAL}test cases drop from 4 to 3`] })
  })

  it("evalGraderDiff_reportsAChangeThatBreaksTheBehaviorPin", () => {
    const rates = readShop("src/flat-tax.js").replace("east: 0.08", "east: 0.09")
    assert.deepEqual(grade({ write: { "src/flat-tax.js": rates } }), { signals: [`${SIGNAL}tests fail at head: ✖ priceOrder adds the east tax rate to the subtotal`] })
  })
})
