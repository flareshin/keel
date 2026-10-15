import os
import unittest

from helpers import LinkTestCase, read_file

TASK = "scheduled-tasks/demo/SKILL.md"
TASK_TEXT = "---\nname: demo\n---\nRun the demo.\n"
OVERLAY_LINKS = (
    "source\ttarget\n"
    "{{OVERLAY}}/commands/hello.md\tcommands/hello.md\n"
    "{{OVERLAY}}/scheduled-tasks/demo/SKILL.md\tscheduled-tasks/demo/SKILL.md\n"
)


class LinkCopiesScheduledTasksTest(LinkTestCase):
    def setUp(self):
        super().setUp()
        self.box.write_overlay(TASK, TASK_TEXT)
        self.box.write_overlay("links.tsv", OVERLAY_LINKS)
        self.source = os.path.join(self.box.overlay, TASK)
        self.target = self.box.data_path(TASK)

    def test_write_copiesScheduledTaskFile_whenTargetIsMissing(self):
        # given an empty data dir
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertFalse(os.path.islink(self.target))
        self.assertEqual(self.box.read_data(TASK), TASK_TEXT)
        self.assertIn({"op": "copy", "path": self.target}, result.json["actions"])
        self.assertTrue(os.path.islink(self.box.data_path("commands/hello.md")))

    def test_write_changesNothing_whenCopyMatchesSource(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        second = self.box.run_link("--write")
        # then
        self.assertExit(second, 0)
        self.assertEqual(second.json["actions"], [])

    def test_write_replacesKeelLinkWithCopy_whenTaskIsStillASymlink(self):
        # given the shape an earlier link left: a keel symlink the app refuses to open
        os.makedirs(os.path.dirname(self.target))
        os.symlink(self.source, self.target)
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertIn({"op": "copy", "path": self.target}, result.json["actions"])
        self.assertFalse(os.path.islink(self.target))
        self.assertEqual(self.box.read_data(TASK), TASK_TEXT)

    def test_write_refusesAndKeepsCopy_whenCopyDiffersFromSourceWithoutForce(self):
        # given a copy edited after it was written
        self.box.write_data(TASK, "edited in the app\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["copy-drift"])
        self.assertEqual(self.box.read_data(TASK), "edited in the app\n")

    def test_write_refreshesCopyAndMovesOldAside_whenForced(self):
        # given
        self.box.write_data(TASK, "edited in the app\n")
        # when
        result = self.box.run_link("--write", "--force")
        # then
        self.assertExit(result, 0)
        self.assertIn({"op": "copy", "path": self.target}, result.json["actions"])
        self.assertFalse(os.path.islink(self.target))
        self.assertEqual(self.box.read_data(TASK), TASK_TEXT)
        self.assertEqual(read_file(self.only_backup(TASK)), "edited in the app\n")

    def test_write_refuses_whenForeignLinkSitsAtTaskWithoutForce(self):
        # given
        elsewhere = os.path.join(self.box.root, "elsewhere.md")
        with open(elsewhere, "w", encoding="utf-8") as f:
            f.write("not keel\n")
        os.makedirs(os.path.dirname(self.target))
        os.symlink(elsewhere, self.target)
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["link-wrong"])
        self.assertEqual(os.readlink(self.target), elsewhere)

    def test_write_refusesEvenWhenForced_whenSourceIsMissing(self):
        # given
        os.unlink(self.source)
        # when
        result = self.box.run_link("--write", "--force")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["dangling"])
        self.assertFalse(os.path.lexists(self.target))

    def test_write_refuses_whenDirectorySitsAtTaskWithoutForce(self):
        # given
        os.makedirs(self.target)
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["target-occupied"])
        self.assertTrue(os.path.isdir(self.target))

    def test_check_reportsCopyDrift_whenSourceChangedAfterCopy(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        self.box.write_overlay(TASK, TASK_TEXT + "New step.\n")
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["copy-drift"])

    def test_check_reportsCopyMissing_whenTargetIsAbsent(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        os.unlink(self.target)
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["copy-missing"])


if __name__ == "__main__":
    unittest.main()
