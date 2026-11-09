import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const READ_LOG_ENV = 'PRECHECK_READ_LOG';
const PRELOAD = new URL('./read-trace-preload.mjs', import.meta.url);

export function readTraceEnv(logFile: string, inheritedNodeOptions = process.env['NODE_OPTIONS']): NodeJS.ProcessEnv {
  const preload = `--import=${PRELOAD.href}`;
  return { [READ_LOG_ENV]: logFile, NODE_OPTIONS: inheritedNodeOptions ? `${inheritedNodeOptions} ${preload}` : preload };
}

export function readTracedPaths(logFile: string, repoRoot: string): Set<string> {
  if (!existsSync(logFile)) return new Set();
  const root = realpathSync(repoRoot);
  const paths = readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '');
  return new Set(paths.flatMap((path) => repoFilesAt(path, root)));
}

function repoFilesAt(path: string, root: string): string[] {
  const inRepo = relative(root, path);
  if (inRepo === '' || inRepo.startsWith('..') || !existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [repoRelative(path, root)];
  return readdirSync(path, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => repoRelative(join(entry.parentPath, entry.name), root));
}

function repoRelative(path: string, root: string): string {
  return relative(root, path).split(sep).join('/');
}
