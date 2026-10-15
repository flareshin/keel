#!/usr/bin/env python3
"""Signal-only regex checks for /readable-code rules over a diff's added lines.

A signal is a candidate, never a verdict: a rule may be broken with its reason in the reading
guide's `Decisions`, so the review's rule-checks lens judges each signal. Exit 0 = scanned
(signals or not); 2 = usage error, a crash, or a repo the diff changed could not be scanned
(`blocked=`: unknown base, a submodule not initialized, a gitlink commit missing locally).

Range:
- no --head: merge-base(BASE, HEAD) to the working tree plus untracked files; a submodule from its
  own merge-base(BASE, HEAD), because its pinned commit may be stale, except when BASE names a parent
  commit (HEAD-relative, or a SHA the submodule lacks): then from the gitlink pinned there.
- --head <commit>: merge-base(BASE, head) to head; a submodule between its gitlinks at those commits.
- --head <tree> (a `keel snapshot` tree id): BASE as given to that tree, so a snapshot review scans
  exactly the reviewed content; a submodule between its gitlinks at BASE and in the tree.
A submodule the diff adds or removes, and an untracked nested repo, are listed as `unscanned=`;
a gitlink replaced by a file or symlink blocks.

Usage:
  rule-checks.py --repo <abs path> --base <commit> [--head <commit|tree>]
  rule-checks.py --self-test
"""
from __future__ import annotations

import argparse
import codecs
import contextlib
import fnmatch
import io
import os
import re
import subprocess
import sys
import traceback

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
# A copy of lib/evidence/risk.py's test-path rule (pinned by tests/skills/test_rule_checks.py): the skill also runs standalone, without keel's lib/.
TEST_SEGMENTS = {'test', 'tests', '__tests__'}
TEST_BASENAME_GLOBS = ('test_*.py', '*_test.*', '*.test.*', '*.spec.*')
GENERATED_PATH = re.compile(r'(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.js$|(^|/)generated/')
API_LAYER_PATH = re.compile(r'(^|/)api[^/]*/', re.I)
CODE_EXT = ('.java', '.ts', '.tsx')
TS_EXT = ('.ts', '.tsx')
REACT_EXT = ('.ts', '.tsx', '.js', '.jsx')

COMMENT_LINE = re.compile(r'^\s*\*|//|/\*')
# Only a directive that opens its comment counts: TypeScript ignores `@ts-ignore` later in prose.
TS_SUPPRESSION = re.compile(r'(?://+|/\*+)\s*@ts-(?:ignore|expect-error)\b')
EXHAUSTIVE_DEPS_DISABLE = re.compile(r'(?://|/\*)\s*eslint-disable(?:-next-line|-line)?\s.*\breact-hooks/exhaustive-deps\b')
HISTORY_COMMENT = re.compile(r'20[0-9]{2}-[0-9]{2}-[0-9]{2}|(^|[^a-z])(it|this|that|which|we) used to|used to be|no longer|corrected|previously|design §|STAGE [0-9]', re.I)
TODO = re.compile(r'\bTODO\b')
TICKET = re.compile(r'\b[A-Z][A-Z0-9]+-\d+\b')
BANNER = re.compile(r'(-{4,}|={4,}|\*{6,}|#{4,})')
BANNED_NAMES = 'process|handle|do|execute|data|info|result|temp|list|obj|flag|util|manager|helper'
TS_DECL = re.compile(r'\b(?:const|let|var|function)\s+(' + BANNED_NAMES + r')\b')
JAVA_DECL = re.compile(r'\b[A-Z]\w*(?:<[^>]*>)?(?:\[\])?\s+(' + BANNED_NAMES + r')\s*[=;,)(]')

NAMES = 'K5.5'
SIZE = 'K5.7'
HIDDEN_BEHAVIOR = 'K5.9'
TYPES = 'K5.11'
ERRORS = 'K5.12'
COMMENTS = 'K5.14'

