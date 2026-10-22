import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import * as registry from '../../lib/evidence/registry.ts';
import * as store from '../../lib/evidence/store.ts';
import { pythonJsonDumps } from '../../lib/evidence/pycompat.ts';
import * as verify from '../../lib/evidence/verify.ts';
import { KEEL_HOME, KEEL_PYTHON, LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Repo, Run } from './helpers.ts';

type Impl = 'py' | 'ts';
const RUNNERS: Record<Impl, string[]> = { py: ['python3', KEEL_PYTHON], ts: ['node', join(KEEL_HOME, 'bin', 'keel.ts')] };
const OTHER: Record<Impl, Impl> = { py: 'ts', ts: 'py' };
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

function judgedIdentically(sandbox: Sandbox, repo: Repo, label: string, needsApproval: boolean, expected: Expectation): void {
  const base = repo.git('merge-base', 'origin/main', 'HEAD');
  const [python, typescript] = (['py', 'ts'] as Impl[]).map((impl) => judge(impl, sandbox.data, sandbox, repo, repo.head(), base, needsApproval));
  assert.equal(typescript, python, label);
  const decision = JSON.parse(python!);
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

function prepare(t: TestContext) {
  const sandbox = new Sandbox(t);
  sandbox.env['GIT_AUTHOR_DATE'] = '2026-01-01T00:00:00Z';
  sandbox.env['GIT_COMMITTER_DATE'] = '2026-01-01T00:00:00Z';
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(NON_ASCII_PATHS, 'first');
  return { sandbox, repo };
}

describe('cross-implementation evidence compatibility', () => {
  test('python-written and typescript-written evidence are byte-identical modulo ids and times', (t) => {
    const { sandbox, repo } = prepare(t);
    const python = new Pipeline(sandbox, repo, join(sandbox.root, 'data-py'));
    const typescript = new Pipeline(sandbox, repo, join(sandbox.root, 'data-ts'));
    runPipeline(python, () => 'py');
    repo.git('reset', '-q', '--hard', 'HEAD~1');
    runPipeline(typescript, () => 'ts');

    assert.deepEqual(typescript.outputs.map((text) => normalize(text, typescript.dataDir)), python.outputs.map((text) => normalize(text, python.dataDir)));
    for (const [subdirectory, minimum] of [['state', 6], ['logs', 2]] as const) {
      const pythonFiles = normalizedTree(python.dataDir, subdirectory);
      assert.ok(pythonFiles.length >= minimum, `${subdirectory}: ${pythonFiles.length} files`);
      assert.deepEqual(normalizedTree(typescript.dataDir, subdirectory), pythonFiles);
    }
    for (const dataDir of [python.dataDir, typescript.dataDir]) {
      for (const path of filesUnder(join(dataDir, 'state', 'keel', 'evidence'))) {
        assert.equal(statSync(path).mode & 0o777, 0o600, path);
        assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700, path);
      }
    }
  });

  for (const first of ['py', 'ts'] as Impl[]) {
    test(`evidence written alternately (${first} first) is read and judged identically by both`, (t) => {
      const { sandbox, repo } = prepare(t);
      const mixed = new Pipeline(sandbox, repo, join(sandbox.root, `data-mixed-${first}`));
      runPipeline(mixed, (step) => step % 2 === 0 ? first : OTHER[first]);

      const files = filesUnder(join(mixed.dataDir, 'state', 'keel', 'evidence')).filter((path) => path.endsWith('.json'));
      assert.ok(files.length >= 6);
      const reserialized = spawnSync('python3', ['-I', '-X', 'utf8', '-c', REROUNDTRIP_PYTHON, ...files], { encoding: 'utf8' });
      assert.equal(reserialized.status, 0, reserialized.stderr);
      assert.ok(reserialized.stdout.trim().split('\n').every((line) => line === 'same'), reserialized.stdout);
      for (const path of files) {
        const text = readFileSync(path, 'utf8');
        assert.equal(pythonJsonDumps(store.readFile(path), { sortKeys: true }) + '\n', text, path);
      }

      const head = repo.head();
      const base = repo.git('merge-base', 'origin/main', 'HEAD');
      repo.commit({ 'src/unreviewed.py': 'print(3)\n' }, 'unreviewed');
      const states: Array<[string, string, boolean]> = [[head, base, true], [head, base, false], [repo.head(), base, true], [base, base, true]];
      for (const [stateHead, stateBase, needsApproval] of states) {
        const results = (['py', 'ts'] as Impl[]).map((impl) => judge(impl, mixed.dataDir, sandbox, repo, stateHead, stateBase, needsApproval));
        assert.equal(results[1], results[0], `judge ${stateHead.slice(0, 8)} approval=${needsApproval}`);
      }
      const reviewed = JSON.parse(judge('ts', mixed.dataDir, sandbox, repo, head, base, true));
      assert.equal(reviewed.ok, true, JSON.stringify(reviewed.reasons));
      assert.equal(JSON.parse(judge('py', mixed.dataDir, sandbox, repo, repo.head(), base, true)).ok, false);

      for (const args of [['evidence', 'show', '--repo', repo.path], ['evidence', 'compatibility'], ['evidence', 'gc'], ['snapshot', repo.path]]) {
        const outputs = (['py', 'ts'] as Impl[]).map((impl) => mixed.use(impl).keel(args));
        assert.equal(outputs[1]!.rc, outputs[0]!.rc, args.join(' '));
        assert.equal(outputs[1]!.stdout, outputs[0]!.stdout, args.join(' '));
      }
      const shown = mixed.use('ts').keel(['evidence', 'show', '--repo', repo.path]).json;
      assert.deepEqual(shown.chains.map((chain: any) => [chain.root_run_id, chain.verdict, chain.paths, chain.approved, chain.acked]),
        [['rv-root-0001', 'PASS', 4, true, true]]);
    });
  }

  describe('verify.judge parity on evidence scenarios', () => {
    const python = (sandbox: Sandbox) => { sandbox.runner = RUNNERS.py; return sandbox; };

    test('two adjacent approved reviews are reused as a series', (t) => {
      const sandbox = python(new Sandbox(t));
      const repo = sandbox.clone('acme', 'app');
      adjacentReviews(sandbox, repo);
      judgedIdentically(sandbox, repo, 'series approved', true, { ok: true, rootRunIds: ['rv-series-0001', 'rv-series-0002'] });
      judgedIdentically(sandbox, repo, 'series without approval requirement', false, { ok: true, rootRunIds: ['rv-series-0001', 'rv-series-0002'] });
    });

    test('an unapproved first review or an unreviewed gap breaks the series', (t) => {
      const unapproved = python(new Sandbox(t));
      const unapprovedRepo = unapproved.clone('acme', 'app');
      adjacentReviews(unapproved, unapprovedRepo, { approveFirst: false });
      judgedIdentically(unapproved, unapprovedRepo, 'first review not approved', true, { ok: false });
      const gapped = python(new Sandbox(t));
      const gappedRepo = gapped.clone('acme', 'app');
      adjacentReviews(gapped, gappedRepo, { gap: true });
      judgedIdentically(gapped, gappedRepo, 'gap between reviews', true, { ok: false, reason: 'src/gap.py' });
    });

    test('parallel approved chains stacked by rebase are accepted, overlapping ones name the commit to review', (t) => {
      const stacked = python(new Sandbox(t));
      const stackedRepo = stacked.clone('acme', 'app', undefined, STACK_SEED);
      stackedChains(stacked, stackedRepo, { 'src/first.py': 'first = 1\n' }, [{ 'src/second.py': 'second = 2\n' }]);
      judgedIdentically(stacked, stackedRepo, 'stacked chains', true, { ok: true, rootRunIds: ['rv-stack-0001', 'rv-stack-0002'] });
      const overlapping = python(new Sandbox(t));
      const overlappingRepo = overlapping.clone('acme', 'app', undefined, STACK_SEED);
      stackedChains(overlapping, overlappingRepo, OVERLAP_FIRST, OVERLAP_SECOND);
      judgedIdentically(overlapping, overlappingRepo, 'overlapping stacked chains', true, { ok: false, reason: 'no review saw the stacked content' });
    });

    test('a smoke-gated row needs smoke evidence covering the tree', (t) => {
      const sandbox = python(new Sandbox(t, SMOKE_REGISTRY));
      const repo = sandbox.clone('acme', 'app');
      repo.branch('feature');
      repo.commit({ 'src/new.py': 'new = 1\n' });
      judgedIdentically(sandbox, repo, 'smoke missing', true, { ok: false, reason: 'no smoke evidence covers this exact content' });
      sandbox.smokeEvidence(repo);
      judgedIdentically(sandbox, repo, 'smoke present', true, { ok: true });
    });

    test('a tests=none row denies a standard change and passes a light one', (t) => {
      const standard = python(new Sandbox(t, NO_TESTS_REGISTRY));
      const standardRepo = featureWithEvidence(standard, LOGIC_WITH_TEST);
      judgedIdentically(standard, standardRepo, 'tests=none standard', true, { ok: false, reason: 'add test infrastructure first' });
      const light = python(new Sandbox(t, NO_TESTS_REGISTRY));
      const lightRepo = featureWithEvidence(light, { 'docs/guide.md': 'light\n' });
      judgedIdentically(light, lightRepo, 'tests=none light', true, { ok: true });
    });

    test('a logic change without a test in the same range is denied unless the reviewer states why', (t) => {
      const bare = python(new Sandbox(t));
      const bareRepo = featureWithEvidence(bare, { 'src/a.py': 'print(1)\n' });
      bare.testsEvidence(bareRepo);
      judgedIdentically(bare, bareRepo, 'K3 same range', true, { ok: false, reason: 'logic changed with no test in the same range' });
      const waived = python(new Sandbox(t));
      const waivedRepo = featureWithEvidence(waived, { 'src/a.py': 'print(1)\n' }, { noTestReason: 'covered by the integration suite' });
      waived.testsEvidence(waivedRepo);
      judgedIdentically(waived, waivedRepo, 'K3 waiver', true, { ok: true, k3Waiver: 'covered by the integration suite' });
    });

    test('a chain with a single-lens link is denied even for a light change', (t) => {
      const sandbox = python(new Sandbox(t, NO_TESTS_REGISTRY));
      const repo = featureWithEvidence(sandbox, { 'docs/guide.md': 'light\n' }, { kind: 'single-lens' });
      judgedIdentically(sandbox, repo, 'single-lens', true, { ok: false, reason: 'every change needs a lens-review chain' });
    });
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
    const cases: Array<{ args: string[]; stdin?: string; cwd?: string }> = [
      { args: [] }, { args: ['bogus'] }, { args: ['test', 'x'] }, { args: ['test', '--'] }, { args: ['approve'] }, { args: ['approve', 'x'] },
      { args: ['approve', 'rv-none-0001'] }, { args: ['approve', 'rv-none-0001', '--bogus'] }, { args: ['snapshot'] }, { args: ['snapshot', sandbox.home] },
      { args: ['evidence'] }, { args: ['evidence', 'bogus'] }, { args: ['evidence', 'show', '--bogus'] }, { args: ['evidence', 'show', '--repo'] },
      { args: ['evidence', 'show', '--repo', sandbox.home] }, { args: ['evidence', 'compatibility', '--repo', repo.path] },
      { args: ['evidence', 'record-codex'] }, { args: ['evidence', 'record-codex', '--repo', repo.path] },
      { args: ['evidence', 'record-codex', '--repo', repo.path, '--audits', 'not-a-uuid'] },
      { args: ['evidence', 'write-review'], stdin: '' }, { args: ['evidence', 'write-review'], stdin: '{"a":' }, { args: ['evidence', 'write-review'], stdin: '[1]' },
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
    ];
    for (const item of cases) {
      const results = (['py', 'ts'] as Impl[]).map((impl) => {
        sandbox.runner = RUNNERS[impl];
        return sandbox.keel(item.args, { stdin: item.stdin, cwd: item.cwd });
      });
      const label = JSON.stringify(item);
      assert.equal(results[1]!.rc, results[0]!.rc, label);
      assert.equal(normalize(results[1]!.stdout, sandbox.data), normalize(results[0]!.stdout, sandbox.data), label);
      assert.equal(normalize(results[1]!.stderr, sandbox.data), normalize(results[0]!.stderr, sandbox.data), label);
    }
    for (const impl of ['py', 'ts'] as Impl[]) {
      sandbox.runner = RUNNERS[impl];
      const filesBefore = filesUnder(sandbox.data).length;
      const shebangless = sandbox.keel(['test', '--', './no-shebang.sh'], { cwd: repo.path });
      assert.equal(shebangless.rc, 70, impl);
      assert.match(shebangless.stderr, /^keel: internal error: OSError: \[Errno 8\] Exec format error: '\.\/no-shebang\.sh'/, impl);
      assert.equal(filesUnder(sandbox.data).length, filesBefore, `${impl} wrote files`);
    }
  });
});
