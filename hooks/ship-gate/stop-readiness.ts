import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionStatePath } from "../lib/hookkit/contract.ts";
import { describeError } from "../lib/hookkit/errors.ts";
import { FireLog } from "../lib/hookkit/fires.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Bullet, Payload } from "../lib/hookkit/protocol.ts";
import { writeStderr } from "../lib/hookkit/stdio.ts";
import * as gitcmd from "../../lib/evidence/gitcmd.ts";
import { pushReadiness } from "../../lib/evidence/readiness.ts";

const HOOK = "ship-gate";
const NO_REPO_KEY = "-";
const SHORT_SHA = 12;
const REMINDER_EXTENSION = "stop-readiness";
const NEXT_STEP = "Before you stop, do what is listed, or say in your reply why it waits; ship-gate denies this push until it is done.";

interface UnreadyPush {
  repo: string;
  head: string;
  reasons: Bullet[];
}

export function unreadyPushReminder(payload: Payload, session: string): string | null {
  let unready: UnreadyPush | null;
  try {
    unready = unreadyPush(protocol.cwdOrProcessDirectory(payload));
  } catch (error) {
    writeStderr(`${HOOK}: push readiness at Stop not judged: ${describeError(error)}\n`);
    return null;
  }
  if (unready === null || !claimFirstReminder(session, unready)) return null;
  const [firstRule] = unready.reasons[0]!;
  new FireLog(HOOK, session).append(firstRule, "warn", {
    repo: unready.repo, head: unready.head, detail: unready.reasons.map(([, text]) => text).join("; "),
  });
  const summary = `this turn ends with ${unready.repo} HEAD ${unready.head.slice(0, SHORT_SHA)} not ready to push`;
  return protocol.formatMessage(HOOK, summary, unready.reasons, NEXT_STEP);
}

function unreadyPush(cwd: string): UnreadyPush | null {
  const repoRoot = gitcmd.toplevel(cwd);
  if (repoRoot === null || upstreamHoldsHead(repoRoot)) return null;
  const readiness = pushReadiness(repoRoot, "skipped");
  if (readiness.ok) return null;
  const reasons: Bullet[] = readiness.reasons.map((reason) => [reason.rule_id, reason.text]);
  return { repo: readiness.repo ?? NO_REPO_KEY, head: readiness.head, reasons };
}

function upstreamHoldsHead(repoRoot: string): boolean {
  const upstream = gitcmd.commitSha(repoRoot, "@{upstream}");
  return upstream !== null && gitcmd.isAncestor(repoRoot, "HEAD", upstream);
}

function claimFirstReminder(session: string, unready: UnreadyPush): boolean {
  const path = sessionStatePath(session, REMINDER_EXTENSION);
  const key = [unready.repo, unready.head, ...unready.reasons.map(([ruleId, text]) => `${ruleId} ${text}`)].join("\n");
  try {
    if (readFileSync(path, "utf8") === key) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") writeStderr(`${HOOK}: ${describeError(error)}\n`);
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, key, "utf8");
  } catch (error) {
    writeStderr(`${HOOK}: could not record the Stop reminder: ${describeError(error)}\n`);
  }
  return true;
}
