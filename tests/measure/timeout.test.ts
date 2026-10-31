import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { refusalMessage } from "../../codex/lib/refusal.ts"
import { run as runHook } from "../../hooks/lib/hookkit/subprocess.ts"
import { runCaptured, runProcessGroup } from "../../lib/evidence/subprocess.ts"
import { runProcess, runProcessAsync } from "../../measure/lib/measurekit/subprocess.ts"
import { TimeoutExpired } from "../../measure/lib/measurekit/timeout.ts"

const SLEEP = ["sleep", "5"]
const SHORT_DEADLINE_SECONDS = 0.05

function thrownBy(call: () => unknown): unknown {
  try {
    call()
  } catch (error) {
    return error
  }
  throw new Error("the call returned without timing out")
}

async function rejectedBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call()
  } catch (error) {
    return error
  }
  throw new Error("the call settled without timing out")
}

describe("TimeoutExpired", () => {
  const expectedTimeouts: [layer: string, raise: () => unknown, message: string][] = [
    ["hookkit run", () => thrownBy(() => runHook(SLEEP, SHORT_DEADLINE_SECONDS)), "Command 'sleep 5' timed out after 0.05 seconds"],
    ["evidence runCaptured", () => thrownBy(() => runCaptured(SLEEP, { timeoutSeconds: SHORT_DEADLINE_SECONDS })), 'Command ["sleep","5"] timed out after 0.05 seconds'],
    ["measurekit runProcess", () => thrownBy(() => runProcess(SLEEP, { timeoutSeconds: SHORT_DEADLINE_SECONDS })), 'command ["sleep","5"] timed out after 0.05 seconds'],
  ]

  for (const [layer, raise, message] of expectedTimeouts) {
    it(`timeoutFrom_${layer.replace(/\W/g, "_")}_isTheSharedClass_andKeepsItsOwnMessage`, () => {
      const error = raise()
      assert.ok(error instanceof TimeoutExpired)
      assert.deepEqual([error.name, error.message, error.timeoutSeconds, error.partialStdout], ["TimeoutExpired", message, SHORT_DEADLINE_SECONDS, ""])
      assert.equal(refusalMessage(error), message)
    })
  }

  it("asyncTimeoutsFromEvidenceAndMeasurekit_areTheSharedClass", async () => {
    const errors = [
      await rejectedBy(() => runProcessGroup(SLEEP, { timeoutSeconds: SHORT_DEADLINE_SECONDS })),
      await rejectedBy(() => runProcessAsync(SLEEP, { timeoutSeconds: SHORT_DEADLINE_SECONDS })),
    ]
    assert.deepEqual(errors.map((error) => error instanceof TimeoutExpired), [true, true])
    assert.deepEqual(errors.map((error) => refusalMessage(error)), errors.map((error) => (error as Error).message))
  })
})
