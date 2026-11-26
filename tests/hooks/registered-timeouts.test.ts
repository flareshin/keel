import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";
import { KEEL_HOME } from "./helpers.ts";
import { BOUNDARY_TIMEOUT_SECONDS } from "../../hooks/git-guard/git-guard.ts";
import { HOOK_GIT_TIMEOUT_SECONDS } from "../../hooks/lib/hookkit/repo.ts";
import { EVIDENCE_DEADLINE_SECONDS } from "../../hooks/report-gate/report-gate.ts";
import { GH_TIMEOUT_SECONDS } from "../../hooks/ship-gate/ship-gate.ts";
import { FETCH_TIMEOUT_SECONDS, LOCAL_GIT_TIMEOUT_SECONDS } from "../../lib/evidence/gitcmd.ts";
import { iterRegistrations, Registration } from "../../measure/lib/measurekit/hook_settings.ts";

const REGISTRATION_FILES = ["hooks/hooks.json", "settings/core.json"];
const DECISION_MARGIN_SECONDS = 1;

const LONGEST_WAIT_SECONDS: ReadonlyMap<string, number> = new Map([
  ["git-guard", Math.max(BOUNDARY_TIMEOUT_SECONDS, HOOK_GIT_TIMEOUT_SECONDS)],
  ["model-assign", 0],
  ["principles", 0],
  ["report-gate", EVIDENCE_DEADLINE_SECONDS],
  ["ship-gate", Math.max(LOCAL_GIT_TIMEOUT_SECONDS, FETCH_TIMEOUT_SECONDS, GH_TIMEOUT_SECONDS)],
]);

function registrations(file: string): Registration[] {
  return iterRegistrations(JSON.parse(readFileSync(join(KEEL_HOME, file), "utf8")).hooks);
}

describe("RegisteredTimeoutTest", () => {
  for (const file of REGISTRATION_FILES) {
    it(`everyHookIn_${file}_finishesItsLongestWaitBeforeItsRegisteredTimeout`, () => {
      const found = registrations(file);
      assert.ok(found.length > 0, `${file} registers no hook`);
      for (const registration of found) {
        const { event, hookName: hook } = registration;
        const timeout = registration.hook["timeout"];
        const longestWait = LONGEST_WAIT_SECONDS.get(hook);
        assert.notEqual(longestWait, undefined, `${file} ${event}: ${hook} has no entry in LONGEST_WAIT_SECONDS`);
        assert.equal(typeof timeout, "number", `${file} ${event}: ${hook} registers no timeout`);
        assert.ok(longestWait! + DECISION_MARGIN_SECONDS < (timeout as number),
          `${file} ${event}: ${hook} may wait ${longestWait} s against a registered ${timeout} s`);
      }
    });
  }
});
