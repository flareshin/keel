import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { stringifySorted } from '../../measure/lib/measurekit/json.ts';
import * as registry from '../../lib/evidence/registry.ts';
import * as store from '../../lib/evidence/store.ts';
import * as verify from '../../lib/evidence/verify.ts';
import { materialize } from '../recorded-cases.ts';
import type { SnapshotStore } from '../recorded-cases.ts';
import { KEEL_HOME, LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Repo, Run } from './helpers.ts';
import { canonicalText, readFixture } from './outcomes.ts';

const FIXED_COMMIT_DATE = '2026-01-01T00:00:00Z';
const NON_ASCII_PATHS = { 'src/é😀 "q".py': 'print("é")\n', 'src/plain.py': 'print(1)\n', 'tests/test_plain.py': 'def test_a():\n    assert True\n' };

class Pipeline {
  sandbox: Sandbox;
  repo: Repo;
  dataDir: string;
  outputs: string[] = [];

  constructor(sandbox: Sandbox, repo: Repo, dataDir: string) {
    this.sandbox = sandbox;
    this.repo = repo;
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
  }

  use(): Sandbox {
    this.sandbox.env['KEEL_DATA_DIR'] = this.dataDir;
    this.sandbox.data = this.dataDir;
    return this.sandbox;
  }

  step(label: string, action: (sandbox: Sandbox) => Run): any {
    const run = action(this.use());
    assert.equal(run.rc, 0, `${label}: ${run.stderr}`);
    this.outputs.push(`${label}\n${run.stdout}${run.rc}`);
    return run.stdout.trim().startsWith('{') ? run.json : null;
  }
}

function runPipeline(pipeline: Pipeline): void {
  const { repo } = pipeline;
  const rootTree = pipeline.step('snapshot', (box) => box.keel(['snapshot', repo.path])).tree;
  pipeline.step('write-review root', (box) => box.keel(['evidence', 'write-review'], { stdin: JSON.stringify(box.reviewRequest(repo)) }));
  repo.commit({ 'src/extra.py': 'print(2)\n' }, 'second');
  pipeline.step('write-review delta', (box) => box.keel(['evidence', 'write-review'], {
    stdin: JSON.stringify(box.reviewRequest(repo, { runId: 'rv-delta-0002', rootRunId: 'rv-root-0001', since: rootTree })),
  }));
  pipeline.step('test', (box) => box.keel(['test', '--', 'bash', '-c', "echo 'Ran 3 tests'; echo OK"], { cwd: repo.path }));
  pipeline.step('write-smoke', (box) => {
    box.smokeLine(repo);
    return box.keel(['evidence', 'write-smoke', '--repo', repo.path]);
  });
  pipeline.step('ack', (box) => box.keel(['approve', 'rv-root-0001', '--read']));
  pipeline.step('approve', (box) => box.keel(['approve', 'rv-root-0001']));
}

function judge(dataDir: string, sandbox: Sandbox, repo: Repo, head: string, base: string, needsApproval: boolean): string {
  const previous = process.env['KEEL_DATA_DIR'];
  const previousOverlay = process.env['KEEL_OVERLAY_DIR'];
  process.env['KEEL_DATA_DIR'] = dataDir;
  process.env['KEEL_OVERLAY_DIR'] = sandbox.overlay;
  try {
    const row = registry.gatedRepos().get(repo.key)!;
    const decision = verify.judge({ repoRoot: repo.path, repoKey: repo.key, row, head, mergeBase: base, needsApproval });
    return stringifySorted({
      ok: decision.ok, reasons: decision.reasons.map((reason) => [reason.ruleId, reason.text]), risk_class: decision.riskClass,
      root_run_id: decision.rootRunId, files: decision.files, lines: decision.lines, k3_waiver: decision.k3Waiver,
      root_run_ids: decision.rootRunIds,
    });
  } finally {
    if (previous === undefined) delete process.env['KEEL_DATA_DIR'];
    else process.env['KEEL_DATA_DIR'] = previous;
    if (previousOverlay === undefined) delete process.env['KEEL_OVERLAY_DIR'];
    else process.env['KEEL_OVERLAY_DIR'] = previousOverlay;
  }
}

const STACK_SEED = { 'README.md': 'top\n\n\n\n\nbottom\n' };
const TOP_CHANGED = { 'README.md': 'top changed\n\n\n\n\nbottom\n' };
const BOTTOM_CHANGED = [{ 'README.md': 'top\n\n\n\n\nbottom changed\n' }];
const TOP_REWORDED = [{ 'README.md': 'top reworded\n\n\n\n\nbottom\n' }];
const OVERLAP_STACKED = { 'README.md': 'top changed and reworded\n\n\n\n\nbottom\n' };
const SMOKE_REGISTRY = ['acme/app\tsmoke\tmain\t-\tnone'];
const NO_TESTS_REGISTRY = ['acme/app\tcode\tmain\tacme\tnone'];

