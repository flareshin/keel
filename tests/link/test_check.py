import json
import os
import unittest

from helpers import LinkTestCase


class LinkCheckTest(LinkTestCase):
    def setUp(self):
        super().setUp()
        self.assertExit(self.box.run_link("--write"), 0)

    def snapshot_data(self):
        snapshot = {}
        for directory, _, files in os.walk(self.box.data):
            for name in files + [d for d in os.listdir(directory) if os.path.islink(os.path.join(directory, d))]:
                path = os.path.join(directory, name)
                snapshot[path] = os.readlink(path) if os.path.islink(path) else _read_bytes(path)
        return snapshot

    def check_without_writing(self):
        before = self.snapshot_data()
        result = self.box.run_link("--check")
        self.assertEqual(self.snapshot_data(), before, "--check must not write")
        return result

    def test_check_passesWithNoProblems_whenEverythingMatches(self):
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 0)
        self.assertEqual(result.json, {"actions": [], "problems": []})

    def test_check_reportsLinkMissing_whenALinkWasDeleted(self):
        # given
        os.unlink(self.box.data_path("bin/keel"))
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 1)
        self.assertEqual(result.json["problems"][0]["kind"], "link-missing")
        self.assertEqual(result.json["problems"][0]["path"], self.box.data_path("bin/keel"))

    def test_check_reportsLinkWrong_whenALinkPointsElsewhere(self):
        # given
        os.unlink(self.box.data_path("bin/keel"))
        os.symlink("/usr/bin/true", self.box.data_path("bin/keel"))
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["link-wrong"])

    def test_check_reportsTargetOccupied_whenALinkWasReplacedByARegularFile(self):
        # given
        os.unlink(self.box.data_path("bin/keel"))
        self.box.write_data("bin/keel", "copied file\n")
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["target-occupied"])

    def test_check_reportsDangling_whenTheLinkSourceWasRemoved(self):
        # given
        os.unlink(os.path.join(self.box.keel, "bin", "keel"))
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["dangling"])

    def test_check_reportsClaudeMdDrift_whenPrinciplesChanged(self):
        # given
        self.box.write_keel("PRINCIPLES.md", "- [K1] Changed.\n")
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["claude-md-drift"])

    def test_check_reportsSettingsDriftWithoutValues_whenOwnedKeyWasEdited(self):
        # given
        live = json.loads(self.box.read_data("settings.json"))
        live["env"]["ACME_NOTES_DIR"] = "secret-value"
        self.box.write_data("settings.json", json.dumps(live))
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["settings-drift"])
        self.assertIn("env.ACME_NOTES_DIR: differs", result.json["problems"][0]["detail"])
        self.assertNotIn("secret-value", result.stdout + result.stderr)

    def test_check_reportsSettingsDriftWithoutValues_whenLiveHoldsAnOwnedKeyNoFragmentDeclares(self):
        # given the overlay fragment that declared env is gone
        os.unlink(os.path.join(self.box.overlay, "settings", "50-permissions.json"))
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["settings-drift"])
        self.assertIn("env: declared by no fragment", result.json["problems"][0]["detail"])
        self.assertNotIn(self.box.data + "/notes", result.stdout + result.stderr)

    def test_check_ignoresUnownedKeys_whenTheyChange(self):
        # given
        live = json.loads(self.box.read_data("settings.json"))
        live["model"] = "anything"
        self.box.write_data("settings.json", json.dumps(live))
        # when
        result = self.check_without_writing()
        # then
        self.assertExit(result, 0)


def _read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


if __name__ == "__main__":
    unittest.main()
