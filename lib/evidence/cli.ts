import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidUtf8Error } from '../../measure/lib/measurekit/files.ts';
import { compareCodePoints, isJsonObject, parseJsonKeepingIntegers, stringifySorted } from '../../measure/lib/measurekit/json.ts';
import type { JsonValue } from '../../measure/lib/measurekit/json.ts';
import * as affected from '../precheck/affected.ts';
import { ruleCheckLines, typecheck } from '../precheck/author.ts';
import { bindPrecheck, precheckRequirement } from '../precheck/binding.ts';
import { renderCensus, renderRerun, summarizeCensus, summarizeRerun } from '../precheck/render.ts';
import { buildChains } from './chain.ts';
import * as codexLenses from './codex_lenses.ts';
import * as codexReview from './codex_review.ts';
import * as env from './env.ts';
import * as gc from './gc.ts';
import * as gitcmd from './gitcmd.ts';
import * as prepare from './prepare.ts';
import * as registry from './registry.ts';
import { printErrorLine, printLine, readStdinText } from './stdio.ts';
import * as store from './store.ts';
import * as testrun from './testrun.ts';
import * as verify from './verify.ts';
import * as writers from './writers.ts';
import type { JsonObject } from './writers.ts';

const USAGE = `usage:
  keel test -- <command…>
  keel home                           (prints the keel checkout this CLI runs from)
  keel approve <root_run_id> [--read]
  keel approve --promote <owner/repo> <sha>
  keel snapshot <repo>
  keel review prepare                 (stdin: workflow args; stdout: prepared metadata)
  keel evidence write-review          (stdin: {"keel_evidence":{…},"verdict":…,"source":{…}})
  keel evidence write-smoke [--repo <path>] [--run <smoke run_id>]
  keel evidence show [--repo <path>] [--root <root_run_id>]
  keel evidence check --repo <path>   (would ship-gate let a push of HEAD through? exit 1 = not ready)
  keel evidence compatibility         (read-only retirement inventory across repos)
  keel evidence record-codex --repo <path> --audits <UUID,UUID,...> [--verifiers <UUID,UUID,...>]
  keel evidence promote-plan --repo <path> --base <ref> --head <sha>
  keel evidence gc
  keel precheck run --repo <path> --base <ref>
  keel precheck rerun --repo <path> --base <ref> --census <file>
  keel precheck bind --repo <path> --base <sha> --end <sha> --tree <precheck tree>
  keel precheck required --repo <path> --base <sha> --end <sha>`;
const PROMOTE_USAGE = 'keel approve --promote <owner/repo> <sha>';
const EXIT_OK = 0;
const EXIT_NOT_READY = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const EXIT_INTERNAL = 70;
const EVIDENCE_OPTIONS = new Set(['--repo', '--run', '--root', '--audits', '--verifiers', '--base', '--head']);
const PROMOTE_PLAN_OPTIONS = ['--repo', '--base', '--head'];
const PRECHECK_BIND_OPTIONS = new Set(['--repo', '--base', '--end', '--tree']);
const PRECHECK_REQUIRED_OPTIONS = new Set(['--repo', '--base', '--end']);
const PRECHECK_RUN_OPTIONS = new Set(['--repo', '--base']);
const PRECHECK_RERUN_OPTIONS = new Set(['--repo', '--base', '--census']);
const TEST_AFFECTED_OPTIONS = new Set(['--base']);
const DEFAULT_AFFECTED_BASE = 'origin/HEAD';
const WITH_REPLAYS = '--with-replays';
const PRECHECK_LOG = 'keel-precheck.jsonl';
const MODULE_NOT_FOUND = 'ERR_MODULE_NOT_FOUND';

