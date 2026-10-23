import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import * as codexLenses from '../../lib/evidence/codex_lenses.ts';
import * as codexReview from '../../lib/evidence/codex_review.ts';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import { pythonJsonLoads } from '../../lib/evidence/pycompat.ts';
import { AUTHOR, AUDIT, CodexFixture, LENSES, VERIFY } from './codex_helpers.ts';
import { recordedAnswers } from '../recorded.ts';
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
  codexReview.validateEvidence(pythonJsonLoads(readFileSync(path, 'utf8')) as any);
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

function recordedPythonOutcome(f: CodexFixture, question: { test: string; step: string }): Outcome {
  return recordedAnswers<unknown, Outcome>('ship-gate-cross-impl-codex', [question], { '{{ROOT}}': f.sandbox.root })[0] as Outcome;
}

describe('TypeScript agrees with the recorded Python outcomes on float spellings of version fields', () => {
  test('lens reports spelled "version": 2.0 are registered like Python', (t) => {
    const f = new CodexFixture(t);
    const audits = writeLensAudits(f);
    for (const identity of audits) respell(sessionFile(f, identity), /\\"version\\":2([,}])/, '\\"version\\":2.0$1');

    const python = recordedPythonOutcome(f, { test: 'lens-version-float', step: 'register' });
    const typescript = typescriptOutcome(() => registerLenses(f, audits));

    assert.deepEqual(typescript, python);
    assert.deepEqual(python.slice(0, 2), ['ok', 'PASS']);
  });

  test('stored lens evidence spelled "version": 2.0 validates, re-registers and extends like Python', (t) => {
    const f = new CodexFixture(t);
    const audits = writeLensAudits(f);
    const steps: Array<[string, Outcome, Outcome]> = [];
    const test = 'stored-version-float';
    const both = (label: string, typescript: Outcome) => steps.push([label, recordedPythonOutcome(f, { test, step: label }), typescript]);
    both('register', typescriptOutcome(() => registerLenses(f, audits)));
    const stored = storedReviews(f.sandbox.data);
    for (const path of stored) respell(path, /"version": 2([,}\n])/, '"version": 2.0$1');
    both('compatibility', compatibilityOutcome(f, f.sandbox.data, ['node', KEEL]));
    both('validate stored', typescriptOutcome(() => validateStored(stored[0]!)));
    both('register again', typescriptOutcome(() => registerLenses(f, audits)));

    const previousTree = f.tree;
    const root = steps[0]![1]![2]!;
    f.repo.write('src/a.py', 'print(3)\n');
    f.tree = gitcmd.snapshotTree(f.repo.path);
    const delta = writeLensAudits(f, { since: previousTree, root });
    both('delta', typescriptOutcome(() => registerLenses(f, delta)));

    for (const [label, pythonResult, typescriptResult] of steps) assert.deepEqual(typescriptResult, pythonResult, label);
    assert.deepEqual(steps.map(([, pythonResult]) => pythonResult[0]), ['ok', 'rc 0', 'ok', 'ok', 'ok']);
    assert.match(steps[1]![1]![1]!, /"read_only_records": 0/);
  });

  test('native reports spelled "version": 1.0 are accepted like Python', (t) => {
    const f = new CodexFixture(t);
    for (const identity of [AUDIT, VERIFY]) respell(sessionFile(f, identity), /\\"version\\":1([,}])/, '\\"version\\":1.0$1');

    const typescript = typescriptOutcome(() => {
      f.register();
      return ['ok', 'validated'];
    });
    const python = typescript[0] === 'ok'
      ? recordedPythonOutcome(f, { test: 'native-version-float', step: 'validate' })
      : ['not registered'];

    assert.deepEqual(typescript, ['ok', 'validated']);
    assert.deepEqual(python, typescript);
  });
});
