"""Every deny or warn a hook emits has one shape (hookkit/protocol.py): a first line `[<ID>] <hook>:
<summary>`, `- [<ID>] …` bullets, for a deny a last line naming what the user can do, and at most
2000 characters. One representative deny (and warn where the hook has one) per hook."""
import importlib.util
import json
import os
import re
import unittest

import helpers
from helpers import ENV_PREFLIGHT, GIT_GUARD, MODEL_ASSIGN, REPORT_GATE, SESSION_ID, bash, pre_tool_use, subagent_stop

SHIP_GATE = "hooks/ship-gate/ship-gate.py"
FIRST_LINE = re.compile(r"^\[[A-Za-z0-9-]+\] (ship-gate|git-guard|report-gate|model-assign|env-preflight): \S")
BULLET = re.compile(r"^- \[[A-Za-z0-9-]+\] \S")
RUN_YOURSELF = "Run it yourself in your terminal: "
ASK_USER = "Stop and ask the user."
MESSAGE_LIMIT = 2000
EVIDENCE_LINE = (
    'KEEL-EVIDENCE: {"v":1,"repo_root":"/work/app","review_base":"%s","head":null,"snapshot_tree":"%s",'
    '"since":null,"run_id":"rv-20261011T085500Z-7f3e21","root_run_id":"rv-20261011T085500Z-7f3e21",'
    '"review_kind":"lens-review"}' % ("a" * 40, "b" * 40))


def handback_tail() -> str:
    spec = importlib.util.spec_from_file_location("report_gate", os.path.join(helpers.KEEL_HOME, REPORT_GATE))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.HANDBACK_TAIL