export const seams = { print: printResult, loadCensus: () => import('../precheck/census.ts'), loadRerun: () => import('../precheck/rerun.ts'), resolveTypescript: () => import.meta.resolve('typescript'), typescriptResolves };

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
    printErrorLine(`keel: internal error: ${error instanceof Error ? error.constructor.name : typeof error}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_INTERNAL;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  if (argv.length === 0) throw new writers.Usage('missing command');
  const commands: Record<string, (rest: string[]) => number | Promise<number>> = {
    test: runTest, home, approve, snapshot, evidence, review, precheck,
  };
  const command = Object.hasOwn(commands, argv[0]!) ? commands[argv[0]!] : undefined;
  if (command === undefined) throw new writers.Usage('unknown command ' + argv[0]);
  return command(argv.slice(1));
}

function home(rest: string[]): number {
  if (rest.length > 0) throw new writers.Usage('keel home takes no arguments');
  printLine(env.keelHome());
  return EXIT_OK;
}

function runTest(rest: string[]): Promise<number> {
  if (rest[0] === '--affected') return runAffectedTests(rest.slice(1));
  if (rest[0] !== '--') throw new writers.Usage('keel test -- <command…>');
  return testrun.run(rest.slice(1), process.cwd());
}

async function runAffectedTests(rest: string[]): Promise<number> {
  const withReplays = rest.includes(WITH_REPLAYS);
  const base = parseOptions(rest.filter((arg) => arg !== WITH_REPLAYS), TEST_AFFECTED_OPTIONS)['--base'] ?? DEFAULT_AFFECTED_BASE;
  if (base.startsWith('-')) throw new writers.Usage(`keel test --affected [${WITH_REPLAYS}] [--base <ref>]`);
  const repoRoot = gitcmd.toplevel(process.cwd());
  if (repoRoot === null) throw new writers.Usage('keel test must run inside a git repository');
  const mergeBase = gitcmd.mergeBase(repoRoot, base, 'HEAD');
  if (mergeBase === null) throw new writers.Refused(`${base} has no merge base with HEAD`);
  const missingReplays = withReplays ? affected.missingReplayTests(repoRoot) : [];
  if (missingReplays.length > 0) {
    throw new writers.Refused(`${counted(missingReplays.length, 'replay test file')} ${missingReplays.length === 1 ? 'is' : 'are'} missing from this repo: ${missingReplays.join(', ')}`);
  }
  const changed = affected.changedSince(repoRoot, mergeBase);
  const reached = affected.affectedTests(repoRoot, changed);
  const replays = withReplays ? affected.REPLAY_TESTS.filter((test) => !reached.includes(test)) : [];
  if (reached.length === 0 && replays.length === 0) {
    printErrorLine(`keel test --affected: no test file reaches the ${counted(changed.length, 'changed path')}; run \`keel test -- <command>\` with a test that covers it`);
    return testrun.NO_TESTS_RECOGNIZED;
  }
  const verb = reached.length === 1 ? 'reaches' : 'reach';
  const plusReplays = withReplays ? `, plus ${counted(replays.length, 'replay test file')}` : '';
  const tests = [...reached, ...replays];
  printErrorLine(`keel test --affected: ${counted(reached.length, 'test file')} ${verb} ${counted(changed.length, 'changed path')}${plusReplays}\n${tests.join('\n')}`);
  const hookCode = affected.fullSuitePaths(changed);
  if (hookCode.length > 0 && !withReplays) {
    printErrorLine(`keel test --affected: code a hook runs changed (${hookCode.join(', ')}); also run \`keel test --affected ${WITH_REPLAYS}\` once, in the background alongside the root review`);
  }
  process.env['NODE_COMPILE_CACHE'] ||= join(env.stateDir(), 'node-compile-cache');
  return testrun.run([process.execPath, '--test', '--test-reporter=tap', ...tests], repoRoot);
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function review(rest: string[]): number {
  if (rest.length !== 1 || rest[0] !== 'prepare') throw new writers.Usage('keel review prepare reads workflow args from stdin');
  seams.print(prepare.review(stdinJson()));
  return EXIT_OK;
}

function precheck(rest: string[]): number | Promise<number> {
  if (rest[0] === 'run') return precheckRun(rest.slice(1));
  if (rest[0] === 'rerun') return precheckRerun(rest.slice(1));
  if (rest[0] === 'required') return precheckRequired(rest.slice(1));
  const options = rest[0] === 'bind' ? parseOptions(rest.slice(1), PRECHECK_BIND_OPTIONS) : {};
  if (Object.keys(options).length !== PRECHECK_BIND_OPTIONS.size) throw new writers.Usage('keel precheck bind --repo <path> --base <sha> --end <sha> --tree <precheck tree>');
  const repoRoot = gitcmd.toplevel(options['--repo']!);
  if (repoRoot === null) throw new writers.Usage(`${options['--repo']} is not inside a git repository`);
  seams.print(bindPrecheck(repoRoot, options['--base']!, options['--end']!, options['--tree']!));
  return EXIT_OK;
}

