import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import * as prepare from '../../lib/evidence/prepare.ts';
import * as writers from '../../lib/evidence/writers.ts';
import { Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

function setUp(t: TestContext): { box: Sandbox; repo: Repo; base: string } {
  const box = new Sandbox(t);
  box.patchProcessEnv(t);
  const repo = box.clone('acme', 'app');
  return { box, repo, base: repo.head() };
}

function preparedByCli(box: Sandbox, diffs: unknown[]): any {
  const prepared = box.keel(['review', 'prepare'], { stdin: JSON.stringify({ diffs, lenses: [] }) });
  assert.equal(prepared.rc, 0, prepared.stderr);
  return prepared.json;
}

describe('PrepareTest', () => {
  test('prepareCli_saysThePrecheckIsRequired_forASingleRootDiffOfThreeSourcesInARepoWithPrecheckTests', (t) => {
    const { box, repo, base } = setUp(t);
    repo.write('tests/a.test.ts', 'export {}\n');
    for (const name of ['a', 'b', 'c']) repo.write(`lib/${name}.ts`, `export const ${name} = 1\n`);

    const root = JSON.parse(preparedByCli(box, [{ repo: repo.path, base }]).diff_outputs[0]);
    const delta = JSON.parse(preparedByCli(box, [{ repo: repo.path, base, since: root.snapshot_tree }]).diff_outputs[0]);
    const twoRepos = preparedByCli(box, [{ repo: repo.path, base }, { repo: box.clone('acme', 'lib').path, base: 'HEAD' }]);

    assert.deepEqual(root.precheck_required, { required: true, sources: 3 });
    assert.equal('precheck_required' in delta, false);
    for (const line of twoRepos.diff_outputs) assert.equal('precheck_required' in JSON.parse(line), false);
  });

  test('prepareCli_saysThePrecheckIsNotRequired_forTwoSources', (t) => {
    const { box, repo, base } = setUp(t);
    repo.write('tests/a.test.ts', 'export {}\n');
    for (const name of ['a', 'b']) repo.write(`lib/${name}.ts`, `export const ${name} = 1\n`);

    const root = JSON.parse(preparedByCli(box, [{ repo: repo.path, base }]).diff_outputs[0]);

    assert.deepEqual(root.precheck_required, { required: false, sources: 2 });
  });

  test('prepare_pinsUntrackedCandidate_withoutChangingIndex', (t) => {
    const { repo, base } = setUp(t);
    repo.write('new.py', 'print(1)\n');
    const before = repo.git('diff', '--cached');

    const prepared = prepare.review({ diffs: [{ repo: repo.path, base }], lenses: [] });

    const target = JSON.parse(prepared['diff_outputs'][0]);
    assert.equal(target.review_base, base);
    assert.equal(target.snapshot_tree, gitcmd.snapshotTree(repo.path));
    assert.equal(before, repo.git('diff', '--cached'));
    assert.match(repo.git('ls-tree', '--name-only', target.snapshot_tree), /new\.py/);
  });

  test('prepare_refusesMissingHead_andInvalidSince', (t) => {
    const { repo, base } = setUp(t);
    for (const extra of [{ head: 'missing-ref' }, { since: base }]) {
      assert.throws(() => prepare.prepareTarget({ repo: repo.path, base, ...extra }), writers.Refused, JSON.stringify(extra));
    }
  });

  test('prepare_refusesOptionLikeRef', (t) => {
    const { repo } = setUp(t);
    assert.throws(() => prepare.prepareTarget({ repo: repo.path, base: '--help' }), writers.Usage);
  });

  test('prepare_countsNeedsFixesLinksInTheRootChain_whenRootRunIdIsGiven', (t) => {
    const { box, repo, base } = setUp(t);
    const rootTree = box.keel(['snapshot', repo.path]).json.tree;
    box.review(repo, { verdict: 'NEEDS_FIXES' });
    repo.write('fix.py', 'print(2)\n');
    const deltaTree = box.keel(['snapshot', repo.path]).json.tree;
    box.review(repo, { runId: 'rv-delta-0002', rootRunId: 'rv-root-0001', since: rootTree, verdict: 'NEEDS_FIXES' });
    repo.write('fix.py', 'print(3)\n');
    box.review(repo, { runId: 'rv-delta-0003', rootRunId: 'rv-root-0001', since: deltaTree });
    const diffs = [{ repo: repo.path, base }];

    const delta = box.keel(['review', 'prepare'], { stdin: JSON.stringify({ diffs, lenses: [], rootRunId: 'rv-root-0001' }) });
    const root = box.keel(['review', 'prepare'], { stdin: JSON.stringify({ diffs, lenses: [] }) });
    const other = box.keel(['review', 'prepare'], { stdin: JSON.stringify({ diffs, lenses: [], rootRunId: 'rv-other-0001' }) });

    assert.deepEqual([delta.rc, delta.json.needs_fixes_rounds], [0, 2]);
    assert.equal(root.json.needs_fixes_rounds, 0);
    assert.equal(other.json.needs_fixes_rounds, 0);
  });

  test('prepare_countsTheLongestRepoChain_notTheSumAcrossRepos', (t) => {
    const { box, repo, base } = setUp(t);
    const lib = box.clone('acme', 'lib');
    for (const target of [repo, lib]) box.review(target, { verdict: 'NEEDS_FIXES' });
    const request = { diffs: [{ repo: repo.path, base }], lenses: [], rootRunId: 'rv-root-0001' };

    const prepared = box.keel(['review', 'prepare'], { stdin: JSON.stringify(request) });

    assert.equal(prepared.json.needs_fixes_rounds, 1);
  });

  test('prepare_reportsTheTierOfTheReviewedDiff_byTheRepoRiskRules', (t) => {
    const { box, repo } = setUp(t);
    const cases: Array<[Record<string, string>, string]> = [
      [{ 'docs/guide.md': 'x\n' }, 'light'], [{ 'src/app.py': 'print(2)\n' }, 'standard'],
      [{ 'docs/guide.md': 'x\n', 'src/a/billing/pay.py': 'print(3)\n' }, 'heavy'],
    ];
    for (const [files, riskClass] of cases) {
      const base = repo.head();
      const head = repo.commit(files, riskClass);

      const prepared = preparedByCli(box, [{ repo: repo.path, base, head }]);

      assert.equal(prepared.risk_class, riskClass);
    }
  });

  test('prepare_takesTheHeaviestTier_acrossReviewedRepos', (t) => {
    const { box, repo, base } = setUp(t);
    const lib = box.clone('acme', 'lib');
    box.writeRegistry(['acme/app\tcode\tmain\tacme\trequired', 'acme/lib\tcode\tmain\tacme\trequired']);
    const appHead = repo.commit({ 'docs/guide.md': 'x\n' }, 'docs');
    const libHead = lib.commit({ 'src/lib.py': 'print(2)\n' }, 'logic');

    const prepared = preparedByCli(box, [{ repo: repo.path, base, head: appHead }, { repo: lib.path, base: 'origin/main', head: libHead }]);

    assert.equal(prepared.risk_class, 'standard');
  });

  test('prepare_reportsNoTier_whenAReviewedRepoHasNoGatedRow', (t) => {
    const { box, repo, base } = setUp(t);
    const lib = box.clone('acme', 'lib');
    const appHead = repo.commit({ 'docs/guide.md': 'x\n' }, 'docs');
    const libHead = lib.commit({ 'docs/guide.md': 'x\n' }, 'docs');
    const appTarget = { repo: repo.path, base, head: appHead };

    const unlisted = preparedByCli(box, [appTarget, { repo: lib.path, base: 'origin/main', head: libHead }]);
    box.writeRegistry(['acme/app\toff\tmain\t-\tnone']);
    const off = preparedByCli(box, [appTarget]);

    assert.equal(unlisted.risk_class, null);
    assert.equal(off.risk_class, null);
  });
});
