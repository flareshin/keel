import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLinks } from '../../measure/lib/measurekit/files.ts';
import { isJsonObject } from '../../measure/lib/measurekit/json.ts';
import { TimeoutExpired } from '../../measure/lib/measurekit/timeout.ts';
import * as gitcmd from './gitcmd.ts';
import { stripEitherWay } from './text.ts';
import { Refused } from './writers.ts';

const PULL_TIMEOUT_SECONDS = 120;
const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json');
const COMMIT_ABBREVIATION = 10;

export interface CheckoutState {
  version: string | null;
  head: string;
}

export interface UpdateResult {
  home: string;
  updated: boolean;
  before: CheckoutState;
  after: CheckoutState;
}

export function updateCheckout(home: string, pullTimeoutSeconds = PULL_TIMEOUT_SECONDS): UpdateResult {
  requireCheckoutRoot(home);
  const before = checkoutState(home);
  const pulled = pullFastForward(home, pullTimeoutSeconds);
  if (pulled.returncode !== 0) {
    throw new Refused(`git pull --ff-only in ${home} failed and left the checkout as it was: ${stripEitherWay(pulled.stderr.toString())}`);
  }
  const after = checkoutState(home);
  return { home, updated: after.head !== before.head, before, after };
}

export function describeUpdate(result: UpdateResult): string {
  const shown = (state: CheckoutState): string => `${state.version ?? 'no version'} (${state.head.slice(0, COMMIT_ABBREVIATION)})`;
  if (!result.updated) return `keel is already at the latest version, ${shown(result.after)}`;
  return `keel moved from ${shown(result.before)} to ${shown(result.after)}; `
    + 'start a new Claude Code session or run /reload-plugins to load it, then run bin/link --check';
}

function pullFastForward(home: string, timeoutSeconds: number): ReturnType<typeof gitcmd.runUnchecked> {
  try {
    return gitcmd.runUnchecked(home, ['pull', '--ff-only'], { timeoutSeconds });
  } catch (error) {
    if (!(error instanceof TimeoutExpired)) throw error;
    throw new Refused(`git pull --ff-only in ${home} did not finish within ${timeoutSeconds} s and was stopped; the checkout is as it was unless git had begun moving it, so check it with git -C ${home} status`);
  }
}

function requireCheckoutRoot(home: string): void {
  if (gitcmd.toplevel(home) !== resolveLinks(home)) {
    throw new Refused(`${home} is not the root of a git checkout; keel update moves a clone by git pull --ff-only`);
  }
}

function checkoutState(home: string): CheckoutState {
  const head = gitcmd.commitSha(home, 'HEAD');
  if (head === null) throw new Refused(`${home} has no commit checked out`);
  return { version: manifestVersion(home), head };
}

function manifestVersion(home: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(home, PLUGIN_MANIFEST), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const version = isJsonObject(manifest) ? manifest['version'] : null;
  return typeof version === 'string' ? version : null;
}
