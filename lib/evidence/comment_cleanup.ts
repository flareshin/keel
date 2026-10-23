import { posix } from 'node:path';
import * as gitcmd from './gitcmd.ts';
import { PYTHON_SPACE_PATTERN, UnicodeDecodeError, decodeStrict, pyStrip } from './pycompat.ts';

const MAX_SOURCE_BYTES = 1024 * 1024;
const PYTHON_SPACE_MEMBERS = PYTHON_SPACE_PATTERN.slice(1, -1);
const PROSE = new RegExp(`^[\\p{L}\\p{N}_${PYTHON_SPACE_MEMBERS}.,!?()'"-]+$`, 'u');
const PROTECTED_KEYWORDS = 'copyright|licen[cs]e|spdx|notice|rights reserved|trademark|coding|encoding|'
  + 'ignore|disable|enable|suppress|pragma|noqa|nosec|lint|prettier|formatter|'
  + 'coverage|istanbul|source[^\\n]?map|sourceurl|checkstyle|generated|preserve|'
  + 'pyright|mypy|pylint|doctest|webpack|rollup|vite|region|falls?<space>*through|'
  + 'databricks|command|magic|'
  + 'global|exported|noinspection|sonar|pmd|isort|ruff|fmt|yapf|__';
const DOTTED_OR_DOTLESS_I = '[i\\u0130\\u0131]';
const PROTECTED = new RegExp(
  PROTECTED_KEYWORDS.replaceAll('i', DOTTED_OR_DOTLESS_I).replace('<space>', `[${PYTHON_SPACE_MEMBERS}-]`), 'iu');
const SUPPORTED_SUFFIXES = ['.js', '.ts', '.java'];
const REGULAR_FILE_MODES = ['100644', '100755'];
const FORBIDDEN_CHARS = ['\0', '\ufeff', '\u2028', '\u2029'];
type Span = [start: number, end: number, body: string];

const verdictCache = new Map<string, boolean>();

export type Content = [mode: string, blob: string | null];

export function matchesContent(repo: string, path: string, reviewed: Content | null, current: Content | null): boolean {
  if (sameContent(reviewed, current)) return true;
  if (!reviewed || !current || reviewed[0] !== current[0] || !REGULAR_FILE_MODES.includes(current[0])) return false;
  return blobCommentDeletions(repo, path, reviewed[1]!, current[1]!);
}

function sameContent(left: Content | null, right: Content | null): boolean {
  if (left === null || right === null) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}

export function blobCommentDeletions(repo: string, path: string, oldBlob: string, newBlob: string): boolean {
  const cacheKey = [repo, path, oldBlob, newBlob].join('\0');
  const cached = verdictCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const verdict = measureBlobs(repo, path, oldBlob, newBlob);
  verdictCache.set(cacheKey, verdict);
  return verdict;
}

function measureBlobs(repo: string, path: string, oldBlob: string, newBlob: string): boolean {
  try {
    const sizes = [oldBlob, newBlob].map((blob) => Number.parseInt(gitcmd.text(repo, ['cat-file', '-s', blob]), 10));
    if (sizes.some(Number.isNaN)) return false;
    if (!(0 < sizes[1]! && sizes[1]! < sizes[0]! && sizes[0]! <= MAX_SOURCE_BYTES)) return false;
    const [before, after] = [oldBlob, newBlob].map((blob) => gitcmd.run(repo, ['cat-file', 'blob', blob]).stdout);
    return onlyCommentDeletions(path, before!, after!);
  } catch (error) {
    if (error instanceof gitcmd.GitError) return false;
    throw error;
  }
}

export function onlyCommentDeletions(path: string, before: Buffer, after: Buffer): boolean {
  const suffix = posix.extname(path);
  if (!SUPPORTED_SUFFIXES.includes(suffix) || !(0 < after.length && after.length < before.length && before.length <= MAX_SOURCE_BYTES)) {
    return false;
  }
  let old: string;
  let current: string;
  try {
    old = decodeStrict(before);
    current = decodeStrict(after);
  } catch (error) {
    if (!(error instanceof UnicodeDecodeError)) throw error;
    return false;
  }
  if (old.replaceAll('\r\n', '').includes('\r') || FORBIDDEN_CHARS.some((char) => old.includes(char))) return false;
  const spans = slashComments(old, suffix);
  if (spans === null) return false;
  const chunks: Array<[text: string, removable: boolean]> = [];
  let cursor = 0;
  for (const [start, end, body] of spans) {
    if (!PROSE.test(body) || PROTECTED.test(body)) return false;
    const first = old.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = old.indexOf('\n', end);
    const last = lineEnd < 0 ? old.length : lineEnd + 1;
    if (pyStrip(old.slice(first, start)) || pyStrip(old.slice(end, last))) continue;
    chunks.push([old.slice(cursor, first), false], [old.slice(first, last), true]);
    cursor = last;
  }
  chunks.push([old.slice(cursor), false]);
  let position = 0;
  let removed = false;
  for (const [piece, removable] of chunks) {
    if (current.startsWith(piece, position)) position += piece.length;
    else if (removable) removed = true;
    else return false;
  }
  return removed && position === current.length;
}

function slashComments(text: string, suffix: string): Span[] | null {
  if ((suffix === '.java' && (text.includes('\\u') || text.includes('"""'))) || text.includes('`')) return null;
  const spans: Span[] = [];
  let position = 0;
  while (position < text.length) {
    const char = text[position]!;
    if (char === '"' || char === "'") {
      const end = quotedEnd(text, position);
      if (end === null) return null;
      position = end;
    } else if (text.startsWith('//', position)) {
      const newline = text.indexOf('\n', position);
      const end = newline < 0 ? text.length : newline;
      spans.push([position, end, text.slice(position + 2, end)]);
      position = end;
    } else if (text.startsWith('/*', position)) {
      const end = text.indexOf('*/', position + 2);
      if (end < 0) return null;
      spans.push([position, end + 2, text.slice(position + 2, end)]);
      position = end + 2;
    } else if (char === '#' || ((char === '/' || char === '<') && suffix !== '.java')) {
      return null;
    } else {
      position++;
    }
  }
  return spans;
}

function quotedEnd(text: string, start: number): number | null {
  let position = start + 1;
  while (position < text.length) {
    const char = text[position]!;
    if (char === text[start]) return position + 1;
    if (char === '\r' || char === '\n') return null;
    position += char === '\\' ? 2 : 1;
  }
  return null;
}
