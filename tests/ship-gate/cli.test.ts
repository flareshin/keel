import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import { KEEL, Sandbox, expireEvidence, readJson } from './helpers.ts';
import type { Repo, Run } from './helpers.ts';

function summaryOf(run: Run): any {
  const lastLine = run.stderr.trim().split('\n').at(-1)!;
  return JSON.parse(lastLine.slice(lastLine.indexOf(' ') + 1));
}

describe('KeelTestCommandTest', () => {
  test('keelTest_writesEvidence_whenGreenRunReportsTests', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 7 tests'; echo OK"], { cwd: repo.path });
    assert.equal(run.rc, 0, run.stderr);
    assert.match(run.stdout, /Ran 7 tests/);
    const summary = summaryOf(run);
    assert.deepEqual([summary.count, summary.exit], [7, 0]);
    const evidence = readJson(sandbox.evidenceFiles('tests')[0]!);
    assert.deepEqual([evidence.count, evidence.framework, evidence.tree], [7, 'unittest', repo.tree()]);
    assert.deepEqual(evidence.cmd, ['bash', '-c', "echo 'Ran 7 tests'; echo OK"]);
    assert.equal(statSync(sandbox.evidenceFiles('tests')[0]!).mode & 0o777, 0o600);
  });

  test('keelTest_exits4WithoutEvidence_whenNoTestsRecognized', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', 'echo BUILD SUCCESS'], { cwd: repo.path });
    assert.equal(run.rc, 4);
    assert.deepEqual(sandbox.evidenceFiles('tests'), []);
    const log = readFileSync(join(sandbox.data, 'logs', 'keel-tests.jsonl'), 'utf8');
    assert.equal(JSON.parse(log.split('\n')[0]!).evidence_id, null);
  });

  test('keelTest_keepsExitCodeWithoutEvidence_whenCommandFails', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 2 tests'; exit 3"], { cwd: repo.path });
    assert.equal(run.rc, 3);
    assert.deepEqual(sandbox.evidenceFiles('tests'), []);
  });

  test('keelTest_writesNoEvidence_whenCommandChangesTheTree', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo changed > generated.txt; echo '4 passed'"], { cwd: repo.path });
    assert.equal(run.rc, 0);
    assert.deepEqual(sandbox.evidenceFiles('tests'), []);
  });

  test('keelTest_writesSubmoduleEvidence_withItsUncommittedContent', (t) => {
    const sandbox = new Sandbox(t);
    const [parent, submodule] = sandbox.cloneWithSubmodule();
    submodule.write('lib.py', 'LIB = 2\n');
    const submoduleTree = sandbox.keel(['snapshot', submodule.path]).json.tree;
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 2 tests'"], { cwd: parent.path });
    assert.equal(run.rc, 0, run.stderr);
    const byRepo = Object.fromEntries(sandbox.evidenceFiles('tests').map((path) => [readJson(path).repo, readJson(path)]));
    assert.deepEqual(Object.keys(byRepo).sort(), ['acme/lib', 'acme/platform']);
    const lib = byRepo['acme/lib'];
    assert.deepEqual([lib.tree, lib.head, lib.count], [submoduleTree, submodule.head(), 2]);
    assert.equal(lib.superproject, 'acme/platform');
    assert.deepEqual(summaryOf(run).submodule_evidence, { 'acme/lib': lib.evidence_id });
  });

  test('keelTest_writesNoSubmoduleEvidence_whenCommandChangesTheSubmodule', (t) => {
    const sandbox = new Sandbox(t);
    const [parent] = sandbox.cloneWithSubmodule();
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo changed > lib/generated.txt; echo '4 passed'"], { cwd: parent.path });
    assert.equal(run.rc, 0, run.stderr);
    assert.deepEqual(sandbox.evidenceFiles('tests').map((path) => readJson(path).repo), ['acme/platform']);
  });

  test('keelTest_writesNoSubmoduleEvidence_whenTheParentRunDoesNotCount', (t) => {
    const sandbox = new Sandbox(t);
    const [parent] = sandbox.cloneWithSubmodule();
    for (const command of ["echo 'Ran 2 tests'; exit 1", 'echo BUILD SUCCESS', "echo x > touched.txt; echo 'Ran 2 tests'"]) {
      const run = sandbox.keel(['test', '--', 'bash', '-c', command], { cwd: parent.path });
      assert.deepEqual(summaryOf(run).submodule_evidence, {}, command);
    }
    assert.deepEqual(sandbox.evidenceFiles('tests'), []);
  });

  test('keelTest_writesNestedSubmoduleEvidence_underTheInnerOrigin', (t) => {
    const sandbox = new Sandbox(t);
    const [parent, submodule] = sandbox.cloneWithSubmodule();
    sandbox.clone('acme', 'inner', undefined, { 'inner.py': 'INNER = 1\n' });
    submodule.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sandbox.remote('acme', 'inner'), 'inner');
    submodule.git('commit', '-q', '-m', 'add inner submodule');
    const innerPath = join(submodule.path, 'inner');
    writeFileSync(join(innerPath, 'inner.py'), 'INNER = 2\n');
    const innerTree = sandbox.keel(['snapshot', innerPath]).json.tree;
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 2 tests'"], { cwd: parent.path });
    assert.equal(run.rc, 0, run.stderr);
    const byRepo = Object.fromEntries(sandbox.evidenceFiles('tests').map((path) => [readJson(path).repo, readJson(path)]));
    assert.deepEqual(Object.keys(byRepo).sort(), ['acme/inner', 'acme/lib', 'acme/platform']);
    assert.equal(byRepo['acme/inner'].tree, innerTree);
  });

  test('keelTest_skipsSubmoduleEvidence_whenTheSubmoduleHasNoOrigin', (t) => {
    const sandbox = new Sandbox(t);
    const [parent, submodule] = sandbox.cloneWithSubmodule();
    submodule.git('remote', 'remove', 'origin');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 2 tests'"], { cwd: parent.path });
    assert.equal(run.rc, 0, run.stderr);
    assert.deepEqual(summaryOf(run).submodule_evidence, {});
    assert.deepEqual(sandbox.evidenceFiles('tests').map((path) => readJson(path).repo), ['acme/platform']);
  });

  test('keelTest_countsTestsOnly_whenVitestOrJestAlsoSummarizesFiles', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const cases: Array<[string, number]> = [
      [' Test Files  7 passed (7)\\n      Tests  67 passed (67)', 67],
      ['Test Suites: 2 passed, 2 total\\nTests:       9 passed, 9 total', 9],
    ];
    for (const [output, expected] of cases) {
      const run = sandbox.keel(['test', '--', 'bash', '-c', `printf '${output}\\n'`], { cwd: repo.path });
      assert.equal(run.rc, 0, run.stderr);
      assert.equal(summaryOf(run).count, expected, output);
    }
  });

  test('keelTest_forwardsOutputWhileTheCommandRuns_andKeepsStdoutStderrOrder', async (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const script = "echo first; echo error-first >&2; sleep 1; echo second; echo error-second >&2; echo 'Ran 1 test'";
    const child = childProcess.spawn('node', [KEEL, 'test', '--', 'bash', '-c', script], { cwd: repo.path, env: sandbox.env });
    let output = '';
    let stillRunningAtFirstOutput: boolean | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      stillRunningAtFirstOutput ??= child.exitCode === null && child.signalCode === null;
      output += chunk.toString();
    });
    child.stderr.resume();
    const exitCode = await new Promise((resolveExit) => child.on('close', resolveExit));
    assert.equal(exitCode, 0);
    assert.equal(stillRunningAtFirstOutput, true);
    assert.equal(output, 'first\nerror-first\nsecond\nerror-second\nRan 1 test\n');
  });

  test('keelTest_keepsEveryByte_whenOutputIsLargerThanOneRead', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "head -c 300000 /dev/zero | tr '\\0' x; echo; echo 'Ran 1 test'"], { cwd: repo.path });
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(run.stdout, 'x'.repeat(300000) + '\nRan 1 test\n');
  });

  test('keelTest_recognizesSurefireTotals_whenPerClassLinesPrecede', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const output = 'Tests run: 3, Failures: 0\\nTests run: 2, Failures: 0\\nResults:\\nTests run: 5, Failures: 0';
    const run = sandbox.keel(['test', '--', 'bash', '-c', `printf '${output}\\n'`], { cwd: repo.path });
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(readJson(sandbox.evidenceFiles('tests')[0]!).count, 5);
  });

  test('keelTest_isUsageError_whenNoDoubleDash', (t) => {
    const sandbox = new Sandbox(t);
    assert.equal(sandbox.keel(['test', 'echo']).rc, 2);
  });
});

