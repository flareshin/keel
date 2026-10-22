import { buildChains } from './chain.ts';
import * as codexLenses from './codex_lenses.ts';
import * as codexReview from './codex_review.ts';
import * as gc from './gc.ts';
import * as gitcmd from './gitcmd.ts';
import * as prepare from './prepare.ts';
import { errorText, UnicodeDecodeError, ValueError, isJsonObject, pyEquals, pythonJsonDumps, pythonJsonLoads, pythonTypeName, sortedStrings } from './pycompat.ts';
import type { JsonValue } from './pycompat.ts';
import * as registry from './registry.ts';
import { printErrorLine, printLine, readStdinText } from './stdio.ts';
import * as store from './store.ts';
import * as testrun from './testrun.ts';
import * as verify from './verify.ts';
import * as writers from './writers.ts';
import type { JsonObject } from './writers.ts';

const USAGE = `usage:
  keel test -- <command…>
  keel approve <root_run_id> [--read]
  keel snapshot <repo>
  keel review prepare                 (stdin: workflow args; stdout: prepared metadata)
  keel evidence write-review          (stdin: {"keel_evidence":{…},"verdict":…,"source":{…}})
  keel evidence write-smoke [--repo <path>] [--run <smoke run_id>]
  keel evidence show [--repo <path>] [--root <root_run_id>]
  keel evidence compatibility         (read-only retirement inventory across repos)
  keel evidence record-codex --repo <path> --audits <UUID,UUID,...> [--verifiers <UUID,UUID,...>]
  keel evidence gc`;
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const EXIT_INTERNAL = 70;
const EVIDENCE_OPTIONS = new Set(['--repo', '--run', '--root', '--audits', '--verifiers']);

export const seams = { print: printResult };

