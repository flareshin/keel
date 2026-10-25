import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { boundaries } from "./boundary-table.ts";

const RECORDED = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "tests", "fixtures", "codex", "boundary-recorded.json"), "utf8")) as Record<string, string>;
const PASSED = "pass, guard calls 2";
const PASSED_ONE_GUARD = "pass, guard calls 1";
const NON_NUMBER_WORDS = "NaN|Infinity|-Infinity";
const NON_STRING_CWD_LITERALS = "9007199254740991|9007199254740992|9007199254740993|-9007199254740993|12345678901234567890|1e400|-1e400|1E400|1\\.0|100\\.0|1e16|1x4300|1x4301\\.0|1x4301e0";
const EXPECTED_CHANGES = 65;

interface Change {
  reason: string;
  keys: RegExp;
  was: string;
  now: string;
}

const CHANGES: Change[] = [
  { reason: "a truthy cwd that is not a string is refused instead of becoming a directory name", keys: new RegExp(`^hook numbers/cwd (${NON_STRING_CWD_LITERALS})$`), was: PASSED, now: "deny" },
  { reason: "a truthy cwd that is not a string is refused instead of becoming a directory name", keys: /^hook working directory\/cwd (true|a list of zero|an object with a member|a number)$/, was: PASSED, now: "deny" },
  { reason: "a cwd that is zero, false, an empty list or an empty object is refused instead of reading as no cwd", keys: /^hook numbers\/cwd (0\.0|-0\.0|1e-400)$/, was: PASSED, now: "deny" },
  { reason: "a cwd that is zero, false, an empty list or an empty object is refused instead of reading as no cwd", keys: /^hook working directory\/cwd (an empty list|an empty object|false|zero)$/, was: PASSED, now: "deny" },
  { reason: "NaN, Infinity and -Infinity are not JSON: the hook payload is refused", keys: new RegExp(`^hook numbers/(extra field|list of|cwd) (${NON_NUMBER_WORDS})( beside a force push)?$`), was: PASSED, now: "deny" },
  { reason: "stdin that is not valid UTF-8 is refused instead of decoded with surrogateescape", keys: /^hook bytes\/invalid UTF-8 .* in a command$/, was: PASSED, now: "deny" },
  { reason: "a state file holding NaN, Infinity or -Infinity is refused", keys: new RegExp(`^state file/member (${NON_NUMBER_WORDS})$`), was: "accepted", now: "refused" },
  { reason: "guard output that is not JSON is refused with the parser's own wording", keys: /^guard output\/stdout of only U\+(FEFF|0000)$/, was: "refused", now: "refused invalid JSON" },
  { reason: "a path holding a surrogate escape byte is refused instead of read as a raw byte", keys: /^write targets\/write to surrogate escape byte/, was: PASSED_ONE_GUARD, now: "deny" },
  { reason: "a symlink whose target is not valid UTF-8 is refused instead of read with surrogate escapes", keys: /^write targets\/write to (symlink|name below a symlink) whose target is not valid UTF-8$/, was: PASSED_ONE_GUARD, now: "deny" },
  { reason: "an option prefix is no longer expanded", keys: /^command line\/(link abbreviated (write|home|help)|config abbreviated help)$/, was: "exit 0", now: "exit 2" },
  { reason: "an option prefix is no longer expanded", keys: /^command line\/config abbreviated (file|profile with equals)$/, was: "exit 3", now: "exit 2" },
  { reason: "stacked short options are no longer expanded", keys: /^command line\/(link|config) (stacked short help|short help with a stray letter)$/, was: "exit 0", now: "exit 2" },
  { reason: "a number-like option value is ambiguous to parseArgs", keys: /^command line\/link home negative number then check$/, was: "exit 1", now: "exit 2" },
  { reason: "help is honoured wherever it appears among the arguments", keys: /^command line\/link write check and help$/, was: "exit 2", now: "exit 0" },
];

function changeFor(key: string): Change | undefined {
  return CHANGES.find((change) => change.keys.test(key));
}

function wasOf(key: string): string {
  return (RECORDED[key] as string).replace(/^refused .*/, "refused");
}

describe("input boundaries", () => {
  it("probes_everyRecordedBoundary_exactlyOnce", () => {
    const { boundaries: list, close } = boundaries();
    try {
      const keys = list.flatMap((boundary) => boundary.probes.map((probe) => `${boundary.name}/${probe.label}`));
      assert.deepEqual(keys.slice().sort(), Object.keys(RECORDED).sort());
    } finally {
      close();
    }
  });

  it("lists_eachChange_againstTheRecordedOutcomeItReplaces", () => {
    const changed = Object.keys(RECORDED).filter((key) => changeFor(key) !== undefined);
    assert.equal(changed.length, EXPECTED_CHANGES);
    for (const change of CHANGES) {
      assert.ok(Object.keys(RECORDED).some((key) => change.keys.test(key)), `no recorded probe matches: ${change.reason}`);
    }
    for (const key of changed) {
      const change = changeFor(key) as Change;
      assert.equal(wasOf(key), change.was, `${key}: ${change.reason}`);
      assert.notEqual(change.now, change.was, key);
    }
  });

  it("observes_theRecordedOutcome_everywhereExceptTheListedChanges", () => {
    const { boundaries: list, close } = boundaries();
    const differences: string[] = [];
    try {
      for (const boundary of list) {
        for (const probe of boundary.probes) {
          const key = `${boundary.name}/${probe.label}`;
          const expected = changeFor(key)?.now ?? RECORDED[key];
          const now = probe.observe();
          if (now !== expected) differences.push(`${key}\n    expected: ${expected}\n    now:      ${now}`);
        }
      }
    } finally {
      close();
    }
    console.log(`boundary probes: ${Object.keys(RECORDED).length}, listed changes: ${EXPECTED_CHANGES}, unexpected differences: ${differences.length}`);
    assert.deepEqual(differences, []);
  });
});
