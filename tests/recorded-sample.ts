import { isJsonObject } from "../measure/lib/measurekit/json.ts";

export const FIRES_LOG_NAME = "keel-fires.jsonl";
const HEX_HASH = /\b[0-9a-f]{7,40}\b/g;
const HASH_MASK = "<hash>";
const COMPACT_TIMESTAMP = /\d{8}T\d{6}Z/g;
const TIMESTAMP_MASK = "<timestamp>";
const RETRY_HINT_PREFIX = "Run it yourself";
const FIRES_TAIL_LINES = 2;
const FIRES_FIELDS = ["hook", "outcome", "rule_id", "detail"] as const;

export function masked(text: string): string {
  return text.replace(COMPACT_TIMESTAMP, TIMESTAMP_MASK).replace(HEX_HASH, HASH_MASK);
}

export function stderrReasons(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line !== "" && !line.startsWith(RETRY_HINT_PREFIX)).map(masked);
}

export function firesTail(written: Record<string, string>): string[][] {
  return Object.entries(written)
    .filter(([path]) => path.endsWith(FIRES_LOG_NAME))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, content]) => content.split("\n").filter((line) => line !== "").slice(-FIRES_TAIL_LINES).map(firesSummary));
}

function firesSummary(line: string): string[] {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return [masked(line)];
  }
  if (!isJsonObject(record)) return [masked(line)];
  return FIRES_FIELDS.map((field) => masked(String(record[field] ?? "")));
}
