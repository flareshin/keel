import os
import unittest

import helpers
from helpers import MODEL_ASSIGN, pre_tool_use


class ModelAssignTestCase(helpers.SandboxTestCase):
    def dispatch(self, **tool_input):
        tool_input.setdefault("description", "Find callers")
        tool_input.setdefault("prompt", "Find every caller of parse().")
        return self.sandbox.run_hook(MODEL_ASSIGN, pre_tool_use("Agent", tool_input, self.sandbox.root))

    def workflow(self, **tool_input):
        return self.sandbox.run_hook(MODEL_ASSIGN, pre_tool_use("Workflow", tool_input, self.sandbox.root))

    def updated(self, result):
        return result.json()["hookSpecificOutput"]["updatedInput"]


class AgentDispatchTest(ModelAssignTestCase):
    def test_dispatch_getsSonnetAndMedium_whenModelAndEffortOmitted(self):
        # when
        result = self.dispatch()
        # then
        self.assertEqual(("sonnet", "medium"), (self.updated(result)["model"], self.updated(result)["effort"]))
        self.assertEqual("Find every caller of parse().", self.updated(result)["prompt"])
        self.assertFired("C-dispatch", "record", "model-assign")

    def test_dispatch_getsOpusAndHigh_whenBriefAsksForVerdict(self):
        result = self.dispatch(prompt="Review the diff and return a VERDICT line.")
        self.assertEqual(("opus", "high"), (self.updated(result)["model"], self.updated(result)["effort"]))

    def test_dispatch_getsHaiku_whenReadOnlyExploreType(self):
        self.assertEqual("haiku", self.updated(self.dispatch(subagent_type="Explore"))["model"])

    def test_dispatch_keepsHaiku_whenExploreNamesIt(self):
        self.assertEqual("haiku", self.updated(self.dispatch(subagent_type="Explore", model="haiku"))["model"])

    def test_dispatch_raisesHaikuToSonnet_whenTypeCanEdit(self):
        self.assertEqual("sonnet", self.updated(self.dispatch(model="haiku", effort="low"))["model"])

    def test_dispatch_capsFableToOpus_whenAgentDispatch(self):
        self.assertEqual("opus", self.updated(self.dispatch(model="fable", effort="high"))["model"])

    def test_dispatch_passesUntouched_whenModelAndEffortInBand(self):
        result = self.dispatch(model="sonnet", effort="low")
        self.assertEqual("", result.stdout)
        self.assertFired("C-dispatch", "pass", "model-assign")

    def test_dispatch_passesUntouched_whenFork(self):
        self.assertEqual("", self.dispatch(subagent_type="fork").stdout)

    def test_dispatch_keepsEffortUnset_whenAgentFilePinsEffort(self):
        self.sandbox.write(os.path.join(self.sandbox.data, "agents", "worker-pinned.md"), "---\nname: worker-pinned\neffort: low\n---\nBody\n")
        result = self.dispatch(subagent_type="worker-pinned", model="sonnet")
        self.assertEqual("", result.stdout)

    def test_dispatch_setsEffort_whenAgentFileHasNoPin(self):
        self.sandbox.write(os.path.join(self.sandbox.data, "agents", "worker-plain.md"), "---\nname: worker-plain\n---\neffort: in body only\n")
        self.assertEqual("medium", self.updated(self.dispatch(subagent_type="worker-plain", model="sonnet"))["effort"])


class WorkflowScriptTest(ModelAssignTestCase):
    def test_workflow_deniedWithCDispatch_whenAgentCallsNameNoModel(self):
        result = self.workflow(script="await agent('probe', {effort: 'medium'})")
        self.assertEqual(2, result.code)
        self.assertIn("opts.model", result.stderr)
        self.assertBulletIdsSeeded(result.stderr)
        self.assertFired("C-dispatch", "deny", "model-assign")

    def test_workflow_passes_whenModelAndEffortPresent(self):
        result = self.workflow(script="await agent('probe', {\"model\": 'haiku', effort: 'medium'})")
        self.assertEqual(0, result.code)
        self.assertFired("C-dispatch", "pass", "model-assign")

    def test_workflow_readsScriptPath_whenGiven(self):
        path = self.sandbox.write(os.path.join(self.sandbox.root, "wf.js"), "await agent('x', {model: 'opus'})\n")
        result = self.workflow(scriptPath=path)
        self.assertEqual(2, result.code)
        self.assertIn(path, result.stderr)

    def test_workflow_passes_whenResuming(self):
        self.assertEqual(0, self.workflow(script="agent('x')", resumeFromRunId="run-1").code)

    def test_workflow_passes_whenNamedWorkflowHasNoScript(self):
        self.assertEqual(0, self.workflow(name="lens-review").code)


class FailureTest(ModelAssignTestCase):
    def test_modelAssign_passes_whenPayloadIsNotJson(self):
        self.assertEqual(0, self.sandbox.run_hook(MODEL_ASSIGN, raw="{").code)

    def test_modelAssign_passesAndLogsError_whenScriptPathUnreadable(self):
        path = os.path.join(self.sandbox.root, "unreadable.js")
        self.sandbox.write(path, "agent(")
        os.chmod(path, 0)
        result = self.workflow(scriptPath=path)
        self.assertEqual(0, result.code)
        self.assertFired("C-dispatch", "error", "model-assign")

    def test_modelAssign_ignoresOtherTools(self):
        result = self.sandbox.run_hook(MODEL_ASSIGN, pre_tool_use("Bash", {"command": "ls"}, self.sandbox.root))
        self.assertEqual(("", []), (result.stdout, self.sandbox.fires()))


if __name__ == "__main__":
    unittest.main()
