import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_EDIT_TOOLS } from "../../hooks/lib/hookkit/protocol.ts";

export const FIXTURE_DIRECTORY = join(import.meta.dirname, "fixtures", "harness-contract");
export const BRIEF = "{{BRIEF}}";
export const REPORT = "{{REPORT}}";
export const EDIT_PATH = "{{EDIT_PATH}}";

const SCRUBBED = "x";
const KEPT_STRING_KEYS = new Set(["type", "role", "version", "userType", "entrypoint", "renderedRole", "stop_reason"]);
const NAMED_BLOCKS = new Set(["tool_use", "server_tool_use"]);
const OPAQUE_KEYS = new Set(["input", "toolUseResult", "wireToolInputs"]);
const EDIT_PATH_KEYS = new Set(["file_path", "notebook_path"]);
const HANDBACK_TOOL = "SubagentHandback";
const TOOL_USE_ID_KEY = /^toolu_/;
const MCP_SERVER_ID = /^mcp__[^_]+(?:_[^_]+)*?__/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

export interface Fixture {
  name: string;
  version: string;
  text: string;
}

export function scrubTranscript(raw: string): string {
  const entries = raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as JsonRecord);
  const briefIndex = entries.findIndex((entry) => entry["type"] === "user");
  const lastToolUse = entries.findLastIndex((entry) => entry["type"] === "assistant" && blocksOf(entry).some((block) => block["type"] === "tool_use"));
  const finalText = { placed: false };
  return entries.map((entry, index) => {
    if (index === briefIndex) return JSON.stringify(scrubBrief(entry));
    if (entry["type"] === "assistant" && index > lastToolUse) return JSON.stringify(scrubFinal(entry, finalText));
    return JSON.stringify(scrub(entry, ""));
  }).join("\n") + "\n";
}

export function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIRECTORY).filter((file) => file.endsWith(".jsonl")).sort().map((file) => {
    const text = readFileSync(join(FIXTURE_DIRECTORY, file), "utf8");
    return { name: file.slice(0, -".jsonl".length), version: versionOf(text), text };
  });
}

export function versionOf(text: string): string {
  const versions = new Set(text.split("\n").filter((line) => line !== "").map((line) => (JSON.parse(line) as JsonRecord)["version"]).filter((version) => typeof version === "string"));
  if (versions.size !== 1) throw new Error(`a harness-contract fixture must carry exactly one harness version, not ${JSON.stringify([...versions])}`);
  return [...versions][0] as string;
}

export function filled(fixture: Fixture, values: { brief: string; report: string; editPath?: string }): string {
  return fixture.text.split("\n").map((line) => line
    .replaceAll(JSON.stringify(BRIEF), JSON.stringify(values.brief))
    .replaceAll(JSON.stringify(REPORT), JSON.stringify(values.report))
    .replaceAll(JSON.stringify(EDIT_PATH), JSON.stringify(values.editPath ?? "/nowhere"))).join("\n");
}

function blocksOf(entry: JsonRecord): JsonRecord[] {
  const message = entry["message"];
  const content = isRecord(message) ? message["content"] : null;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function scrubBrief(entry: JsonRecord): JsonRecord {
  const scrubbed = scrub(entry, "") as JsonRecord;
  const message = scrubbed["message"];
  if (!isRecord(message)) return scrubbed;
  if (typeof message["content"] === "string") message["content"] = BRIEF;
  const firstText = blocksOf(scrubbed).find((block) => block["type"] === "text");
  if (firstText !== undefined) firstText["text"] = BRIEF;
  return scrubbed;
}

function scrubFinal(entry: JsonRecord, finalText: { placed: boolean }): JsonRecord {
  const scrubbed = scrub(entry, "") as JsonRecord;
  for (const block of blocksOf(scrubbed)) {
    if (block["type"] !== "text") continue;
    block["text"] = finalText.placed ? "" : REPORT;
    finalText.placed = true;
  }
  return scrubbed;
}

function scrub(value: Json, key: string, opaque = false): Json {
  if (typeof value === "string") return !opaque && KEPT_STRING_KEYS.has(key) ? value : SCRUBBED;
  if (Array.isArray(value)) return value.map((item) => scrub(item, "", opaque));
  if (!isRecord(value)) return value;
  const scrubbed: JsonRecord = {};
  Object.entries(value).forEach(([field, item], index) => {
    scrubbed[TOOL_USE_ID_KEY.test(field) ? `toolu_${index}` : field] = scrub(item, field, opaque || OPAQUE_KEYS.has(field));
  });
  if (NAMED_BLOCKS.has(String(value["type"])) && typeof value["name"] === "string") {
    scrubbed["name"] = value["name"].replace(MCP_SERVER_ID, "mcp__server__");
    scrubbed["input"] = scrubToolInput(value["name"], value["input"] ?? null, scrubbed["input"] ?? null);
  }
  return scrubbed;
}

function scrubToolInput(name: string, input: Json, scrubbed: Json): Json {
  if (!isRecord(input) || !isRecord(scrubbed)) return scrubbed;
  if (name === HANDBACK_TOOL && "message" in input) scrubbed["message"] = REPORT;
  if (FILE_EDIT_TOOLS.has(name.toLowerCase())) {
    for (const field of Object.keys(input)) if (EDIT_PATH_KEYS.has(field)) scrubbed[field] = EDIT_PATH;
  }
  return scrubbed;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
