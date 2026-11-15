import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Refusal } from "../lib/refusal.ts";
import { RecursionError, TOMLDecodeError, tomlLoads } from "../lib/toml.ts";

const NESTING_PAST_THE_LIMIT = 2000;

describe("tomllib port accepts and refuses what tomllib did", () => {
  it("raises TOMLDecodeError with the position tomllib reported", () => {
    assert.throws(() => tomlLoads("a = 1\nb = $"), (error: unknown) =>
      error instanceof TOMLDecodeError && error.message === "Invalid value (at line 2, column 5)");
  });

  it("quotes the offending character in JSON form", () => {
    assert.throws(() => tomlLoads('a = "x\u0001y"'), (error: unknown) =>
      error instanceof TOMLDecodeError && error.message === 'Illegal character "\\u0001" (at line 1, column 7)');
  });

  it("refuses a document with an integer of more than 4300 digits and accepts 4300", () => {
    assert.throws(() => tomlLoads("x = " + "1".repeat(4301)), Refusal);
    assert.equal(tomlLoads("x = " + "1".repeat(4300)).get("x"), BigInt("1".repeat(4300)));
  });
});

describe("TOML nesting", () => {
  it("makes the TOML recursion failure a crash, not a refusal", () => {
    assert.ok(!(new RecursionError() instanceof Refusal));
    assert.throws(() => tomlLoads("a = " + "[".repeat(NESTING_PAST_THE_LIMIT) + "]".repeat(NESTING_PAST_THE_LIMIT) + "\n"), RecursionError);
  });
});