interface Expectation {
  ok: boolean;
  reason?: string;
  rootRunIds?: string[];
  k3Waiver?: string;
}

const EVIDENCE_ID = /\b(review|tests|smoke|approval|ack)-\d{8}T\d{6}Z-[0-9a-f]{8}\b/g;

function withoutEvidenceIds(judgement: string): string {
  return judgement.replace(EVIDENCE_ID, '<EVIDENCE_ID>');
}

function withoutChainChoice(judgement: string): string {
  const { ok, files, lines, risk_class: riskClass, k3_waiver: k3Waiver, reasons } = JSON.parse(judgement);
  return JSON.stringify({ ok, files, lines, riskClass, k3Waiver, denied: reasons.length > 0 });
}

function judgedAsRecorded(sandbox: Sandbox, repo: Repo, label: string, needsApproval: boolean, expected: Expectation, chainOrderDependent = false): void {
  const base = repo.git('merge-base', 'origin/main', 'HEAD');
  const comparable = chainOrderDependent ? withoutChainChoice : withoutEvidenceIds;
  const recorded = readFixture<{ judge: Record<string, string> }>('cross-impl.json', sandbox.root).judge[label]!;
  const typescript = judge(sandbox.data, sandbox, repo, repo.head(), base, needsApproval);
  assert.equal(comparable(typescript), comparable(recorded), label);
  assert.equal(JSON.parse(typescript).ok, expected.ok, `${label}: ${typescript}`);
  const decision = JSON.parse(chainOrderDependent ? recorded : typescript);
  assert.equal(decision.ok, expected.ok, `${label}: ${recorded}`);
  if (expected.reason !== undefined) {
    assert.ok(decision.reasons.some(([, text]: [string, string]) => text.includes(expected.reason!)), `${label}: ${recorded}`);
  }
  if (expected.rootRunIds !== undefined) assert.deepEqual(decision.root_run_ids, expected.rootRunIds, label);
  if (expected.k3Waiver !== undefined) assert.equal(decision.k3_waiver, expected.k3Waiver, label);
}

function adjacentReviews(sandbox: Sandbox, repo: Repo, options: { approveFirst?: boolean; gap?: boolean } = {}): void {
  repo.branch('feature');
  const base = repo.head();
  repo.commit({ ...LOGIC_WITH_TEST, 'src/first.py': 'first = 1\n' });
  sandbox.review(repo, { runId: 'rv-series-0001', reviewBase: base });
  if (options.approveFirst !== false) sandbox.approve('rv-series-0001');
  if (options.gap) repo.commit({ 'src/gap.py': 'unreviewed = True\n' });
  const boundary = repo.head();
  repo.commit({ 'src/a.py': 'print(2)\n', 'src/second.py': 'second = 2\n' });
  sandbox.review(repo, { runId: 'rv-series-0002', reviewBase: boundary });
  sandbox.approve('rv-series-0002');
  sandbox.testsEvidence(repo);
}

function stackedChains(sandbox: Sandbox, repo: Repo, firstFiles: Record<string, string>, secondCommits: Array<Record<string, string>>,
  stackedFiles?: Record<string, string>): void {
  const base = repo.head();
  repo.branch('first');
  repo.commit({ ...LOGIC_WITH_TEST, ...firstFiles });
  sandbox.review(repo, { runId: 'rv-stack-0001', reviewBase: base });
  sandbox.approve('rv-stack-0001');
  repo.branch('second', base);
  for (const files of secondCommits) repo.commit(files);
  const second = repo.head();
  sandbox.review(repo, { runId: 'rv-stack-0002', reviewBase: base });
  sandbox.approve('rv-stack-0002');
  repo.branch('feature', 'first');
  if (stackedFiles) repo.commit(stackedFiles);
  else repo.git('cherry-pick', `${base}..${second}`);
  sandbox.testsEvidence(repo);
}

function featureWithEvidence(sandbox: Sandbox, files: Record<string, string>, review: { kind?: string; noTestReason?: string } = {}): Repo {
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(files);
  sandbox.review(repo, review);
  sandbox.approve('rv-root-0001');
  return repo;
}

