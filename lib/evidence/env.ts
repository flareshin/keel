import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from '../../measure/lib/measurekit/files.ts';
import { stringifySorted } from '../../measure/lib/measurekit/json.ts';
import { dumpFiresLine } from './hook_pinned.ts';

const RUN_ID_BODY = '[A-Za-z0-9._-]{8,64}';
const SHA_BODY = '[0-9a-f]{40}';
export const RUN_ID_PATTERN = `^${RUN_ID_BODY}$`;
const RUN_ID_FULL_RE = new RegExp(`^${RUN_ID_BODY}$`);
const SHA_FULL_RE = new RegExp(`^${SHA_BODY}$`);
export const EVIDENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const GITLINK_MODE = '160000';
export const DELETED_MODE = '000000';
export const EVIDENCE_ID_RANDOM_BYTES = 4;
export const RUN_ID_RANDOM_BYTES = 3;

export function dataDir(): string {
  return expandHome(process.env['KEEL_DATA_DIR'] || '~/.claude');
}

export function overlayDir(): string {
  return expandHome(process.env['KEEL_OVERLAY_DIR'] || '~/git/keel-overlay');
}

export function stateDir(): string {
  return join(dataDir(), 'state', 'keel');
}

export function logsDir(): string {
  return join(dataDir(), 'logs');
}

export function appendLogLine(name: string, line: Record<string, unknown>): void {
  appendLine(name, dumpFiresLine(line));
}

export function appendRecord(name: string, record: Record<string, unknown>): void {
  appendLine(name, stringifySorted(record));
}

function appendLine(name: string, text: string): void {
  mkdirSync(logsDir(), { recursive: true });
  appendFileSync(join(logsDir(), name), text + '\n', 'utf8');
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
