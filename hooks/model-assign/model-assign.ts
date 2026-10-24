import { dataDir } from "../lib/hookkit/env.ts";
import { FireLog } from "../lib/hookkit/fires.ts";
import { getField, isTruthy, joinPath, PY_SPACE, PY_WORD, pythonStr } from "../lib/hookkit/pycompat.ts";
import { readFileSync } from "node:fs";
import { isFile } from "../lib/hookkit/files.ts";
import { parsePayload } from "../lib/hookkit/pyjson.ts";
import { describeError, readStdin, RecursionError, ValueError } from "../lib/hookkit/pyruntime.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";

const HOOK = "model-assign";
const RULE = "C-dispatch";
const FORK_TYPE = "fork";
const READ_ONLY_TYPES: ReadonlySet<string> = new Set(["explore"]);
const WORD_START = `(?<![${PY_WORD}])`;
const WORD_END = `(?![${PY_WORD}])`;
const JUDGMENT_RE = new RegExp(`${WORD_START}(?:VERDICT|NEEDS_FIXES|review-lenses)${WORD_END}`, "u");
const REQUIRED_SCRIPT_OPTIONS: ReadonlyArray<readonly [string, RegExp]> = ["model", "effort"].map((key) => [
  key, new RegExp(`${WORD_START}${key}${WORD_END}["']?[${PY_SPACE}]*:`, "u"),
]);
const EFFORT_PIN_RE = new RegExp(`(?<![^\\n])effort[${PY_SPACE}]*:`);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const OPUS = "opus";
const SONNET = "sonnet";
const HAIKU = "haiku";
const ABOVE_BAND = "fable";
const WORKFLOW_GUIDE =
  "Set opts per agent: model 'haiku' for read-only census or probing, 'sonnet' for implementation, " +
  "'opus' for review or judgment, 'fable' only for long unattended orchestration; effort 'medium' " +
  "for census and implementation, 'high' for review. Any explicit value passes.";

type Choice = readonly [value: string, why: string];

function main(): number {
  let payload: Payload;
  try {
    payload = parsePayload(readStdin());
  } catch (error) {
    if (error instanceof ValueError) return protocol.EXIT_PASS;
    if (!(error instanceof RecursionError)) throw error;
    new FireLog(HOOK, null).append(RULE, "error", { detail: describeError(error) });
    return protocol.EXIT_PASS;
  }
  const fires = new FireLog(HOOK, getField(payload, "session_id") as string | null);
  try {
    return assignDispatch(payload, fires);
  } catch (error) {
    fires.append(RULE, "error", { detail: describeError(error) });
    return protocol.EXIT_PASS;
  }
}

function assignDispatch(payload: Payload, fires: FireLog): number {
  const name = protocol.toolName(payload);
  const toolArgs = protocol.toolInput(payload);
  if (name === "workflow") return checkWorkflowScript(toolArgs, fires);
  if (name !== "agent" && name !== "task") return protocol.EXIT_PASS;
  const agentType = textOf(toolArgs, "subagent_type").toLowerCase();
  const judgment = JUDGMENT_RE.test(`${textOf(toolArgs, "prompt")} ${textOf(toolArgs, "description")}`);
  const choices: Array<[string, Choice | null]> = agentType === FORK_TYPE ? [] : [
    ["model", resolveModel(getField(toolArgs, "model"), agentType, judgment)],
    ["effort", resolveEffort(getField(toolArgs, "effort"), agentType, judgment)],
  ];
  const assigned = choices.flatMap(([key, choice]) => (choice ? [[key, choice] as const] : []));
  if (assigned.length === 0) {
    fires.append(RULE, "pass");
    return protocol.EXIT_PASS;
  }
  const note = assigned.map(([key, [value, why]]) => `${key} -> ${value} (${why})`).join(", ");
  fires.append(RULE, "record", { detail: note });
  const values = Object.fromEntries(assigned.map(([key, [value]]) => [key, value]));
  return protocol.rewriteInput({ ...toolArgs, ...values }, note);
}

function textOf(toolArgs: Payload, key: string): string {
  return textValue(getField(toolArgs, key));
}

function textValue(value: unknown): string {
  return pythonStr(isTruthy(value) ? value : "");
}

function resolveModel(model: unknown, agentType: string, judgment: boolean): Choice | null {
  const named = textValue(model).toLowerCase();
  const tier = [OPUS, SONNET, HAIKU, ABOVE_BAND].find((candidate) => named.includes(candidate));
  if (tier === OPUS || tier === SONNET) return null;
  if (tier === ABOVE_BAND) return [OPUS, "ceiling"];
  if (judgment) return [OPUS, "judgment marker"];
  const readOnly = READ_ONLY_TYPES.has(agentType);
  if (tier === HAIKU) return readOnly ? null : [SONNET, "floor"];
  return readOnly ? [HAIKU, "read-only type"] : [SONNET, "default"];
}

function resolveEffort(effort: unknown, agentType: string, judgment: boolean): Choice | null {
  if (isTruthy(effort) || typePinsEffort(agentType)) return null;
  return judgment ? ["high", "judgment marker"] : ["medium", "default"];
}

function checkWorkflowScript(toolArgs: Payload, fires: FireLog): number {
  if (isTruthy(getField(toolArgs, "resumeFromRunId"))) return protocol.EXIT_PASS;
  const script = workflowScript(toolArgs);
  if (!script || !script.includes("agent(")) return protocol.EXIT_PASS;
  const missing = REQUIRED_SCRIPT_OPTIONS.filter(([, pattern]) => !pattern.test(script)).map(([key]) => key);
  if (missing.length === 0) {
    fires.append(RULE, "pass");
    return protocol.EXIT_PASS;
  }
  fires.append(RULE, "deny", { detail: `workflow script names no ${missing.join("/")}` });
  let text = `The agent() calls name no opts.${missing.join(" / opts.")}, so every agent inherits main's. ${WORKFLOW_GUIDE}`;
  const scriptPath = getField(toolArgs, "scriptPath");
  if (isTruthy(scriptPath)) text += ` Edit ${pythonStr(scriptPath)} and invoke it again.`;
  return protocol.deny(protocol.formatMessage(HOOK, "workflow agents need a model and an effort", [[RULE, text]]));
}

function typePinsEffort(agentType: string): boolean {
  const path = joinPath(dataDir(), "agents", `${agentType}.md`);
  if (!agentType || !isFile(path)) return false;
  const frontmatter = FRONTMATTER_RE.exec(readFileSync(path, "utf8"));
  return frontmatter !== null && EFFORT_PIN_RE.test(frontmatter[1] ?? "");
}

function workflowScript(toolArgs: Payload): string | null {
  const script = getField(toolArgs, "script");
  const scriptPath = getField(toolArgs, "scriptPath");
  if (typeof script === "string") return script;
  if (typeof scriptPath !== "string" || !isFile(scriptPath)) return null;
  return readFileSync(scriptPath, "utf8");
}

if (import.meta.main) process.exitCode = main();
