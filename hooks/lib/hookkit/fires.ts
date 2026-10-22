import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dataDir } from "./env.ts";
import { isSystemError, joinPath, pythonJsonDumps, pythonStr, truncate } from "./pycompat.ts";

export const DETAIL_LIMIT = 200;

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class FireLog {
  readonly hook: string;
  readonly session: string;

  constructor(hook: string, session: string | null | undefined) {
    this.hook = hook;
    this.session = session || "-";
  }

  append(ruleId: string, outcome: string, optional: Record<string, unknown> = {}): void {
    const record: Record<string, unknown> = {
      ts: utcNow(), rule_id: ruleId, hook: this.hook, outcome, session: this.session,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value === null || value === undefined) continue;
      record[key] = key === "detail" ? truncate(pythonStr(value), DETAIL_LIMIT) : value;
    }
    const path = joinPath(dataDir(), "logs", "keel-fires.jsonl");
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, pythonJsonDumps(record) + "\n", "utf8");
    } catch (error) {
      if (!isSystemError(error)) throw error;
      process.stderr.write(`${this.hook}: could not append keel-fires.jsonl (${describeError(error)})\n`);
    }
  }
}

function describeError(error: unknown): string {
  return `${(error as Error).name}(${(error as Error).message})`;
}
