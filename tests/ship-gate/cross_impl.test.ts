import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import * as registry from '../../lib/evidence/registry.ts';
import * as store from '../../lib/evidence/store.ts';
import { pythonJsonDumps } from '../../lib/evidence/pycompat.ts';
import * as verify from '../../lib/evidence/verify.ts';
import { materialize, SnapshotPacker } from '../recorded-cases.ts';
import type { SnapshotStore } from '../recorded-cases.ts';
import { isRecording, recordedAnswers } from '../recorded.ts';
import { KEEL_HOME, KEEL_PYTHON, LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Repo, Run } from './helpers.ts';

type Impl = 'py' | 'ts';
const RUNNERS: Record<Impl, string[]> = { py: ['python3', KEEL_PYTHON], ts: ['node', join(KEEL_HOME, 'bin', 'keel.ts')] };
const BUILDER: Impl = isRecording() ? 'py' : 'ts';
const FIXED_COMMIT_DATE = '2026-01-01T00:00:00Z';
const NON_ASCII_PATHS = { 'src/é😀 "q".py': 'print("é")\n', 'src/plain.py': 'print(1)\n', 'tests/test_plain.py': 'def test_a():\n    assert True\n' };

const JUDGE_PYTHON = `
import json, sys
sys.path.insert(0, sys.argv[1])
from evidence import registry, verify
repo, key, head, base = sys.argv[2:6]
row = registry.gated_repos()[key]
d = verify.judge(verify.Outgoing(repo, key, row, head, base, sys.argv[6] == "true"))
print(json.dumps({"ok": d.ok, "reasons": [[r.rule_id, r.text] for r in d.reasons], "risk_class": d.risk_class,
                  "root_run_id": d.root_run_id, "files": d.files, "lines": d.lines, "k3_waiver": d.k3_waiver,
                  "root_run_ids": list(d.root_run_ids)}, sort_keys=True))
`;
const REROUNDTRIP_PYTHON = `
import json, sys
for path in sys.argv[1:]:
    raw = open(path, "rb").read().decode("utf-8")
    print("same" if json.dumps(json.loads(raw), sort_keys=True) + "\\n" == raw else "different")
`;

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

  use(impl: Impl): Sandbox {
    this.sandbox.env['KEEL_DATA_DIR'] = this.dataDir;
    this.sandbox.data = this.dataDir;
    this.sandbox.runner = RUNNERS[impl];
    return this.sandbox;
  }

  step(impl: Impl, label: string, action: (sandbox: Sandbox) => Run): any {
    const run = action(this.use(impl));
    assert.equal(run.rc, 0, `${label} via ${impl}: ${run.stderr}`);
    this.outputs.push(`${label}\n${run.stdout}${run.rc}`);
    return run.stdout.trim().startsWith('{') ? run.json : null;
  }
}

function runPipeline(pipeline: Pipeline, implFor: (step: number) => Impl): void {
  const { repo } = pipeline;
  let step = 0;
  const next = () => implFor(step++);
  const rootTree = pipeline.step(next(), 'snapshot', (box) => box.keel(['snapshot', repo.path])).tree;
  pipeline.step(next(), 'write-review root', (box) => box.keel(['evidence', 'write-review'], { stdin: JSON.stringify(box.reviewRequest(repo)) }));
  repo.commit({ 'src/extra.py': 'print(2)\n' }, 'second');
  pipeline.step(next(), 'write-review delta', (box) => box.keel(['evidence', 'write-review'], {
    stdin: JSON.stringify(box.reviewRequest(repo, { runId: 'rv-delta-0002', rootRunId: 'rv-root-0001', since: rootTree })),
  }));
  pipeline.step(next(), 'test', (box) => box.keel(['test', '--', 'bash', '-c', "echo 'Ran 3 tests'; echo OK"], { cwd: repo.path }));
  pipeline.step(next(), 'write-smoke', (box) => {
    box.smokeLine(repo);
    return box.keel(['evidence', 'write-smoke', '--repo', repo.path]);
  });
  pipeline.step(next(), 'ack', (box) => box.keel(['approve', 'rv-root-0001', '--read']));
  pipeline.step(next(), 'approve', (box) => box.keel(['approve', 'rv-root-0001']));
}

