import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runParity } from "./shell-parity.ts";
import { ADVERSARIAL_SPELLINGS } from "./shell-parity-corpus.ts";

const MIN_ADVERSARIAL_SPELLINGS = 50;

describe("shell parser parity with hookkit/shell.py", () => {
  it("returns the same JSON from every public function on the whole corpus", () => {
    const report = runParity();
    assert.ok(ADVERSARIAL_SPELLINGS.length >= MIN_ADVERSARIAL_SPELLINGS, `${ADVERSARIAL_SPELLINGS.length} adversarial spellings`);
    assert.ok(report.corpusSize > ADVERSARIAL_SPELLINGS.length, `corpus holds only ${report.corpusSize} strings`);
    assert.ok(report.cases >= report.corpusSize, `${report.cases} cases for ${report.corpusSize} strings`);
    assert.equal(report.mismatches, 0, report.details.join("\n"));
  });
});
