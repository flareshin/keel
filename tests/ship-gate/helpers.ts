import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import type { TestContext } from 'node:test';

export const TESTS_DIR = import.meta.dirname;
export const KEEL_HOME = dirname(dirname(TESTS_DIR));
export const KEEL = join(KEEL_HOME, 'bin', 'keel.ts');
export const SHIP_GATE = join(KEEL_HOME, 'hooks', 'ship-gate', 'ship-gate.ts');
const SETTINGS_PATH = join(KEEL_HOME, 'settings', 'core.json');
export const DEFAULT_REGISTRY = ['acme/app\tcode\tmain\tacme\trequired'];
export const PUSH_APPROVAL_REGISTRY = ['acme/app\tcode\tmain\tacme\trequired\ttrue'];
const REGISTRY_HEADER = 'origin\tgate\tintegration_base\trisk_rules\ttests';
const REGISTRY_OPTIONAL_COLUMN = 'push_approval';
export const DEFAULT_RULES = ['acme\tsrc/*/billing/*\theavy', 'acme\tdocs/*\tlight', 'acme\t*.md\tlight',
  'overlay\tsettings/*\tsmoke-only', 'overlay\tledger.tsv\tsmoke-only'];
export const LOGIC_WITH_TEST = { 'src/a.py': 'print(1)\n', 'tests/test_a.py': 'def test_a():\n    assert True\n' };
const GH_STUB = `#!/bin/bash
printf '%s\\n' "\${GH_REPO:+GH_REPO=$GH_REPO }$*" >> "$KEEL_TEST_GH_LOG"
cat "$KEEL_TEST_GH_RESPONSE"
`;
const CLAUDE_STUB = "#!/bin/bash\necho '9.9.9 (Claude Code)'\n";
const GIT_CONFIG = `[user]
\tname = Keel Test
\temail = keel-test@example.com
[init]
\tdefaultBranch = main
[protocol "file"]
\tallow = always
`;

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function shipGateTimeout(): number {
  const registered: number[] = readJson(SETTINGS_PATH).hooks.PreToolUse.flatMap((entry: any) => entry.hooks)
    .filter((registration: any) => registration.command.includes('ship-gate.')).map((registration: any) => registration.timeout);
  if (registered.length !== 1) throw new Error(`expected one ship-gate registration, found ${registered.length}`);
  return registered[0]!;
}

export class Run {
  rc: number;
  stdout: string;
  stderr: string;

  constructor(rc: number, stdout: string, stderr: string) {
    this.rc = rc;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  get json(): any {
    return JSON.parse(this.stdout);
  }

  get context(): string {
    return this.stdout.trim() ? this.json.hookSpecificOutput.additionalContext : '';
  }
}

export interface PayloadOptions {
  agentId?: string;
  session?: string;
}

export class Repo {
  sandbox: Sandbox;
  path: string;
  key: string;

  constructor(sandbox: Sandbox, path: string, key: string) {
    this.sandbox = sandbox;
    this.path = path;
    this.key = key;
  }

  git(...args: string[]): string {
    return this.gitChecked(args, true);
  }

  gitLoose(...args: string[]): string {
    return this.gitChecked(args, false);
  }

