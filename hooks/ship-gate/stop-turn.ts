import { getField, isNonEmptyString } from "../lib/hookkit/fields.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";
import { advisorReminder } from "./stop-advisor.ts";
import { unreadyPushReminder } from "./stop-readiness.ts";

const EVENT = "Stop";
const NO_SESSION = "-";

export function judgeStop(payload: Payload): number {
  if (getField(payload, "stop_hook_active") === true) return protocol.EXIT_PASS;
  const sessionField = getField(payload, "session_id");
  const session = isNonEmptyString(sessionField) ? sessionField : NO_SESSION;
  const pushReminder = unreadyPushReminder(payload, session);
  const advisor = advisorReminder(payload, session);
  if (advisor !== null) return protocol.blockStop(pushReminder === null ? advisor : `${advisor}\n\n${pushReminder}`);
  return pushReminder === null ? protocol.EXIT_PASS : protocol.warn(EVENT, pushReminder);
}
