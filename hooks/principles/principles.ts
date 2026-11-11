import { keelHome, overlayPath } from "../lib/hookkit/env.ts";
import { getField } from "../lib/hookkit/fields.ts";
import { tryReadText } from "../lib/hookkit/files.ts";
import { parsePayload } from "../lib/hookkit/json.ts";
import { joinPath } from "../lib/hookkit/paths.ts";
import { readStdin } from "../lib/hookkit/stdio.ts";
import { describeError, RecursionError, ValueError } from "../lib/hookkit/errors.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";

const INJECTED_EVENTS: ReadonlySet<string> = new Set(["SessionStart", "SubagentStart"]);

function main(): number {
  let payload: Payload;
  try {
    payload = parsePayload(readStdin());
  } catch (error) {
    if (error instanceof ValueError || error instanceof RecursionError) return protocol.EXIT_PASS;
    throw error;
  }
  const event = getField(payload, "hook_event_name");
  if (typeof event !== "string" || !INJECTED_EVENTS.has(event)) return protocol.EXIT_PASS;
  try {
    return protocol.warn(event, principlesContext());
  } catch (error) {
    return protocol.warn(event, notLoaded(describeError(error)));
  }
}

function principlesContext(): string {
  const principlesPath = joinPath(keelHome(), "PRINCIPLES.md");
  const principles = tryReadText(principlesPath);
  if (principles === null) return notLoaded(`${principlesPath} is missing`);
  const personal = tryReadText(overlayPath("PERSONAL.md"));
  const sections = personal === null ? [principles] : [principles, personal];
  return sections.map(withFinalNewline).join("\n");
}

function notLoaded(reason: string): string {
  return `keel principles did not load: ${reason}. Tell the owner before doing any work.`;
}

function withFinalNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

if (import.meta.main) process.exitCode = main();