describe('SnapshotTest', () => {
  test('snapshot_includesUntrackedAndLeavesIndexUntouched', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.write('untracked.txt', 'new\n');
    const run = sandbox.keel(['snapshot', repo.path]);
    assert.equal(run.rc, 0, run.stderr);
    const tree = run.json.tree;
    assert.notEqual(tree, repo.tree());
    assert.match(repo.git('ls-tree', '--name-only', tree), /untracked\.txt/);
    assert.equal(repo.git('status', '--porcelain'), '?? untracked.txt');
  });

  test('snapshot_isUsageError_whenPathIsNotARepo', (t) => {
    const sandbox = new Sandbox(t);
    assert.equal(sandbox.keel(['snapshot', sandbox.home]).rc, 2);
  });

  test('snapshot_givesEachGitCallTheSnapshotTimeout_notTheHookBudget', (t) => {
    const done = { status: 0, signal: null, stdout: Buffer.from('tree\n'), stderr: Buffer.alloc(0), pid: 1, output: [] };
    const spawn = t.mock.method(childProcess, 'spawnSync', () => done);
    gitcmd.snapshotTree('/nowhere');
    const timeouts = spawn.mock.calls.map((call) => (call.arguments[2] as { timeout: number }).timeout);
    assert.equal(timeouts.length, 3);
    assert.ok(!timeouts.includes(gitcmd.GIT_TIMEOUT_SECONDS * 1000));
    assert.deepEqual(new Set(timeouts), new Set([gitcmd.SNAPSHOT_TIMEOUT_SECONDS * 1000]));
  });
});