function judge(impl: Impl, dataDir: string, sandbox: Sandbox, repo: Repo, head: string, base: string, needsApproval: boolean): string {
  const previous = process.env['KEEL_DATA_DIR'];
  const previousOverlay = process.env['KEEL_OVERLAY_DIR'];
  process.env['KEEL_DATA_DIR'] = dataDir;
  process.env['KEEL_OVERLAY_DIR'] = sandbox.overlay;
  try {
    if (impl === 'ts') {
      const row = registry.gatedRepos().get(repo.key)!;
      const decision = verify.judge({ repoRoot: repo.path, repoKey: repo.key, row, head, mergeBase: base, needsApproval });
      return pythonJsonDumps({
        ok: decision.ok, reasons: decision.reasons.map((reason) => [reason.ruleId, reason.text]), risk_class: decision.riskClass,
        root_run_id: decision.rootRunId, files: decision.files, lines: decision.lines, k3_waiver: decision.k3Waiver,
        root_run_ids: decision.rootRunIds,
      }, { sortKeys: true });
    }
    const completed = spawnSync('python3', ['-I', '-X', 'utf8', '-c', JUDGE_PYTHON, join(KEEL_HOME, 'lib'), repo.path, repo.key, head, base,
      String(needsApproval)], { encoding: 'utf8', env: { ...sandbox.env, KEEL_DATA_DIR: dataDir } });
    assert.equal(completed.status, 0, completed.stderr);
    return completed.stdout.trim();
  } finally {
    if (previous === undefined) delete process.env['KEEL_DATA_DIR'];
    else process.env['KEEL_DATA_DIR'] = previous;
    if (previousOverlay === undefined) delete process.env['KEEL_OVERLAY_DIR'];
    else process.env['KEEL_OVERLAY_DIR'] = previousOverlay;
  }
}

const STACK_SEED = { 'README.md': 'top\n\n\n\n\nbottom\n' };
const OVERLAP_FIRST = { 'README.md': 'top changed\n\n\n\n\nbottom\n' };
const OVERLAP_SECOND = [{ 'README.md': 'top\n\n\n\n\nbottom changed\n' }];
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

