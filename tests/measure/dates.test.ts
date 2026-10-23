import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { addDays, compactUtcSeconds, parseIsoDate, utcSeconds } from "../../measure/lib/measurekit/dates.ts"

const RECORDED_SHAPES: [string, string | null][] = [
  ["2026-01-05", "2026-01-05"], ["2026-1-5", "2026-01-05"], ["2026-02-30", null], ["2024-02-29", "2024-02-29"], ["2023-02-29", null],
  ["0001-01-01", "0001-01-01"], ["0000-01-01", null], ["2026-13-01", null], ["2026-12-32", null], ["2026-12-31 ", null], [" 2026-12-31", null],
  ["26-01-05", null], ["2026/01/05", null], ["yesterday", null], ["", null], ["2026-01-5x", null], ["2026-00-10", null], ["2026-10-00", null],
  ["9999-12-31", "9999-12-31"], ["2026-04-31", null],
]

describe("dates", () => {
  it("parseIsoDate_acceptsYearMonthDayWithOneOrTwoDigitParts_andRejectsImpossibleDates", () => {
    assert.deepEqual(RECORDED_SHAPES.map(([text]) => parseIsoDate(text)), RECORDED_SHAPES.map(([, parsed]) => parsed))
  })

  it("parseIsoDate_rejectsDigitsOutsideAsciiAndASpacePaddedDay", () => {
    assert.deepEqual([parseIsoDate("\uff12\uff10\uff12\uff16-01-05"), parseIsoDate("2026-12- 1")], [null, null])
  })

  it("addDays_crossesMonthYearAndLeapDayEdges", () => {
    assert.deepEqual([addDays("2026-01-05", -60), addDays("2024-02-28", 1), addDays("2025-12-31", 1)], ["2025-11-06", "2024-02-29", "2026-01-01"])
  })

  it("utcSeconds_dropsMilliseconds_andTheCompactFormDropsSeparators", () => {
    const moment = new Date("2026-10-23T04:05:06.789Z")
    assert.deepEqual([utcSeconds(moment), compactUtcSeconds(moment)], ["2026-10-23T04:05:06Z", "20261023T040506Z"])
  })
})