export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    if (error instanceof writers.Usage) {
      printErrorLine(`keel: ${error.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    if (error instanceof writers.Refused) {
      printErrorLine(`keel: refused: ${error.message}`);
      return EXIT_REFUSED;
    }
    printErrorLine(`keel: internal error: ${pythonTypeName(error)}: ${errorText(error)}`);
    return EXIT_INTERNAL;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  if (argv.length === 0) throw new writers.Usage('missing command');
  const commands: Record<string, (rest: string[]) => number | Promise<number>> = {
    test: runTest, approve, snapshot, evidence, review,
  };
  const command = Object.hasOwn(commands, argv[0]!) ? commands[argv[0]!] : undefined;
  if (command === undefined) throw new writers.Usage('unknown command ' + argv[0]);
  return command(argv.slice(1));
}

function runTest(rest: string[]): Promise<number> {
  if (rest[0] !== '--') throw new writers.Usage('keel test -- <command…>');
  return testrun.run(rest.slice(1), process.cwd());
}

function review(rest: string[]): number {
  if (rest.length !== 1 || rest[0] !== 'prepare') throw new writers.Usage('keel review prepare reads workflow args from stdin');
  seams.print(prepare.review(stdinJson()));
  return EXIT_OK;
}

function approve(rest: string[]): number {
  const flags = rest.filter((arg) => arg.startsWith('--'));
  const positional = rest.filter((arg) => !arg.startsWith('--'));
  if (positional.length !== 1 || flags.some((flag) => flag !== '--read')) throw new writers.Usage('keel approve <root_run_id> [--read]');
  const kind = flags.includes('--read') ? 'ack' : 'approval';
  seams.print(writers.writeApproval(positional[0]!, kind));
  return EXIT_OK;
}

function snapshot(rest: string[]): number {
  if (rest.length !== 1) throw new writers.Usage('keel snapshot <repo>');
  const repoRoot = gitcmd.toplevel(rest[0]!);
  if (repoRoot === null) throw new writers.Usage(`${rest[0]} is not inside a git repository`);
  seams.print({ repo_root: repoRoot, tree: gitcmd.snapshotTree(repoRoot) });
  return EXIT_OK;
}

function evidence(rest: string[]): number {
  if (rest.length === 0) throw new writers.Usage('keel evidence <write-review|write-smoke|show|gc>');
  const subcommand = rest[0]!;
  const options = parseOptions(rest.slice(1), EVIDENCE_OPTIONS);
  const optionNames = Object.keys(options);
  if (subcommand === 'record-codex') {
    const allowed = ['--repo', '--audits', '--verifiers'];
    if (!('--repo' in options) || !('--audits' in options) || optionNames.some((name) => !allowed.includes(name))) {
      throw new writers.Usage('registration requires --repo, --audits and optional --verifiers');
    }
    const verifiers = '--verifiers' in options ? options['--verifiers']!.split(',') : [];
    seams.print(codexLenses.register(options['--repo']!, options['--audits']!.split(','), verifiers));
  } else if (subcommand === 'write-review') {
    seams.print(writers.writeReview(stdinJson()));
  } else if (subcommand === 'write-smoke') {
    seams.print(writers.writeSmoke(options['--repo'] || process.cwd(), options['--run'] ?? null));
  } else if (subcommand === 'show') {
    seams.print(show(options['--repo'] || process.cwd(), options['--root'] ?? null));
  } else if (subcommand === 'compatibility') {
    if (optionNames.length > 0) throw new writers.Usage('compatibility inventories all repositories; it takes no options');
    seams.print(compatibility());
  } else if (subcommand === 'gc') {
    seams.print({ deleted: gc.collect() });
  } else {
    throw new writers.Usage('unknown evidence subcommand ' + subcommand);
  }
  return EXIT_OK;
}

export function show(repoPath: string, rootRunId: string | null): JsonObject {
  const repoRoot = gitcmd.toplevel(repoPath);
  const repoKey = repoRoot ? registry.originKey(repoRoot) : null;
  if (repoKey === null) throw new writers.Usage(`${repoPath} is not a git repository with an origin remote`);
  const chains = [];
  for (const chain of buildChains(store.loadReviews(repoKey))) {
    if (rootRunId && chain.rootRunId !== rootRunId) continue;
    const head = chain.head;
    chains.push({
      root_run_id: chain.rootRunId, head_evidence_id: head.evidence_id, verdict: head.verdict,
      review_kind: head.review_kind, paths: chain.reviewed.size,
      approved: verify.boundEvidence('approval', chain.rootRunId, repoKey, head.evidence_id) !== null,
      acked: verify.boundEvidence('ack', chain.rootRunId, repoKey, head.evidence_id) !== null,
    });
  }
  return {
    repo: repoKey, chains,
    tests: store.load('tests', repoKey).map((item) => item.evidence_id),
    smoke: store.load('smoke', repoKey).map((item) => item.evidence_id),
  };
}

export function compatibility(): JsonObject {
  let count = 0;
  const roots: string[] = [];
  for (const key of store.repoKeys('review')) {
    const reviews = store.loadReviews(key);
    const old = new Set(reviews
      .filter((item) => item.review_kind === codexReview.KIND && !pyEquals((item.source || {})['version'], 2))
      .map((item) => item.evidence_id));
    count += old.size;
    roots.push(...buildChains(reviews).filter((chain) => chain.links.some((link) => old.has(link.evidence_id))).map((chain) => chain.rootRunId));
  }
  return { read_only_records: count, chain_roots: sortedStrings(new Set(roots)), reader_removable: count === 0 && roots.length === 0 };
}

function parseOptions(args: string[], allowed: Set<string>): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!allowed.has(arg)) throw new writers.Usage('unexpected argument ' + arg);
    const value = args[index + 1];
    if (value === undefined) throw new writers.Usage(`${arg} needs a value`);
    options[arg] = value;
    index++;
  }
  return options;
}

function stdinJson(): JsonObject {
  let request: JsonValue;
  try {
    request = pythonJsonLoads(readStdinText());
  } catch (error) {
    if (error instanceof ValueError || error instanceof UnicodeDecodeError) {
      throw new writers.Usage(`stdin is not JSON: ${(error as Error).message}`);
    }
    throw error;
  }
  if (!isJsonObject(request)) throw new writers.Usage('stdin must be a JSON object');
  return request;
}

function printResult(payload: JsonObject): void {
  printLine(pythonJsonDumps(payload, { sortKeys: true }));
}
