import { describeError } from "../lib/hookkit/errors.ts";
import { getField, isRecord } from "../lib/hookkit/fields.ts";
import { FireLog } from "../lib/hookkit/fires.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";
import { writeStderr } from "../lib/hookkit/stdio.ts";
import { contentOf, iterEntries } from "../lib/hookkit/transcript.ts";
import type { Entry } from "../lib/hookkit/transcript.ts";

const HOOK = "ship-gate";
const RULE = "K1";
const ADVISOR_TOOL = "advisor";
const ADVISOR_ATTACHMENT = "advisor_tool";
const OWNER_ORIGIN = "human";
const SUBSTANTIVE_TOOL_CALLS = 6;
export const CALL_ADVISOR = "Call advisor() now, weigh its advice, then finish the turn.";

interface TurnWork {
  toolCalls: number;
  fileEdits: number;
  advisorCalled: boolean;
}

export function advisorReminder(payload: Payload, session: string): string | null {
  const transcript = getField(payload, "transcript_path");
  if (typeof transcript !== "string") return null;
  let work: TurnWork | null;
  try {
    work = unadvisedTurn(transcript);
  } catch (error) {
    writeStderr(`${HOOK}: advisor call at Stop not judged: ${describeError(error)}\n`);
    return null;
  }
  if (work === null) return null;
  const detail = `${work.toolCalls} tool calls, ${work.fileEdits} file edits`;
  new FireLog(HOOK, session).append(RULE, "block", { detail });
  const summary = `this turn did substantive work (${detail}) without an advisor call`;
  const bullets: protocol.Bullet[] = [[RULE, "The advisor is available in this session and was not called since the owner's latest prompt."]];
  return protocol.formatMessage(HOOK, summary, bullets, CALL_ADVISOR);
}

function unadvisedTurn(transcript: string): TurnWork | null {
  let advisorAvailable = false;
  let turn: TurnWork | null = null;
  for (const entry of iterEntries(transcript)) {
    if (getField(entry, "isSidechain") === true) continue;
    const availability = advisorAvailability(entry);
    if (availability !== null) advisorAvailable = availability;
    if (isOwnerPrompt(entry)) turn = { toolCalls: 0, fileEdits: 0, advisorCalled: false };
    else if (turn !== null && getField(entry, "type") === "assistant") countWork(turn, entry);
  }
  if (!advisorAvailable || turn === null || turn.advisorCalled) return null;
  return turn.fileEdits > 0 || turn.toolCalls >= SUBSTANTIVE_TOOL_CALLS ? turn : null;
}

function advisorAvailability(entry: Entry): boolean | null {
  const attachment = getField(entry, "attachment");
  if (!isRecord(attachment) || getField(attachment, "type") !== ADVISOR_ATTACHMENT) return null;
  return getField(attachment, "available") === true;
}

function isOwnerPrompt(entry: Entry): boolean {
  const origin = getField(entry, "origin");
  return getField(entry, "type") === "user" && isRecord(origin) && getField(origin, "kind") === OWNER_ORIGIN;
}

function countWork(turn: TurnWork, entry: Entry): void {
  const content = contentOf(entry);
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const name = getField(block, "name");
    if (typeof name !== "string") continue;
    const kind = getField(block, "type");
    if (kind === "server_tool_use" && name === ADVISOR_TOOL) turn.advisorCalled = true;
    if (kind !== "tool_use") continue;
    turn.toolCalls += 1;
    if (protocol.FILE_EDIT_TOOLS.has(name.toLowerCase())) turn.fileEdits += 1;
  }
}