DIFF_LINE_SIGNAL = 400
COMPONENT_LINE_SIGNAL = 300
USE_STATE_SIGNAL = 10
CLASS_LINE_SIGNAL = 500

GITLINK_MODE = '160000'
NO_ENTRY_MODE = '000000'
BLOCKED = 'blocked'


def main():
    sys.exit(run_cli(sys.argv[1:]))


def run_cli(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo')
    parser.add_argument('--base')
    parser.add_argument('--head')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args(argv)
    if args.self_test:
        return run_self_test()
    if not args.repo or not args.base:
        parser.error('--repo and --base are required')
    try:
        signals, summary = scan_tree(args.repo, args.base, args.head)
    except Exception as error:
        traceback.print_exc()
        print(f'summary repos=0 scanned_lines=0 signals=0 unscanned=none blocked=.(crashed: {type(error).__name__})')
        return 2
    for s in signals:
        print(f"signal {s['id']} {s['where']} {s['text']}")
    print(format_summary(summary, len(signals)))
    return 2 if summary['blocked'] else 0


def scan_tree(root, base, head):
    summary = {'repos': 0, 'scanned': 0, 'changed': 0, 'unscanned': [], 'blocked': []}
    start = resolve_start(root, base, head)
    if start is None:
        summary['blocked'].append('.')
        return [], summary
    signals = scan_repo(root, '.', (start, head), base, summary)
    if summary['changed'] > DIFF_LINE_SIGNAL:
        signals.append(signal(SIZE, '(diff)', f"{summary['changed']} changed lines excluding tests and generated files > {DIFF_LINE_SIGNAL}"))
    return signals, summary


def resolve_start(root, base, head):
    """A snapshot tree is diffed from BASE itself (the review's base); a commit or the working tree from the merge-base."""
    if head and git(root, 'cat-file', '-t', head) == 'tree':
        return git(root, 'rev-parse', '--verify', '--quiet', f'{base}^{{commit}}')
    return git(root, 'merge-base', base, head or 'HEAD')


def scan_repo(repo, rel, span, base, summary):
    start, end = span
    changes = read_changes(repo, start, end)
    if changes is None:
        summary['blocked'].append(rel)
        return []
    summary['repos'] += 1
    found = []
    if end is None:
        files, nested_repos = read_untracked(repo)
        changes += files
        summary['unscanned'] += [f"{join_rel(rel, path)}(untracked repo)" for path in nested_repos]
    for path, before_path, added, removed in changes:
        label = join_rel(rel, path)
        summary['scanned'] += len(added)
        summary['changed'] += count_reviewable_changes(path, added, removed)
        found += check_lines(label, path, added)
        found += check_file_size(repo, span, label, path, before_path)
    for path, status in changed_gitlinks(repo, start, end):
        found += scan_submodule(repo, join_rel(rel, path), path, status, span, base, summary)
    return found


def join_rel(rel, path):
    return path if rel == '.' else f'{rel}/{path}'


def scan_submodule(parent, rel, path, status, parent_span, base, summary):
    if status in ('A', 'D'):
        summary['unscanned'].append(f"{rel}({'added' if status == 'A' else 'removed'})")
        return []
    span = resolve_submodule_span(parent, path, parent_span, base) if status == 'M' else BLOCKED
    if span == BLOCKED:
        summary['blocked'].append(rel)
        return []
    return scan_repo(os.path.join(parent, path), rel, span, base, summary)


def resolve_submodule_span(parent, path, parent_span, base):
    sub = os.path.join(parent, path)
    if not is_initialized(sub):
        return BLOCKED
    parent_start, parent_end = parent_span
    if parent_end:
        start, end = read_gitlink(parent, parent_start, path), read_gitlink(parent, parent_end, path)
        return (start, end) if has_commit(sub, start) and has_commit(sub, end) else BLOCKED
    if names_parent_commit(base, sub):
        start = read_gitlink(parent, parent_start, path)
        return (start, None) if has_commit(sub, start) else BLOCKED
    start = git(sub, 'merge-base', base, 'HEAD')
    return (start, None) if start else BLOCKED


def names_parent_commit(base, sub):
    """HEAD-relative, or a commit SHA the submodule does not have: either way BASE names a parent commit."""
    is_head_relative = re.match(r'(HEAD|@)([~^]|$)', base) is not None
    is_foreign_sha = re.fullmatch(r'[0-9a-fA-F]{7,40}', base) is not None and not has_commit(sub, base)
    return is_head_relative or is_foreign_sha


def changed_gitlinks(repo, start, end):
    """[(path, gitlink_status)] for submodule entries the diff touches; a dirty submodule counts, whatever `.gitmodules` `ignore=` says."""
    found = []
    raw = git(repo, 'diff', '--raw', '--no-renames', '--ignore-submodules=none', start, *([end] if end else []))
    for line in (raw or '').splitlines():
        meta, _, path = line.partition('\t')
        old_mode, new_mode = meta[1:].split(' ')[:2]
        if GITLINK_MODE in (old_mode, new_mode):
            found.append((path, gitlink_status(old_mode, new_mode)))
    return found


def gitlink_status(old_mode, new_mode):
    """'A' added (or replacing a file), 'D' removed, 'M' moved or dirty, 'T' replaced by a file or symlink."""
    if old_mode == new_mode:
        return 'M'
    if old_mode != GITLINK_MODE:
        return 'A'
    return 'D' if new_mode == NO_ENTRY_MODE else 'T'


def is_initialized(sub):
    top = git(sub, 'rev-parse', '--show-toplevel')
    return top is not None and os.path.realpath(top) == os.path.realpath(sub)


def read_gitlink(parent, rev, path):
    entry = git(parent, 'ls-tree', rev, '--', path) or ''
    match = re.match(GITLINK_MODE + r' commit ([0-9a-f]+)\t', entry)
    return match.group(1) if match else None


def has_commit(repo, sha):
    return bool(sha) and git(repo, 'cat-file', '-e', f'{sha}^{{commit}}') is not None


def read_changes(repo, start, end):
    """[(path, before_path, [(line_no, text)] added, removed_count)] for tracked changes; None when git diff fails."""
    diff = git(repo, 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--ignore-submodules=all',
               '--src-prefix=a/', '--dst-prefix=b/', start, *([end] if end else []))
    return None if diff is None else list(parse_unified_diff(diff))


def read_untracked(repo):
    """Untracked regular text files as changes, plus untracked nested repos (git lists them as `dir/`); binaries and symlinks are skipped."""
    files, nested_repos = [], []
    for path in filter(None, (git(repo, 'ls-files', '-z', '--others', '--exclude-standard') or '').split('\0')):
        full = os.path.join(repo, path)
        if path.endswith('/'):
            nested_repos.append(path.rstrip('/'))
        elif is_regular_file(full) and not is_binary(full):
            files.append((path, path, list(enumerate(read_text(full).splitlines(), 1)), 0))
    return files, nested_repos


def is_regular_file(path):
    """Not a symlink (a `node_modules` link, a dangling one) or a special file."""
    return os.path.isfile(path) and not os.path.islink(path)


def is_binary(path):
    with open(path, 'rb') as f:
        return b'\0' in f.read(8000)


def parse_unified_diff(diff):
    """A pure rename has no ---/+++ headers and yields nothing; a deleted file yields its old path."""
    entry, line_no, in_hunk = None, 0, False
    for line in diff.splitlines():
        if line.startswith('diff --git '):
            yield from finished(entry)
            entry, in_hunk = {'path': None, 'before': None, 'added': [], 'removed': 0}, False
        elif entry is None:
            continue
        elif not in_hunk and line.startswith('--- '):
            entry['before'] = header_path(line)
        elif not in_hunk and line.startswith('+++ '):
            entry['path'] = header_path(line) or entry['before']
        elif line.startswith('@@'):
            in_hunk, line_no = True, int(re.match(r'@@ -\S+ \+(\d+)', line).group(1))
        elif in_hunk and line.startswith('+'):
            entry['added'].append((line_no, line[1:]))
            line_no += 1
        elif in_hunk and line.startswith('-'):
            entry['removed'] += 1
    yield from finished(entry)


def finished(entry):
    if entry and entry['path']:
        yield entry['path'], entry['before'] or entry['path'], entry['added'], entry['removed']


def header_path(line):
    """`+++ b/x` → x; `/dev/null` → None. Git appends a tab after a path with a space and C-quotes one with `"` or `\\`."""
    raw = line[4:].rstrip('\t')
    if raw == '/dev/null':
        return None
    if raw.startswith('"'):
        raw = codecs.escape_decode(raw[1:-1].encode('utf-8'))[0].decode('utf-8')
    return raw[2:]


def count_reviewable_changes(path, added, removed):
    if is_test_path(path) or GENERATED_PATH.search(path):
        return 0
    return len(added) + removed


def check_lines(label, path, added):
    if is_test_path(path):
        return []
    return [signal(check_id, f'{label}:{line_no}', text.strip())
            for line_no, text in added for check_id in matching_checks(path, text)]


def matching_checks(path, text):
    ids = []
    is_ts, is_java = path.endswith(TS_EXT), path.endswith('.java')
    if is_ts and re.search(r':\s*any\b|\bas any\b|<any>', text):
        ids.append(TYPES)
    if is_ts and 'JSON.parse(' in text and not API_LAYER_PATH.search(path):
        ids.append(TYPES)
    if is_java and re.search(r'Map<String,\s*Object>', text):
        ids.append(TYPES)
    if is_ts and TS_SUPPRESSION.search(text):
        ids.append(TYPES)
    if is_java and re.search(r'@SuppressWarnings\(.*"unchecked"', text):
        ids.append(TYPES)
    if path.endswith(REACT_EXT) and EXHAUSTIVE_DEPS_DISABLE.search(text):
        ids.append(HIDDEN_BEHAVIOR)
    if (is_ts or is_java) and is_swallowed_error(text):
        ids.append(ERRORS)
    if path.endswith(CODE_EXT) and COMMENT_LINE.search(text) and is_comment_violation(text):
        ids.append(COMMENTS)
    if (is_ts and TS_DECL.search(text)) or (is_java and JAVA_DECL.search(text)):
        ids.append(NAMES)
    return ids


def is_swallowed_error(text):
    empty_catch = re.search(r'catch\s*(\([^)]*\))?\s*\{\s*\}', text)
    # Not `log.warn("…", e.getMessage(), e)`: only a call whose last argument is the message.
    message_only_log = re.search(r'\blog\w*\.\w+\(.*\.getMessage\(\)\s*\)', text)
    return bool(empty_catch or message_only_log)


def is_comment_violation(text):
    ticketless_todo = TODO.search(text) and not TICKET.search(text)
    return bool(HISTORY_COMMENT.search(text) or ticketless_todo or BANNER.search(text))


def check_file_size(repo, span, label, path, before_path):
    """Size signals fire only when this diff carried the file past the signal, never on legacy size alone."""
    if is_test_path(path):
        return []
    if path.endswith('.tsx'):
        limits = [('lines', COMPONENT_LINE_SIGNAL), ('useState', USE_STATE_SIGNAL)]
    elif path.endswith('.java'):
        limits = [('lines', CLASS_LINE_SIGNAL)]
    else:
        return []
    start, end = span
    before = git(repo, 'show', f'{start}:{before_path}') or ''
    after = (git(repo, 'show', f'{end}:{path}') if end else read_text(os.path.join(repo, path))) or ''
    found = []
    for measure, limit in limits:
        old, new = measure_file(before, measure), measure_file(after, measure)
        if new > limit >= old:
            found.append(signal(SIZE, label, f'{measure} {old} → {new} > {limit}'))
    return found


def is_test_path(path):
    segments = path.split('/')
    if any(segment in TEST_SEGMENTS for segment in segments[:-1]):
        return True
    return any(fnmatch.fnmatchcase(segments[-1], glob) for glob in TEST_BASENAME_GLOBS)


def measure_file(text, measure):
    return len(text.splitlines()) if measure == 'lines' else len(re.findall(r'\buseState\b', text))


def signal(check_id, where, text):
    return {'id': check_id, 'where': where, 'text': text[:160]}


def format_summary(summary, signal_count):
    unscanned = ','.join(summary['unscanned']) or 'none'
    blocked = ','.join(summary['blocked']) or 'none'
    return f"summary repos={summary['repos']} scanned_lines={summary['scanned']} signals={signal_count} unscanned={unscanned} blocked={blocked}"


def git(repo, *args):
    completed = subprocess.run(['git', '-C', repo, '-c', 'core.quotePath=false', *args], capture_output=True, encoding='utf-8', errors='replace')
    return completed.stdout.strip('\n') if completed.returncode == 0 else None


def read_text(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            return f.read()
    except FileNotFoundError:
        return ''


# Each fixture line carries the check ids it must raise; an empty list means it must raise none.
LINE_FIXTURES = {
    'web/Screen.tsx': [
        ('const a: any = 1', [TYPES]), ('const c = x as any', [TYPES]), ('const d = <any>y', [TYPES]),
        ('const b = JSON.parse(s)', [TYPES]), ('const data = load()', [NAMES]),
        ('const rows: Row[] = []', []), ('{count > 0 && <Badge />}', []),
        ('// @ts-ignore', [TYPES]), ('/// @ts-ignore', [TYPES]), ('// @ts-expect-error: legacy prop', [TYPES]),
        ('{/* @ts-ignore */}', [TYPES]), ('// never add @ts-ignore here', []), ("const tag = '@ts-ignore'", []),
        ('// eslint-disable-next-line react-hooks/exhaustive-deps', [HIDDEN_BEHAVIOR]),
        ('}, []) // eslint-disable-line react-hooks/exhaustive-deps', [HIDDEN_BEHAVIOR]),
        ('/* eslint-disable react-hooks/rules-of-hooks, react-hooks/exhaustive-deps */', [HIDDEN_BEHAVIOR]),
        ('// eslint-disable-next-line no-console', []), ('/* eslint-enable react-hooks/exhaustive-deps */', []),
        ('// the exhaustive-deps rule caught a stale closure', []),
    ],
    'web/Panel.jsx': [
        ('{/* eslint-disable-next-line react-hooks/exhaustive-deps */}', [HIDDEN_BEHAVIOR]),
        ('const a = load() // @ts-ignore', []), ('const a: any = 1', []),
    ],
    'web/api/items.ts': [('export const parse = (s: string) => JSON.parse(s) as Item', [])],
    'web/Screen.test.tsx': [('const x: any = 1', []), ('// @ts-ignore', [])],
    'web/log.ts': [('log.error("x {}", e.getMessage())', [ERRORS]), ('log.warn("skip {}", e.getMessage(), e)', [])],
    'core/Service.java': [
        ('Map<String, Object> m = new HashMap<>();', [TYPES]), ('try { run(); } catch (Exception e) {}', [ERRORS]),
        ('log.error("failed {}", e.getMessage());', [ERRORS]), ('log.error("failed order={}", orderId, e);', []),
        ('// this used to call the old API', [COMMENTS]), ('/* no longer used by the batch */', [COMMENTS]),
        (' * corrected after the outage', [COMMENTS]), ('// TODO clean this', [COMMENTS]), ('// ------', [COMMENTS]),
        ('// TODO ABC-123 drop after migration', []), ('String day = "2026-10-07";', []), ('String data = x;', [NAMES]),
        ('@SuppressWarnings("unchecked")', [TYPES]), ('@SuppressWarnings({"unchecked", "rawtypes"})', [TYPES]),
        ('@SuppressWarnings("deprecation")', []),
    ],
    'core/pom.xml': [('<version>${project.version}</version>', [])],
}


def run_self_test():
    """Pure checks only (no git): the line regexes, the diff parser, the rule pins and the crash contract."""
    results = check_line_fixtures() + check_diff_parser() + check_rule_sources() + check_crash_contract()
    failures = [r for r in results if r]
    for f in failures:
        print(f'FAIL {f}')
    print(f'self-test: {len(results) - len(failures)}/{len(results)} pass')
    return 1 if failures else 0


def check_line_fixtures():
    results = []
    for path, lines in LINE_FIXTURES.items():
        for line_no, (text, expected) in enumerate(lines, 1):
            got = [s['id'] for s in check_lines(path, path, [(line_no, text)])]
            results.append(expect(got == expected, f'{path}: {text!r} expected {expected}, got {got}'))
    return results


def check_diff_parser():
    diff = ('diff --git a/web/Gone.ts b/web/Gone.ts\ndeleted file mode 100644\n--- a/web/Gone.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n'
            'diff --git a/my file.ts b/my file.ts\n--- a/my file.ts\t\n+++ b/my file.ts\t\n@@ -1 +1 @@\n--- a/not a header\n+--- not a header\n'
            'diff --git a/old/X.java b/new/X.java\nsimilarity index 90%\nrename from old/X.java\nrename to new/X.java\n--- a/old/X.java\n+++ b/new/X.java\n@@ -1,0 +2 @@\n+y\n'
            'diff --git a/old/Y.java b/new/Y.java\nsimilarity index 100%\nrename from old/Y.java\nrename to new/Y.java\n'
            'diff --git "a/q\\"x.ts" "b/q\\"x.ts"\n--- "a/q\\"x.ts"\n+++ "b/q\\"x.ts"\n@@ -0,0 +1 @@\n+z\n')
    got = list(parse_unified_diff(diff))
    expected = [('web/Gone.ts', 'web/Gone.ts', [], 3), ('my file.ts', 'my file.ts', [(1, '--- not a header')], 1),
                ('new/X.java', 'old/X.java', [(2, 'y')], 0), ('q"x.ts', 'q"x.ts', [(1, 'z')], 0)]
    return [expect(got == expected, f'diff parser (deleted, spaced path, "---" content, edited and pure rename, C-quoted name): got {got}')]


def check_rule_sources():
    """The thresholds and banned names are copies of SKILL.md; fail when the skill changes them."""
    skill = read_text(os.path.join(SKILL_DIR, 'SKILL.md'))
    pinned = ['`' + BANNED_NAMES.replace('|', ', ') + '`', f'class {CLASS_LINE_SIGNAL}', f'FE component {COMPONENT_LINE_SIGNAL}',
              f'`useState` per component {USE_STATE_SIGNAL}', f'**{DIFF_LINE_SIGNAL} changed lines**',
              '`@ts-ignore`', '`@ts-expect-error`', '`@SuppressWarnings("unchecked")`', 'a disabled `react-hooks/exhaustive-deps`']
    missing = [p for p in pinned if p not in skill]
    return [expect(not missing, f'readable-code SKILL.md no longer states {missing}: update the constants')]


def check_crash_contract():
    """An unexpected error still ends in a summary line and exit 2, never a bare traceback."""
    global scan_tree
    real_scan_tree, out, err = scan_tree, io.StringIO(), io.StringIO()

    def crash(*_):
        raise RuntimeError('boom')

    scan_tree = crash
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run_cli(['--repo', '/x', '--base', 'b'])
    finally:
        scan_tree = real_scan_tree
    last = out.getvalue().strip().splitlines()[-1]
    return [expect(code == 2 and last.endswith('blocked=.(crashed: RuntimeError)'), f'crash contract: got exit {code}, {last!r}')]


def expect(ok, message):
    return None if ok else message


if __name__ == '__main__':
    main()