function feature(sandbox: Sandbox): Repo {
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit({ 'src/a.py': 'a\n', 'README.md': null });
  return repo;
}

describe('WriteReviewTest', () => {
  test('writeReview_recomputesPathsFromGit_whenClaimIsValid', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const run = sandbox.review(repo);
    assert.equal(run.json.paths, 2);
    const evidence = readJson(sandbox.evidenceFiles('review')[0]!);
    const paths = Object.fromEntries(evidence.paths.map((entry: any) => [entry.path, [entry.blob, entry.mode]]));
    assert.deepEqual(paths['README.md'], [null, '000000']);
    assert.equal(paths['src/a.py'][1], '100644');
    assert.equal(evidence.reviewed_tree, evidence.snapshot_tree);
    assert.equal(evidence.source.via, 'SubagentHandback');
  });

  test('writeReview_recordsTheReporterType_whenTheLensReviewReporterHandsBack', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    sandbox.review(repo, { agentType: 'keel-reporter' });
    assert.equal(readJson(sandbox.evidenceFiles('review')[0]!).source.agent_type, 'keel-reporter');
  });

  test('writeReview_isIdempotent_whenSameRunReviewsSameTree', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const first = sandbox.review(repo).json;
    const second = sandbox.review(repo).json;
    assert.equal(first.evidence_id, second.evidence_id);
    assert.equal(sandbox.evidenceFiles('review').length, 1);
  });

  test('writeReview_linksDelta_whenSinceNamesAReviewedTree', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const rootTree = sandbox.keel(['snapshot', repo.path]).json.tree;
    const rootId = sandbox.review(repo).json.evidence_id;
    repo.commit({ 'src/b.py': 'b\n' });
    const delta = sandbox.review(repo, { runId: 'rv-delta-0002', rootRunId: 'rv-root-0001', since: rootTree }).json;
    assert.equal(delta.paths, 1);
    const evidence = sandbox.evidenceFiles('review').map(readJson);
    const deltaEvidence = evidence.find((item: any) => item.run_id === 'rv-delta-0002');
    assert.deepEqual([deltaEvidence.since, deltaEvidence.since_tree], [rootId, rootTree]);
  });

  test('writeReview_refuses_whenSinceTreeWasNeverReviewed', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    sandbox.review(repo);
    const request = sandbox.reviewRequest(repo, { runId: 'rv-delta-0002', rootRunId: 'rv-root-0001', since: 'a'.repeat(40) });
    const run = sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) });
    assert.equal(run.rc, 3, run.stderr);
    assert.equal(sandbox.evidenceFiles('review').length, 1);
  });

  test('writeReview_refuses_whenRootRunIdDiffersForRootReview', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const request = sandbox.reviewRequest(repo, { runId: 'rv-root-0001', rootRunId: 'rv-root-0000' });
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) }).rc, 3);
  });

  test('writeReview_isUsageError_whenKeysAreWrong', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    let request = sandbox.reviewRequest(repo);
    request.keel_evidence.paths = ['src/a.py'];
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) }).rc, 2);
    request = sandbox.reviewRequest(repo);
    request.keel_evidence.head = repo.head();
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) }).rc, 2);
    assert.deepEqual(sandbox.evidenceFiles('review'), []);
  });

  test('writeReview_checksNoTestReason_onlyForBeingNonBlank', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const blank = sandbox.reviewRequest(repo, { noTestReason: '  ' });
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(blank) }).rc, 2);
    const longReason = sandbox.reviewRequest(repo, { noTestReason: 'wording only '.repeat(30) });
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(longReason) }).rc, 0);
  });

  test('reviewPrepare_readsDeeplyNestedStdin_andRefusesItWhenItIsNotAnObject', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.keel(['review', 'prepare'], { stdin: '['.repeat(200_000) + ']'.repeat(200_000) });
    assert.equal(run.rc, 2, run.stderr.slice(0, 300));
    assert.ok(run.stderr.startsWith('keel: stdin must be a JSON object\n'), run.stderr.slice(0, 300));
  });

  test('reviewPrepare_reportsAnInternalError_whenDeepStdinAlsoHoldsAnIntegerPastDoublePrecision', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.keel(['review', 'prepare'], { stdin: '['.repeat(200_000) + '9007199254740993' + ']'.repeat(200_000) });
    assert.equal(run.rc, 70, run.stderr.slice(0, 300));
    assert.ok(run.stderr.includes('keel: internal error: RangeError'), run.stderr.slice(0, 300));
    assert.ok(!run.stderr.includes('stdin is not JSON'), run.stderr.slice(0, 300));
  });

  test('writeReview_refuses_whenObjectsAreMissing', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const request = sandbox.reviewRequest(repo);
    request.keel_evidence.snapshot_tree = 'b'.repeat(40);
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) }).rc, 3);
  });

  test('writeReview_refuses_whenAgentIdIsMissing', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const request = sandbox.reviewRequest(repo);
    request.source.agent_id = null;
    const run = sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) });
    assert.equal(run.rc, 3);
    assert.match(run.stderr, /no agent_id/);
    assert.deepEqual(sandbox.evidenceFiles('review'), []);
  });

  test('writeReview_refuses_whenAgentTranscriptIsMissing', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const request = sandbox.reviewRequest(repo);
    request.source.agent_transcript_path = join(sandbox.data, 'projects', 'proj', 's1', 'subagents', 'agent-gone.jsonl');
    const run = sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) });
    assert.equal(run.rc, 3);
    assert.match(run.stderr, /agent transcript does not exist/);
    assert.deepEqual(sandbox.evidenceFiles('review'), []);
  });

  test('writeReview_accepts_whenAgentTranscriptSitsInAWorkflowSubdirectory', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const request = sandbox.reviewRequest(repo);
    request.source.agent_transcript_path = sandbox.agentTranscript('s1', 'ag1', 'wf-1');
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) }).rc, 0);
  });
});