  private gitChecked(args: string[], check: boolean): string {
    const completed = spawnSync('git', ['-C', this.path, ...args], { env: this.sandbox.env, encoding: 'utf8' });
    if (check && completed.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${completed.stderr}`);
    return completed.stdout.trim();
  }

  write(relative: string, content: string | Buffer, executable = false): string {
    const full = join(this.path, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (executable) chmodSync(full, statSync(full).mode | 0o111);
    return full;
  }

  commit(files: Record<string, string | Buffer | null>, message = 'change'): string {
    for (const [relative, content] of Object.entries(files)) {
      if (content === null) unlinkSync(join(this.path, relative));
      else this.write(relative, content);
    }
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.head();
  }

  head(): string {
    return this.git('rev-parse', 'HEAD');
  }

  tree(rev = 'HEAD'): string {
    return this.git('rev-parse', rev + '^{tree}');
  }

  branch(name: string, start?: string): void {
    this.git('checkout', '-q', '-b', name, ...(start ? [start] : []));
  }
}

export interface ReviewOptions {
  runId?: string;
  rootRunId?: string;
  since?: string | null;
  verdict?: string;
  kind?: string;
  head?: string | null;
  reviewBase?: string;
  agentId?: string;
  session?: string;
  baseBranch?: string;
  noTestReason?: string | null;
  agentType?: string;
}

export class Sandbox {
  root: string;
  data: string;
  overlay: string;
  home: string;
  remotes: string;
  env: Record<string, string>;
  runner: string[] = ['node', KEEL];
  ghLog: string;
  ghResponse: string;
  private lockedDirectories: string[] = [];

  constructor(t: TestContext, registry: string[] = DEFAULT_REGISTRY, rules: string[] = DEFAULT_RULES) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'keel-ship-gate-')));
    t.after(() => {
      for (const directory of this.lockedDirectories) chmodSync(directory, 0o700);
      rmSync(this.root, { recursive: true, force: true });
    });
    this.data = join(this.root, 'data');
    this.overlay = join(this.root, 'overlay');
    this.home = join(this.root, 'home');
    this.remotes = join(this.root, 'remotes');
    for (const directory of [this.data, this.overlay, this.home, this.remotes]) mkdirSync(directory);
    const gitconfig = join(this.root, 'gitconfig');
    writeFileSync(gitconfig, GIT_CONFIG);
    this.ghLog = join(this.root, 'gh.log');
    this.ghResponse = join(this.root, 'gh.json');
    const ghStub = join(this.root, 'gh');
    writeFileSync(ghStub, GH_STUB);
    chmodSync(ghStub, 0o755);
    this.env = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: this.home, LC_ALL: 'C',
      KEEL_DATA_DIR: this.data, KEEL_OVERLAY_DIR: this.overlay, KEEL_HOME,
      GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', KEEL_GH: ghStub,
      KEEL_TEST_GH_LOG: this.ghLog, KEEL_TEST_GH_RESPONSE: this.ghResponse,
    };
    if (!this.env['KEEL_DATA_DIR']!.startsWith(this.root + sep)) throw new Error('KEEL_DATA_DIR must be inside the temp dir');
    this.writeRegistry(registry);
    this.riskRules(rules);
  }

  patchProcessEnv(t: TestContext, extra: Record<string, string> = {}): void {
    for (const [key, value] of Object.entries({ ...this.env, ...extra })) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
  }

  writeRegistry(rows: string[]): void {
    let header = REGISTRY_HEADER;
    let lines = rows;
    if (rows.some((row) => row.split('\t').length === REGISTRY_HEADER.split('\t').length + 1)) {
      header += '\t' + REGISTRY_OPTIONAL_COLUMN;
      lines = rows.map((row) => row.split('\t').length === header.split('\t').length ? row : row + '\tfalse');
    }
    this.writeTsv('gated-repos.tsv', header, lines);
  }

  stubClaude(): void {
    const stubs = join(this.root, 'stubs');
    mkdirSync(stubs, { recursive: true });
    const path = join(stubs, 'claude');
    writeFileSync(path, CLAUDE_STUB);
    chmodSync(path, 0o755);
    this.env['PATH'] = stubs + delimiter + this.env['PATH'];
  }

  removeRegistry(): void {
    unlinkSync(join(this.overlay, 'gated-repos.tsv'));
  }

  makeLogsUnwritable(): void {
    const logs = join(this.data, 'logs');
    mkdirSync(logs, { recursive: true });
    this.lockedDirectories.push(logs);
    chmodSync(logs, 0o500);
  }

  riskRules(rows: string[]): void {
    this.writeTsv('risk-rules.tsv', 'set\tpath_glob\tclass', rows);
  }

  private writeTsv(name: string, header: string, rows: string[]): void {
    writeFileSync(join(this.overlay, name), [header, ...rows].join('\n') + '\n');
  }

  remote(owner: string, repo: string): string {
    const path = join(this.remotes, owner, repo + '.git');
    try {
      statSync(path);
    } catch {
      mkdirSync(dirname(path), { recursive: true });
      spawnSync('git', ['init', '-q', '--bare', path], { env: this.env, encoding: 'utf8' });
    }
    return path;
  }

  clone(owner: string, repo: string, name?: string, seed?: Record<string, string>): Repo {
    const remote = this.remote(owner, repo);
    const path = join(this.root, 'repos', name ?? repo);
    mkdirSync(dirname(path), { recursive: true });
    const cloned = spawnSync('git', ['clone', '-q', remote, path], { env: this.env, encoding: 'utf8' });
    if (cloned.status !== 0) throw new Error('clone failed: ' + cloned.stderr);
    const clone = new Repo(this, path, `${owner}/${repo}`);
    if (!clone.git('ls-remote', '--heads', 'origin', 'main')) {
      clone.git('checkout', '-q', '-b', 'main');
      clone.commit(seed ?? { 'README.md': 'seed\n', 'src/app.py': "print('seed')\n" }, 'seed');
      clone.git('push', '-q', '-u', 'origin', 'main');
    }
    clone.git('fetch', '-q', 'origin');
    return clone;
  }

  cloneWithSubmodule(): [Repo, Repo] {
    const lib = this.clone('acme', 'lib', undefined, { 'lib.py': 'LIB = 1\n' });
    void lib;
    const parent = this.clone('acme', 'platform', undefined, { 'README.md': 'platform\n' });
    parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', this.remote('acme', 'lib'), 'lib');
    parent.git('commit', '-q', '-m', 'add lib submodule');
    parent.git('push', '-q', 'origin', 'main');
    parent.git('fetch', '-q', 'origin');
    const submodule = new Repo(this, join(parent.path, 'lib'), 'acme/lib');
    submodule.git('fetch', '-q', 'origin');
    return [parent, submodule];
  }

  keel(args: string[], options: { cwd?: string; stdin?: string } = {}): Run {
    const [program, ...prefix] = this.runner;
    const completed = spawnSync(program!, [...prefix, ...args], {
      input: options.stdin ?? '', encoding: 'utf8', env: this.env, cwd: options.cwd ?? this.root,
    });
    return new Run(completed.status ?? -1, completed.stdout, completed.stderr);
  }

  hook(payload: unknown, extraEnv: Record<string, string> = {}): Run {
    return this.hookRaw(JSON.stringify(payload), extraEnv);
  }

  hookRaw(stdin: string, extraEnv: Record<string, string> = {}): Run {
    const completed = spawnSync(process.execPath, [SHIP_GATE], { input: stdin, encoding: 'utf8', env: { ...this.env, ...extraEnv } });
    return new Run(completed.status ?? -1, completed.stdout, completed.stderr);
  }

  bashPayload(repo: Repo, command: string, options: PayloadOptions = {}): any {
    const session = options.session ?? 's1';
    const payload: Record<string, unknown> = {
      session_id: session, transcript_path: this.mainTranscript(session), cwd: repo.path, permission_mode: 'default',
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu1',
    };
    if (options.agentId) {
      payload['agent_id'] = options.agentId;
      payload['agent_type'] = 'general-purpose';
    }
    return payload;
  }

  push(repo: Repo, command = 'git push origin HEAD', options: PayloadOptions = {}): Run {
    return this.hook(this.bashPayload(repo, command, options));
  }

  fires(ruleId?: string, outcome?: string): any[] {
    let content: string;
    try {
      content = readFileSync(join(this.data, 'logs', 'keel-fires.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const lines = content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    return lines.filter((line) => (ruleId === undefined || line.rule_id === ruleId) && (outcome === undefined || line.outcome === outcome));
  }

  evidenceFiles(kind: string): string[] {
    const found: string[] = [];
    const walk = (directory: string) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.json')) found.push(full);
      }
    };
    walk(join(this.data, 'state', 'keel', 'evidence', kind));
    return found.sort();
  }

  mainTranscript(session = 's1'): string {
    const path = join(this.data, 'projects', 'proj', session + '.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, 'a'));
    return path;
  }

  agentTranscript(session = 's1', agentId = 'ag1', subdir = ''): string {
    const path = join(this.data, 'projects', 'proj', session, 'subagents', subdir, `agent-${agentId}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, 'a'));
    return path;
  }

