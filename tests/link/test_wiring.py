import json
import os
import shutil
import unittest

from helpers import KEEL_ROOT, LinkTestCase

LEDGER_HEADER = (
    "id\tscope\ttype\tstatement\tlayer\tenforced_at\twhy_not_stronger\tjustification\t"
    "incidents\tmetric\treview_by\tgrace_until\tstatus"
)
GATE_HOOK = {"type": "command", "command": "python3 {{KEEL}}/hooks/git-guard/git-guard.py", "timeout": 10, "onFailure": "block"}


def hook_row(row_id, hook, scope="core", status="active"):
    return "\t".join([row_id, scope, "floor", "A demo rule.", "hook", "hook:" + hook, "-", "-", "-", "fires:" + row_id, "-", "-", status])


class LinkCoreFragmentTest(LinkTestCase):
    def test_write_refusesAndKeepsSettings_whenCoreFragmentIsMissing(self):
        # given
        os.unlink(os.path.join(self.box.keel, "settings", "core.json"))
        self.box.write_data("settings.json", '{"model": "m"}\n')
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("core.json", result.stderr)
        self.assertEqual(self.box.read_data("settings.json"), '{"model": "m"}\n')

    def test_check_refuses_whenCoreFragmentIsMissing(self):
        # given
        os.unlink(os.path.join(self.box.keel, "settings", "core.json"))
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 3)


class LinkHookRegistrationTest(LinkTestCase):
    def write_ledgers(self, keel_rows, overlay_rows=()):
        self.box.write_keel("ledger.tsv", "\n".join([LEDGER_HEADER, *keel_rows]) + "\n")
        if overlay_rows:
            self.box.write_overlay("ledger.tsv", "\n".join([LEDGER_HEADER, *overlay_rows]) + "\n")

    def test_check_passes_whenEveryActiveHookRowIsRegistered(self):
        # given
        self.write_ledgers([hook_row("F-demo", "demo")])
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 0)

    def test_check_reportsHookUnregistered_whenAKeelHookRowNamesAnUnregisteredHook(self):
        # given
        self.write_ledgers([hook_row("F-demo", "demo"), hook_row("F-ghost", "ghost-gate")])
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 1)
        unregistered = [p for p in result.json["problems"] if p["kind"] == "hook-unregistered"]
        self.assertEqual(len(unregistered), 1)
        self.assertIn("F-ghost", unregistered[0]["detail"])
        self.assertIn("ghost-gate", unregistered[0]["detail"])

    def test_check_reportsHookUnregistered_whenAnOverlayHookRowNamesAnUnregisteredHook(self):
        # given
        self.write_ledgers([], [hook_row("O-ghost", "ghost-gate", scope="overlay")])
        # when
        result = self.box.run_link("--check")
        # then
        self.assertIn("hook-unregistered", self.problem_kinds(result))

    def test_write_refusesAndWritesNothing_whenAHookRowIsUnregistered(self):
        # given
        self.write_ledgers([hook_row("F-ghost", "ghost-gate")])
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertFalse(os.path.exists(self.box.data_path("settings.json")))

    def test_check_ignoresRetiredRowsAndRowsOfInactiveStacks(self):
        # given
        self.write_ledgers([
            hook_row("F-old", "ghost-gate", status="retired"),
            hook_row("S-jdk", "ghost-preflight", scope="stack:inactive-stack"),
        ])
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 0)

    def test_check_reportsHookUnregistered_whenARowOfAnActiveStackHasNoRegistration(self):
        # given
        self.box.write_overlay("stacks.txt", "demo-stack\n")
        self.box.write_keel("stacks/demo-stack/settings.json", "{}")
        self.write_ledgers([hook_row("S-demo", "ghost-preflight", scope="stack:demo-stack")])
        # when
        result = self.box.run_link("--check")
        # then
        self.assertIn("hook-unregistered", self.problem_kinds(result))


class LinkGateOnFailureTest(LinkTestCase):
    def write_core_hook(self, matcher, hook):
        core = {"hooks": {"PreToolUse": [{"matcher": matcher, "hooks": [hook]}]}}
        self.box.write_keel("settings/core.json", json.dumps(core))

    def test_check_passes_whenGateRegistrationsBlockOnFailureWithATimeout(self):
        # given
        self.write_core_hook("Bash|Edit|Write|NotebookEdit", GATE_HOOK)
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 0)

    def test_check_reportsGateOnFailureMissing_whenAGateRegistrationLacksOnFailure(self):
        # given
        self.write_core_hook("Bash|Edit|Write|NotebookEdit", {k: v for k, v in GATE_HOOK.items() if k != "onFailure"})
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 1)
        self.assertIn("gate-onfailure-missing", self.problem_kinds(result))

    def test_check_reportsGateOnFailureMissing_whenAGateRegistrationHasNoTimeout(self):
        # given
        self.write_core_hook("Edit", {k: v for k, v in GATE_HOOK.items() if k != "timeout"})
        # when
        result = self.box.run_link("--check")
        # then
        self.assertIn("gate-onfailure-missing", self.problem_kinds(result))

    def test_check_skipsGateHookOnAToolItDoesNotGate(self):
        # given ship-gate on Skill is not a fail-closed registration
        self.write_core_hook("Skill", {"type": "command", "command": "python3 {{KEEL}}/hooks/ship-gate/ship-gate.py", "timeout": 30})
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 0)