describe('ApproveTest', () => {
  test('approve_refuses_whenNoChainHasThatRoot', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.keel(['approve', 'rv-none-0001']);
    assert.equal(run.rc, 3);
    assert.deepEqual(sandbox.evidenceFiles('approval'), []);
  });

  test('approve_refuses_whenAHeadIsNeedsFixes', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    repo.commit({ 'src/a.py': 'a\n' });
    sandbox.review(repo, { verdict: 'NEEDS_FIXES' });
    const run = sandbox.keel(['approve', 'rv-root-0001']);
    assert.equal(run.rc, 3);
    assert.match(run.stderr, /not PASS for acme\/app/);
  });

  test('approve_pinsHeads_andReadWritesAck', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    repo.commit({ 'src/a.py': 'a\n' });
    const headId = sandbox.review(repo).json.evidence_id;
    const approval = sandbox.keel(['approve', 'rv-root-0001']).json;
    const ack = sandbox.keel(['approve', 'rv-root-0001', '--read']).json;
    assert.deepEqual([approval.kind, approval.heads], ['approval', { 'acme/app': headId }]);
    assert.equal(ack.kind, 'ack');
    assert.equal(readJson(sandbox.evidenceFiles('approval')[0]!).source, 'cli');
  });

  test('approve_isUsageError_whenRootIsMalformed', (t) => {
    const sandbox = new Sandbox(t);
    assert.equal(sandbox.keel(['approve', 'x']).rc, 2);
  });
});

