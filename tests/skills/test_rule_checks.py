from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
import unittest

from helpers import KEEL_HOME, RULE_CHECKS, IsolatedTestCase

LIB_DIR = os.path.join(KEEL_HOME, 'lib')

ANY_LINE = 'const v: any = 1\n'
CLEAN_LINE = 'export const v = 1\n'


class RuleChecksCliTest(IsolatedTestCase):

    def base_repo(self, name='repo'):
        """A repo with one commit on `main` and a `base` branch pointing at it."""
        repo = self.new_repo(name)
        self.write(repo, 'README', 'x\n')
        self.commit_all(repo)
        self.git(repo, 'branch', 'base')
        return repo

    def test_selfTest_passes(self):
        completed = subprocess.run([sys.executable, RULE_CHECKS, '--self-test'], capture_output=True, text=True, env=self.env)
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertRegex(completed.stdout, r'self-test: (\d+)/\1 pass')

    def test_ruleChecks_exitsTwo_whenRepoOrBaseMissing(self):
        completed = subprocess.run([sys.executable, RULE_CHECKS, '--base', 'main'], capture_output=True, text=True, env=self.env)
        self.assertEqual(completed.returncode, 2)

    def test_ruleChecks_reportsK5Signals_forWorkingTreeAndUntrackedLines(self):
        # given
        repo = self.base_repo()
        self.write(repo, 'web/a.ts', ANY_LINE)
        self.write(repo, 'core/Service.java', 'class S { void f() { try { run(); } catch (Exception e) {} } }\n'
                                              'Map<String, Object> m = null;\n// TODO clean this\nString data = x;\n')
        self.git(repo, 'add', 'core/Service.java')
        # when
        code, signals, summary, lines = self.run_rule_checks('--repo', repo, '--base', 'base')
        # then
        self.assertEqual(code, 0)
        self.assertEqual(signals, {('K5.11', 'web/a.ts:1'), ('K5.12', 'core/Service.java:1'),
                                   ('K5.11', 'core/Service.java:2'), ('K5.14', 'core/Service.java:3'),
                                   ('K5.5', 'core/Service.java:4')})
        self.assertEqual(summary, 'summary repos=1 scanned_lines=5 signals=5 unscanned=none blocked=none')
        for line in lines[:-1]:
            self.assertRegex(line, r'^signal K5\.(?:[1-9]|1[0-6]) \S+ .{1,160}$')

    def test_ruleChecks_reportsSuppressionSignals_forTsDirectiveAndExhaustiveDepsDisable(self):
        # given
        repo = self.base_repo()
        self.write(repo, 'web/a.ts', '// @ts-ignore\nconst v = f(x)\n')
        self.write(repo, 'web/Panel.jsx', 'useEffect(() => load(id), [])  // eslint-disable-line react-hooks/exhaustive-deps\n')
        # when
        code, signals, summary, lines = self.run_rule_checks('--repo', repo, '--base', 'base')
        # then
        self.assertEqual((code, signals), (0, {('K5.11', 'web/a.ts:1'), ('K5.9', 'web/Panel.jsx:1')}))
        self.assertEqual(summary, 'summary repos=1 scanned_lines=3 signals=2 unscanned=none blocked=none')
        for line in lines[:-1]:
            self.assertRegex(line, r'^signal K5\.(?:[1-9]|1[0-6]) \S+ .{1,160}$')

    def test_ruleChecks_reportsNoSignal_forCleanDiff(self):
        # given
        repo = self.base_repo()
        self.write(repo, 'web/a.ts', CLEAN_LINE)
        # when
        code, signals, summary, _ = self.run_rule_checks('--repo', repo, '--base', 'base')
        # then
        self.assertEqual((code, signals), (0, set()))
        self.assertEqual(summary, 'summary repos=1 scanned_lines=1 signals=0 unscanned=none blocked=none')

    def test_ruleChecks_blocksWithExitTwo_whenBaseUnknown(self):
        # given
        repo = self.base_repo()
        # when
        code, signals, summary, _ = self.run_rule_checks('--repo', repo, '--base', 'no-such-ref')
        # then
        self.assertEqual((code, signals), (2, set()))
        self.assertTrue(summary.endswith('blocked=.'), summary)

    def diverged_repo(self):
        """`base` advanced past the branch point and cleaned z.ts, a flagged line `main` never touched."""
        repo = self.new_repo('diverged')
        self.write(repo, 'z.ts', ANY_LINE)
        self.commit_all(repo)
        self.git(repo, 'branch', 'base')
        self.git(repo, 'checkout', '-q', 'base')
        self.write(repo, 'z.ts', CLEAN_LINE)
        self.commit_all(repo)
        self.git(repo, 'checkout', '-q', 'main')
        self.write(repo, 'a.ts', ANY_LINE)
        self.commit_all(repo)
        return repo

    def test_ruleChecks_scansFromMergeBase_whenHeadIsCommit(self):
        # given
        repo = self.diverged_repo()
        self.write(repo, 'later.ts', ANY_LINE)
        # when
        code, signals, _, _ = self.run_rule_checks('--repo', repo, '--base', 'base', '--head', 'HEAD')
        # then: z.ts comes from the base side, later.ts is not committed
        self.assertEqual((code, signals), (0, {('K5.11', 'a.ts:1')}))

    def test_ruleChecks_scansFromBaseAsGiven_whenHeadIsSnapshotTree(self):
        # given
        repo = self.diverged_repo()
        self.write(repo, 'snap.ts', ANY_LINE)
        tree = self.snapshot_tree(repo)
        self.write(repo, 'after-snapshot.ts', ANY_LINE)
        review_base = self.git(repo, 'rev-parse', 'base')
        # when
        code, signals, _, _ = self.run_rule_checks('--repo', repo, '--base', review_base, '--head', tree)
        # then: no merge-base, so z.ts differs from the base as given; the post-snapshot file is not in the tree
        self.assertEqual((code, signals), (0, {('K5.11', 'a.ts:1'), ('K5.11', 'snap.ts:1'), ('K5.11', 'z.ts:1')}))
        self.assertEqual(self.git(repo, 'status', '--porcelain'), '?? after-snapshot.ts\n?? snap.ts', 'the real index stays untouched')

    def test_ruleChecks_blocksWithExitTwo_whenSnapshotBaseUnknown(self):
        # given
        repo = self.base_repo()
        self.write(repo, 'a.ts', ANY_LINE)
        tree = self.snapshot_tree(repo)
        # when
        code, _, summary, _ = self.run_rule_checks('--repo', repo, '--base', 'no-such-ref', '--head', tree)
        # then
        self.assertEqual(code, 2)
        self.assertTrue(summary.endswith('blocked=.'), summary)

    def test_ruleChecks_ignoresExternalDiffAndTextconv_whenRepoConfiguresThem(self):
        # given
        repo = self.base_repo()
        self.git(repo, 'config', 'diff.external', '/usr/bin/true')
        self.git(repo, 'config', 'diff.strip.textconv', 'sed s/any/ANY/')
        self.write(repo, '.git/info/attributes', '*.ts diff=strip\n')
        self.write(repo, 'a.ts', ANY_LINE)
        self.commit_all(repo)
        # when
        _, signals, _, _ = self.run_rule_checks('--repo', repo, '--base', 'base', '--head', 'HEAD')
        # then
        self.assertEqual(signals, {('K5.11', 'a.ts:1')})

    def test_ruleChecks_signalsDiffSize_whenChangedLinesExceedSignalCountingRemovals(self):
        # given: 200 added + 250 removed lines
        repo = self.new_repo('rewrite')
        self.write(repo, 'notes.md', ''.join(f'old {i}\n' for i in range(300)))
        self.commit_all(repo)
        self.git(repo, 'branch', 'base')
        self.write(repo, 'notes.md', ''.join(f'old {i}\n' for i in range(50)) + ''.join(f'new {i}\n' for i in range(200)))
        self.commit_all(repo)
        # when
        _, signals, _, _ = self.run_rule_checks('--repo', repo, '--base', 'base', '--head', 'HEAD')
        # then
        self.assertEqual(signals, {('K5.7', '(diff)')})

    def test_ruleChecks_skipsDiffSize_forTestAndGeneratedFiles(self):
        # given
        repo = self.base_repo()
        self.write(repo, 'web/big.test.ts', 'x\n' * 450)
        self.write(repo, 'package-lock.json', '{}\n' * 450)
        self.write(repo, 'src/test/AppTest.java', 'x\n' * 450)
        # when
        _, signals, _, _ = self.run_rule_checks('--repo', repo, '--base', 'base')
        # then
        self.assertEqual(signals, set())

    def test_ruleChecks_skipsDiffSizeAndLineSignals_forPythonAndSuffixTestFiles(self):
        # given
        repo = self.base_repo()
        self.write(repo, 'tests/test_feature.py', 'x = 1\n' * 450)
        self.write(repo, 'web/util_test.ts', 'const data = load()\n')
        # when
        code, signals, _, _ = self.run_rule_checks('--repo', repo, '--base', 'base')
        # then
        self.assertEqual((code, signals), (0, set()))

    def test_ruleChecks_scansWithExitZero_whenChangedFileIsNotUtf8(self):
        # given
        repo = self.base_repo()
        with open(os.path.join(repo, 'messages.properties'), 'wb') as f:
            f.write(b'greeting=caf\xe9\n')
        self.commit_all(repo)
        # when
        code, _, summary, _ = self.run_rule_checks('--repo', repo, '--base', 'base', '--head', 'HEAD')
        # then
        self.assertEqual(code, 0)
        self.assertEqual(summary, 'summary repos=1 scanned_lines=1 signals=0 unscanned=none blocked=none')

    def test_ruleChecks_signalsFileSize_onlyWhenDiffCrossesSignal(self):
        # given
        repo = self.new_repo('sizes')
        self.write(repo, 'web/Big.tsx', 'x\n' * 290)
        self.write(repo, 'web/Legacy.tsx', 'x\n' * 310)
        self.write(repo, 'web/State.tsx', 'useState(0)\n' * 10)
        self.write(repo, 'core/Big.java', 'x\n' * 495)
        self.write(repo, 'web/Panel.test.tsx', 'x\n' * 290)
        self.commit_all(repo)
        self.git(repo, 'branch', 'base')
        self.write(repo, 'web/Big.tsx', 'x\n' * 305)
        self.write(repo, 'web/Legacy.tsx', 'x\n' * 320)
        self.write(repo, 'web/State.tsx', 'useState(0)\n' * 11)
        self.write(repo, 'core/Big.java', 'x\n' * 505)
        self.write(repo, 'web/Panel.test.tsx', 'x\n' * 305)
        # when
        _, signals, _, _ = self.run_rule_checks('--repo', repo, '--base', 'base')
        # then
        self.assertEqual(signals, {('K5.7', 'web/Big.tsx'), ('K5.7', 'web/State.tsx'), ('K5.7', 'core/Big.java')})

    def test_ruleChecks_skipsBinaryAndSymlinks_whenUntracked(self):
        # given
        repo = self.base_repo()
        with open(os.path.join(repo, 'logo.png'), 'wb') as f:
            f.write(b'\x89PNG\0' + b'const v: any = 1\n' * 3)
        os.symlink(os.path.join(repo, 'README'), os.path.join(repo, 'file-link.ts'))
        os.symlink(os.path.join(self.tmp, 'no-such-file'), os.path.join(repo, 'dangling.ts'))
        # when
        code, signals, summary, _ = self.run_rule_checks('--repo', repo, '--base', 'base')
        # then
        self.assertEqual((code, signals), (0, set()))
        self.assertIn('scanned_lines=0', summary)

    def test_ruleChecks_listsUntrackedNestedRepo_asUnscanned(self):
        # given
        repo = self.base_repo()
        nested = os.path.join(repo, 'nested')
        os.makedirs(nested)
        self.git(nested, 'init', '-q')
        self.write(nested, 'n.ts', ANY_LINE)
        # when
        code, signals, summary, _ = self.run_rule_checks('--repo', repo, '--base', 'base')
        # then
        self.assertEqual((code, signals), (0, set()))
        self.assertIn('unscanned=nested(untracked repo)', summary)


