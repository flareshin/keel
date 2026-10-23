import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandUser, pythonJsonDumps } from './pycompat.ts';
import type { JsonValue } from './pycompat.ts';

const RUN_ID_BODY = '[A-Za-z0-9._-]{8,64}';
const SHA_BODY = '[0-9a-f]{40}';
export const RUN_ID_PATTERN = `^${RUN_ID_BODY}$`;
const RUN_ID_FULL_RE = new RegExp(`^${RUN_ID_BODY}$`);
const RUN_ID_MATCH_RE = new RegExp(`^${RUN_ID_BODY}\\n?$`);
const SHA_FULL_RE = new RegExp(`^${SHA_BODY}$`);
const SHA_MATCH_RE = new RegExp(`^${SHA_BODY}\\n?$`);
export const EVIDENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const GITLINK_MODE = '160000';
export const DELETED_MODE = '000000';
export const EVIDENCE_ID_RANDOM_BYTES = 4;
export const RUN_ID_RANDOM_BYTES = 3;

export function dataDir(): string {
  return expandUser(process.env['KEEL_DATA_DIR'] || '~/.claude');
}

export function overlayDir(): string {
  return expandUser(process.env['KEEL_OVERLAY_DIR'] || '~/git/keel-overlay');
}

export function stateDir(): string {
  return join(dataDir(), 'state', 'keel');
}

export function logsDir(): string {
  return join(dataDir(), 'logs');
}

export function appendLogLine(name: string, line: { [key: string]: JsonValue }): void {
  mkdirSync(logsDir(), { recursive: true });
  appendFileSync(join(logsDir(), name), pythonJsonDumps(line, { sortKeys: true }) + '\n', 'utf8');
}

export function utcNow(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

export function iso(moment: Date): string {
  return moment.toISOString().slice(0, 19) + 'Z';
}

export function newId(prefix: string, moment: Date, randomByteCount: number): string {
  const stamp = iso(moment).replace(/[-:]/g, '');
  return `${prefix}-${stamp}-${randomBytes(randomByteCount).toString('hex')}`;
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_FULL_RE.test(value);
}

export function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_FULL_RE.test(value);
}

export function matchesRunId(value: string): boolean {
  return RUN_ID_MATCH_RE.test(value);
}

export function matchesSha(value: string): boolean {
  return SHA_MATCH_RE.test(value);
}
