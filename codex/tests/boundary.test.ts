import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { boundaries } from "./boundary-table.ts";
import { GOLDEN_FILE } from "./boundary-record.ts";

const GOLDEN = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, string>;

describe("input boundaries", () => {
  it("probes_everyGoldenBoundary_exactlyOnce", () => {
    const { boundaries: list, close } = boundaries();
    try {
      const keys = list.flatMap((boundary) => boundary.probes.map((probe) => `${boundary.name}/${probe.label}`));
      assert.deepEqual(keys.slice().sort(), Object.keys(GOLDEN).sort());
    } finally {
      close();
    }
  });

  it("observes_theGoldenOutcome_ofEveryProbe", () => {
    const { boundaries: list, close } = boundaries();
    const differences: string[] = [];
    try {
      for (const boundary of list) {
        for (const probe of boundary.probes) {
          const key = `${boundary.name}/${probe.label}`;
          const now = probe.observe();
          if (now !== GOLDEN[key]) differences.push(`${key}\n    golden: ${GOLDEN[key]}\n    node:   ${now}`);
        }
      }
    } finally {
      close();
    }
    console.log(`golden: ${Object.keys(GOLDEN).length} cases, ${differences.length} mismatches`);
    assert.deepEqual(differences, []);
  });
});
