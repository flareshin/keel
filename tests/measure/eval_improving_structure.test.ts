import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { CHECKOUT } from "./helpers.ts"
import { fixtureEditGrader } from "./eval_helpers.ts"
import type { FixtureEdit } from "./eval_helpers.ts"

const SHOP = path.join(CHECKOUT, "measure", "evals", "C-improving-structure", "repo")
const SIGNAL = "signal C-improving-structure -: "

const DIRECT_CALLERS: FixtureEdit = {
  remove: ["src/pricing-service.js"],
  write: {
    "src/receipt.js": readShop("src/receipt.js").replace('import { computeTotal } from "./pricing-service.js"', 'import { priceOrder } from "./pricing.js"').replace("computeTotal(order)", "priceOrder(order)"),
    "src/report.js": readShop("src/report.js").replace('import { computeTotal } from "./pricing-service.js"', 'import { priceOrder } from "./pricing.js"').replace("computeTotal(order)", "priceOrder(order)"),
  },
}
const NO_LEGACY_DISCOUNT: FixtureEdit = { write: { "src/money.js": 'export function dollars(cents) {\n  return (cents / 100).toFixed(2)\n}\n' } }
const DIRECT_TAX: FixtureEdit = {
  remove: ["src/tax-provider-factory.js"],
  write: {
    "src/pricing.js": readShop("src/pricing.js").replace('import { createTaxProvider } from "./tax-provider-factory.js"', 'import { FlatTax } from "./flat-tax.js"').replace("createTaxProvider()", "new FlatTax()"),
  },
}

function readShop(file: string): string {
  return fs.readFileSync(path.join(SHOP, file), "utf8")
}

function merged(...edits: FixtureEdit[]): FixtureEdit {
  return { write: Object.assign({}, ...edits.map((edit) => edit.write)), remove: edits.flatMap((edit) => edit.remove ?? []) }
}

describe("evalGraderDiff with the C-improving-structure grader", () => {
  const grade = fixtureEditGrader("C-improving-structure", SHOP)

  it("evalGraderDiff_findsNoSignal_forCallersMovedOffThePassThrough", () => {
    assert.deepEqual(grade(DIRECT_CALLERS), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forTheUnusedFunctionRemoved", () => {
    assert.deepEqual(grade(NO_LEGACY_DISCOUNT), { signals: [] })
  })

  it("evalGraderDiff_reportsTheMoneyModuleDeletedWithTheUnusedFunction", () => {
    assert.deepEqual(grade({ remove: ["src/money.js"], write: {} }), { signals: [`${SIGNAL}tests fail at head: ✖ test/receipt.test.js`] })
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
    const touched = { write: { "src/money.js": readShop("src/money.js").replace("\n", " \n") } }
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
    const grown = readShop("src/money.js") + "export const NO_DISCOUNT_CENTS = 0\n"
    assert.deepEqual(grade({ write: { "src/money.js": grown } }), { signals: [`${SIGNAL}source line count grows by 1`] })
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
