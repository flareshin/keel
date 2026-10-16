import unittest

from helpers import LOGIC_WITH_TEST, Sandbox


class ApprovedSeriesTest(unittest.TestCase):
    def test_commentDeletion_reusesApprovedSeries_afterLastReview(self):
        sandbox, repo = self.stages()
        boundary = repo.head()
        repo.commit({'src/second.py': '# Ordinary explanation.\nsecond = 3\n',
                     'tests/test_second.py': 'assert 3 == 3\n'})
        sandbox.review(repo, run_id='rv-series-0003', review_base=boundary)
        sandbox.approve('rv-series-0003')
        sandbox.tests_evidence(repo)
        repo.commit({'src/second.py': 'second = 3\n'})

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def stages(self, approve_first=True, gap=False):
        sandbox = Sandbox(self)
        repo = sandbox.clone('acme', 'app')
        repo.branch('feature')
        base = repo.head()
        repo.commit(dict(LOGIC_WITH_TEST, **{'src/first.py': 'first = 1\n'}))
        sandbox.review(repo, run_id='rv-series-0001', review_base=base)
        if approve_first:
            sandbox.approve('rv-series-0001')
        if gap:
            repo.commit({'src/gap.py': 'unreviewed = True\n'})
        boundary = repo.head()
        repo.commit({'src/a.py': 'print(2)\n', 'src/second.py': 'second = 2\n'})
        sandbox.review(repo, run_id='rv-series-0002', review_base=boundary)
        sandbox.approve('rv-series-0002')
        sandbox.tests_evidence(repo)
        return sandbox, repo

    def test_adjacent_approved_changes_reuse_both_reviews(self):
        sandbox, repo = self.stages()

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_missing_approval_does_not_compose(self):
        sandbox, repo = self.stages(approve_first=False)

        self.assertEqual(sandbox.push(repo, 'git push origin feature').rc, 2)

    def test_unreviewed_gap_does_not_compose(self):
        sandbox, repo = self.stages(gap=True)

        self.assertEqual(sandbox.push(repo, 'git push origin feature').rc, 2)

    def test_changes_after_review_do_not_compose(self):
        sandbox, repo = self.stages()
        repo.commit({'src/a.py': 'print(3)\n'})
        sandbox.tests_evidence(repo)

        self.assertEqual(sandbox.push(repo, 'git push origin feature').rc, 2)

    def test_three_adjacent_reviews_compose(self):
        sandbox, repo = self.stages()
        boundary = repo.head()
        repo.commit({'src/third.py': 'third = 3\n'})
        sandbox.review(repo, run_id='rv-series-0003', review_base=boundary)
        sandbox.approve('rv-series-0003')
        sandbox.tests_evidence(repo)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_final_tests_must_cover_latest_content(self):
        sandbox, repo = self.stages()
        boundary = repo.head()
        repo.commit({'src/third.py': 'third = 3\n'})
        sandbox.review(repo, run_id='rv-series-0003', review_base=boundary)
        sandbox.approve('rv-series-0003')

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 2)
        self.assertIn('no tests evidence', result.stderr)

    def test_reviewed_deletion_composes(self):
        sandbox, repo = self.stages()
        boundary = repo.head()
        repo.commit({'src/first.py': None})
        sandbox.review(repo, run_id='rv-series-0003', review_base=boundary)
        sandbox.approve('rv-series-0003')
        sandbox.tests_evidence(repo)

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_unreviewed_mode_change_does_not_compose(self):
        sandbox, repo = self.stages()
        repo.write('src/a.py', 'print(2)\n', executable=True)
        repo.commit({})
        sandbox.tests_evidence(repo)

        self.assertEqual(sandbox.push(repo, 'git push origin feature').rc, 2)

    def test_invalid_newer_chain_does_not_hide_valid_series(self):
        sandbox, repo = self.stages()
        sandbox.review(repo, run_id='rv-decoy-0001', review_base=repo.head())

        result = sandbox.push(repo, 'git push origin feature')

        self.assertEqual(result.rc, 0, result.stderr)

    def test_disconnected_history_cannot_supply_predecessor(self):
        sandbox, repo = self.stages()
        repo.git('checkout', '-b', 'other', 'origin/main')
        repo.commit({'src/unrelated.py': 'unrelated = True\n'})
        unrelated = repo.head()
        repo.git('checkout', 'feature')
        boundary = repo.head()
        repo.commit({'src/third.py': 'third = 3\n'})
        sandbox.review(repo, run_id='rv-other-0001', review_base=unrelated)
        sandbox.approve('rv-other-0001')
        sandbox.tests_evidence(repo)

        self.assertNotEqual(boundary, unrelated)
        self.assertEqual(sandbox.push(repo, 'git push origin feature').rc, 2)