class TestPathEquivalenceTest(unittest.TestCase):
    """rule-checks.py runs from the data-dir copy without lib/, so it carries its own copy of risk.is_test_path."""

    PATHS = ['tests/test_x.py', 'src/test/A.java', 'web/a.test.ts', 'pkg/a_test.go', '__tests__/a.js', 'test_x.py',
             'web/b.spec.tsx', 'src/app.py', 'web/Screen.tsx', 'lib/contest/a.py', 'docs/testing.md', 'latest.py']

    def test_testPathConstants_equalTheRiskClassifiers(self):
        # given
        rule_checks = load_rule_checks()
        sys.path.insert(0, LIB_DIR)
        self.addCleanup(sys.path.remove, LIB_DIR)
        from evidence import risk
        # then
        self.assertEqual((rule_checks.TEST_SEGMENTS, rule_checks.TEST_BASENAME_GLOBS), (risk.TEST_SEGMENTS, risk.TEST_BASENAME_GLOBS))

    def test_isTestPath_agreesWithRiskClassifier_forSharedPathTable(self):
        # given
        rule_checks = load_rule_checks()
        sys.path.insert(0, LIB_DIR)
        self.addCleanup(sys.path.remove, LIB_DIR)
        from evidence.risk import is_test_path
        # when
        disagreements = [p for p in self.PATHS if rule_checks.is_test_path(p) != is_test_path(p)]
        # then
        self.assertEqual(disagreements, [])
        self.assertEqual({is_test_path(p) for p in self.PATHS}, {True, False})


