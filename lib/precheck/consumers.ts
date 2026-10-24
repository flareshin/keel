import { GitError, run, text } from '../evidence/gitcmd.ts';

export type NameKind = 'export' | 'flag' | 'key';

export interface Consumer {
  path: string;
  line: number;
}

export interface ChangedName {
  kind: NameKind;
  name: string;
  consumers: Consumer[];
}

interface FileChange {
  path: string;
  addedLines: Set<number>;
  anchors: number[];
  removedText: string[];
  addedText: string[];
}

interface Declaration {
  name: string;
  path: string;
  line: number;
}

const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const SHELL_FILE = /\.(?:sh|bash|zsh)$/u;
const JSON_FILE = /\.json$/u;
const EXPORT_DECLARATION = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/u;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/u;
const EXPORT_ALIAS = /\s+as\s+/u;
const COLUMN_ZERO = /^\S/u;
const FLAG = /(?<![\w-])--[a-z][a-z0-9-]*/gu;
const JSON_KEY = /^\s*"([^"\\]+)"\s*:/u;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;
const NEW_FILE_HEADER = 'diff --git ';
const OLD_PATH_PREFIX = '--- a/';
const NEW_PATH_PREFIX = '+++ b/';
const DELETED_FILE = '+++ /dev/null';
const NO_MATCH = 1;

export function findConsumers(repo: string, base: string, tree: string): ChangedName[] {
  const changes = parseDiff(text(repo, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '-U0', base, tree]));
  const declarations = changes.flatMap((change) => enclosingExports(repo, tree, change));
  const names = new Map<string, { kind: NameKind; name: string }>();
  const add = (kind: NameKind, name: string): void => { names.set(`${kind}\0${name}`, { kind, name }); };
  for (const declaration of declarations) add('export', declaration.name);
  for (const change of changes) {
    for (const name of removedExports(change)) add('export', name);
    for (const name of changedTokens(change, flagsOf, SCRIPT_FILE, SHELL_FILE)) add('flag', name);
    for (const name of changedTokens(change, jsonKeysOf, JSON_FILE)) add('key', name);
  }
  const insideDiff = (consumer: Consumer): boolean =>
    changes.some((change) => change.path === consumer.path && change.addedLines.has(consumer.line))
    || declarations.some((declaration) => declaration.path === consumer.path && declaration.line === consumer.line);
  return [...names.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    .map(({ kind, name }) => {
      const consumers = grepWord(repo, tree, kind, name).filter((consumer) => !insideDiff(consumer));
      return { kind, name, consumers };
    });
}

function parseDiff(diff: string): FileChange[] {
  const changes: FileChange[] = [];
  let current: FileChange | null = null;
  let oldPath = '';
  let nextAdded = 0;
  const open = (path: string): FileChange => {
    const change = { path, addedLines: new Set<number>(), anchors: [], removedText: [], addedText: [] };
    changes.push(change);
    return change;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith(NEW_FILE_HEADER)) {
      current = null;
    } else if (current === null && line.startsWith(OLD_PATH_PREFIX)) {
      oldPath = line.slice(OLD_PATH_PREFIX.length);
    } else if (current === null && line === DELETED_FILE) {
      current = open(oldPath);
    } else if (current === null && line.startsWith(NEW_PATH_PREFIX)) {
      current = open(line.slice(NEW_PATH_PREFIX.length));
    } else if (current !== null && HUNK_HEADER.test(line)) {
      const [, start, count] = HUNK_HEADER.exec(line) as RegExpExecArray;
      nextAdded = Number(start);
      if (count === '0' && nextAdded > 0) current.anchors.push(nextAdded);
    } else if (current !== null && line.startsWith('+')) {
      current.addedLines.add(nextAdded);
      current.anchors.push(nextAdded);
      current.addedText.push(line.slice(1));
      nextAdded++;
    } else if (current !== null && line.startsWith('-')) {
      current.removedText.push(line.slice(1));
    }
  }
  return changes;
}

function enclosingExports(repo: string, tree: string, change: FileChange): Declaration[] {
  if (!SCRIPT_FILE.test(change.path) || change.anchors.length === 0) return [];
  const lines = text(repo, ['show', `${tree}:${change.path}`]).split('\n');
  const found = new Map<number, Declaration>();
  for (const anchor of change.anchors) {
    let line = anchor;
    while (line > 1 && !COLUMN_ZERO.test(lines[line - 1] ?? '')) line--;
    const name = EXPORT_DECLARATION.exec(lines[line - 1] ?? '')?.[1];
    if (name !== undefined) found.set(line, { name, path: change.path, line });
  }
  return [...found.values()];
}

function removedExports(change: FileChange): string[] {
  if (!SCRIPT_FILE.test(change.path)) return [];
  const kept = new Set(change.addedText.flatMap(exportedNames));
  return change.removedText.flatMap(exportedNames).filter((name) => !kept.has(name));
}

function exportedNames(line: string): string[] {
  const declared = EXPORT_DECLARATION.exec(line)?.[1];
  if (declared !== undefined) return [declared];
  const list = EXPORT_LIST.exec(line)?.[1];
  if (list === undefined) return [];
  return list.split(',').map((entry) => entry.split(EXPORT_ALIAS).at(-1)?.trim() ?? '').filter((name) => name !== '');
}

function changedTokens(change: FileChange, tokensOf: (line: string) => string[], ...fileTypes: RegExp[]): string[] {
  if (!fileTypes.some((type) => type.test(change.path))) return [];
  const removed = new Set(change.removedText.flatMap(tokensOf));
  const added = new Set(change.addedText.flatMap(tokensOf));
  return [...removed, ...added].filter((token) => removed.has(token) !== added.has(token));
}

function flagsOf(line: string): string[] {
  return [...line.matchAll(FLAG)].map((match) => match[0]);
}

function jsonKeysOf(line: string): string[] {
  const key = JSON_KEY.exec(line)?.[1];
  return key === undefined ? [] : [key];
}

function grepWord(repo: string, tree: string, kind: NameKind, name: string): Consumer[] {
  const args = ['grep', '-z', '-n', '-I', '-F', '-w', '-e', name, tree, '--'];
  const completed = run(repo, args, { check: false });
  if (completed.returncode === NO_MATCH) return [];
  if (completed.returncode !== 0) throw new GitError(`git grep for ${name} exited ${completed.returncode}: ${completed.stderr.toString()}`);
  const boundary = kind === 'flag' ? flagBoundary(name) : null;
  const prefix = `${tree}:`;
  return completed.stdout.toString().split('\n').filter((record) => record !== '').flatMap((record) => {
    const [where = '', line = '', content = ''] = record.split('\0');
    if (boundary !== null && !boundary.test(content)) return [];
    return [{ path: where.slice(prefix.length), line: Number(line) }];
  });
}

function flagBoundary(flag: string): RegExp {
  return new RegExp(`(?<![\\w-])${flag}(?![\\w-])`, 'u');
}
