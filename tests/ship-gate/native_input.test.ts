import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { InvalidUtf8Error } from '../../measure/lib/measurekit/files.ts';
import { parseJsonKeepingIntegers } from '../../measure/lib/measurekit/json.ts';
import { dataDir } from '../../lib/evidence/env.ts';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import * as codexReview from '../../lib/evidence/codex_review.ts';
import { onlyCommentDeletions } from '../../lib/evidence/comment_cleanup.ts';
import { RegistryError, readTsv } from '../../lib/evidence/registry.ts';
import * as store from '../../lib/evidence/store.ts';
import { TimeoutExpired, runCaptured } from '../../lib/evidence/subprocess.ts';
import { recognize } from '../../lib/evidence/testrun.ts';
import { Refused, Usage, isInputFailure } from '../../lib/evidence/writers.ts';
import { LOGIC_WITH_TEST, Sandbox } from './helpers.ts';

const scratch = mkdtempSync(join(tmpdir(), 'keel-native-input-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function feature(sandbox: Sandbox) {
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(LOGIC_WITH_TEST);
  return repo;
}

describe('write-review reads its stdin as plain JSON', () => {
  test('stdin that is not valid UTF-8 is refused as not JSON, exit 2', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.keel(['evidence', 'write-review'], { stdin: Buffer.from([0x7b, 0xff, 0x7d]) as unknown as string });
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.startsWith('keel: stdin is not JSON: stdin is not valid UTF-8\n'), run.stderr);
  });

  test('NaN and Infinity are not JSON, exit 2', (t) => {
    const sandbox = new Sandbox(t);
    for (const stdin of ['{"keel_evidence": NaN}', '{"a": Infinity}', '[-Infinity]']) {
      const run = sandbox.keel(['evidence', 'write-review'], { stdin });
      assert.equal(run.rc, 2, stdin);
      assert.ok(run.stderr.startsWith('keel: stdin is not JSON: '), run.stderr);
    }
  });

  test('a claim whose ids are numbers is refused, exit 2, even when the number reads like an id', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const cases: Array<[key: string, value: unknown, message: string]> = [
      ['run_id', 12345678, 'run_id must match'], ['root_run_id', 12345678, 'root_run_id must match'],
      ['review_base', 1234567890123456789012345678901234567890n, 'review_base must be a 40-hex id'],
    ];
    for (const [key, value, message] of cases) {
      const request = sandbox.reviewRequest(repo);
      request.keel_evidence[key] = '@@NUMBER@@';
      const stdin = JSON.stringify(request).replace('"@@NUMBER@@"', String(value));
      const run = sandbox.keel(['evidence', 'write-review'], { stdin });
      assert.equal(run.rc, 2, `${key}: ${run.stderr}`);
      assert.ok(run.stderr.includes(`keel: ${message}`), run.stderr);
    }
    assert.deepEqual(sandbox.evidenceFiles('review'), []);
  });

  test('ids followed by a newline are refused, exit 2', (t) => {
    const sandbox = new Sandbox(t);
    const repo = feature(sandbox);
    const request = sandbox.reviewRequest(repo);
    request.keel_evidence.run_id = 'rv-root-0001\n';
    request.keel_evidence.root_run_id = 'rv-root-0001\n';
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(request) }).rc, 2);
    const withHead = sandbox.reviewRequest(repo);
    withHead.keel_evidence.review_base += '\n';
    assert.equal(sandbox.keel(['evidence', 'write-review'], { stdin: JSON.stringify(withHead) }).rc, 2);
    assert.equal(sandbox.keel(['approve', 'rv-root-0001\n']).rc, 2);
    assert.deepEqual(sandbox.evidenceFiles('review'), []);
  });

  test('an integer beyond 2^53 where an object is expected is refused as a claim without the right keys, exit 2', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.keel(['evidence', 'write-review'], { stdin: '{"keel_evidence": 9007199254740993, "verdict": "PASS", "source": {}}' });
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('keel: keel_evidence must have exactly the keys'), run.stderr);
  });
});

