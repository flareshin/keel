import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ccVersion } from "../../hooks/lib/hookkit/contract.ts";
import { FieldTypeError, isNonEmptyString, jsonTypeName, textField, textOrEmpty } from "../../hooks/lib/hookkit/fields.ts";
import { FireLog } from "../../hooks/lib/hookkit/fires.ts";
import * as protocol from "../../hooks/lib/hookkit/protocol.ts";
import { roleOf } from "../../hooks/lib/hookkit/transcript.ts";
import { Sandbox, withEnv } from "./helpers.ts";

const NOT_TEXT: Array<[label: string, value: unknown, typeName: string]> = [
  ["object", { k: "v" }, "object"], ["empty object", {}, "object"], ["list", ["x"], "list"], ["empty list", [], "list"],
  ["number", 5, "number"], ["zero", 0, "number"], ["true", true, "boolean"], ["false", false, "boolean"],
];

describe("jsonTypeName", () => {
  it("names_everyJsonType_byTheWordsAPayloadAuthorUses", () => {
    assert.deepEqual([null, undefined, true, 1, "s", [], {}].map(jsonTypeName), ["null", "null", "boolean", "number", "string", "list", "object"]);
  });
});

describe("textOrEmpty", () => {
  it("reads_absentAndNullAndEmptyTextAsEmpty_andTextAsItself", () => {
    assert.deepEqual([null, undefined, "", "a"].map((value) => textOrEmpty(value, "field")), ["", "", "", "a"]);
  });

  for (const [label, value, typeName] of NOT_TEXT) {
    it(`raises_aFieldTypeErrorNamingTheField_for_${label.replace(" ", "_")}`, () => {
      assert.throws(
        () => textOrEmpty(value, "command"),
        (error: Error) => error instanceof FieldTypeError && error instanceof TypeError && error.name === "FieldTypeError"
          && error.message === `command must be a string, not ${typeName}`,
      );
    });
  }
});

describe("textField", () => {
  it("reads_aMissingKeyAsEmpty_andAnInheritedKeyAsMissing", () => {
    assert.equal(textField({}, "command"), "");
    assert.equal(textField(Object.create({ command: "inherited" }) as Record<string, unknown>, "command"), "");
    assert.equal(textField({ command: "ls" }, "command"), "ls");
  });
});

describe("isNonEmptyString", () => {
  it("accepts_onlyTextWithAtLeastOneCharacter", () => {
    assert.deepEqual(["a", " ", "", null, 0, true, ["a"], { a: 1 }].map(isNonEmptyString), [true, true, false, false, false, false, false, false]);
  });
});

describe("protocol readers of wrong-typed payload fields", () => {
  it("toolName_readsATextNameInLowerCase_andAnythingElseAsNoTool", () => {
    assert.equal(protocol.toolName({ tool_name: "MultiEdit" }), "multiedit");
    for (const [, value] of [...NOT_TEXT, ["null", null, "null"] as const]) assert.equal(protocol.toolName({ tool_name: value }), "");
    assert.equal(protocol.toolName({}), "");
  });

  it("cwdOrProcessDirectory_usesTheProcessDirectory_unlessTheCwdIsNonEmptyText", () => {
    assert.equal(protocol.cwdOrProcessDirectory({ cwd: "/w" }), "/w");
    for (const [, value] of [...NOT_TEXT, ["empty string", "", "string"] as const, ["null", null, "null"] as const]) {
      assert.equal(protocol.cwdOrProcessDirectory({ cwd: value }), process.cwd());
    }
    assert.equal(protocol.cwdOrProcessDirectory({}), process.cwd());
  });

  it("isSubagent_isTrueOnlyForANonEmptyTextAgentId", () => {
    assert.equal(protocol.isSubagent({ agent_id: "a1" }), true);
    for (const [, value] of [...NOT_TEXT, ["empty string", "", "string"] as const]) assert.equal(protocol.isSubagent({ agent_id: value }), false);
  });
});

describe("roleOf", () => {
  it("fallsBackToTheEntryType_forAnEmptyOrAbsentRole", () => {
    assert.equal(roleOf({ type: "user", message: { role: "" } }), "user");
    assert.equal(roleOf({ type: "assistant", message: { role: null } }), "assistant");
    assert.equal(roleOf({ type: "assistant" }), "assistant");
    assert.equal(roleOf({ type: "user", message: { role: "assistant" } }), "assistant");
  });

  for (const [label, value, typeName] of NOT_TEXT) {
    it(`raises_whenTheRoleIs_${label.replace(" ", "_")}`, () => {
      assert.throws(() => roleOf({ type: "assistant", message: { role: value } }), (error: Error) => error instanceof FieldTypeError && error.message === `message.role must be a string, not ${typeName}`);
    });
  }
});

describe("FireLog with fields of the wrong type", () => {
  function fireLines(sandbox: Sandbox): Array<Record<string, unknown>> {
    const text = readFileSync(join(sandbox.data, "logs", "keel-fires.jsonl"), "utf8");
    return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("labelsAFireWithADashWhenTheSessionIsNotNonEmptyText", () => {
    const sandbox = new Sandbox();
    try {
      withEnv({ KEEL_DATA_DIR: sandbox.data }, () => {
        for (const session of [5, true, ["s"], { k: "v" }, 0, false, "", null, undefined]) new FireLog("h", session as string).append("K1", "pass");
        new FireLog("h", "real").append("K1", "pass");
      });
      assert.deepEqual(fireLines(sandbox).map((line) => line["session"]), [...Array<string>(9).fill("-"), "real"]);
    } finally {
      sandbox.close();
    }
  });

  it("raisesForADetailThatIsNotText_andKeepsTheOtherFieldsAsTheyAre", () => {
    const sandbox = new Sandbox();
    try {
      withEnv({ KEEL_DATA_DIR: sandbox.data }, () => {
        assert.throws(() => new FireLog("h", "s").append("K1", "deny", { detail: 5 }), (error: Error) => error instanceof FieldTypeError && error.message === "detail must be a string, not number");
        new FireLog("h", "s").append("K1", "deny", { repo: "acme/app", detail: "x", head: 3 });
      });
      assert.deepEqual(fireLines(sandbox).map(({ repo, detail, head }) => [repo, detail, head]), [["acme/app", "x", 3]]);
    } finally {
      sandbox.close();
    }
  });
});

describe("ccVersion with a session of the wrong type", () => {
  it("namesTheCacheAfterADash_whenTheSessionIsNotNonEmptyText", () => {
    const sandbox = new Sandbox();
    try {
      const claude = sandbox.stubClaude("3.4.5");
      withEnv({ KEEL_DATA_DIR: sandbox.data, PATH: claude }, () => {
        for (const [, session] of [...NOT_TEXT, ["empty string", "", "string"] as const]) assert.equal(ccVersion(session), "3.4.5");
      });
      assert.equal(readFileSync(join(sandbox.data, "state", "keel", "sessions", "-.cc-version"), "utf8"), "3.4.5");
    } finally {
      sandbox.close();
    }
  });
});
