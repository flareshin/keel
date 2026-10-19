import os
import sys
import time
import unittest

from helpers import KEEL_HOME, LOGIC_WITH_TEST, Sandbox, ship_gate_timeout

sys.path.insert(0, os.path.join(KEEL_HOME, "lib"))
from evidence import gitcmd  # noqa: E402

SEED = {'README.md': 'top\n\n\n\n\nbottom\n'}
SECOND = [{'src/second.py': 'second = 2\n'}]
OVERLAP_FIRST = {'README.md': 'top changed\n\n\n\n\nbottom\n'}
OVERLAP_SECOND = [{'README.md': 'top\n\n\n\n\nbottom changed\n'}]


class StackedChainsTest(unittest.TestCase):

    def stack(self, approve_second=True, first_files=None, second_commits=SECOND):
        sandbox = Sandbox(self)
        repo = sandbox.clone('acme', 'app', seed=SEED)
        base = repo.head()
        repo.branch('first')
        repo.commit(dict(LOGIC_WITH_TEST, **(first_files or {'src/first.py': 'first = 1\n'})))
        sandbox.review(repo, run_id='rv-stack-0001', review_base=base)
        sandbox.approve('rv-stack-0001')
        second = self.reviewed_branch(sandbox, repo, 'second', base, second_commits, 'rv-stack-0002', approve_second)
        repo.git('checkout', '-b', 'feature', 'first')
        repo.git('cherry-pick', '%s..%s' % (base, second))
        sandbox.tests_evidence(repo)
        return sandbox, repo

    def reviewed_branch(self, sandbox, repo, name, start, commits, run_id, approve=True):
        repo.git('checkout', '-b', name, start)
        for files in commits:
            repo.commit(files)
        sandbox.review(repo, run_id=run_id, review_base=start)
        if approve:
            sandbox.approve(run_id)
        return repo.head()

    def test_parallel_approved_chains_stacked_by_rebase_pass(self):
        sandbox, repo = self.stack()

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_stacked_chain_of_several_commits_on_one_path_passes(self):
        sandbox, repo = self.stack(second_commits=[{'src/second.py': 'second = 2\n'},
                                                   {'src/second.py': 'second = 3\n'}])

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_stacked_chain_that_edits_and_restores_a_path_passes(self):
        sandbox, repo = self.stack(second_commits=[{'src/second.py': 'second = 2\n'},
                                                   {'README.md': 'top edited\n\n\n\n\nbottom\n'},
                                                   {'README.md': SEED['README.md']}])

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_stacked_chain_that_adds_and_deletes_a_path_passes(self):
        sandbox, repo = self.stack(second_commits=[{'src/second.py': 'second = 2\n'},
                                                   {'src/scratch.py': 'scratch = 1\n'},
                                                   {'src/scratch.py': None}])

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_stacked_series_reached_through_a_second_parent_passes(self):
        sandbox, repo = self.stack()
        stacked = repo.head()
        base = repo.git('rev-parse', 'origin/main')
        repo.git('checkout', '-b', 'merged', base)
        repo.commit({'src/merged.py': 'merged = 1\n'})
        repo.git('merge', '--no-ff', '-q', '-m', 'merge stacked', 'feature')
        sandbox.review(repo, run_id='rv-stack-0004', review_base=stacked)
        sandbox.approve('rv-stack-0004')
        sandbox.tests_evidence(repo)

        result = sandbox.push(repo, 'git push origin merged')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_unapproved_stacked_chain_denies(self):
        sandbox, repo = self.stack(approve_second=False)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)

    def test_stacked_chains_editing_one_file_deny(self):
        sandbox, repo = self.stack(first_files=OVERLAP_FIRST, second_commits=OVERLAP_SECOND)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('README.md (content or mode changed after review)', result.stderr)

    def test_stacked_overlap_deny_names_the_commit_to_review_again(self):
        sandbox, repo = self.stack(first_files=OVERLAP_FIRST, second_commits=OVERLAP_SECOND)
        overlapping = repo.head()

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('README.md: chains rv-stack-0001, rv-stack-0002 each reviewed it, but no review saw the stacked '
                      'content; review commit %s from its parent %s, then approve that review'
                      % (overlapping[:10], repo.git('rev-parse', 'HEAD^')[:10]), result.stderr)

    def test_stacked_overlap_with_a_review_of_the_stacked_content_gives_no_hint(self):
        sandbox, repo = self.stack(first_files=OVERLAP_FIRST, second_commits=OVERLAP_SECOND)
        self.reviewed_branch(sandbox, repo, 'combined', repo.git('rev-parse', 'origin/main'),
                             [{'README.md': 'top changed\n\n\n\n\nbottom changed\n'}], 'rv-stack-0006')
        repo.git('checkout', 'feature')
        repo.commit({'src/gap.py': 'unreviewed = True\n'})
        sandbox.tests_evidence(repo)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertNotIn('no review saw the stacked content', result.stderr)

    def test_reviewed_overlap_gives_no_hint_when_an_unrelated_commit_is_unreviewed(self):
        sandbox, repo = self.stack(first_files=OVERLAP_FIRST, second_commits=OVERLAP_SECOND)
        sandbox.review(repo, run_id='rv-stack-0005', review_base=repo.git('rev-parse', 'HEAD^'), head=repo.head())
        sandbox.approve('rv-stack-0005')
        repo.commit({'src/gap.py': 'unreviewed = True\n'})
        sandbox.tests_evidence(repo)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('src/gap.py', result.stderr)
        self.assertNotIn('no review saw the stacked content', result.stderr)

    def test_unapproved_review_of_stacked_content_does_not_suppress_the_hint(self):
        sandbox, repo = self.stack(first_files=OVERLAP_FIRST, second_commits=OVERLAP_SECOND)
        sandbox.review(repo, run_id='rv-stack-0005', review_base=repo.git('rev-parse', 'HEAD^'), head=repo.head())

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('no review saw the stacked content', result.stderr)

    def test_stacked_overlap_passes_after_the_named_commit_is_reviewed_from_its_parent(self):
        sandbox, repo = self.stack(first_files=OVERLAP_FIRST, second_commits=OVERLAP_SECOND)
        sandbox.review(repo, run_id='rv-stack-0005', review_base=repo.git('rev-parse', 'HEAD^'), head=repo.head())
        sandbox.approve('rv-stack-0005')

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_unreviewed_commit_in_stack_denies(self):
        sandbox, repo = self.stack()
        repo.commit({'src/gap.py': 'unreviewed = True\n'})
        sandbox.tests_evidence(repo)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('src/gap.py', result.stderr)

    def test_stacked_commit_changed_after_review_denies(self):
        sandbox, repo = self.stack()
        repo.write('src/second.py', 'second = 3\n')
        repo.git('commit', '-a', '--amend', '-m', 'change')
        sandbox.tests_evidence(repo)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('src/second.py', result.stderr)
        self.assertNotIn('no review saw the stacked content', result.stderr)

    def test_stacked_chain_reviewed_from_above_the_merge_base_denies(self):
        sandbox, repo = self.stack()
        first = repo.git('rev-parse', 'first')
        narrow = self.reviewed_branch(sandbox, repo, 'narrow', first, [{'src/narrow.py': 'narrow = 1\n'}],
                                      'rv-stack-0003')
        repo.git('checkout', 'feature')
        repo.git('cherry-pick', narrow)
        sandbox.tests_evidence(repo)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)

    def test_long_stack_among_many_live_chains_passes_well_inside_the_hook_timeout(self):
        sandbox = Sandbox(self)
        repo = sandbox.clone('acme', 'app', seed=SEED)
        base = repo.head()
        for index in range(30):
            self.reviewed_branch(sandbox, repo, 'noise%d' % index, base, [{'noise/n%d.py' % index: 'n = 1\n'}],
                                 'rv-noise-%04d' % index)
        heads = [self.reviewed_branch(sandbox, repo, 'chain%d' % index, base,
                                      ([LOGIC_WITH_TEST] if index == 0 else [])
                                      + [{'src/c%d.py' % index: 'v = %d\n' % step} for step in range(15)],
                                      'rv-chain-%04d' % index)
                 for index in range(4)]
        repo.git('checkout', '-b', 'feature', heads[0])
        for head in heads[1:]:
            repo.git('cherry-pick', '%s..%s' % (base, head))
        sandbox.tests_evidence(repo)

        started = time.monotonic()
        result = sandbox.push(repo, 'git push origin feature')
        elapsed = time.monotonic() - started

        self.assertEqual(result.rc, 0, result.stderr)
        self.assertLess(elapsed, ship_gate_timeout() / 3)


class FirstParentAncestorsTest(unittest.TestCase):

    def test_first_parent_ancestors_lists_the_line_down_to_stop(self):
        repo = Sandbox(self).clone('acme', 'app', seed=SEED)
        stop = repo.head()
        middle = repo.commit({'src/m.py': 'm = 1\n'})
        head = repo.commit({'src/h.py': 'h = 1\n'})

        self.assertEqual(gitcmd.first_parent_ancestors(repo.path, head, stop), [middle, stop])

    def test_first_parent_ancestors_is_empty_when_stop_arrives_only_through_a_second_parent(self):
        repo = Sandbox(self).clone('acme', 'app', seed=SEED)
        repo.branch('side')
        stop = repo.commit({'src/side.py': 'side = 1\n'})
        repo.git('checkout', 'main')
        repo.commit({'src/main.py': 'main = 1\n'})
        repo.git('merge', '--no-ff', '-q', '-m', 'merge', 'side')
        head = repo.commit({'src/after.py': 'after = 1\n'})

        self.assertEqual(gitcmd.first_parent_ancestors(repo.path, head, stop), [])


if __name__ == '__main__':
    unittest.main()