describe('SmokeShowGcTest', () => {
  test('writeSmoke_refuses_whenRunFailedOrDidNotCoverRepo', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    assert.equal(sandbox.smokeEvidence(repo, false).rc, 3);
    const other = sandbox.clone('acme', 'other');
    sandbox.smokeLine(other, true, undefined, 'sm-0002');
    assert.equal(sandbox.keel(['evidence', 'write-smoke', '--repo', repo.path]).rc, 3);
    assert.deepEqual(sandbox.evidenceFiles('smoke'), []);
  });

  test('writeSmoke_picksNamedRun_whenRunGiven', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    sandbox.smokeLine(repo, true, undefined, 'sm-0001');
    sandbox.smokeLine(repo, false, undefined, 'sm-0002');
    const run = sandbox.keel(['evidence', 'write-smoke', '--repo', repo.path, '--run', 'sm-0001']);
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(run.json.tree, repo.tree());
  });

  test('show_listsChainsTestsAndSmoke_whenEvidenceExists', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    repo.commit({ 'src/a.py': 'a\n' });
    sandbox.fullBundle(repo);
    sandbox.smokeEvidence(repo);
    const shown = sandbox.keel(['evidence', 'show', '--repo', repo.path]).json;
    assert.equal(shown.repo, 'acme/app');
    const chain = shown.chains[0];
    assert.deepEqual([chain.root_run_id, chain.verdict, chain.paths, chain.approved, chain.acked],
      ['rv-root-0001', 'PASS', 1, true, false]);
    assert.deepEqual([shown.tests.length, shown.smoke.length], [1, 1]);
    assert.deepEqual(sandbox.keel(['evidence', 'show', '--repo', repo.path, '--root', 'rv-x']).json.chains, []);
  });

  test('gc_deletesExpired_keepsLiveEvidenceEvenWhenMerged', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    const mergedHead = repo.commit({ 'src/a.py': 'a\n' });
    sandbox.review(repo, { head: mergedHead });
    sandbox.testsEvidence(repo);
    sandbox.approve('rv-root-0001');
    const expired = sandbox.evidenceFiles('approval')[0]!;
    expireEvidence(expired);
    repo.commit({ 'src/live.py': 'live\n' });
    sandbox.review(repo, { runId: 'rv-root-0002' });
    repo.git('push', '-q', 'origin', 'feature:main');
    repo.git('fetch', '-q', 'origin');
    const run = sandbox.keel(['evidence', 'gc']);
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(run.json.deleted, 1);
    assert.equal(sandbox.evidenceFiles('review').length, 2);
    assert.equal(sandbox.evidenceFiles('tests').length, 1);
    assert.deepEqual(sandbox.evidenceFiles('approval'), []);
  });
});

describe('KeelEntryPointTest', () => {
  function stubbedHome(t: TestContext): string {
    const home = mkdtempSync(join(tmpdir(), 'keel-entry-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, 'lib', 'evidence'), { recursive: true });
    writeFileSync(join(home, 'lib', 'evidence', 'cli.ts'),
      "export async function main(argv: string[]): Promise<number> {\n  process.stdout.write('stub:' + argv.join(',') + '\\n');\n  return 5;\n}\n");
    return home;
  }

  function entry(keelHome: string | undefined, args: string[]) {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    delete env['KEEL_HOME'];
    if (keelHome !== undefined) env['KEEL_HOME'] = keelHome;
    return childProcess.spawnSync('node', [KEEL, ...args], { encoding: 'utf8', env });
  }

  test('entry_loadsCliFromKeelHome_whenSet', (t) => {
    const run = entry(stubbedHome(t), ['a', 'b']);
    assert.deepEqual([run.status, run.stdout], [5, 'stub:a,b\n']);
  });

  test('entry_loadsCliBesideItself_whenKeelHomeIsEmpty', () => {
    const run = entry('', ['bogus']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^keel: /);
  });
});

describe('EchoedNumberTest', () => {
  const NUMBER_TOKENS: Array<[token: string, persisted: string]> = [
    ['1.0', '1'], ['-0.0', '0'], ['1e16', '10000000000000000'], ['9007199254740993', '9007199254740993'], ['1E2', '100'],
  ];

  for (const [token, persisted] of NUMBER_TOKENS) {
    test(`writeReview_persistsTheNumberTheTokenDenotes_whenAgentTypeIsTheNumberToken ${token}`, (t) => {
      const sandbox = new Sandbox(t);
      const repo = sandbox.clone('acme', 'app');
      repo.branch('feature');
      repo.commit({ 'src/a.py': 'a\n' });
      const stdin = JSON.stringify(sandbox.reviewRequest(repo)).replace('"agent_type":"general-purpose"', `"agent_type":${token}`);
      assert.ok(stdin.includes(`"agent_type":${token},`), stdin);
      const written = sandbox.keel(['evidence', 'write-review'], { stdin });
      assert.equal(written.rc, 0, written.stderr);
      const file = sandbox.evidenceFiles('review').at(-1)!;
      assert.equal(/"agent_type":([^,]*),/.exec(readFileSync(file, 'utf8'))![1], persisted);
      rmSync(file);
    });
  }
});
