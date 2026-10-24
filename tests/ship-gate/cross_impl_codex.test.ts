import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import * as codexLenses from '../../lib/evidence/codex_lenses.ts';
import * as codexReview from '../../lib/evidence/codex_review.ts';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import * as store from '../../lib/evidence/store.ts';
import { AUTHOR, AUDIT, CodexFixture, LENSES, VERIFY } from './codex_helpers.ts';
import { KEEL } from './helpers.ts';

type Outcome = string[];

function typescriptOutcome(action: () => Outcome): Outcome {
  try {
    return action();
  } catch (error) {
    return ['error', (error as Error).constructor.name, (error as Error).message];
  }
}

function registerLenses(f: CodexFixture, audits: string[]): Outcome {
  const done = codexLenses.register(f.repo.path, audits, []);
  return ['ok', done['verdict'], done['root_run_id'], String(done['paths'])];
}

function validateStored(path: string): Outcome {
  codexReview.validateEvidence(store.readFile(path));
  return ['ok', 'validated'];
}

function compatibilityOutcome(f: CodexFixture, dataDir: string, runner: string[]): Outcome {
  const [program, ...prefix] = runner;
  const completed = spawnSync(program!, [...prefix, 'evidence', 'compatibility'], {
    encoding: 'utf8', cwd: f.repo.path, env: { ...f.sandbox.env, KEEL_DATA_DIR: dataDir },
  });
  return ['rc ' + completed.status, completed.stdout.trim(), completed.stderr.trim()];
}

const DELTA_IDENTITY_OFFSET = 100;

function lensIdentity(index: number): string {
  return `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`;
}

function writeLensAudits(f: CodexFixture, delta?: { since: string; root: string }): string[] {
  return LENSES.map((lens, index) => {
    const identity = lensIdentity(index + (delta ? DELTA_IDENTITY_OFFSET : 0));
    const report = {
      ...structuredClone(f.report), version: 2, tree: f.tree, lenses: { [lens]: structuredClone(f.report.lenses[lens]) },
      since_tree: delta?.since ?? null, root_run_id: delta?.root ?? null,
    };
    if (lens === 'rule-checks') report.lenses[lens].evidence = codexReview.runRuleChecks(f.repo.path, f.base, f.tree);
    f.writeSession(identity, AUTHOR, report);
    return identity;
  });
}

function respell(path: string, pattern: RegExp, replacement: string): void {
  const text = readFileSync(path, 'utf8');
  assert.match(text, pattern, path);
  writeFileSync(path, text.replace(pattern, replacement));
}

function sessionFile(f: CodexFixture, identity: string): string {
  const found = (readdirSync(f.profile, { recursive: true }) as string[]).find((name) => name.endsWith(`${identity}.jsonl`));
  return join(f.profile, found!);
}

function storedReviews(dataDir: string): string[] {
  const root = join(dataDir, 'state', 'keel', 'evidence', 'review');
  return (readdirSync(root, { recursive: true }) as string[]).filter((name) => name.endsWith('.json')).sort().map((name) => join(root, name));
}

const RECORDED_ROOT_RUN_ID = 'cx2-aef21664daecd793da45b09e83cadd3a';

describe('Codex evidence with float spellings of version fields', () => {
  test('lens reports spelled "version": 2.0 are registered as version 2', (t) => {
    const f = new CodexFixture(t);
    const audits = writeLensAudits(f);
    for (const identity of audits) respell(sessionFile(f, identity), /\\"version\\":2([,}])/, '\\"version\\":2.0$1');

    assert.deepEqual(typescriptOutcome(() => registerLenses(f, audits)), ['ok', 'PASS', RECORDED_ROOT_RUN_ID, '2']);
  });

  test('stored lens evidence spelled "version": 2.0 is still a version 2 record: it validates, re-registers and extends', (t) => {
    const f = new CodexFixture(t);
    const audits = writeLensAudits(f);
    assert.deepEqual(typescriptOutcome(() => registerLenses(f, audits)), ['ok', 'PASS', RECORDED_ROOT_RUN_ID, '2']);
    const stored = storedReviews(f.sandbox.data);
    for (const path of stored) respell(path, /"version":2([,}\n])/, '"version":2.0$1');

    const [status, inventory] = compatibilityOutcome(f, f.sandbox.data, ['node', KEEL]);
    assert.equal(status, 'rc 0');
    assert.deepEqual(JSON.parse(inventory!), { chain_roots: [], read_only_records: 0, reader_removable: true });
    assert.deepEqual(typescriptOutcome(() => validateStored(stored[0]!)), ['ok', 'validated']);
    assert.deepEqual(typescriptOutcome(() => registerLenses(f, audits)), ['ok', 'PASS', RECORDED_ROOT_RUN_ID, '2']);

    const previousTree = f.tree;
    f.repo.write('src/a.py', 'print(3)\n');
    f.tree = gitcmd.snapshotTree(f.repo.path);
    const delta = writeLensAudits(f, { since: previousTree, root: RECORDED_ROOT_RUN_ID });
    assert.deepEqual(typescriptOutcome(() => registerLenses(f, delta)), ['ok', 'PASS', RECORDED_ROOT_RUN_ID, '1']);
  });

  test('native reports spelled "version": 1.0 are accepted as version 1', (t) => {
    const f = new CodexFixture(t);
    for (const identity of [AUDIT, VERIFY]) respell(sessionFile(f, identity), /\\"version\\":1([,}])/, '\\"version\\":1.0$1');

    assert.deepEqual(typescriptOutcome(() => {
      f.register();
      return ['ok', 'validated'];
    }), ['ok', 'validated']);
  });
});
