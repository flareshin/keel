from __future__ import annotations

import json
import os
import shutil
import unittest

from helpers import CHECKOUT, DEMO_HOOK, MeasureSandbox, charter_row, ledger_row

SHIPPED_FRAGMENTS = ("settings/core.json", "stacks/spring-maven/settings.json")


class WiredFiresTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()
        self.box.seed_clean_keel()
        self.fixtures = os.path.join(self.box.keel, "tests", "hooks", "fixtures")

    def tearDown(self) -> None:
        self.box.cleanup()

    def wired_fires(self) -> dict:
        _, result = self.box.run_json("smoke", "--json-only")
        [item] = [item for item in result["assertions"] if item["check"] == "wired-fires"]
        return item

    def test_wiredFires_passes_whenEveryHookRowFiresOnItsBadFixtureAndStaysQuietOnTheGoodOne(self) -> None:
        # when
        item = self.wired_fires()
        # then
        self.assertEqual((item["scope"], item["status"]), ("all", "PASS"), item)
        self.assertIn("2 rows", item["detail"])

    def test_wiredFires_fails_whenNoHookLayerRowIsRecognized(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [charter_row("K1", layer="skill", enforced_at="skill:demo", why_not_stronger="Judgment.")])
        # when
        item = self.wired_fires()
        # then
        self.assertEqual(item["status"], "FAIL")
        self.assertIn("0 hook-layer rows", item["detail"])

    def test_wiredFires_fails_whenABadFixtureIsMissing(self) -> None:
        # given
        os.remove(os.path.join(self.fixtures, "C-demo.bad.json"))
        # when
        item = self.wired_fires()
        # then
        self.assertEqual(item["status"], "FAIL")
        self.assertIn("C-demo: missing fixture", item["detail"])

    def test_wiredFires_fails_whenTheGoodFixtureIsMissing(self) -> None:
        # given
        os.remove(os.path.join(self.fixtures, "demo.good.json"))
        # then
        self.assertIn("demo: missing fixture", self.wired_fires()["detail"])

    def test_wiredFires_fails_whenTheHookIsNotRegisteredForTheFixtureEvent(self) -> None:
        # given
        self.box.register_hooks({})
        # when
        item = self.wired_fires()
        # then
        self.assertEqual(item["status"], "FAIL")
        self.assertIn("C-demo: no PreToolUse[Bash] registration of hook demo", item["detail"])

    def test_wiredFires_fails_whenTheMatcherDoesNotCoverTheFixtureTool(self) -> None:
        # given
        script = os.path.join(self.box.keel, "hooks", "demo", "demo.py")
        self.box.register_hooks({"PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "python3 " + script}]}]})
        # then
        self.assertIn("no PreToolUse[Bash] registration", self.wired_fires()["detail"])

    def test_wiredFires_fails_whenTheRegisteredScriptDoesNotExist(self) -> None:
        # given
        os.remove(os.path.join(self.box.keel, "hooks", "demo", "demo.py"))
        # then
        self.assertIn("script missing", self.wired_fires()["detail"])

    def test_wiredFires_fails_whenTheBadFixtureFiresAnotherRule(self) -> None:
        # given
        self.box.write("keel/tests/hooks/fixtures/C-demo.bad.json", self.box.bash_fixture("bad K1", expect="deny"))
        # when
        item = self.wired_fires()
        # then
        self.assertEqual(item["status"], "FAIL")
        self.assertIn("C-demo: bad fixture logged no deny fires line for C-demo", item["detail"])

    def test_wiredFires_fails_whenTheHookFiresOnTheGoodFixture(self) -> None:
        # given
        self.box.write("keel/tests/hooks/fixtures/demo.good.json", self.box.bash_fixture("bad K1"))
        # then
        self.assertIn("demo: good fixture fired K1", self.wired_fires()["detail"])

    def test_wiredFires_fails_whenTheHookWritesTheRealFiresLog(self) -> None:
        # given a hook that ignores KEEL_DATA_DIR
        real_log = os.path.join(self.box.data, "logs", "keel-fires.jsonl")
        script = self.box.write("keel/hooks/demo/demo.py", (
            "import json, sys\n"
            "command = json.load(sys.stdin)['tool_input']['command']\n"
            "if command.startswith('bad '):\n"
            "    open(%r, 'a').write(json.dumps({'rule_id': command.split()[1], 'outcome': 'deny'}) + '\\n')\n"
        ) % real_log)
        self.box.register_hooks({"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 " + script}]}]})
        # then
        self.assertIn("the real keel-fires.jsonl changed during the run", self.wired_fires()["detail"])

    def test_wiredFires_runsSetupCommandsInTheTempDir_beforeFeedingThePayload(self) -> None:
        # given a hook that fires only when the payload's cwd holds a directory the fixture setup creates
        for rule_id in ("K1", "C-demo"):
            fixture = json.loads(self.box.bash_fixture("bad " + rule_id, expect="deny"))
            fixture["setup"] = ["mkdir repo"]
            self.box.write("keel/tests/hooks/fixtures/%s.bad.json" % rule_id, json.dumps(fixture))
        script = self.box.write("keel/hooks/demo/demo.py", (
            "import json, os, sys\n"
            "payload = json.load(sys.stdin)\n"
            "if not os.path.isdir(os.path.join(payload['cwd'], 'repo')):\n"
            "    sys.exit(0)\n"
        ) + "\n".join(self.demo_hook_lines()))
        self.box.register_hooks({"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 " + script}]}]})
        # then
        self.assertEqual(self.wired_fires()["status"], "PASS")

    def test_wiredFires_givesHooksTheOverlayTheFixtureSetupBuilds_notTheLiveOverlay(self) -> None:
        # given a hook that fires only on overlay data, which the live overlay lacks and the setup writes
        for rule_id in ("K1", "C-demo"):
            fixture = json.loads(self.box.bash_fixture("bad " + rule_id, expect="deny"))
            fixture["setup"] = ["mkdir -p overlay && touch overlay/fire-on-me"]
            self.box.write("keel/tests/hooks/fixtures/%s.bad.json" % rule_id, json.dumps(fixture))
        script = self.box.write("keel/hooks/demo/demo.py", (
            "import json, os, sys\n"
            "payload = json.load(sys.stdin)\n"
            "if not os.path.isfile(os.path.join(os.environ['KEEL_OVERLAY_DIR'], 'fire-on-me')):\n"
            "    sys.exit(0)\n"
        ) + "\n".join(self.demo_hook_lines()))
        self.box.register_hooks({"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 " + script}]}]})
        # then
        self.assertEqual(self.wired_fires()["status"], "PASS", self.wired_fires())

    def test_wiredFires_neverShowsHooksTheLiveOverlay_whenTheSetupBuildsNone(self) -> None:
        # given live overlay data on which the demo hook fires even for the good fixture
        self.box.write("overlay/fire-on-me", "")
        script = self.box.write("keel/hooks/demo/demo.py", (
            "import json, os, sys\n"
            "payload = json.load(sys.stdin)\n"
            "if os.path.isfile(os.path.join(os.environ['KEEL_OVERLAY_DIR'], 'fire-on-me')):\n"
            "    payload['tool_input']['command'] = 'bad K1'\n"
            "if not payload['tool_input']['command'].startswith('bad '):\n"
            "    sys.exit(0)\n"
        ) + "\n".join(self.demo_hook_lines()))
        self.box.register_hooks({"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 " + script}]}]})
        # then the good fixture stays quiet
        self.assertEqual(self.wired_fires()["status"], "PASS", self.wired_fires())

    def test_wiredFires_skipsRowsOfStacksTheOverlayHasNotActivated(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [charter_row("K1"), ledger_row("C-demo"), ledger_row("S-jdk", scope="stack:inactive-stack")])
        # then
        self.assertEqual(self.wired_fires()["status"], "PASS")

    def test_wiredFires_checksRowsOfActiveStacks(self) -> None:
        # given
        self.box.write("overlay/stacks.txt", "demo-stack\n")
        self.box.write_ledger("keel/ledger.tsv", [charter_row("K1"), ledger_row("C-demo"), ledger_row("S-jdk", scope="stack:demo-stack")])
        # then
        self.assertIn("S-jdk: missing fixture", self.wired_fires()["detail"])

    def test_wiredFires_looksForOverlayRowFixturesInTheOverlay(self) -> None:
        # given
        self.box.write_ledger("overlay/ledger.tsv", [ledger_row("O-demo", scope="overlay")])
        self.box.write("overlay/tests/hooks/fixtures/O-demo.bad.json", self.box.bash_fixture("bad O-demo", expect="deny"))
        # then
        self.assertEqual(self.wired_fires()["status"], "PASS", self.wired_fires())

    def test_wiredFires_looksForTheGoodFixtureOfAnOverlayHookInTheOverlay(self) -> None:
        # given an overlay row enforced by a hook whose script lives in the overlay
        script = self.box.write("overlay/hooks/odemo/odemo.py", DEMO_HOOK)
        self.box.register_hooks({"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "python3 " + os.path.join(self.box.keel, "hooks", "demo", "demo.py")},
            {"type": "command", "command": "python3 " + script}]}]})
        self.box.write_ledger("overlay/ledger.tsv", [ledger_row("O-demo", scope="overlay", enforced_at="hook:odemo")])
        self.box.write("overlay/tests/hooks/fixtures/O-demo.bad.json", self.box.bash_fixture("bad O-demo", expect="deny"))
        good = self.box.write("overlay/tests/hooks/fixtures/odemo.good.json", self.box.bash_fixture("ls"))
        # when
        item = self.wired_fires()
        # then
        self.assertEqual(item["status"], "PASS", item)
        os.remove(good)
        self.assertIn("odemo: missing fixture " + good, self.wired_fires()["detail"])

    def test_wiredFires_passesForEveryShippedHookRow_withTheShippedSettingsAndFixtures(self) -> None:
        # given this checkout's ledger, fixtures and hook registrations, with the spring-maven stack active
        self.box.env["KEEL_HOME"] = CHECKOUT
        self.box.write("overlay/stacks.txt", "spring-maven\n")
        self.box.register_hooks(shipped_hooks())
        # when
        item = self.wired_fires()
        # then
        self.assertEqual(item["status"], "PASS", item)
        self.assertIn("13 rows fired on bad fixtures, 6 hooks quiet", item["detail"])

    def test_wiredFires_passes_whenTheOverlayIsAssembledFromTheShippedExamples(self) -> None:
        # given an overlay made of every examples/<track>/ directory, as the README describes them
        self.box.env["KEEL_HOME"] = CHECKOUT
        for track in os.listdir(os.path.join(CHECKOUT, "examples")):
            shutil.copytree(os.path.join(CHECKOUT, "examples", track), self.box.overlay, dirs_exist_ok=True)
        self.box.write("overlay/stacks.txt", "spring-maven\n")
        self.box.register_hooks(shipped_hooks())
        # when
        item = self.wired_fires()
        # then the example overlay's hook row (O-files) fires on its own shipped fixture
        self.assertEqual(item["status"], "PASS", item)
        self.assertIn("14 rows fired on bad fixtures, 6 hooks quiet", item["detail"])

    @staticmethod
    def demo_hook_lines():
        return [
            "command = payload['tool_input']['command']",
            "logs = os.path.join(os.environ['KEEL_DATA_DIR'], 'logs')",
            "os.makedirs(logs, exist_ok=True)",
            "open(os.path.join(logs, 'keel-fires.jsonl'), 'a').write(json.dumps({'rule_id': command.split()[1], 'outcome': 'deny'}) + '\\n')",
            "sys.exit(2)",
        ]


def shipped_hooks() -> dict:
    """The `hooks` bin/link writes from keel's own fragments: arrays concatenate per event, {{KEEL}} expanded."""
    merged = {}
    for fragment in SHIPPED_FRAGMENTS:
        with open(os.path.join(CHECKOUT, fragment), encoding="utf-8") as handle:
            text = handle.read().replace("{{KEEL}}", CHECKOUT)
        for event, groups in json.loads(text)["hooks"].items():
            merged.setdefault(event, []).extend(groups)
    return merged


if __name__ == "__main__":
    unittest.main()