def load_rule_checks():
    spec = importlib.util.spec_from_file_location('rule_checks', RULE_CHECKS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RuleChecksSubmoduleTest(IsolatedTestCase):

    def parent_with_submodule(self):
        """parent pins `mod`; `base` branches in both; then `mod` gets a flagged commit and the parent pins it."""
        source = self.new_repo('mod-src')
        self.write(source, 'f.ts', CLEAN_LINE)
        self.commit_all(source)
        parent = self.new_repo('parent')
        self.add_submodule(parent, source, 'mod')
        self.commit_all(parent)
        self.git(parent, 'branch', 'base')
        mod = os.path.join(parent, 'mod')
        self.git(mod, 'branch', 'base')
        self.write(mod, 'f.ts', ANY_LINE)
        self.commit_all(mod)
        self.commit_all(parent)
        return parent, source

    def test_ruleChecks_scansMovedSubmodule_withPathPrefix(self):
        # given
        parent, _ = self.parent_with_submodule()
        for head in (('--head', 'HEAD'), ()):
            with self.subTest(head=head):
                # when
                code, signals, summary, _ = self.run_rule_checks('--repo', parent, '--base', 'base', *head)
                # then
                self.assertEqual((code, signals), (0, {('K5.11', 'mod/f.ts:1')}))
                self.assertIn('repos=2', summary)

    def test_ruleChecks_scansSubmodule_inSnapshotTree(self):
        # given
        parent, _ = self.parent_with_submodule()
        tree = self.snapshot_tree(parent)
        review_base = self.git(parent, 'rev-parse', 'base')
        # when
        code, signals, _, _ = self.run_rule_checks('--repo', parent, '--base', review_base, '--head', tree)
        # then
        self.assertEqual((code, signals), (0, {('K5.11', 'mod/f.ts:1')}))

    def test_ruleChecks_scansFromParentPin_whenBaseIsHeadRelative(self):
        # given: a second flagged commit in `mod` the parent does not pin, so mod's own HEAD~1 is not the parent's HEAD~1 pin
        parent, _ = self.parent_with_submodule()
        mod = os.path.join(parent, 'mod')
        self.write(mod, 'g.ts', ANY_LINE)
        self.commit_all(mod)
        # when
        code, signals, _, _ = self.run_rule_checks('--repo', parent, '--base', 'HEAD~1')
        # then: f.ts comes only from starting at the parent's pin
        self.assertEqual((code, signals), (0, {('K5.11', 'mod/f.ts:1'), ('K5.11', 'mod/g.ts:1')}))

    def test_ruleChecks_listsAddedSubmodule_asUnscanned(self):
        # given
        parent, source = self.parent_with_submodule()
        self.add_submodule(parent, source, 'extra')
        self.commit_all(parent)
        # when
        code, _, summary, _ = self.run_rule_checks('--repo', parent, '--base', 'base', '--head', 'HEAD')
        # then
        self.assertEqual(code, 0)
        self.assertIn('unscanned=extra(added)', summary)

    def test_ruleChecks_blocksWithExitTwo_whenSubmoduleNotInitialized(self):
        # given
        parent, _ = self.parent_with_submodule()
        self.git(parent, 'submodule', 'deinit', '-q', '-f', 'mod')
        # when
        code, signals, summary, _ = self.run_rule_checks('--repo', parent, '--base', 'base', '--head', 'HEAD')
        # then
        self.assertEqual((code, signals), (2, set()))
        self.assertTrue(summary.endswith('blocked=mod'), summary)

    def test_ruleChecks_blocksWithExitTwo_whenGitlinkReplacedBySymlink(self):
        # given
        parent, _ = self.parent_with_submodule()
        self.git(parent, 'rm', '-q', '--cached', 'mod')
        os.rename(os.path.join(parent, 'mod'), os.path.join(self.tmp, 'mod-moved'))
        os.symlink('README', os.path.join(parent, 'mod'))
        self.commit_all(parent)
        # when
        code, _, summary, _ = self.run_rule_checks('--repo', parent, '--base', 'base', '--head', 'HEAD')
        # then
        self.assertEqual(code, 2)
        self.assertTrue(re.search(r'blocked=mod$', summary), summary)