function precheckRequired(rest: string[]): number {
  const options = parseOptions(rest, PRECHECK_REQUIRED_OPTIONS);
  if (Object.keys(options).length !== PRECHECK_REQUIRED_OPTIONS.size) throw new writers.Usage('keel precheck required --repo <path> --base <sha> --end <sha>');
  const repoRoot = gitcmd.toplevel(options['--repo']!);
  if (repoRoot === null) throw new writers.Usage(`${options['--repo']} is not inside a git repository`);
  seams.print(precheckRequirement(repoRoot, options['--base']!, options['--end']!));
  return EXIT_OK;
}

async function precheckRun(rest: string[]): Promise<number> {
  const { options, base, repoRoot, reviewBase } = resolvePrecheckTarget(rest, PRECHECK_RUN_OPTIONS, 'keel precheck run --repo <path> --base <ref>');
  const { runCensus } = await loadNeedingTypescript(seams.loadCensus, 'run');
  requireTypecheck(repoRoot);
  const tree = gitcmd.snapshotTree(repoRoot);
  const census = await runCensus(repoRoot, { base, reviewBase, tree });
  printLine([renderCensus(census), ...ruleCheckLines(repoRoot, reviewBase, tree)].join('\n'));
  env.appendRecord(PRECHECK_LOG, { at: env.iso(env.utcNow()), repo: repoRoot, review_base: reviewBase, ...summarizeCensus(census) });
  return EXIT_OK;
}

async function precheckRerun(rest: string[]): Promise<number> {
  const { options, base, repoRoot, reviewBase } = resolvePrecheckTarget(rest, PRECHECK_RERUN_OPTIONS, 'keel precheck rerun --repo <path> --base <ref> --census <file>');
  const { censusBeforeRerun, RerunRefused, rerunSurvivors } = await loadNeedingTypescript(seams.loadRerun, 'rerun');
  requireTypecheck(repoRoot);
  const census = censusBeforeRerun(readCensusFile(options['--census']!));
  try {
    const rerun = await rerunSurvivors(repoRoot, { base, reviewBase, tree: gitcmd.snapshotTree(repoRoot) }, census);
    printLine([census, renderRerun(rerun)].join('\n'));
    env.appendRecord(PRECHECK_LOG, { at: env.iso(env.utcNow()), repo: repoRoot, review_base: reviewBase, ...summarizeRerun(rerun, base) });
    return EXIT_OK;
  } catch (error) {
    if (error instanceof RerunRefused) throw new writers.Refused(error.message);
    throw error;
  }
}

function readCensusFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new writers.Refused(`cannot read ${path}: ${(error as Error).message}`);
  }
}

function resolvePrecheckTarget(rest: string[], allowed: Set<string>, usage: string): { options: Record<string, string>; base: string; repoRoot: string; reviewBase: string } {
  const options = parseOptions(rest, allowed);
  const base = options['--base'];
  if (Object.keys(options).length !== allowed.size || base!.startsWith('-')) throw new writers.Usage(usage);
  const repoRoot = gitcmd.toplevel(options['--repo']!);
  if (repoRoot === null) throw new writers.Usage(`${options['--repo']} is not inside a git repository`);
  const reviewBase = gitcmd.mergeBase(repoRoot, base!, 'HEAD');
  if (reviewBase === null) throw new writers.Refused(`${base} has no merge base with HEAD`);
  return { options, base: base!, repoRoot, reviewBase };
}

function requireTypecheck(repoRoot: string): void {
  const typechecked = typecheck(repoRoot);
  if (!typechecked.ok) throw new writers.Refused(`tsc --noEmit failed in ${repoRoot}\n${typechecked.head}`);
}

async function loadNeedingTypescript<Module>(load: () => Promise<Module>, subcommand: string): Promise<Module> {
  try {
    return await load();
  } catch (error) {
    if (!seams.typescriptResolves()) throw new writers.Refused(`keel precheck ${subcommand} needs typescript; run npm ci in the keel checkout`);
    throw error;
  }
}

function typescriptResolves(): boolean {
  try {
    seams.resolveTypescript();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === MODULE_NOT_FOUND) return false;
    throw error;
  }
}

