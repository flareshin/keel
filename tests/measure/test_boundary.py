from __future__ import annotations

import os
import unittest

from helpers import CHECKOUT, MeasureSandbox

# Built at runtime so this file itself never carries a matching line.
FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP"
INVENTED_PRIVATE_IP = "10.250." + "3.4"
TRACK_PATHS = ("ledger.tsv", "measure", "githooks", "tests/measure", "examples/ledger-smoke")


class BoundaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()
        self.repo = os.path.join(self.box.root, "work")
        os.makedirs(self.repo)

    def tearDown(self) -> None:
        self.box.cleanup()

    def scan(self, *args: str):
        return self.box.run_json("boundary", *args, cwd=self.repo)

    def test_boundaryPaths_reportsLexiconRegexAndGenericHits_withLinesAndRuleNames(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.write("work/notes.txt", "clean line\nshipped for acmecorp\nsee TKT-1234\nhost %s\nkey %s\n" % (INVENTED_PRIVATE_IP, FAKE_AWS_KEY))
        # when
        completed, result = self.scan("--paths", "notes.txt")
        # then
        self.assertEqual(completed.returncode, 1)
        found = {(hit["line"], hit["rule"]) for hit in result["hits"]}
        self.assertEqual(found, {
            (2, "lexicon:1"), (3, "lexicon:2"), (3, "regex:1"), (4, "regex:2"),
            (4, "generic:private-ipv4-10"), (5, "generic:aws-access-key"),
        })
        self.assertNotIn("ACMECORP", completed.stdout + completed.stderr)

    def test_boundaryPaths_passes_whenNothingMatches(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.write("work/notes.txt", "a public sentence\n")
        # when
        completed, result = self.scan("--paths", "notes.txt")
        # then
        self.assertEqual((completed.returncode, result["hits"], result["scanned"]), (0, [], 2))

    def test_boundaryPaths_scansPathNames_asLineZero(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.write("work/acmecorp-notes.txt", "clean\n")
        # when
        _, result = self.scan("--paths", ".")
        # then
        self.assertEqual(result["hits"], [{"file": "acmecorp-notes.txt", "line": 0, "rule": "lexicon:1"}])

    def test_boundary_exitsTwo_whenOverlayLexiconIsMissing(self) -> None:
        # given
        self.box.write("work/notes.txt", "clean\n")
        # when
        completed = self.box.run_measure("boundary", "--paths", "notes.txt", cwd=self.repo)
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertIn("overlay lexicon missing", completed.stderr)

    def test_boundary_exitsTwo_whenOverlayLexiconHasNoTerms(self) -> None:
        # given
        self.box.write("overlay/boundary/lexicon.txt", "# terms go here\n\n")
        self.box.write("work/notes.txt", "clean\n")
        # when
        completed = self.box.run_measure("boundary", "--paths", "notes.txt", cwd=self.repo)
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertIn("has no terms", completed.stderr)

    def test_boundary_usesGenericRulesOnly_whenGenericOnlyIsGiven(self) -> None:
        # given
        self.box.write("work/notes.txt", "acmecorp\nkey %s\n" % FAKE_AWS_KEY)
        # when
        completed, result = self.scan("--generic-only", "--paths", "notes.txt")
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertEqual([hit["rule"] for hit in result["hits"]], ["generic:aws-access-key"])

    def test_boundary_exitsTwo_whenOverlayRegexIsInvalid(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.write("overlay/boundary/regex.txt", "(unclosed\n")
        self.box.write("work/notes.txt", "clean\n")
        # when
        completed = self.box.run_measure("boundary", "--paths", "notes.txt", cwd=self.repo)
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertIn("regex:1", completed.stderr)

    def test_boundaryStaged_scansOnlyStagedAddedLines_withNewLineNumbers(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        self.box.write("work/app.txt", "one\ntwo\nthree\n")
        self.box.commit_all(self.repo)
        self.box.write("work/app.txt", "one\ntwo acmecorp\nthree\n++ TKT-9 header lookalike\n")
        self.box.git(self.repo, "add", "app.txt")
        self.box.write("work/unstaged.txt", "acmecorp but not staged\n")
        # when
        completed, result = self.scan("--staged")
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(result["hits"], [
            {"file": "app.txt", "line": 2, "rule": "lexicon:1"},
            {"file": "app.txt", "line": 4, "rule": "lexicon:2"},
        ])

    def test_boundaryStaged_passes_whenStagedLinesAreClean(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        self.box.write("work/app.txt", "clean\n")
        self.box.git(self.repo, "add", "app.txt")
        # when
        completed, result = self.scan("--staged")
        # then
        self.assertEqual((completed.returncode, result["hits"]), (0, []))

    def test_boundaryStaged_reportsTheName_whenAStagedFileIsBinary(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        with open(os.path.join(self.repo, "acmecorp.bin"), "wb") as handle:
            handle.write(b"\0\1\2")
        self.box.git(self.repo, "add", "acmecorp.bin")
        # when
        completed, result = self.scan("--staged")
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(result["hits"], [{"file": "acmecorp.bin", "line": 0, "rule": "lexicon:1"}])

    def test_boundaryStaged_reportsTheName_whenAStagedFileIsEmpty(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        self.box.write("work/acmecorp-empty.txt", "")
        self.box.git(self.repo, "add", "acmecorp-empty.txt")
        # when
        completed, result = self.scan("--staged")
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(result["hits"], [{"file": "acmecorp-empty.txt", "line": 0, "rule": "lexicon:1"}])

    def test_boundaryRange_reportsTheName_whenACommitAddsAnEmptyFile(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        self.box.write("work/a.txt", "base\n")
        base = self.box.commit_all(self.repo, "Base")
        self.box.write("work/acmecorp-empty.txt", "")
        head = self.box.commit_all(self.repo, "Add a file")
        # when
        completed, result = self.scan("--range", "%s..%s" % (base, head))
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertEqual([(hit["file"].split(":", 1)[1], hit["line"]) for hit in result["hits"]], [("acmecorp-empty.txt", 0)])

    def test_boundaryStaged_skipsTheName_whenAStagedChangeDeletesTheFile(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        self.box.write("work/acmecorp-old.txt", "clean\n")
        self.box.git(self.repo, "add", "-A")
        self.box.git(self.repo, "commit", "-q", "--no-verify", "-m", "Base")
        self.box.git(self.repo, "rm", "-q", "acmecorp-old.txt")
        # when
        completed, result = self.scan("--staged")
        # then
        self.assertEqual((completed.returncode, result["hits"]), (0, []))

    def test_boundaryPaths_scansOnlyTrackedFiles_whenTheDirectoryIsALinkedWorktree(self) -> None:
        # given
        self.box.write_lexicon()
        main = os.path.join(self.box.root, "main")
        os.makedirs(main)
        self.box.init_repo(main)
        self.box.write("main/tracked.txt", "one\ntwo\n")
        self.box.write("main/.gitignore", "*.log\n")
        self.box.commit_all(main)
        worktree = os.path.join(self.box.root, "acmecorp-wt")
        self.box.git(main, "worktree", "add", "-q", worktree)
        self.box.write("acmecorp-wt/untracked.txt", "acmecorp\n")
        self.box.write("acmecorp-wt/build.log", "acmecorp\n")
        # when
        completed, result = self.box.run_json("boundary", "--paths", ".", cwd=worktree)
        # then
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["scanned"], 2 + 3)

    def test_boundaryPaths_exitsTwo_whenADirectoryHoldsOnlyUntrackedFiles(self) -> None:
        # given
        self.box.write_lexicon()
        repo = os.path.join(self.box.root, "repo")
        os.makedirs(repo)
        self.box.init_repo(repo)
        self.box.write("repo/tracked.txt", "one\n")
        self.box.commit_all(repo)
        self.box.write("repo/newskill/SKILL.md", "draft\n")
        # when
        completed, _ = self.box.run_json("boundary", "--paths", "newskill", cwd=repo)
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertIn("newskill", completed.stderr)

    def make_parent_with_submodule(self) -> str:
        sub = os.path.join(self.box.root, "sub")
        parent = os.path.join(self.box.root, "parent")
        os.makedirs(sub)
        os.makedirs(parent)
        self.box.init_repo(sub)
        self.box.write("sub/s.txt", "acmecorp\n")
        self.box.commit_all(sub)
        self.box.init_repo(parent)
        self.box.write("parent/p.txt", "one\n")
        self.box.git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mysub")
        self.box.commit_all(parent)
        return parent

    def test_boundaryPaths_skipsTheGitlink_whenTheSubmoduleIsUninitialized(self) -> None:
        # given
        self.box.write_lexicon()
        parent = self.make_parent_with_submodule()
        clone = os.path.join(self.box.root, "clone")
        self.box.git(self.box.root, "clone", "-q", parent, clone)
        # when
        whole, whole_result = self.box.run_json("boundary", "--paths", ".", cwd=clone)
        gitlink, gitlink_result = self.box.run_json("boundary", "--paths", "mysub", cwd=clone)
        # then
        self.assertEqual(whole.returncode, 0, whole.stderr)
        self.assertEqual(whole_result["hits"], [])
        self.assertEqual((gitlink.returncode, gitlink_result), (0, {"scanned": 0, "hits": []}), gitlink.stderr)

    def test_boundaryPaths_scansSubmoduleFiles_whenTheSubmoduleIsInitialized(self) -> None:
        # given
        self.box.write_lexicon()
        parent = self.make_parent_with_submodule()
        # when
        completed, result = self.box.run_json("boundary", "--paths", ".", cwd=parent)
        # then
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual([hit["file"] for hit in result["hits"]], ["mysub/s.txt"])

    def test_boundaryPaths_skipsGitInternals_whenTheDirectoryIsOutsideAWorkTree(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.write("work/notes.txt", "clean\n")
        self.box.write("work/.git", "gitdir: /somewhere/acmecorp/.git/worktrees/x\n")
        self.box.write("work/sub/.git/config", "[remote] acmecorp\n")
        self.box.write("work/sub/untracked.txt", "acmecorp\n")
        # when
        completed, result = self.box.run_json("boundary", "--paths", "work", cwd=self.box.root)
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertEqual([hit["file"] for hit in result["hits"]], ["work/sub/untracked.txt"])

    def test_boundaryRange_scansCommitMessagesAndAddedLines_perCommit(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        self.box.write("work/a.txt", "base\n")
        base = self.box.commit_all(self.repo, "Base")
        self.box.write("work/a.txt", "base\nacmecorp\n")
        self.box.commit_all(self.repo, "Add a line")
        self.box.write("work/a.txt", "base\n")
        head = self.box.commit_all(self.repo, "Fix TKT-4321")
        # when
        completed, result = self.scan("--range", "%s..%s" % (base, head))
        # then
        self.assertEqual(completed.returncode, 1)
        rules_by_file = {(hit["file"].split(":", 1)[1], hit["line"], hit["rule"]) for hit in result["hits"]}
        self.assertEqual(rules_by_file, {("a.txt", 2, "lexicon:1"), ("message", 1, "lexicon:2"), ("message", 1, "regex:1")})

    def test_boundaryRange_scansCommitsNotOnAnyRemote_whenOldIsZero(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        self.box.write("work/a.txt", "acmecorp in the root commit\n")
        head = self.box.commit_all(self.repo, "Root")
        # when
        completed, result = self.scan("--range", "%s..%s" % ("0" * 40, head))
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertEqual([(hit["line"], hit["rule"]) for hit in result["hits"]], [(1, "lexicon:1")])

    def test_boundaryRange_exitsTwo_whenRangeHasNoDots(self) -> None:
        # given
        self.box.write_lexicon()
        self.box.init_repo(self.repo)
        # when
        completed = self.box.run_measure("boundary", "--range", "HEAD", cwd=self.repo)
        # then
        self.assertEqual(completed.returncode, 2)

    def test_boundaryGeneric_findsNothing_inThisTracksOwnFiles(self) -> None:
        # given
        paths = [os.path.join(CHECKOUT, path) for path in TRACK_PATHS]
        # when
        completed, result = self.box.run_json("boundary", "--generic-only", "--paths", *paths)
        # then
        self.assertEqual(completed.returncode, 0, result["hits"] if result else completed.stderr)
        self.assertGreater(result["scanned"], 100)


if __name__ == "__main__":
    unittest.main()