function normalize(text: string, dataDir: string): string {
  return text.replaceAll(dataDir, '<DATA>')
    .replace(/\b(review|tests|smoke|approval|ack)-\d{8}T\d{6}Z-[0-9a-f]{8}\b/g, '<EVIDENCE_ID>')
    .replace(/\btr-\d{8}T\d{6}Z-[0-9a-f]{6}\b/g, '<RUN_ID>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, '<TIME>');
}

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

function normalizedTree(dataDir: string, subdirectory: string): Array<[string, string]> {
  return filesUnder(join(dataDir, subdirectory))
    .filter((path) => !path.includes(join(dataDir, 'projects')))
    .map((path): [string, string] => [normalize(relative(dataDir, path), dataDir).replace(/-<EVIDENCE_ID>/g, ''), normalize(readFileSync(path, 'utf8'), dataDir)])
    .sort((left, right) => (left[0] + left[1] < right[0] + right[1] ? -1 : 1));
}

function treeOrEmpty(dataDir: string, subdirectory: string): Array<[string, string]> {
  try {
    return normalizedTree(dataDir, subdirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function prepare(t: TestContext) {
  const sandbox = new Sandbox(t);
  sandbox.env['GIT_AUTHOR_DATE'] = '2026-01-01T00:00:00Z';
  sandbox.env['GIT_COMMITTER_DATE'] = '2026-01-01T00:00:00Z';
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(NON_ASCII_PATHS, 'first');
  return { sandbox, repo };
}

function scenarioSandbox(t: TestContext, registry?: string[]): Sandbox {
  const sandbox = new Sandbox(t, registry);
  sandbox.env['GIT_AUTHOR_DATE'] = FIXED_COMMIT_DATE;
  sandbox.env['GIT_COMMITTER_DATE'] = FIXED_COMMIT_DATE;
  return sandbox;
}

function assertEvidenceModes(dataDir: string): void {
  for (const path of filesUnder(join(dataDir, 'state', 'keel', 'evidence'))) {
    assert.equal(statSync(path).mode & 0o777, 0o600, path);
    assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700, path);
  }
}

interface CliOutcome {
  args: string[];
  stdin: string | null;
  rc: number;
  stdout: string;
  stderr?: string;
  errorCode?: string;
  stdinNotJson?: boolean;
}

interface WrittenEvidence {
  outputs: string[];
  state: Array<[string, string]>;
  logs: Array<[string, string]>;
}

function writtenByTypescript(sandbox: Sandbox, repo: Repo): WrittenEvidence {
  const pipeline = new Pipeline(sandbox, repo, join(sandbox.root, 'data-ts'));
  runPipeline(pipeline);
  repo.git('reset', '-q', '--hard', 'HEAD~1');
  assertEvidenceModes(pipeline.dataDir);
  return {
    outputs: pipeline.outputs.map((text) => normalize(text, pipeline.dataDir)),
    state: normalizedTree(pipeline.dataDir, 'state'),
    logs: normalizedTree(pipeline.dataDir, 'logs'),
  };
}

interface EvidenceFacts {
  judged: string[];
  cli: Array<[number, string]>;
}

interface PythonWrittenEvidence extends EvidenceFacts {
  store: SnapshotStore;
  snapshot: string;
}

function inspectEvidence(sandbox: Sandbox, repo: Repo, mixed: Pipeline): EvidenceFacts {
  const head = repo.head();
  const base = repo.git('merge-base', 'origin/main', 'HEAD');
  repo.commit({ 'src/unreviewed.py': 'print(3)\n' }, 'unreviewed');
  const states: Array<[string, string, boolean]> = [[head, base, true], [head, base, false], [repo.head(), base, true], [base, base, true]];
  const judged = states.map(([stateHead, stateBase, needsApproval]) => judge(mixed.dataDir, sandbox, repo, stateHead, stateBase, needsApproval));
  const probes = [['evidence', 'show', '--repo', repo.path], ['evidence', 'compatibility'], ['evidence', 'gc'], ['snapshot', repo.path]];
  const cli = probes.map((args): [number, string] => {
    const run = mixed.use().keel(args);
    return [run.rc, run.stdout];
  });
  return { judged, cli };
}

describe('cross-implementation evidence compatibility', () => {
  test('written evidence has the recorded field names and values modulo ids and times', (t) => {
    const { sandbox, repo } = prepare(t);
    const recorded = readFixture<{ pipeline: WrittenEvidence }>('cross-impl.json', sandbox.root).pipeline;
    const written = writtenByTypescript(sandbox, repo);
    const canonical = (files: Array<[string, string]>) => files.map(([path, text]): [string, string] => [path, canonicalText(text)]);

    assert.deepEqual(written.outputs.map(canonicalText), recorded.outputs);
    for (const [subdirectory, minimum] of [['state', 6], ['logs', 2]] as const) {
      assert.ok(recorded[subdirectory].length >= minimum, `${subdirectory}: ${recorded[subdirectory].length} files`);
      assert.deepEqual(canonical(written[subdirectory]), recorded[subdirectory]);
    }
  });

  test('evidence written by the recorded python run is read and judged as recorded', (t) => {
    const { sandbox, repo } = prepare(t);
    const mixed = new Pipeline(sandbox, repo, join(sandbox.root, 'data-mixed'));
    const recorded = readFixture<{ pythonWrittenStore: PythonWrittenEvidence }>('cross-impl.json', sandbox.root).pythonWrittenStore;
    rmSync(sandbox.root, { recursive: true, force: true });
    materialize(recorded.store, recorded.snapshot, sandbox.root);

    const files = filesUnder(join(mixed.dataDir, 'state', 'keel', 'evidence')).filter((path) => path.endsWith('.json'));
    assert.ok(files.length >= 6);
    for (const path of files) assert.equal(typeof store.readFile(path).expires_at, 'string', path);

    const facts = inspectEvidence(sandbox, repo, mixed);
    assert.deepEqual(facts.judged.map(canonicalText), recorded.judged);
    assert.deepEqual(facts.cli.map(([rc, stdout]) => [rc, canonicalText(stdout)]), recorded.cli);
    assert.equal(JSON.parse(facts.judged[0]!).ok, true, facts.judged[0]);
    assert.equal(JSON.parse(facts.judged[2]!).ok, false, facts.judged[2]);
    const shown = mixed.use().keel(['evidence', 'show', '--repo', repo.path]).json;
    assert.deepEqual(shown.chains.map((chain: any) => [chain.root_run_id, chain.verdict, chain.paths, chain.approved, chain.acked]),
      [['rv-root-0001', 'PASS', 4, true, true]]);
  });

  describe('verify.judge parity on evidence scenarios', () => {

    test('two adjacent approved reviews are reused as a series', (t) => {
      const sandbox = scenarioSandbox(t);
      const repo = sandbox.clone('acme', 'app');
      adjacentReviews(sandbox, repo);
      judgedAsRecorded(sandbox, repo, 'series approved', true, { ok: true, rootRunIds: ['rv-series-0001', 'rv-series-0002'] });
      judgedAsRecorded(sandbox, repo, 'series without approval requirement', false, { ok: true, rootRunIds: ['rv-series-0001', 'rv-series-0002'] });
    });

    test('an unapproved first review or an unreviewed gap breaks the series', (t) => {
      const unapproved = scenarioSandbox(t);
      const unapprovedRepo = unapproved.clone('acme', 'app');
      adjacentReviews(unapproved, unapprovedRepo, { approveFirst: false });
      judgedAsRecorded(unapproved, unapprovedRepo, 'first review not approved', true, { ok: false }, true);
      const gapped = scenarioSandbox(t);
      const gappedRepo = gapped.clone('acme', 'app');
      adjacentReviews(gapped, gappedRepo, { gap: true });
      judgedAsRecorded(gapped, gappedRepo, 'gap between reviews', true, { ok: false, reason: 'src/gap.py' }, true);
    });

    test('parallel approved chains stacked by rebase are accepted, also on disjoint hunks of one file; overlapping ones name the commit to review', (t) => {
      const stacked = scenarioSandbox(t);
      const stackedRepo = stacked.clone('acme', 'app', undefined, STACK_SEED);
      stackedChains(stacked, stackedRepo, { 'src/first.py': 'first = 1\n' }, [{ 'src/second.py': 'second = 2\n' }]);
      judgedAsRecorded(stacked, stackedRepo, 'stacked chains', true, { ok: true, rootRunIds: ['rv-stack-0001', 'rv-stack-0002'] }, true);
      const disjoint = scenarioSandbox(t);
      const disjointRepo = disjoint.clone('acme', 'app', undefined, STACK_SEED);
      stackedChains(disjoint, disjointRepo, TOP_CHANGED, BOTTOM_CHANGED);
      judgedAsRecorded(disjoint, disjointRepo, 'disjoint stacked chains', true, { ok: true, rootRunIds: ['rv-stack-0001', 'rv-stack-0002'] }, true);
      const overlapping = scenarioSandbox(t);
      const overlappingRepo = overlapping.clone('acme', 'app', undefined, STACK_SEED);
      stackedChains(overlapping, overlappingRepo, TOP_CHANGED, TOP_REWORDED, OVERLAP_STACKED);
      judgedAsRecorded(overlapping, overlappingRepo, 'overlapping stacked chains', true, { ok: false, reason: 'no review saw the stacked content' }, true);
    });

    test('a smoke-gated row needs smoke evidence covering the tree', (t) => {
      const sandbox = scenarioSandbox(t, SMOKE_REGISTRY);
      const repo = sandbox.clone('acme', 'app');
      repo.branch('feature');
      repo.commit({ 'src/new.py': 'new = 1\n' });
      judgedAsRecorded(sandbox, repo, 'smoke missing', true, { ok: false, reason: 'no smoke evidence covers this exact content' });
      sandbox.smokeEvidence(repo);
      judgedAsRecorded(sandbox, repo, 'smoke present', true, { ok: true });
    });

    test('a tests=none row denies a standard change and passes a light one', (t) => {
      const standard = scenarioSandbox(t, NO_TESTS_REGISTRY);
      const standardRepo = featureWithEvidence(standard, LOGIC_WITH_TEST);
      judgedAsRecorded(standard, standardRepo, 'tests=none standard', true, { ok: false, reason: 'add test infrastructure first' });
      const light = scenarioSandbox(t, NO_TESTS_REGISTRY);
      const lightRepo = featureWithEvidence(light, { 'docs/guide.md': 'light\n' });
      judgedAsRecorded(light, lightRepo, 'tests=none light', true, { ok: true });
    });

    test('a logic change without a test in the same range is denied unless the reviewer states why', (t) => {
      const bare = scenarioSandbox(t);
      const bareRepo = featureWithEvidence(bare, { 'src/a.py': 'print(1)\n' });
      bare.testsEvidence(bareRepo);
      judgedAsRecorded(bare, bareRepo, 'K3 same range', true, { ok: false, reason: 'logic changed with no test in the same range' });
      const waived = scenarioSandbox(t);
      const waivedRepo = featureWithEvidence(waived, { 'src/a.py': 'print(1)\n' }, { noTestReason: 'covered by the integration suite' });
      waived.testsEvidence(waivedRepo);
      judgedAsRecorded(waived, waivedRepo, 'K3 waiver', true, { ok: true, k3Waiver: 'covered by the integration suite' });
    });

    test('a chain with a single-lens link is denied even for a light change', (t) => {
      const sandbox = scenarioSandbox(t, NO_TESTS_REGISTRY);
      const repo = featureWithEvidence(sandbox, { 'docs/guide.md': 'light\n' }, { kind: 'single-lens' });
      judgedAsRecorded(sandbox, repo, 'single-lens', true, { ok: false, reason: 'every change needs a lens-review chain' });
    });
  });

  test('review prepare echoes the numbers of the lens file with their values, and integers beyond 2^53 exactly', (t) => {
    const { sandbox, repo } = prepare(t);
    mkdirSync(join(sandbox.data, 'workflows'));
    writeFileSync(join(sandbox.data, 'workflows', 'review-lenses.json'),
      '{"guardrails": "g", "lenses": [{"name": "a", "weight": 1.0, "big": 9007199254740993, "tiny": 1e-7, "neg": -0.0, "wide": 1e16, "int": -0, "exp": 2E3}]}');
    const stdin = JSON.stringify({ diffs: [{ repo: repo.path, base: 'HEAD' }] });
    const run = sandbox.keel(['review', 'prepare'], { stdin });
    assert.equal(run.rc, 0, run.stderr);
    const echoed = /"lenses_output":(\{.*?\}\]\}),/.exec(run.stdout)![1];
    assert.equal(echoed, '{"guardrails":"g","lenses":[{"big":9007199254740993,"exp":2000,"int":0,"name":"a","neg":0,"tiny":1e-7,"weight":1,"wide":10000000000000000}]}');
  });

  test('write-review accepts the claim version when it is the JSON number 1 in any spelling', (t) => {
    const { sandbox, repo } = prepare(t);
    const base = JSON.stringify(sandbox.reviewRequest(repo));
    const writeReviews = (): Array<[number, string]> => {
      const outcomes: Array<[number, string]> = [];
      for (const token of ['1', '1.0', '1e0', '10e-1', 'true', '2.0', '0.5', '1.0000000000000001', '9007199254740993']) {
        const stdin = base.replace('"v":1,', `"v":${token},`);
        assert.ok(stdin.includes(`"v":${token},`), token);
        const run = sandbox.keel(['evidence', 'write-review'], { stdin });
        outcomes.push([run.rc, normalize(run.stderr, sandbox.data)]);
        if (run.rc === 0) rmSync(sandbox.evidenceFiles('review').at(-1)!);
      }
      return outcomes;
    };
    const outcomes = writeReviews();
    assert.deepEqual(outcomes.map(([rc]) => rc), [0, 0, 0, 0, 2, 2, 2, 0, 2]);
    for (const [rc, stderr] of outcomes) {
      if (rc === 2) assert.ok(stderr.startsWith('keel: keel_evidence.v must be 1\nusage:\n'), stderr);
    }
  });

  test('keel test reads output until every holder of the shared descriptor closes it', (t) => {
    const { sandbox, repo } = prepare(t);
    const scripts = [
      "(sleep 1; echo 'Ran 3 tests') &",
      "(sleep 1; echo 'Ran 3 tests') & exit 3",
      "(sleep 1; echo 'Ran 3 tests' >&2) & echo foreground; exit 0",
    ];
    const outcomeOf = () => {
      sandbox.data = join(sandbox.root, 'data-background-ts');
      sandbox.env['KEEL_DATA_DIR'] = sandbox.data;
      mkdirSync(sandbox.data);
      const runs = scripts.map((script) => {
        const run = sandbox.keel(['test', '--', 'bash', '-c', script], { cwd: repo.path });
        return [run.rc, normalize(run.stdout, sandbox.data), normalize(run.stderr, sandbox.data)];
      });
      return { runs, state: treeOrEmpty(sandbox.data, 'state'), logs: treeOrEmpty(sandbox.data, 'logs') };
    };
    const recorded = readFixture<{ backgroundHolders: ReturnType<typeof outcomeOf> }>('cross-impl.json', sandbox.root).backgroundHolders;
    const outcome = outcomeOf();
    assert.deepEqual(outcome.runs.map(([rc, stdout, stderr]) => [rc, stdout, canonicalText(stderr as string)]), recorded.runs);
    assert.deepEqual(outcome.state.map(([path, text]) => [path, canonicalText(text)]), recorded.state);
    assert.deepEqual(outcome.logs.map(([path, text]) => [path, canonicalText(text)]), recorded.logs);
    assert.deepEqual(recorded.runs.map(([rc]) => rc), [0, 3, 0]);
    assert.match(String(recorded.runs[0]![1]), /^Ran 3 tests\n$/);
    assert.equal(recorded.state.length, 2);
  });

  test('file system failures in the evidence store and in spawning are reported with the error code', (t) => {
    const { sandbox, repo } = prepare(t);
    const busy = repo.write('busy.sh', "#!/bin/sh\necho 'Ran 3 tests'\n", true);
    const holder = openSync(busy, 'r+');
    t.after(() => closeSync(holder));
    const executingBusyFileFails = process.platform !== 'darwin';
    if (!executingBusyFileFails) t.diagnostic('ETXTBSY case skipped: darwin lets a file open for writing execute');
    const testsDirectory = (dataDir: string) => join(dataDir, 'state', 'keel', 'evidence', 'tests', 'acme__app');
    const badFile = '<DATA>/state/keel/evidence/tests/acme__app/bad\\.json';
    const cases = [
      { label: 'directory in place of an evidence file (EISDIR)', args: ['evidence', 'gc'], cwd: undefined, rc: 0, stdout: '{"deleted":0}\n',
        stderr: new RegExp(`^keel evidence gc: skipped unreadable evidence ${badFile}: EISDIR`),
        setup: (dataDir: string) => mkdirSync(join(testsDirectory(dataDir), 'bad.json'), { recursive: true }) },
      { label: 'unreadable evidence file (EACCES)', args: ['evidence', 'gc'], cwd: undefined, rc: 0, stdout: '{"deleted":0}\n',
        stderr: new RegExp(`^keel evidence gc: skipped unreadable evidence ${badFile}: EACCES`),
        setup: (dataDir: string) => {
          mkdirSync(testsDirectory(dataDir), { recursive: true });
          writeFileSync(join(testsDirectory(dataDir), 'bad.json'), '{}', { mode: 0o000 });
        } },
      { label: 'file in place of the evidence directory (EEXIST)', args: ['test', '--', 'bash', '-c', "echo 'Ran 3 tests'"], cwd: repo.path, rc: 70, stdout: 'Ran 3 tests\n',
        stderr: /^keel: internal error: Error: EEXIST: file already exists, mkdir '<DATA>\/state\/keel\/evidence\/tests\/acme__app'\n$/,
        setup: (dataDir: string) => {
          mkdirSync(dirname(testsDirectory(dataDir)), { recursive: true });
          writeFileSync(testsDirectory(dataDir), 'not a directory');
        } },
      ...(executingBusyFileFails ? [{ label: 'script open for writing (ETXTBSY)', args: ['test', '--', './busy.sh'], cwd: repo.path, rc: 70, stdout: '',
        stderr: /^keel: internal error: Error: cannot run \.\/busy\.sh: spawn (?:\S+ )?ETXTBSY\n$/, setup: () => undefined }] : []),
    ];
    for (const [index, item] of cases.entries()) {
      sandbox.data = join(sandbox.root, `data-os-ts-${index}`);
      sandbox.env['KEEL_DATA_DIR'] = sandbox.data;
      mkdirSync(sandbox.data);
      item.setup(sandbox.data);
      const run = sandbox.keel(item.args, { cwd: item.cwd });
      assert.equal(run.rc, item.rc, item.label);
      assert.equal(normalize(run.stdout, sandbox.data), item.stdout, item.label);
      assert.match(normalize(run.stderr, sandbox.data), item.stderr, item.label);
    }
  });

  test('keel test does not depend on the caller PATH for mkfifo', (t) => {
    const { sandbox, repo } = prepare(t);
    const tools = join(sandbox.root, 'tools-without-mkfifo');
    mkdirSync(tools);
    for (const name of ['git', 'sed', 'basename', 'uname', 'bash']) {
      const located = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(located, join(tools, name));
    }
    sandbox.env['PATH'] = tools;
    const outcomeOf = () => {
      sandbox.data = join(sandbox.root, 'data-no-mkfifo-ts');
      sandbox.env['KEEL_DATA_DIR'] = sandbox.data;
      mkdirSync(sandbox.data);
      sandbox.runner = [process.execPath, join(KEEL_HOME, 'bin', 'keel.ts')];
      const run = sandbox.keel(['test', '--', '/bin/echo', 'Ran 1 test'], { cwd: repo.path });
      return { run: [run.rc, normalize(run.stdout, sandbox.data), normalize(run.stderr, sandbox.data)], recorded: sandbox.evidenceFiles('tests').length };
    };
    const recorded = readFixture<{ noMkfifo: ReturnType<typeof outcomeOf> }>('cross-impl.json', sandbox.root).noMkfifo;
    const outcome = outcomeOf();
    assert.deepEqual([outcome.run[0], outcome.run[1], canonicalText(outcome.run[2] as string)], recorded.run);
    assert.equal(outcome.recorded, recorded.recorded);
    assert.deepEqual(recorded.run.slice(0, 2), [0, 'Ran 1 test\n']);
    assert.equal(recorded.recorded, 1);
  });

  test('cli error paths end with the recorded exit code, output and refusal text', (t) => {
    const { sandbox, repo } = prepare(t);
    sandbox.data = join(sandbox.root, 'data-errors');
    sandbox.env['KEEL_DATA_DIR'] = sandbox.data;
    mkdirSync(sandbox.data);
    repo.write('no-shebang.sh', "echo 'Ran 3 tests'\n", true);
    repo.write('empty.sh', '', true);
    repo.write('not-executable.sh', "#!/bin/sh\necho 'Ran 3 tests'\n");
    repo.write('missing-interpreter.sh', "#!/nonexistent/interpreter\necho 'Ran 3 tests'\n", true);
    repo.write('empty-interpreter.sh', "#!\necho 'Ran 3 tests'\n", true);
    repo.write('crlf.sh', "#!/bin/sh\r\necho 'Ran 3 tests'\r\n", true);
    repo.write('data-interpreter.sh', "#!/etc/hosts\necho 'Ran 3 tests'\n", true);
    repo.write('ok-interpreter.sh', "#!/bin/sh\necho 'Ran 3 tests'\n", true);
    repo.write('padded-interpreter.sh', "#! \t/bin/sh\necho 'Ran 3 tests'\n", true);
    symlinkSync('loop-b.sh', join(repo.path, 'loop-a.sh'));
    symlinkSync('loop-a.sh', join(repo.path, 'loop-b.sh'));
    const executeOnly = join(sandbox.root, 'execute-only');
    const compiled = spawnSync('cc', ['-x', 'c', '-o', executeOnly, '-'], { input: '#include <stdio.h>\nint main(void) { puts("Ran 2 tests"); return 0; }\n' });
    if (compiled.status === 0) chmodSync(executeOnly, 0o111);
    else t.diagnostic('execute-only binary case skipped: no working cc');
    const searchFirst = join(sandbox.root, 'search-first');
    const searchSecond = join(sandbox.root, 'search-second');
    for (const directory of [searchFirst, searchSecond]) mkdirSync(directory);
    writeFileSync(join(searchFirst, 'both'), "echo 'Ran 3 tests'\n", { mode: 0o644 });
    writeFileSync(join(searchSecond, 'both'), "echo 'Ran 3 tests'\n", { mode: 0o755 });
    writeFileSync(join(searchFirst, 'later'), "echo 'Ran 3 tests'\n", { mode: 0o755 });
    writeFileSync(join(searchSecond, 'later'), "#!/bin/sh\necho 'Ran 3 tests'\n", { mode: 0o755 });
    sandbox.env['PATH'] = [searchFirst, searchSecond, sandbox.env['PATH']].join(':');
    const cases: Array<{ args: string[]; stdin?: string; cwd?: string }> = [
      { args: [] }, { args: ['bogus'] }, { args: ['test', 'x'] }, { args: ['test', '--'] }, { args: ['approve'] }, { args: ['approve', 'x'] },
      { args: ['approve', 'rv-none-0001'] }, { args: ['approve', 'rv-none-0001', '--bogus'] }, { args: ['snapshot'] }, { args: ['snapshot', sandbox.home] },
      { args: ['evidence'] }, { args: ['evidence', 'bogus'] }, { args: ['evidence', 'show', '--bogus'] }, { args: ['evidence', 'show', '--repo'] },
      { args: ['evidence', 'show', '--repo', sandbox.home] }, { args: ['evidence', 'compatibility', '--repo', repo.path] },
      { args: ['evidence', 'record-codex'] }, { args: ['evidence', 'record-codex', '--repo', repo.path] },
      { args: ['evidence', 'record-codex', '--repo', repo.path, '--audits', 'not-a-uuid'] },
      { args: ['evidence', 'write-review'], stdin: '' }, { args: ['evidence', 'write-review'], stdin: '{"a":' }, { args: ['evidence', 'write-review'], stdin: '[1]' },
      { args: ['evidence', 'write-review'], stdin: '1.0' }, { args: ['evidence', 'write-review'], stdin: '[1.0, 2.5]' }, { args: ['evidence', 'write-review'], stdin: '-0.0' },
      { args: ['evidence', 'write-review'], stdin: '1e400' }, { args: ['evidence', 'write-review'], stdin: '{"keel_evidence": 1.0, "verdict": "PASS"}' },
      { args: ['evidence', 'write-review'], stdin: '{"diffs": [{"repo": 1.0}]}' },
      { args: ['evidence', 'write-review'], stdin: '{"a":1}\r\n,' }, { args: ['evidence', 'write-review'], stdin: '{"keel_evidence": {}}' },
      { args: ['evidence', 'write-review'], stdin: '{"keel_evidence": 1, "verdict": "PASS"}' }, { args: ['evidence', 'write-smoke', '--repo', repo.path] },
      { args: ['evidence', 'write-smoke', '--repo', repo.path, '--run', 'nope'] }, { args: ['review'] }, { args: ['review', 'prepare'], stdin: '{}' },
      { args: ['review', 'prepare'], stdin: '{"diffs": [{"repo": "/nonexistent", "base": "main"}], "lenses": []}' },
      { args: ['review', 'prepare'], stdin: '{"diffs": [{"repo": "x", "extra": 1}], "lenses": []}' }, { args: ['test', '--', 'definitely-not-a-command-xyz'], cwd: repo.path },
      { args: ['test', '--', 'bash', '-c', 'exit 7'], cwd: repo.path },
      { args: ['test', '--', 'bash', '-c', "echo out; echo err >&2; echo 'Ran 2 tests'; echo more >&2"], cwd: repo.path },
      { args: ['test', '--', 'bash', '-c', 'echo partial; kill -TERM $$'], cwd: repo.path },
      { args: ['test', '--', 'bash', '-c', "printf 'no newline Ran 4 tests'"], cwd: repo.path }, { args: ['test', '--', 'true'], cwd: sandbox.home },
      { args: ['test', '--', './no-shebang.sh'], cwd: repo.path }, { args: ['test', '--', './empty.sh'], cwd: repo.path },
      { args: ['test', '--', './not-executable.sh'], cwd: repo.path }, { args: ['test', '--', './missing-interpreter.sh'], cwd: repo.path },
      ...(compiled.status === 0 ? [{ args: ['test', '--', executeOnly], cwd: repo.path }] : []), { args: ['test', '--', './empty-interpreter.sh'], cwd: repo.path },
      { args: ['test', '--', './crlf.sh'], cwd: repo.path }, { args: ['test', '--', './data-interpreter.sh'], cwd: repo.path },
      { args: ['test', '--', './ok-interpreter.sh'], cwd: repo.path }, { args: ['test', '--', './padded-interpreter.sh'], cwd: repo.path },
      { args: ['test', '--', './no-shebang.sh/x'], cwd: repo.path }, { args: ['test', '--', '.'], cwd: repo.path },
      { args: ['test', '--', './loop-a.sh'], cwd: repo.path }, { args: ['test', '--', './' + 'n'.repeat(300)], cwd: repo.path },
      { args: ['test', '--', 'both'], cwd: repo.path }, { args: ['test', '--', 'later'], cwd: repo.path }, { args: ['test', '--', ''], cwd: repo.path },
    ];
    const recorded = readFixture<{ cliOutcomes: CliOutcome[] }>('cross-impl.json', sandbox.root).cliOutcomes;
    assert.ok(recorded.length >= cases.length, `${recorded.length} recorded outcomes for ${cases.length} cases`);
    for (const item of cases) {
      const expected = recorded.find((outcome) => isDeepStrictEqual(outcome.args, item.args) && (outcome.stdin ?? undefined) === item.stdin);
      assert.ok(expected, `no recorded outcome for ${JSON.stringify(item.args)}`);
      const run = sandbox.keel(item.args, { stdin: item.stdin, cwd: item.cwd });
      const label = JSON.stringify(item.args);
      assert.equal(run.rc, expected.rc, label);
      assert.equal(canonicalText(normalize(run.stdout, sandbox.data)), expected.stdout, label);
      const stderr = normalize(run.stderr, sandbox.data);
      if (expected.errorCode !== undefined) {
        assert.match(stderr, new RegExp(`^keel: internal error: Error: cannot run \\S*: spawn (?:\\S+ )?${expected.errorCode}\\n$`), label);
      } else if (expected.stdinNotJson) {
        const [firstLine, ...rest] = stderr.split('\n');
        assert.match(firstLine!, /^keel: stdin is not JSON: .+/, label);
        assert.equal(rest.join('\n'), expected.stderr, label);
      } else {
        assert.equal(canonicalText(stderr), expected.stderr, label);
      }
    }
    const filesBefore = filesUnder(sandbox.data).length;
    const shebangless = sandbox.keel(['test', '--', './no-shebang.sh'], { cwd: repo.path });
    assert.equal(shebangless.rc, 70);
    assert.match(shebangless.stderr, /^keel: internal error: Error: cannot run \.\/no-shebang\.sh: spawn (?:\S+ )?ENOEXEC/);
    assert.equal(filesUnder(sandbox.data).length, filesBefore, 'typescript wrote files');
  });
});
