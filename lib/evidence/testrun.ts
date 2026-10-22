import childProcess from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import * as env from './env.ts';
import * as gitcmd from './gitcmd.ts';
import { PYTHON_SPACE_PATTERN, decodeReplacing, pythonJsonDumps } from './pycompat.ts';
import * as registry from './registry.ts';
import { printErrorLine, writeStdout } from './stdio.ts';
import * as store from './store.ts';
import { OSError, returnCode } from './subprocess.ts';
import { Usage } from './writers.ts';

const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}_])';
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const LINE_START = '(?<![^\\n])';
const SPACE = `[${PYTHON_SPACE_PATTERN.slice(1, -1)}]`;
export const COUNT_PATTERNS: Array<[name: string, pattern: RegExp]> = [
  ['surefire', /Tests run: ([0-9]+)/gu],
  ['unittest', new RegExp(`${LINE_START}Ran ([0-9]+) tests?${NOT_WORD_AFTER}`, 'gu')],
  ['tap', new RegExp(`${LINE_START}# pass ([0-9]+)`, 'gu')],
  ['passed', new RegExp(
    `${LINE_START}(?!${SPACE}*Test (?:Files|Suites)${NOT_WORD_AFTER})[^\\n]*?${NOT_WORD_BEFORE}([0-9]+) passed${NOT_WORD_AFTER}`, 'gu')],
];
const NO_TESTS_RECOGNIZED = 4;
const COMMAND_NOT_FOUND = 2;
const SHELL_EXEC_STDERR_TO_STDOUT = 'exec "$@" 2>&1';

type Json = Parameters<typeof pythonJsonDumps>[0];

export async function run(argv: string[], cwd: string): Promise<number> {
  if (argv.length === 0) throw new Usage('keel test -- <command…>');
  const repoRoot = gitcmd.toplevel(cwd);
  if (repoRoot === null) throw new Usage('keel test must run inside a git repository');
  const repoKey = registry.originKey(repoRoot);
  if (repoKey === null) throw new Usage('the repository needs an origin remote');
  const now = env.utcNow();
  const runId = env.newId('tr', now, env.RUN_ID_RANDOM_BYTES);
  const before = gitcmd.snapshotTree(repoRoot);
  const submodulesBefore = submoduleSnapshots(repoRoot);
  const [exitCode, output] = await stream(argv, cwd);
  const after = gitcmd.snapshotTree(repoRoot);
  const submodulesAfter = submoduleSnapshots(repoRoot);
  const [count, framework] = recognize(output);
  const result = { run_id: runId, repo: repoKey, repo_root: repoRoot, cmd: argv, exit: exitCode, count, framework, tree: after };
  let evidenceId: string | null = null;
  let submoduleEvidence: Record<string, string> = {};
  if (exitCode === 0 && count > 0 && before === after) {
    const evidence = store.write('tests', { ...result, head: gitcmd.commitSha(repoRoot, 'HEAD') }, repoKey);
    evidenceId = evidence.evidence_id;
    submoduleEvidence = writeSubmoduleEvidence(result, submodulesBefore, submodulesAfter);
  }
  env.appendLogLine('keel-tests.jsonl', {
    ...result, ts: env.iso(env.utcNow()), evidence_id: evidenceId, submodule_evidence: submoduleEvidence,
  });
  printErrorLine('KEEL-TEST ' + pythonJsonDumps({
    run_id: runId, count, exit: exitCode, evidence_id: evidenceId, submodule_evidence: submoduleEvidence,
  } as Json));
  if (exitCode === 0 && count === 0) return NO_TESTS_RECOGNIZED;
  return exitCode;
}

function submoduleSnapshots(repoRoot: string): Map<string, string> {
  return new Map(gitcmd.submoduleRoots(repoRoot).map((root) => [root, gitcmd.snapshotTree(root)]));
}

function writeSubmoduleEvidence(result: { repo: string }, before: Map<string, string>, after: Map<string, string>): Record<string, string> {
  const written: Record<string, string> = {};
  for (const [root, tree] of after) {
    const repoKey = registry.originKey(root);
    if (repoKey === null || before.get(root) !== tree) continue;
    const evidence = store.write('tests', {
      ...result, repo: repoKey, repo_root: root, tree, head: gitcmd.commitSha(root, 'HEAD'), superproject: result.repo,
    } as { [key: string]: any }, repoKey);
    written[repoKey] = evidence.evidence_id;
  }
  return written;
}

export function recognize(output: string): [count: number, framework: string | null] {
  let total = 0;
  let framework: string | null = null;
  for (const [name, pattern] of COUNT_PATTERNS) {
    const counts = [...output.matchAll(pattern)].map((match) => Number(match[1]));
    if (counts.length === 0) continue;
    framework ??= name;
    total += name === 'surefire' ? counts.at(-1)! : counts.reduce((sum, item) => sum + item, 0);
  }
  return [total, framework];
}

async function stream(argv: string[], cwd: string): Promise<[exitCode: number, output: string]> {
  const program = findExecutable(argv[0]!);
  if (program === null) {
    printErrorLine(`keel test: command not found: ${argv[0]}`);
    return [COMMAND_NOT_FOUND, ''];
  }
  const child = childProcess.spawn('/bin/sh', ['-c', SHELL_EXEC_STDERR_TO_STDOUT, 'keel-test', ...argv], {
    cwd, stdio: ['inherit', 'pipe', 'inherit'],
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    writeStdout(chunk);
    chunks.push(chunk);
  });
  const status = await new Promise<number>((resolveStatus) => {
    child.on('close', (code, signal) => resolveStatus(returnCode(code, signal)));
  });
  return [status, decodeReplacing(Buffer.concat(chunks))];
}

function findExecutable(name: string): string | null {
  const candidates = name.includes('/') ? [name] : (process.env['PATH'] ?? '/usr/bin:/bin').split(delimiter).map((dir) => join(dir || '.', name));
  let denied: string | null = null;
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES') denied = candidate;
    }
  }
  if (denied !== null) throw new OSError(`[Errno 13] Permission denied: '${name}'`, 'PermissionError');
  return null;
}
