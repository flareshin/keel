import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import helpers  # noqa: E402

HOOKS = {helpers.GIT_GUARD, helpers.HANDOFF, helpers.MODEL_ASSIGN, helpers.REPORT_GATE, helpers.ENV_PREFLIGHT}
TEST_MODULES = ["test_git_guard", "test_handoff", "test_model_assign", "test_report_gate", "test_env_preflight", "test_message_contract"]
CASE_FILE = "case.json"
SNAPSHOT_DIR = "root"


class Recorder:
    def __init__(self, cases_dir: str, sandbox_root: str):
        self.cases_dir = cases_dir
        self.sandbox_root = sandbox_root
        self.count = 0
        self.current_test = ""

    def snapshot(self, root: str, destination: str) -> None:
        shutil.copytree(root, destination, symlinks=True, copy_function=copy_even_if_unreadable)

    def record(self, sandbox, script, payload, args, cwd, raw) -> None:
        self.count += 1
        case_dir = os.path.join(self.cases_dir, "%04d" % self.count)
        os.makedirs(case_dir)
        self.snapshot(sandbox.root, os.path.join(case_dir, SNAPSHOT_DIR))
        stdin = raw if raw is not None else ("" if payload is None else json.dumps(payload))
        with open(os.path.join(case_dir, CASE_FILE), "w", encoding="utf-8") as stream:
            json.dump({"test": self.current_test, "script": script, "args": list(args), "cwd": cwd or sandbox.root,
                       "stdin": stdin, "env": sandbox.env, "python": sys.executable}, stream)


def copy_even_if_unreadable(source: str, destination: str) -> None:
    try:
        shutil.copy2(source, destination)
    except PermissionError:
        open(destination, "wb").close()
        shutil.copymode(source, destination)


class RecordingResult(unittest.TextTestResult):
    recorder = None

    def startTest(self, test):
        self.recorder.current_test = test.id()
        super().startTest(test)


def main() -> int:
    cases_dir, sandbox_root = os.path.abspath(sys.argv[1]), os.path.realpath(sys.argv[2])
    recorder = Recorder(cases_dir, sandbox_root)

    def fixed_root(prefix="tmp"):
        shutil.rmtree(sandbox_root, ignore_errors=True)
        os.makedirs(sandbox_root)
        return sandbox_root

    original_run_hook = helpers.HookSandbox.run_hook

    def recording_run_hook(self, script, payload=None, args=(), cwd=None, raw=None):
        if script in HOOKS:
            recorder.record(self, script, payload, args, cwd, raw)
        return original_run_hook(self, script, payload, args, cwd, raw)

    helpers.HookSandbox.run_hook = recording_run_hook
    tempfile.mkdtemp = fixed_root
    RecordingResult.recorder = recorder
    suite = unittest.defaultTestLoader.loadTestsFromNames(TEST_MODULES)
    result = unittest.TextTestRunner(stream=open(os.devnull, "w"), resultclass=RecordingResult).run(suite)
    for test, trace in result.failures + result.errors:
        sys.stderr.write("%s\n%s\n" % (test.id(), trace))
    print(json.dumps({"recorded": recorder.count, "testsRun": result.testsRun, "failures": len(result.failures),
                      "errors": len(result.errors), "skipped": len(result.skipped)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
