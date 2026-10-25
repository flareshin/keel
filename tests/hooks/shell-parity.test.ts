import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { EXPECTED_DIVERGENCES, runParity } from "./shell-parity.ts";
import type { ParityReport } from "./shell-parity.ts";
import { ADVERSARIAL_SPELLINGS } from "./shell-parity-corpus.ts";

const MIN_ADVERSARIAL_SPELLINGS = 50;

describe("shell parser parity with the recorded hookkit/shell.py results", () => {
  let report: ParityReport;

  before(() => {
    report = runParity();
  });

  it("returns the same JSON from every public function on the whole corpus", () => {
    assert.ok(ADVERSARIAL_SPELLINGS.length >= MIN_ADVERSARIAL_SPELLINGS, `${ADVERSARIAL_SPELLINGS.length} adversarial spellings`);
    assert.ok(report.corpusSize > ADVERSARIAL_SPELLINGS.length, `corpus holds only ${report.corpusSize} strings`);
    assert.ok(report.cases >= report.corpusSize, `${report.cases} cases for ${report.corpusSize} strings`);
    assert.equal(report.mismatches, 0, report.details.join("\n"));
  });

  it("lists exactly the resolve_directory calls whose ~name belongs to an account other than the current user", () => {
    assert.equal(report.divergences, EXPECTED_DIVERGENCES.length);
    assert.deepEqual(EXPECTED_DIVERGENCES.map((divergence) => divergence.call.args[1]).sort(), ["~root", "~root", "~root/", "~root/", "~root/x", "~root/x"]);
  });

  it("the recorded run executed every line of shell.py except the justified unreachable ones", () => {
    assert.deepEqual(report.coverageGaps, []);
    assert.equal(report.executedLines + report.allowlistedLines, report.executableLines);
  });
});