describe('write-smoke counts a smoke run as passed only when ok is JSON true', () => {
  for (const ok of ['1', '"yes"', '[]', '{}']) {
    test(`ok ${ok} is refused, exit 3`, (t) => {
      const sandbox = new Sandbox(t);
      const repo = sandbox.clone('acme', 'app');
      mkdirSync(join(sandbox.data, 'logs'), { recursive: true });
      const line = `{"run_id":"sm-0001","ok":${ok},"trees":{"${repo.key}":"${repo.tree()}"}}\n`;
      writeFileSync(join(sandbox.data, 'logs', 'keel-smoke.jsonl'), line);
      const run = sandbox.keel(['evidence', 'write-smoke', '--repo', repo.path]);
      assert.equal(run.rc, 3, run.stderr);
      assert.ok(run.stderr.includes('keel: refused: smoke run sm-0001 failed'), run.stderr);
      assert.deepEqual(sandbox.evidenceFiles('smoke'), []);
    });
  }

  test('ok true writes the evidence, exit 0', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    assert.equal(sandbox.smokeEvidence(repo).rc, 0);
    assert.equal(sandbox.evidenceFiles('smoke').length, 1);
  });
});

describe('write-smoke reads its log line by line', () => {
  test('a line of only a byte order mark is not skipped, so no evidence is written', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    mkdirSync(join(sandbox.data, 'logs'), { recursive: true });
    const line = '{"run_id":"sm-0001","ok":true,"trees":{"' + repo.key + '":"' + repo.tree() + '"}}';
    writeFileSync(join(sandbox.data, 'logs', 'keel-smoke.jsonl'), String.fromCharCode(0xfeff) + '\n' + line + '\n');
    const run = sandbox.keel(['evidence', 'write-smoke', '--repo', repo.path]);
    assert.equal(run.rc, 70, run.stderr);
    assert.deepEqual(sandbox.evidenceFiles('smoke'), []);
    writeFileSync(join(sandbox.data, 'logs', 'keel-smoke.jsonl'), ' \t\n\n' + line + '\n');
    assert.equal(sandbox.keel(['evidence', 'write-smoke', '--repo', repo.path]).rc, 0);
  });
});

describe('keel test prints the KEEL-TEST line with its five fields in order', () => {
  test('a green run names the run, count, exit and evidence ids, and an empty submodule map', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 3 tests'"], { cwd: repo.path });
    const last = run.stderr.trim().split('\n').at(-1)!;
    assert.match(last, /^KEEL-TEST \{"run_id":"tr-\d{8}T\d{6}Z-[0-9a-f]{6}","count":3,"exit":0,"evidence_id":"tests-\d{8}T\d{6}Z-[0-9a-f]{8}","submodule_evidence":\{\}\}$/);
  });
});

describe('the evidence store writes and lists with code point order', () => {
  function inStore(directory: string, run: () => void): void {
    const saved = process.env['KEEL_DATA_DIR'];
    process.env['KEEL_DATA_DIR'] = directory;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env['KEEL_DATA_DIR'];
      else process.env['KEEL_DATA_DIR'] = saved;
    }
  }

  test('write sorts object keys by code point and keeps an integer beyond 2^53 exact', () => {
    const directory = mkdtempSync(join(scratch, 'write-'));
    inStore(directory, () => {
      const written = store.write('approval', { '\u{10000}': 1, '\uffff': 2, big: parseJsonKeepingIntegers('9007199254740993'), a: [{ y: 1, x: 2 }] });
      const text = readFileSync(join(store.kindDir('approval'), written.evidence_id + '.json'), 'utf8');
      assert.equal(text.endsWith('\n'), true);
      assert.ok(text.includes('"a":[{"x":2,"y":1}],"big":9007199254740993,"created_at":'), text);
      assert.ok(text.indexOf('"\uffff":2') < text.indexOf('"\u{10000}":1'), text);
    });
  });

  test('listFiles and repoKeys order names by code point, not by UTF-16 unit', () => {
    const directory = mkdtempSync(join(scratch, 'list-'));
    inStore(directory, () => {
      const kindDirectory = store.kindDir('approval');
      mkdirSync(kindDirectory, { recursive: true });
      for (const name of ['\u{10000}.json', '\uff5e.json', 'b.json']) writeFileSync(join(kindDirectory, name), '{}');
      assert.deepEqual(store.listFiles('approval').map((path) => path.slice(kindDirectory.length + 1)), ['b.json', '\uff5e.json', '\u{10000}.json']);
      for (const key of ['\u{10000}__x', '\uff5e__x', 'b__x']) mkdirSync(join(store.evidenceRoot(), 'review', key), { recursive: true });
      assert.deepEqual(store.repoKeys('review'), ['b/x', '\uff5e/x', '\u{10000}/x']);
    });
  });

  test('readFile names an unreadable file and the system error code', () => {
    const directory = mkdtempSync(join(scratch, 'read-'));
    mkdirSync(join(directory, 'bad.json'));
    assert.throws(() => store.readFile(join(directory, 'bad.json')), (error: Error) => error instanceof store.EvidenceError
      && error.message.startsWith(`unreadable evidence ${join(directory, 'bad.json')}: EISDIR`));
  });
});