  reviewRequest(repo: Repo, options: ReviewOptions = {}): any {
    const head = options.head ?? null;
    const snapshot = head ? null : this.keel(['snapshot', repo.path]).json.tree;
    const runId = options.runId ?? 'rv-root-0001';
    const session = options.session ?? 's1';
    const agentId = options.agentId ?? 'ag1';
    const keelEvidence: Record<string, unknown> = {
      v: 1, repo_root: repo.path,
      review_base: options.reviewBase ?? repo.git('merge-base', options.baseBranch ?? 'origin/main', head ?? 'HEAD'),
      head, snapshot_tree: snapshot, since: options.since ?? null, run_id: runId,
      root_run_id: options.rootRunId ?? runId, review_kind: options.kind ?? 'lens-review',
    };
    if (options.noTestReason !== undefined && options.noTestReason !== null) keelEvidence['no_test_reason'] = options.noTestReason;
    return {
      keel_evidence: keelEvidence,
      verdict: options.verdict ?? 'PASS',
      source: {
        session_id: session, agent_id: agentId, agent_type: options.agentType ?? 'general-purpose',
        transcript_path: this.mainTranscript(session),
        agent_transcript_path: this.agentTranscript(session, agentId), via: 'SubagentHandback',
      },
    };
  }

  review(repo: Repo, options: ReviewOptions = {}): Run {
    const run = this.keel(['evidence', 'write-review'], { stdin: JSON.stringify(this.reviewRequest(repo, options)) });
    if (run.rc !== 0) throw new Error(`write-review failed (${run.rc}): ${run.stderr}`);
    return run;
  }

