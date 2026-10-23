import { writeSync } from "node:fs";
import { codePointLength, getField, isRecord, isTruthy, pythonJsonDumps, pythonStr, truncate } from "./pycompat.ts";

export const EXIT_PASS = 0;
export const EXIT_DENY = 2;
export const MESSAGE_LIMIT = 2000;
export const LIST_LIMIT = 10;
export const RUN_YOURSELF = "Run it yourself in your terminal: ";
export const ASK_USER = "Stop and ask the user.";

const STDOUT = 1;
const STDERR = 2;

export type Payload = Record<string, unknown>;
export type Bullet = readonly [ruleId: string, text: string];

export function toolName(payload: Payload): string {
  const name = getField(payload, "tool_name");
  return pythonStr(isTruthy(name) ? name : "").toLowerCase();
}

export function toolInput(payload: Payload): Payload {
  const value = getField(payload, "tool_input");
  return isRecord(value) ? value : {};
}

export function isSubagent(payload: Payload): boolean {
  return isTruthy(getField(payload, "agent_id"));
}

export function formatMessage(hook: string, summary: string, bullets: readonly Bullet[], nextStep: string = ASK_USER): string {
  const message = buildMessage(hook, summary, bullets) + "\n" + nextStep;
  if (codePointLength(message) <= MESSAGE_LIMIT) return message;
  const split = message.lastIndexOf("\n");
  const body = message.slice(0, split);
  const last = message.slice(split + 1);
  return truncate(body, MESSAGE_LIMIT - codePointLength(last) - 2) + "…\n" + last;
}

export function formatWarning(hook: string, summary: string, bullets: readonly Bullet[]): string {
  const message = buildMessage(hook, summary, bullets);
  return codePointLength(message) <= MESSAGE_LIMIT ? message : truncate(message, MESSAGE_LIMIT - 1) + "…";
}

function buildMessage(hook: string, summary: string, bullets: readonly Bullet[]): string {
  const firstId = bullets[0]?.[0] ?? hook;
  return [`[${firstId}] ${hook}: ${summary}`, ...bullets.map(([ruleId, text]) => `- [${ruleId}] ${text}`)].join("\n");
}

export function runYourself(command: string): string {
  return RUN_YOURSELF + command;
}

export function listed(items: readonly unknown[]): string {
  let shown = items.slice(0, LIST_LIMIT).map(pythonStr).join(", ");
  if (items.length > LIST_LIMIT) shown += `, …and ${items.length - LIST_LIMIT} more`;
  return shown;
}

export function deny(message: string): number {
  writeAll(STDERR, message + "\n");
  return EXIT_DENY;
}

export function warn(event: string, message: string): number {
  printJson({ hookSpecificOutput: { hookEventName: event, additionalContext: message } });
  return EXIT_PASS;
}

export function blockStop(message: string): number {
  printJson({ decision: "block", reason: message });
  return EXIT_PASS;
}

export function rewriteInput(updatedInput: Payload, note: string): number {
  printJson({
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput },
    systemMessage: note,
    suppressOutput: true,
  });
  return EXIT_PASS;
}

function printJson(value: unknown): void {
  writeAll(STDOUT, pythonJsonDumps(value) + "\n");
}

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(descriptor, bytes, written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}
