import { readFileSync } from "node:fs";
import { splitLines } from "../../../measure/lib/measurekit/files.ts";
import { JsonSyntaxError, parseTranscriptLine } from "./json.ts";
import { getField, isRecord, textOrEmpty } from "./fields.ts";
import { trimSpace } from "./text.ts";

export type Entry = Record<string, unknown>;

export function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (isRecord(content)) {
    const text = getField(content, "text");
    if (typeof text === "string") return text;
    if (Object.hasOwn(content, "content")) return textOf(getField(content, "content"));
    if (Object.hasOwn(content, "message")) return textOf(getField(content, "message"));
    return null;
  }
  if (Array.isArray(content)) {
    const chunks = content.flatMap((block: unknown) => {
      if (!isRecord(block) || getField(block, "type") !== "text") return [];
      const text = getField(block, "text");
      return typeof text === "string" ? [text] : [];
    });
    return chunks.join("\n");
  }
  return null;
}

export function* iterEntries(path: string): Generator<Entry> {
  for (const line of splitLines(readFileSync(path, "utf8"))) {
    let entry: unknown;
    try {
      entry = parseTranscriptLine(trimSpace(line));
    } catch (error) {
      if (error instanceof JsonSyntaxError) continue;
      throw error;
    }
    if (isRecord(entry)) yield entry;
  }
}

function messageOf(entry: Entry): Entry {
  const message = getField(entry, "message");
  return isRecord(message) ? message : {};
}

export function roleOf(entry: Entry): unknown {
  const role = textOrEmpty(getField(messageOf(entry), "role"), "message.role");
  return role !== "" ? role : getField(entry, "type");
}

export function contentOf(entry: Entry): unknown {
  return getField(messageOf(entry), "content");
}

export function toolUses(entry: Entry): Entry[] {
  const content = contentOf(entry);
  if (!Array.isArray(content)) return [];
  return content.filter((block: unknown): block is Entry => isRecord(block) && getField(block, "type") === "tool_use");
}

const HANDBACK_TOOL = "subagenthandback";

export function finalReport(path: string): string | null {
  let finalText: string | null = null;
  let handback: string | null = null;
  for (const entry of iterEntries(path)) {
    if (roleOf(entry) !== "assistant") continue;
    const blocks = toolUses(entry);
    if (blocks.length === 0) {
      finalText = withText(finalText, textOf(contentOf(entry)));
      continue;
    }
    finalText = null;
    handback = handbackMessage(blocks[blocks.length - 1] as Entry);
  }
  return finalText ?? handback;
}

function withText(finalText: string | null, text: string | null): string | null {
  if (text === null || trimSpace(text) === "") return finalText;
  return finalText === null ? text : `${finalText}\n${text}`;
}

function handbackMessage(block: Entry): string | null {
  const name = getField(block, "name");
  if (typeof name !== "string" || name.toLowerCase() !== HANDBACK_TOOL) return null;
  const input = getField(block, "input");
  const message = isRecord(input) ? getField(input, "message") : null;
  return typeof message === "string" ? message : null;
}