  testsEvidence(repo: Repo, output = 'Ran 3 tests'): Run {
    const run = this.keel(['test', '--', 'bash', '-c', `echo '${output}'`], { cwd: repo.path });
    if (run.rc !== 0) throw new Error(`keel test failed (${run.rc}): ${run.stderr}`);
    return run;
  }

  smokeEvidence(repo: Repo, ok = true, tree?: string, runId = 'sm-0001'): Run {
    this.smokeLine(repo, ok, tree, runId);
    return this.keel(['evidence', 'write-smoke', '--repo', repo.path]);
  }

  smokeLine(repo: Repo, ok = true, tree?: string, runId = 'sm-0001'): void {
    const logs = join(this.data, 'logs');
    mkdirSync(logs, { recursive: true });
    const line = { ts: '2026-10-11T00:00:00Z', run_id: runId, ok, count: 1, failed: [], trees: { [repo.key]: tree ?? repo.tree() } };
    writeFileSync(join(logs, 'keel-smoke.jsonl'), JSON.stringify(line) + '\n', { flag: 'a' });
  }

  approve(rootRunId: string): Run {
    const run = this.keel(['approve', rootRunId]);
    if (run.rc !== 0) throw new Error(`keel approve failed (${run.rc}): ${run.stderr}`);
    return run;
  }

  pushBundle(repo: Repo, rootRunId = 'rv-root-0001'): void {
    this.review(repo, { runId: rootRunId });
    this.testsEvidence(repo);
  }

  fullBundle(repo: Repo, rootRunId = 'rv-root-0001'): void {
    this.review(repo, { runId: rootRunId });
    this.testsEvidence(repo);
    this.approve(rootRunId);
  }
}