describe('keel evidence show prints what a stored record holds', () => {
  for (const [stored, printed] of [['1.5', '1.5'], ['9007199254740993', '9007199254740993']]) {
    test('a stored verdict of ' + stored + ' is printed as that number, exit 0', (t) => {
      const sandbox = new Sandbox(t);
      const repo = feature(sandbox);
      sandbox.review(repo);
      const path = sandbox.evidenceFiles('review')[0]!;
      writeFileSync(path, readFileSync(path, 'utf8').replace('"verdict":"PASS"', '"verdict":' + stored));
      assert.ok(readFileSync(path, 'utf8').includes('"verdict":' + stored));
      const run = sandbox.keel(['evidence', 'show', '--repo', repo.path]);
      assert.equal(run.rc, 0, run.stderr);
      assert.ok(run.stdout.includes('"verdict":' + printed + '}'), run.stdout);
    });
  }
});

describe('the data directory expands ~ and ~/ only', () => {
  test('~/x follows HOME and ~user/x stays as written', () => {
    const saved = { data: process.env['KEEL_DATA_DIR'], home: process.env['HOME'] };
    process.env['HOME'] = '/home/tester';
    try {
      process.env['KEEL_DATA_DIR'] = '~/keel-data';
      assert.equal(dataDir(), '/home/tester/keel-data');
      process.env['KEEL_DATA_DIR'] = '~root/keel-data';
      assert.equal(dataDir(), '~root/keel-data');
    } finally {
      for (const [name, value] of [['KEEL_DATA_DIR', saved.data], ['HOME', saved.home]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('git diff paths are decoded as UTF-8 or refused, and a tree lookup never returns a lossy name', () => {
  function treeWithRawPath(rawPath: Buffer): [repo: string, emptyTree: string, tree: string] {
    const repo = mkdtempSync(join(scratch, 'git-'));
    const git = (args: string[], input?: Buffer) => {
      const completed = spawnSync('git', ['-C', repo, ...args], { input });
      assert.equal(completed.status, 0, completed.stderr.toString());
      return completed.stdout.toString().trim();
    };
    git(['init', '-q']);
    const blob = git(['hash-object', '-w', '--stdin'], Buffer.from('x\n'));
    const entry = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), rawPath, Buffer.from('\n')]);
    const inner = git(['mktree'], entry);
    return [repo, git(['mktree'], Buffer.alloc(0)), git(['mktree'], Buffer.from(`040000 tree ${inner}\td\n`))];
  }

  test('a valid UTF-8 path is read back as written', () => {
    const [repo, emptyTree, tree] = treeWithRawPath(Buffer.from('é😀.txt'));
    assert.deepEqual(gitcmd.diffEntries(repo, emptyTree, tree).map((entry) => entry.path), ['d/é😀.txt']);
    assert.equal(gitcmd.treeEntry(repo, tree, 'd/é😀.txt')?.[0], '100644');
  });

  test('a path that is not valid UTF-8 is refused instead of being read as a lossy name', () => {
    const [repo, emptyTree, tree] = treeWithRawPath(Buffer.from([0x61, 0xff, 0x2e, 0x74]));
    assert.throws(() => gitcmd.diffEntries(repo, emptyTree, tree), InvalidUtf8Error);
    assert.throws(() => gitcmd.diffStats(repo, emptyTree, tree), InvalidUtf8Error);
    assert.equal(gitcmd.treeEntry(repo, tree, 'd')?.[0], '040000');
    assert.equal(gitcmd.treeEntry(repo, tree, 'd/a�.t'), null);
  });
});

describe('failure classification', () => {
  const systemError = Object.assign(new Error('boom'), { errno: -2, code: 'ENOENT', syscall: 'open' });

  test('isInputFailure accepts parse, type, range, decode and system errors and rejects programming errors', () => {
    const accepted = [new TypeError('x'), new RangeError('x'), new SyntaxError('x'), new InvalidUtf8Error('x'), systemError];
    for (const error of accepted) assert.equal(isInputFailure(error), true, error.constructor.name);
    for (const unexpected of [new Error('x'), new ReferenceError('x'), new Usage('x'), new Refused('x'), 'text', null]) {
      assert.equal(isInputFailure(unexpected), false, String(unexpected));
    }
  });

  test('a command that cannot start throws the system error itself, and a timeout throws TimeoutExpired', () => {
    assert.throws(() => runCaptured(['definitely-not-a-command-xyz']), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' && isInputFailure(error));
    assert.throws(() => runCaptured(['sleep', '5'], { timeoutSeconds: 0.05 }), TimeoutExpired);
  });
});

describe('deliberate differences on odd input in the evidence helpers', () => {
  test('a comment body with U+0085 is not prose, so its deletion no longer keeps review evidence', () => {
    const before = Buffer.from('// plain words\nconst x = 1;\n');
    const odd = Buffer.from('// plain\u0085words\nconst x = 1;\n');
    const after = Buffer.from('const x = 1;\n');
    assert.equal(onlyCommentDeletions('a.ts', before, after), true);
    assert.equal(onlyCommentDeletions('a.ts', odd, after), false);
  });
});

describe('Codex rollouts and runner output at their edges', () => {
  const IDENTITY = '22222222-2222-4222-8222-222222222222';

  function rollout(startedTurn: unknown, completedTurn: unknown): Buffer {
    const records = [
      { type: 'session_meta', payload: { id: IDENTITY } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: startedTurn } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '{"a":1}' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: completedTurn } },
    ];
    return Buffer.from(records.map((record) => JSON.stringify(record) + '\n').join(''));
  }

  test('a turn is complete when it carries the same non-empty string id at start and completion', () => {
    assert.deepEqual(codexReview.completedReport(rollout('turn-1', 'turn-1'), IDENTITY)[1], { a: 1 });
    for (const [started, completed] of [['turn-1', 'turn-2'], ['', ''], [5, 5], [null, null]]) {
      assert.throws(() => codexReview.completedReport(rollout(started, completed), IDENTITY), (error: Error) => error instanceof Refused
        && error.message === 'Codex reviewer has no completed structured final report', JSON.stringify([started, completed]));
    }
  });

  test('a rollout is split into records at \\r\\n, \\r and \\n', () => {
    const lines = rollout('turn-1', 'turn-1').toString().trimEnd().split('\n');
    assert.deepEqual(codexReview.completedReport(Buffer.from(lines.join('\r\n') + '\r\n'), IDENTITY)[1], { a: 1 });
    assert.deepEqual(codexReview.completedReport(Buffer.from(lines.join('\r')), IDENTITY)[1], { a: 1 });
  });

  test('git remote lists one name per line', () => {
    const repo = mkdtempSync(join(scratch, 'urls-'));
    const git = (...args: string[]) => assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0, args.join(' '));
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://example.com/acme/app.git');
    git('remote', 'add', 'upstream', 'https://example.com/acme/other.git');
    assert.deepEqual(gitcmd.remotes(repo), ['origin', 'upstream']);
  });

  test('a runner count beyond 2^53 is the nearest double, and a Test Files line led by U+0085 or U+FEFF is not counted', () => {
    assert.deepEqual(recognize('Ran 12345678901234567890 tests'), [12345678901234567000, 'unittest']);
    assert.deepEqual(recognize('\u0085Test Files  7 passed (7)\n'), [0, null]);
    assert.deepEqual(recognize('\ufeffTest Files  7 passed (7)\n'), [0, null]);
  });
});