function approve(rest: string[]): number {
  if (rest[0] === '--promote') {
    if (rest.length !== 3) throw new writers.Usage(PROMOTE_USAGE);
    seams.print(writers.writePromoteApproval(rest[1]!, rest[2]!));
    return EXIT_OK;
  }
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
  } else if (subcommand === 'check') {
    if (optionNames.length !== 1 || !('--repo' in options)) throw new writers.Usage('check requires --repo and takes no other option');
    const readiness = pushReadiness(options['--repo']!);
    seams.print(readiness);
    return readiness['ok'] ? EXIT_OK : EXIT_NOT_READY;
  } else if (subcommand === 'show') {
    seams.print(show(options['--repo'] || process.cwd(), options['--root'] ?? null));
  } else if (subcommand === 'compatibility') {
    if (optionNames.length > 0) throw new writers.Usage('compatibility inventories all repositories; it takes no options');
    seams.print(compatibility());
  } else if (subcommand === 'promote-plan') {
    if (optionNames.length !== PROMOTE_PLAN_OPTIONS.length || !PROMOTE_PLAN_OPTIONS.every((name) => name in options)) {
      throw new writers.Usage('promote-plan requires --repo, --base and --head');
    }
    seams.print(promotePlan(options['--repo']!, options['--base']!, options['--head']!));
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

export function pushReadiness(repoPath: string): JsonObject {
  const repoRoot = gitcmd.toplevel(repoPath);
  if (repoRoot === null) throw new writers.Usage(`${repoPath} is not in a git repository`);
  const head = gitcmd.commitSha(repoRoot, 'HEAD');
  if (head === null) throw new writers.Usage(`${repoRoot} has no commit at HEAD`);
  const repoKey = registry.originKey(repoRoot);
  const row = registry.lookup(repoKey);
  if (!registry.isGated(row)) return { repo: repoKey, head, gated: false, ok: true, risk: null, root_run_id: null, reasons: [] };
  const baseRef = 'origin/' + row!.integrationBase;
  if (!gitcmd.refExists(repoRoot, 'refs/remotes/' + baseRef)) throw new writers.Usage(`base ${baseRef} is missing: run \`git fetch origin\``);
  const mergeBase = gitcmd.mergeBase(repoRoot, baseRef, head);
  if (mergeBase === null) throw new writers.Usage(`no merge base between ${baseRef} and HEAD`);
  const decision = verify.judge({
    repoRoot, repoKey: repoKey!, row: row!, head, mergeBase, needsApproval: registry.pushNeedsApproval(row!), promote: false,
  });
  return {
    repo: repoKey, head, gated: true, ok: decision.ok, risk: decision.riskClass, root_run_id: decision.rootRunId,
    reasons: decision.reasons.map((reason) => ({ rule_id: reason.ruleId, text: reason.text })),
  };
}

export function promotePlan(repoPath: string, base: string, head: string): JsonObject {
  const repoRoot = gitcmd.toplevel(repoPath);
  const repoKey = repoRoot ? registry.originKey(repoRoot) : null;
  const row = registry.lookup(repoKey);
  if (repoRoot === null || repoKey === null || !registry.isGated(row)) throw new writers.Usage(`${repoPath} is not a clone of a gated repo`);
  const headSha = gitcmd.commitSha(repoRoot, head);
  const mergeBase = headSha === null ? null : gitcmd.mergeBase(repoRoot, base, headSha);
  if (headSha === null || mergeBase === null) throw new writers.Usage(`no merge base between ${base} and ${head}`);
  const plan = verify.promotePlan({ repoRoot, repoKey, row: row!, head: headSha, mergeBase, needsApproval: true, promote: true });
  return { repo: repoKey, merge_base: mergeBase, head: headSha, steps: plan.steps, uncovered: plan.uncovered };
}

export function compatibility(): JsonObject {
  let count = 0;
  const roots: string[] = [];
  for (const key of store.repoKeys('review')) {
    const reviews = store.loadReviews(key);
    const old = new Set(reviews
      .filter((item) => item.review_kind === codexReview.KIND && (item.source || {})['version'] !== 2)
      .map((item) => item.evidence_id));
    count += old.size;
    roots.push(...buildChains(reviews).filter((chain) => chain.links.some((link) => old.has(link.evidence_id))).map((chain) => chain.rootRunId));
  }
  return { read_only_records: count, chain_roots: [...new Set(roots)].sort(compareCodePoints), reader_removable: count === 0 && roots.length === 0 };
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
    request = parseJsonKeepingIntegers(readStdinText());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidUtf8Error) {
      throw new writers.Usage(`stdin is not JSON: ${(error as Error).message}`);
    }
    throw error;
  }
  if (!isJsonObject(request)) throw new writers.Usage('stdin must be a JSON object');
  return request;
}

function printResult(payload: JsonObject): void {
  printLine(stringifySorted(payload));
}
