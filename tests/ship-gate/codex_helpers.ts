import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import * as codexReview from '../../lib/evidence/codex_review.ts';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import * as registry from '../../lib/evidence/registry.ts';
import * as store from '../../lib/evidence/store.ts';
import type { Outgoing } from '../../lib/evidence/verify.ts';
import * as writers from '../../lib/evidence/writers.ts';
import { Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

export const AUTHOR = '11111111-1111-4111-8111-111111111111';
export const AUDIT = '22222222-2222-4222-8222-222222222222';
export const VERIFY = '33333333-3333-4333-8333-333333333333';
export const LENSES = ['reuse', 'contract', 'tests', 'readable-code', 'rule-checks'];

export class CodexFixture {
  sandbox: Sandbox;
  repo: Repo;
  base: string;
  profile: string;
  tree: string;
  report: any;
  verification: any;

  constructor(t: TestContext) {
    this.sandbox = new Sandbox(t);
    this.repo = this.sandbox.clone('acme', 'app');
    this.base = this.repo.head();
    this.repo.write('src/a.py', 'print(2)\n');
    this.repo.write('tests/test_a.py', 'assert 1 + 1 == 2\n');
    this.profile = join(this.sandbox.root, 'codex');
    t.mock.method(codexReview.seams, 'sessionRoot', () => this.profile);
    this.sandbox.patchProcessEnv(t, { CODEX_HOME: this.profile, CODEX_THREAD_ID: AUTHOR });
    this.tree = gitcmd.snapshotTree(this.repo.path);
    this.report = {
      version: 1, role: 'audit', repo: this.repo.path, base: this.base, tree: this.tree,
      lenses: Object.fromEntries(LENSES.map((key) => [key, { status: 'complete', evidence: 'static: src/a.py:1 inspected' }])),
      findings: [], audit_session: null, decisions: [],
    };
    this.report.lenses['rule-checks'].evidence = codexReview.runRuleChecks(this.repo.path, this.base, this.tree);
    this.writeSession(AUTHOR, null, null);
    this.writeSession(AUDIT, AUTHOR, this.report);
    this.verification = { ...this.report, role: 'verify', audit_session: AUDIT };
    this.writeSession(VERIFY, AUTHOR, this.verification);
  }

  writeSession(identity: string, parent: string | null, report: unknown, completed = true): string {
    const directory = join(this.profile, 'sessions', '2026', '10', '16');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `rollout-2026-10-16T13-00-00-${identity}.jsonl`);
    const meta: Record<string, unknown> = { id: identity, cwd: this.repo.path, source: 'cli' };
    if (parent) Object.assign(meta, { parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });
    const records: unknown[] = [{ type: 'session_meta', payload: meta }];
    if (report) {
      records.push(
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
        {
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify(report) }] },
        });
      if (completed) records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } });
    }
    writeFileSync(path, records.map((row) => JSON.stringify(row) + '\n').join(''));
    return path;
  }

  register(): { evidence_id: string; root_run_id: string; verdict: string } {
    const [auditPath, auditBytes] = codexReview.locateSession(AUDIT);
    const [verifierPath, verifierBytes] = codexReview.locateSession(VERIFY);
    const [, audit] = codexReview.completedReport(auditBytes, AUDIT);
    const [, verification] = codexReview.completedReport(verifierBytes, VERIFY);
    const verdict = codexReview.validateReports(audit, verification, this.repo.path, AUDIT);
    const root = 'cx-' + VERIFY;
    const source = {
      via: codexReview.VIA, session_id: AUTHOR, audit_id: AUDIT, agent_id: VERIFY,
      audit_path: auditPath, agent_transcript_path: verifierPath,
      audit_sha256: codexReview.digest(auditBytes), agent_sha256: codexReview.digest(verifierBytes),
    };
    const body = {
      repo: this.repo.key, repo_root: this.repo.path, run_id: root, root_run_id: root,
      since: null, since_tree: null, review_base: this.base, head: null,
      snapshot_tree: this.tree, reviewed_tree: this.tree, review_kind: codexReview.KIND,
      verdict,
      paths: gitcmd.diffEntries(this.repo.path, this.base, this.tree).map((entry) => ({ path: entry.path, blob: entry.blob, mode: entry.mode })),
      source, [writers.NO_TEST_REASON]: null,
    };
    codexReview.validateEvidence(body);
    const existing = writers.sameReview(this.repo.key, root, this.tree);
    const evidence = existing ?? store.write('review', body, this.repo.key);
    return { evidence_id: evidence.evidence_id, root_run_id: root, verdict };
  }

  outgoing(needsApproval = true): Outgoing {
    return {
      repoRoot: this.repo.path, repoKey: this.repo.key, row: registry.gatedRepos().get(this.repo.key)!,
      head: this.repo.head(), mergeBase: this.base, needsApproval,
    };
  }
}
