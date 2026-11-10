import { dataDir } from "../lib/hookkit/env.ts";
import { FireLog } from "../lib/hookkit/fires.ts";
import { getField, isNonEmptyString, textField } from "../lib/hookkit/fields.ts";
import { joinPath } from "../lib/hookkit/paths.ts";
import { SPACE_CHARS, WORD_CHARS } from "../lib/hookkit/text.ts";
import { readFileSync } from "node:fs";
import { isFile } from "../lib/hookkit/files.ts";
import { parsePayload } from "../lib/hookkit/json.ts";
import { describeError, RecursionError, ValueError } from "../lib/hookkit/errors.ts";
import { readStdin } from "../lib/hookkit/stdio.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";

const HOOK = "model-assign";
const RULE = "C-dispatch";
const FORK_TYPE = "fork";
const READ_ONLY_TYPES: ReadonlySet<string> = new Set(["explore"]);
const WORD_START = `(?<![${WORD_CHARS}])`;
const WORD_END = `(?![${WORD_CHARS}])`;
const JUDGMENT_RE = new RegExp(`${WORD_START}(?:VERDICT|NEEDS_FIXES|review-lenses)${WORD_END}`, "u");
const REQUIRED_SCRIPT_OPTIONS: ReadonlyArray<readonly [string, RegExp]> = ["model", "effort"].map((key) => [
  key, new RegExp(`${WORD_START}${key}${WORD_END}["']?[${SPACE_CHARS}]*:`, "u"),
]);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const OPUS = "opus";
const SONNET = "sonnet";
const HAIKU = "haiku";
const ABOVE_BAND = "fable";
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "multiedit", "write", "notebookedit"]);
const PLAIN_TOOL_LIST_RE = /^[\w*:.()-]+(?:[\s,]+[\w*:.()-]+)*$/u;
const WORKFLOW_GUIDE =
  "Set opts per agent: model 'haiku' for read-only census or probing, 'sonnet' for implementation, " +
  "'opus' for review or judgment, 'fable' only for long unattended orchestration; effort 'medium' " +
  "for census and implementation, 'high' for review. Any explicit value passes.";

type Choice = readonly [value: string, why: string];

type AgentFile = { readonly model: string; readonly pinsEffort: boolean; readonly canEdit: boolean };

const NO_AGENT_FILE: AgentFile = { model: "", pinsEffort: false, canEdit: true };

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
  const agentType = textField(toolArgs, "subagent_type").toLowerCase();
  const judgment = JUDGMENT_RE.test(`${textField(toolArgs, "prompt")} ${textField(toolArgs, "description")}`);
  const agentFile = readAgentFile(agentType);
  const namedModel = textField(toolArgs, "model");
  const modelChoice = namedModel === "" && agentFile.model !== ""
    ? resolvePinnedModel(agentFile, judgment)
    : resolveModel(namedModel, READ_ONLY_TYPES.has(agentType), judgment);
  const choices: Array<[string, Choice | null]> = agentType === FORK_TYPE ? [] : [
    ["model", modelChoice],
    ["effort", agentFile.pinsEffort ? null : resolveEffort(textField(toolArgs, "effort"), judgment)],
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

function resolveModel(model: string, readOnlyType: boolean, judgment: boolean): Choice | null {
  const named = model.toLowerCase();
  const tier = [OPUS, SONNET, HAIKU, ABOVE_BAND].find((candidate) => named.includes(candidate));
  if (tier === OPUS || tier === SONNET) return null;
  if (tier === ABOVE_BAND) return [OPUS, "ceiling"];
  if (judgment) return [OPUS, "judgment marker"];
  if (tier === HAIKU) return readOnlyType ? null : [SONNET, "floor"];
  return readOnlyType ? [HAIKU, "read-only type"] : [SONNET, "default"];
}

function resolvePinnedModel(agentFile: AgentFile, judgment: boolean): Choice | null {
  const pinned = agentFile.model;
  if (pinned.includes(ABOVE_BAND)) return [OPUS, "ceiling"];
  if (judgment) return pinned.includes(OPUS) ? null : [OPUS, "judgment marker"];
  if (pinned.includes(HAIKU) && agentFile.canEdit) return [SONNET, "floor"];
  return null;
}

function resolveEffort(effort: string, judgment: boolean): Choice | null {
  if (effort !== "") return null;
  return judgment ? ["high", "judgment marker"] : ["medium", "default"];
}

function checkWorkflowScript(toolArgs: Payload, fires: FireLog): number {
  if (isNonEmptyString(getField(toolArgs, "resumeFromRunId"))) return protocol.EXIT_PASS;
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
  if (isNonEmptyString(scriptPath)) text += ` Edit ${scriptPath} and invoke it again.`;
  return protocol.deny(protocol.formatMessage(HOOK, "workflow agents need a model and an effort", [[RULE, text]]));
}

function readAgentFile(agentType: string): AgentFile {
  const path = joinPath(dataDir(), "agents", `${agentType}.md`);
  if (!agentType || !isFile(path)) return NO_AGENT_FILE;
  const frontmatter = FRONTMATTER_RE.exec(readFileSync(path, "utf8"))?.[1];
  if (frontmatter === undefined) return NO_AGENT_FILE;
  return {
    model: (frontmatterField(frontmatter, "model") ?? "").toLowerCase(),
    pinsEffort: frontmatterField(frontmatter, "effort") !== null,
    canEdit: toolsCanEdit(frontmatterField(frontmatter, "tools")),
  };
}

function toolsCanEdit(tools: string | null): boolean {
  if (tools === null || !PLAIN_TOOL_LIST_RE.test(tools)) return true;
  return tools.toLowerCase().split(/[\s,]+/u).some((tool) => EDIT_TOOLS.has(tool.split("(")[0] ?? ""));
}

function frontmatterField(frontmatter: string, key: string): string | null {
  const line = new RegExp(`(?<![^\\n])${key}[${SPACE_CHARS}]*:(.*)`, "u").exec(frontmatter);
  return line ? (line[1] ?? "").trim() : null;
}

function workflowScript(toolArgs: Payload): string | null {
  const script = getField(toolArgs, "script");
  const scriptPath = getField(toolArgs, "scriptPath");
  if (typeof script === "string") return script;
  if (typeof scriptPath !== "string" || !isFile(scriptPath)) return null;
  return readFileSync(scriptPath, "utf8");
}

if (import.meta.main) process.exitCode = main();