class MessageContractTest(helpers.SandboxTestCase):
    def setUp(self):
        super().setUp()
        self.sandbox.env["KEEL_BOUNDARY"] = self.sandbox.stub("boundary", stdout='{"scanned": 1, "hits": []}')
        self.sandbox.env["KEEL_CLI"] = self.sandbox.stub("keel", stdout="{}")
        self.sandbox.stub_claude()
        self.next_steps = (RUN_YOURSELF, ASK_USER, handback_tail())

    def assertDenyShape(self, message: str):
        lines = message.rstrip("\n").splitlines()
        self.assertRegex(lines[0], FIRST_LINE)
        self.assertTrue(len(lines) >= 3, message)
        for line in lines[1:-1]:
            self.assertRegex(line, BULLET)
        self.assertTrue(any(lines[-1].startswith(step) for step in self.next_steps) or RUN_YOURSELF in message, message)
        self.assertLessEqual(len(message.rstrip("\n")), MESSAGE_LIMIT)

    def assertWarnShape(self, message: str):
        lines = message.rstrip("\n").splitlines()
        self.assertRegex(lines[0], FIRST_LINE)
        for line in lines[1:]:
            self.assertTrue(BULLET.match(line) or FIRST_LINE.match(line), line)
        self.assertLessEqual(len(message), MESSAGE_LIMIT)

    def gated_feature_repo(self) -> str:
        self.sandbox.write(os.path.join(self.sandbox.overlay, "gated-repos.tsv"),
                           "origin\tgate\tintegration_base\trisk_rules\ttests\nacme/app\tcode\tmain\t-\trequired\n")
        repo = self.sandbox.make_repo("acme", "app")
        self.sandbox.git(repo, "checkout", "-q", "-b", "feature")
        self.sandbox.commit_file(repo, "src/a.py", "x\n", "feature work")
        return repo

    def test_shipGate_deny_followsTheContract(self):
        repo = self.gated_feature_repo()
        result = self.sandbox.run_hook(SHIP_GATE, bash("git push origin feature", repo))
        self.assertEqual(2, result.code, result.stderr)
        self.assertDenyShape(result.stderr)
        self.assertTrue(result.stderr.rstrip("\n").splitlines()[-1].startswith(RUN_YOURSELF + "cd "), result.stderr)

    def test_shipGate_warn_followsTheContract(self):
        repo = self.gated_feature_repo()
        result = self.sandbox.run_hook(SHIP_GATE, bash("gh pr create --title t --body b", repo))
        self.assertEqual(0, result.code, result.stderr)
        self.assertWarnShape(result.json()["hookSpecificOutput"]["additionalContext"])

    def test_shipGate_failClosed_followsTheContract(self):
        result = self.sandbox.run_hook(SHIP_GATE, raw='{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin x"')
        self.assertEqual(2, result.code)
        self.assertDenyShape(result.stderr)

    def test_gitGuard_bashDeny_followsTheContract(self):
        repo = self.sandbox.make_repo("example", "app")
        result = self.sandbox.run_hook(GIT_GUARD, bash("git push --force origin main", repo))
        self.assertEqual(2, result.code, result.stderr)
        self.assertDenyShape(result.stderr)
        self.assertTrue(result.stderr.rstrip("\n").endswith(RUN_YOURSELF + "cd %s && git push --force origin main" % repo))

    def test_gitGuard_editDeny_followsTheContract(self):
        target = os.path.join(self.sandbox.data, "state", "keel", "evidence", "x.json")
        result = self.sandbox.run_hook(GIT_GUARD, pre_tool_use("Write", {"file_path": target, "content": "{}"}, self.sandbox.root))
        self.assertEqual(2, result.code)
        self.assertDenyShape(result.stderr)
        self.assertEqual(ASK_USER, result.stderr.rstrip("\n").splitlines()[-1])

    def test_gitGuard_failClosed_followsTheContract(self):
        result = self.sandbox.run_hook(GIT_GUARD, raw='{"tool_input": {"command": "git push"')
        self.assertEqual(2, result.code)
        self.assertDenyShape(result.stderr)

    def test_reportGate_handbackDeny_followsTheContract(self):
        self.sandbox.agent_transcript("[SCOPE] /work/app\nDo it.")
        payload = pre_tool_use("SubagentHandback", {"message": "Done, VERDICT: PASS"}, self.sandbox.root,
                               transcript_path=self.sandbox.main_transcript(), in_subagent=True)
        result = self.sandbox.run_hook(REPORT_GATE, payload)
        self.assertEqual(2, result.code)
        self.assertDenyShape(result.stderr)

    def test_reportGate_stopBlock_followsTheContract(self):
        transcript = self.sandbox.agent_transcript("[SCOPE] /work/app\nDo it.", [("Edit", {"file_path": "/elsewhere/x.py"})])
        payload = subagent_stop(self.sandbox.root, self.sandbox.main_transcript(), transcript, "Done.")
        result = self.sandbox.run_hook(REPORT_GATE, payload)
        self.assertEqual("block", result.json()["decision"])
        self.assertDenyShape(result.json()["reason"])

    def test_modelAssign_deny_followsTheContract(self):
        payload = pre_tool_use("Workflow", {"script": "await agent('probe', {effort: 'medium'})"}, self.sandbox.root)
        result = self.sandbox.run_hook(MODEL_ASSIGN, payload)
        self.assertEqual(2, result.code)
        self.assertDenyShape(result.stderr)

    def test_envPreflight_deny_followsTheContract(self):
        self.sandbox.use_example_overlay("stack-data/spring-maven/jdk.tsv")
        repo = self.sandbox.make_repo("acmecorp", "billing")
        result = self.sandbox.run_hook(ENV_PREFLIGHT, bash("mvn -q test", repo))
        self.assertEqual(2, result.code, result.stderr)
        self.assertDenyShape(result.stderr)

    def test_longDeny_isCappedAndKeepsItsLastLine(self):
        repo = self.sandbox.make_repo("example", "app")
        paths = ["f%03d.sql" % index for index in range(400)]
        for path in paths:
            self.sandbox.write(os.path.join(repo, path), "select 1;\n")
        self.sandbox.git(repo, "add", *paths)
        self.sandbox.write(os.path.join(self.sandbox.overlay, "git-guard", "repo-rules.tsv"),
                           "origin_glob\taction\tpattern\trule_id\tmessage\nexample/*\tdeny-path\t*.sql\tO-files\tNo SQL.\n")
        result = self.sandbox.run_hook(GIT_GUARD, bash("git commit -m 'Add sql'", repo))
        self.assertEqual(2, result.code)
        self.assertDenyShape(result.stderr)
        self.assertIn("…and 390 more", result.stderr)

    def test_everyFiresLine_namesASeededRuleId(self):
        self.gated_feature_repo()
        for fire in self.sandbox.fires():
            self.assertIn(fire["rule_id"], helpers.SEEDED_RULE_IDS, json.dumps(fire))


if __name__ == "__main__":
    unittest.main()