function judgedIdentically(sandbox: Sandbox, repo: Repo, label: string, needsApproval: boolean, expected: Expectation, chainOrderDependent = false): void {
  const base = repo.git('merge-base', 'origin/main', 'HEAD');
  const comparable = chainOrderDependent ? withoutChainChoice : withoutEvidenceIds;
  const python = recordedPython(sandbox, { test: 'judge', label }, () => judge('py', sandbox.data, sandbox, repo, repo.head(), base, needsApproval));
  const typescript = judge('ts', sandbox.data, sandbox, repo, repo.head(), base, needsApproval);
  assert.equal(comparable(typescript), comparable(python), label);
  assert.equal(JSON.parse(typescript).ok, expected.ok, `${label}: ${typescript}`);
  const decision = JSON.parse(chainOrderDependent ? python : typescript);
  assert.equal(decision.ok, expected.ok, `${label}: ${python}`);
  if (expected.reason !== undefined) {
    assert.ok(decision.reasons.some(([, text]: [string, string]) => text.includes(expected.reason!)), `${label}: ${python}`);
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

function stackedChains(sandbox: Sandbox, repo: Repo, firstFiles: Record<string, string>, secondCommits: Array<Record<string, string>>): void {
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
  repo.git('cherry-pick', `${base}..${second}`);
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

function recordedPython<T>(sandbox: Sandbox, key: Record<string, unknown>, askPython: () => T): T {
  return recordedAnswers('ship-gate-cross-impl', [key], () => [askPython()], { '{{ROOT}}': sandbox.root })[0] as T;
}

function scenarioSandbox(t: TestContext, registry?: string[]): Sandbox {
  const sandbox = new Sandbox(t, registry);
  sandbox.env['GIT_AUTHOR_DATE'] = FIXED_COMMIT_DATE;
  sandbox.env['GIT_COMMITTER_DATE'] = FIXED_COMMIT_DATE;
  sandbox.runner = RUNNERS[BUILDER];
  return sandbox;
}

function assertEvidenceModes(dataDir: string): void {
  for (const path of filesUnder(join(dataDir, 'state', 'keel', 'evidence'))) {
    assert.equal(statSync(path).mode & 0o777, 0o600, path);
    assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700, path);
  }
}

interface WrittenEvidence {
  outputs: string[];
  state: Array<[string, string]>;
  logs: Array<[string, string]>;
}

function writtenBy(impl: Impl, sandbox: Sandbox, repo: Repo): WrittenEvidence {
  const pipeline = new Pipeline(sandbox, repo, join(sandbox.root, `data-${impl}`));
  runPipeline(pipeline, () => impl);
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
  reserialized: string[];
}

function inspectEvidence(impl: Impl, sandbox: Sandbox, repo: Repo, mixed: Pipeline): EvidenceFacts {
  const files = filesUnder(join(mixed.dataDir, 'state', 'keel', 'evidence')).filter((path) => path.endsWith('.json'));
  const reserialized = impl === 'py'
    ? spawnSync('python3', ['-I', '-X', 'utf8', '-c', REROUNDTRIP_PYTHON, ...files], { encoding: 'utf8' }).stdout.trim().split('\n')
    : [];
  const head = repo.head();
  const base = repo.git('merge-base', 'origin/main', 'HEAD');
  repo.commit({ 'src/unreviewed.py': 'print(3)\n' }, 'unreviewed');
  const states: Array<[string, string, boolean]> = [[head, base, true], [head, base, false], [repo.head(), base, true], [base, base, true]];
  const judged = states.map(([stateHead, stateBase, needsApproval]) => judge(impl, mixed.dataDir, sandbox, repo, stateHead, stateBase, needsApproval));
  const probes = [['evidence', 'show', '--repo', repo.path], ['evidence', 'compatibility'], ['evidence', 'gc'], ['snapshot', repo.path]];
  const cli = probes.map((args): [number, string] => {
    const run = mixed.use(impl).keel(args);
    return [run.rc, run.stdout];
  });
  return { judged, cli, reserialized };
}

describe('cross-implementation evidence compatibility', () => {
  test('typescript-written evidence matches the recorded python-written evidence modulo ids and times', (t) => {
    const { sandbox, repo } = prepare(t);
    const python = recordedPython(sandbox, { test: 'evidence-bytes' }, () => writtenBy('py', sandbox, repo));
    const typescript = writtenBy('ts', sandbox, repo);

    assert.deepEqual(typescript.outputs, python.outputs);
    for (const [subdirectory, minimum] of [['state', 6], ['logs', 2]] as const) {
      assert.ok(python[subdirectory].length >= minimum, `${subdirectory}: ${python[subdirectory].length} files`);
      assert.deepEqual(typescript[subdirectory], python[subdirectory]);
    }
  });

  test('evidence written by the recorded python run is read and judged identically by typescript', (t) => {
    const { sandbox, repo } = prepare(t);
    const mixed = new Pipeline(sandbox, repo, join(sandbox.root, 'data-mixed'));
    const recorded = recordedPython(sandbox, { test: 'python-written-evidence' }, () => {
      runPipeline(mixed, () => 'py');
      const packer = new SnapshotPacker();
      const snapshot = packer.addTree(sandbox.root, sandbox.root);
      const facts = inspectEvidence('py', sandbox, repo, mixed);
      return { store: packer.store, snapshot, facts };
    });
    rmSync(sandbox.root, { recursive: true, force: true });
    materialize(recorded.store as SnapshotStore, recorded.snapshot, sandbox.root);

    const files = filesUnder(join(mixed.dataDir, 'state', 'keel', 'evidence')).filter((path) => path.endsWith('.json'));
    assert.ok(files.length >= 6);
    assert.ok(recorded.facts.reserialized.length >= 6 && recorded.facts.reserialized.every((line) => line === 'same'), recorded.facts.reserialized.join('\n'));
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      assert.equal(pythonJsonDumps(store.readFile(path), { sortKeys: true }) + '\n', text, path);
    }

    const facts = inspectEvidence('ts', sandbox, repo, mixed);
    assert.deepEqual(facts.judged, recorded.facts.judged);
    assert.deepEqual(facts.cli, recorded.facts.cli);
    assert.equal(JSON.parse(facts.judged[0]!).ok, true, facts.judged[0]);
    assert.equal(JSON.parse(facts.judged[2]!).ok, false, facts.judged[2]);
    const shown = mixed.use('ts').keel(['evidence', 'show', '--repo', repo.path]).json;
    assert.deepEqual(shown.chains.map((chain: any) => [chain.root_run_id, chain.verdict, chain.paths, chain.approved, chain.acked]),
      [['rv-root-0001', 'PASS', 4, true, true]]);
  });

  describe('verify.judge parity on evidence scenarios', () => {

    test('two adjacent approved reviews are reused as a series', (t) => {
      const sandbox = scenarioSandbox(t);
      const repo = sandbox.clone('acme', 'app');
      adjacentReviews(sandbox, repo);
      judgedIdentically(sandbox, repo, 'series approved', true, { ok: true, rootRunIds: ['rv-series-0001', 'rv-series-0002'] });
      judgedIdentically(sandbox, repo, 'series without approval requirement', false, { ok: true, rootRunIds: ['rv-series-0001', 'rv-series-0002'] });
    });

    test('an unapproved first review or an unreviewed gap breaks the series', (t) => {
      const unapproved = scenarioSandbox(t);
      const unapprovedRepo = unapproved.clone('acme', 'app');
      adjacentReviews(unapproved, unapprovedRepo, { approveFirst: false });
      judgedIdentically(unapproved, unapprovedRepo, 'first review not approved', true, { ok: false }, true);
      const gapped = scenarioSandbox(t);
      const gappedRepo = gapped.clone('acme', 'app');
      adjacentReviews(gapped, gappedRepo, { gap: true });
      judgedIdentically(gapped, gappedRepo, 'gap between reviews', true, { ok: false, reason: 'src/gap.py' }, true);
    });

    test('parallel approved chains stacked by rebase are accepted, overlapping ones name the commit to review', (t) => {
      const stacked = scenarioSandbox(t);
      const stackedRepo = stacked.clone('acme', 'app', undefined, STACK_SEED);
      stackedChains(stacked, stackedRepo, { 'src/first.py': 'first = 1\n' }, [{ 'src/second.py': 'second = 2\n' }]);
      judgedIdentically(stacked, stackedRepo, 'stacked chains', true, { ok: true, rootRunIds: ['rv-stack-0001', 'rv-stack-0002'] }, true);
      const overlapping = scenarioSandbox(t);
      const overlappingRepo = overlapping.clone('acme', 'app', undefined, STACK_SEED);
      stackedChains(overlapping, overlappingRepo, OVERLAP_FIRST, OVERLAP_SECOND);
      judgedIdentically(overlapping, overlappingRepo, 'overlapping stacked chains', true, { ok: false, reason: 'no review saw the stacked content' }, true);
    });

    test('a smoke-gated row needs smoke evidence covering the tree', (t) => {
      const sandbox = scenarioSandbox(t, SMOKE_REGISTRY);
      const repo = sandbox.clone('acme', 'app');
      repo.branch('feature');
      repo.commit({ 'src/new.py': 'new = 1\n' });
      judgedIdentically(sandbox, repo, 'smoke missing', true, { ok: false, reason: 'no smoke evidence covers this exact content' });
      sandbox.smokeEvidence(repo);
      judgedIdentically(sandbox, repo, 'smoke present', true, { ok: true });
    });

    test('a tests=none row denies a standard change and passes a light one', (t) => {
      const standard = scenarioSandbox(t, NO_TESTS_REGISTRY);
      const standardRepo = featureWithEvidence(standard, LOGIC_WITH_TEST);
      judgedIdentically(standard, standardRepo, 'tests=none standard', true, { ok: false, reason: 'add test infrastructure first' });
      const light = scenarioSandbox(t, NO_TESTS_REGISTRY);
      const lightRepo = featureWithEvidence(light, { 'docs/guide.md': 'light\n' });
      judgedIdentically(light, lightRepo, 'tests=none light', true, { ok: true });
    });

    test('a logic change without a test in the same range is denied unless the reviewer states why', (t) => {
      const bare = scenarioSandbox(t);
      const bareRepo = featureWithEvidence(bare, { 'src/a.py': 'print(1)\n' });
      bare.testsEvidence(bareRepo);
      judgedIdentically(bare, bareRepo, 'K3 same range', true, { ok: false, reason: 'logic changed with no test in the same range' });
      const waived = scenarioSandbox(t);
      const waivedRepo = featureWithEvidence(waived, { 'src/a.py': 'print(1)\n' }, { noTestReason: 'covered by the integration suite' });
      waived.testsEvidence(waivedRepo);
      judgedIdentically(waived, waivedRepo, 'K3 waiver', true, { ok: true, k3Waiver: 'covered by the integration suite' });
    });

    test('a chain with a single-lens link is denied even for a light change', (t) => {
      const sandbox = scenarioSandbox(t, NO_TESTS_REGISTRY);
      const repo = featureWithEvidence(sandbox, { 'docs/guide.md': 'light\n' }, { kind: 'single-lens' });
      judgedIdentically(sandbox, repo, 'single-lens', true, { ok: false, reason: 'every change needs a lens-review chain' });
    });
  });

  test('review prepare echoes the number spellings of the lens file byte for byte', (t) => {
    const { sandbox, repo } = prepare(t);
    mkdirSync(join(sandbox.data, 'workflows'));
    writeFileSync(join(sandbox.data, 'workflows', 'review-lenses.json'),
      '{"guardrails": "g", "lenses": [{"name": "a", "weight": 1.0, "big": 9007199254740993, "tiny": 1e-7, "neg": -0.0, "wide": 1e16, "int": -0, "exp": 2E3}]}');
    const stdin = JSON.stringify({ diffs: [{ repo: repo.path, base: 'HEAD' }] });
    const run = sandbox.keel(['review', 'prepare'], { stdin });
    assert.equal(run.rc, 0, run.stderr);
    const echoed = /"lenses_output": (\{.*?\}\]\}),/.exec(run.stdout)![1];
    assert.equal(echoed, '{"guardrails": "g", "lenses": [{"big": 9007199254740993, "exp": 2000.0, "int": 0, "name": "a", "neg": -0.0, "tiny": 1e-07, "weight": 1.0, "wide": 1e+16}]}');
  });

  test('write-review judges the claim version by numeric value like Python', (t) => {
    const { sandbox, repo } = prepare(t);
    const base = JSON.stringify(sandbox.reviewRequest(repo));
    const writeReviews = (impl: Impl): Array<[number, string]> => {
      sandbox.runner = RUNNERS[impl];
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
    const python = recordedPython(sandbox, { test: 'claim-version' }, () => writeReviews('py'));
    const typescript = writeReviews('ts');
    assert.deepEqual(typescript, python);
    assert.deepEqual(python.map(([rc]) => rc), [0, 0, 0, 0, 0, 2, 2, 0, 2]);
  });

  test('keel test reads output until every holder of the shared descriptor closes it', (t) => {
    const { sandbox, repo } = prepare(t);
    const scripts = [
      "(sleep 1; echo 'Ran 3 tests') &",
      "(sleep 1; echo 'Ran 3 tests') & exit 3",
      "(sleep 1; echo 'Ran 3 tests' >&2) & echo foreground; exit 0",
    ];
    const outcomeOf = (impl: Impl) => {
      sandbox.data = join(sandbox.root, `data-background-${impl}`);
      sandbox.env['KEEL_DATA_DIR'] = sandbox.data;
      mkdirSync(sandbox.data);
      sandbox.runner = RUNNERS[impl];
      const runs = scripts.map((script) => {
        const run = sandbox.keel(['test', '--', 'bash', '-c', script], { cwd: repo.path });
        return [run.rc, normalize(run.stdout, sandbox.data), normalize(run.stderr, sandbox.data)];
      });
      return { runs, state: treeOrEmpty(sandbox.data, 'state'), logs: treeOrEmpty(sandbox.data, 'logs') };
    };
    const python = recordedPython(sandbox, { test: 'background-holders' }, () => outcomeOf('py'));
    const typescript = outcomeOf('ts');
    assert.deepEqual(typescript, python);
    assert.deepEqual(python.runs.map(([rc]) => rc), [0, 3, 0]);
    assert.match(String(python.runs[0]![1]), /^Ran 3 tests\n$/);
    assert.equal(python.state.length, 2);
  });

  test('file system failures in the evidence store and in spawning read like the OS wording Python prints', (t) => {
    const { sandbox, repo } = prepare(t);
    const busy = repo.write('busy.sh', "#!/bin/sh\necho 'Ran 3 tests'\n", true);
    const holder = openSync(busy, 'r+');
    t.after(() => closeSync(holder));
    const executingBusyFileFails = process.platform !== 'darwin';
    if (!executingBusyFileFails) t.diagnostic('ETXTBSY case skipped: darwin lets a file open for writing execute');
    const testsDirectory = (dataDir: string) => join(dataDir, 'state', 'keel', 'evidence', 'tests', 'acme__app');
    const cases = [
      { label: 'directory in place of an evidence file (EISDIR)', args: ['evidence', 'gc'], cwd: undefined, errno: 'Errno 21',
        setup: (dataDir: string) => mkdirSync(join(testsDirectory(dataDir), 'bad.json'), { recursive: true }) },
      { label: 'unreadable evidence file (EACCES)', args: ['evidence', 'gc'], cwd: undefined, errno: 'Errno 13',
        setup: (dataDir: string) => {
          mkdirSync(testsDirectory(dataDir), { recursive: true });
          writeFileSync(join(testsDirectory(dataDir), 'bad.json'), '{}', { mode: 0o000 });
        } },
      { label: 'file in place of the evidence directory (EEXIST)', args: ['test', '--', 'bash', '-c', "echo 'Ran 3 tests'"], cwd: repo.path, errno: 'Errno 17',
        setup: (dataDir: string) => {
          mkdirSync(dirname(testsDirectory(dataDir)), { recursive: true });
          writeFileSync(testsDirectory(dataDir), 'not a directory');
        } },
      ...(executingBusyFileFails ? [{ label: 'script open for writing (ETXTBSY)', args: ['test', '--', './busy.sh'], cwd: repo.path, errno: 'Errno 26', setup: () => undefined }] : []),
    ];
    for (const [index, item] of cases.entries()) {
      const resultOf = (impl: Impl) => {
        sandbox.data = join(sandbox.root, `data-os-${impl}-${index}`);
        sandbox.env['KEEL_DATA_DIR'] = sandbox.data;
        mkdirSync(sandbox.data);
        item.setup(sandbox.data);
        sandbox.runner = RUNNERS[impl];
        const run = sandbox.keel(item.args, { cwd: item.cwd });
        return [run.rc, normalize(run.stdout, sandbox.data), normalize(run.stderr, sandbox.data)];
      };
      const python = recordedPython(sandbox, { test: 'os-wording', label: item.label }, () => resultOf('py'));
      const typescript = resultOf('ts');
      assert.ok(String(python[2]).includes(item.errno), `${item.label}: python stderr ${String(python[2])}`);
      assert.deepEqual(typescript, python, item.label);
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
    const outcomeOf = (impl: Impl) => {
      const interpreter = impl === 'py' ? spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim() : process.execPath;
      sandbox.data = join(sandbox.root, `data-no-mkfifo-${impl}`);
      sandbox.env['KEEL_DATA_DIR'] = sandbox.data;
      mkdirSync(sandbox.data);
      sandbox.runner = [interpreter, impl === 'py' ? KEEL_PYTHON : join(KEEL_HOME, 'bin', 'keel.ts')];
      const run = sandbox.keel(['test', '--', '/bin/echo', 'Ran 1 test'], { cwd: repo.path });
      return { run: [run.rc, normalize(run.stdout, sandbox.data), normalize(run.stderr, sandbox.data)], recorded: sandbox.evidenceFiles('tests').length };
    };
    const python = recordedPython(sandbox, { test: 'no-mkfifo' }, () => outcomeOf('py'));
    const typescript = outcomeOf('ts');
    assert.deepEqual(typescript, python);
    assert.deepEqual(python.run.slice(0, 2), [0, 'Ran 1 test\n']);
    assert.equal(python.recorded, 1);
  });

  test('cli error paths match: usage, refusal and stdin JSON errors', (t) => {
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
    const resultOf = (impl: Impl, item: { args: string[]; stdin?: string; cwd?: string }) => {
      sandbox.runner = RUNNERS[impl];
      const run = sandbox.keel(item.args, { stdin: item.stdin, cwd: item.cwd });
      return [run.rc, normalize(run.stdout, sandbox.data), normalize(run.stderr, sandbox.data)];
    };
    const mismatches: string[] = [];
    for (const [index, item] of cases.entries()) {
      const python = recordedPython(sandbox, { test: 'cli-error-paths', index, args: item.args, stdin: item.stdin ?? null }, () => resultOf('py', item));
      const typescript = resultOf('ts', item);
      if (!isDeepStrictEqual(typescript, python)) {
        mismatches.push(`${JSON.stringify(item.args)}: python ${JSON.stringify(python)} typescript ${JSON.stringify(typescript)}`);
      }
    }
    assert.deepEqual(mismatches, []);
    sandbox.runner = RUNNERS.ts;
    const filesBefore = filesUnder(sandbox.data).length;
    const shebangless = sandbox.keel(['test', '--', './no-shebang.sh'], { cwd: repo.path });
    assert.equal(shebangless.rc, 70);
    assert.match(shebangless.stderr, /^keel: internal error: OSError: \[Errno 8\] Exec format error: '\.\/no-shebang\.sh'/);
    assert.equal(filesUnder(sandbox.data).length, filesBefore, 'typescript wrote files');
  });
});