class LinkHooksPathTest(LinkTestCase):
    def test_write_setsCoreHooksPathToGithooks_inKeelHome(self):
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.git(self.box.keel, "config", "--get", "core.hooksPath").strip(), "githooks")

    def test_check_reportsHooksPathDrift_whenCoreHooksPathWasChanged(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        self.box.git(self.box.keel, "config", "core.hooksPath", "/elsewhere")
        # when
        result = self.box.run_link("--check")
        # then
        self.assertExit(result, 1)
        self.assertEqual(self.problem_kinds(result), ["hookspath-drift"])

    def test_write_refuses_whenKeelHomeIsNotAGitCheckout(self):
        # given
        shutil.rmtree(os.path.join(self.box.keel, ".git"))
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("hookspath-drift", self.problem_kinds(result))

    def test_write_refusesAndLeavesParentHooksPathUnset_whenKeelHomeIsASubdirectoryOfAnotherRepo(self):
        # given
        shutil.rmtree(os.path.join(self.box.keel, ".git"))
        self.box.git(self.box.root, "init", "-q")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("hookspath-drift", self.problem_kinds(result))
        self.assertNotIn("core.hookspath", self.box.git(self.box.root, "config", "--local", "--list"))


class ShippedSettingsTest(LinkTestCase):
    """The real settings/core.json and ledger.tsv, linked with the spring-maven stack active."""

    def setUp(self):
        super().setUp()
        for relative in ("ledger.tsv", "settings/core.json", "stacks/spring-maven/settings.json"):
            self.box.write_keel(relative, _read(os.path.join(KEEL_ROOT, relative)))
        self.box.write_overlay("stacks.txt", "spring-maven\n")

    def test_shippedCore_registersEveryHookRowAndFailsClosedOnGates(self):
        # when
        result = self.box.run_link("--check")
        # then
        kinds = self.problem_kinds(result)
        self.assertNotIn("hook-unregistered", kinds, result.json)
        self.assertNotIn("gate-onfailure-missing", kinds, result.json)

    def test_shippedLedger_reportsCDispatch_whenModelAssignIsDroppedFromCore(self):
        # given
        core = json.loads(_read(os.path.join(KEEL_ROOT, "settings", "core.json")))
        core["hooks"]["PreToolUse"] = [e for e in core["hooks"]["PreToolUse"] if "model-assign" not in e["hooks"][0]["command"]]
        self.box.write_keel("settings/core.json", json.dumps(core))
        # when
        result = self.box.run_link("--check")
        # then
        details = [p["detail"] for p in result.json["problems"] if p["kind"] == "hook-unregistered"]
        self.assertEqual(len(details), 1, details)
        self.assertTrue(details[0].startswith("C-dispatch (keel ledger): hook model-assign"), details)

    def test_shippedCore_blocksOnFailureOnlyOnShipGateBashAndGitGuard(self):
        # given
        with open(os.path.join(KEEL_ROOT, "settings", "core.json"), encoding="utf-8") as f:
            pre_tool_use = json.load(f)["hooks"]["PreToolUse"]
        # when
        blocking = sorted(
            (entry["matcher"], hook["command"].rsplit("/", 1)[1])
            for entry in pre_tool_use for hook in entry["hooks"] if hook.get("onFailure") == "block"
        )
        # then
        self.assertEqual(blocking, [("Bash", "ship-gate.py"), ("Bash|Edit|Write|NotebookEdit", "git-guard.py")])

    def test_shippedCore_registersShipGateOnlyOnPreToolUseBash(self):
        # given
        with open(os.path.join(KEEL_ROOT, "settings", "core.json"), encoding="utf-8") as f:
            hooks = json.load(f)["hooks"]
        # when
        ship_gate = [
            (event, entry.get("matcher", ""))
            for event, entries in hooks.items() for entry in entries for hook in entry["hooks"]
            if "ship-gate" in hook.get("command", "")
        ]
        # then
        self.assertEqual(ship_gate, [("PreToolUse", "Bash")])


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


if __name__ == "__main__":
    unittest.main()
