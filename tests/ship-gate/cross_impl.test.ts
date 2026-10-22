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
import { KEEL_HOME, KEEL_PYTHON, Sandbox } from './helpers.ts';
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

  test('cli error paths match: usage, refusal and stdin JSON errors', (t) => {
    const { sandbox, repo } = prepare(t);
    sandbox.data = join(sandbox.root, 'data-errors');
    sandbox.env['KEEL_DATA_DIR'] = sandbox.data;
    mkdirSync(sandbox.data);
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
  });
});
