import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
KEEL_HOME = os.path.dirname(os.path.dirname(HERE))
SHIP_GATE = "hooks/ship-gate/ship-gate.py"
TS_KEEL = os.path.join(KEEL_HOME, "bin", "keel.ts")
SUITES = {
    "python-keel": "tests",
    "ts-keel": "tests",
    "message-contract": "contract",
    "extra": "extra",
}
TEST_MODULES = ["test_approved_series", "test_hook_commands", "test_merge_and_smoke", "test_multi_repo_scenarios",
                "test_push_scenarios", "test_spellings", "test_stacked_chains", "test_comment_reuse"]
CASE_FILE = "case.json"
SNAPSHOT_DIR = "root"
UNLIMITED_HOOK_SECONDS = 10 ** 6


def copy_even_if_unreadable(source: str, destination: str) -> None:
    try:
        shutil.copy2(source, destination)
    except PermissionError:
        open(destination, "wb").close()
        shutil.copymode(source, destination)


class Recorder:
    def __init__(self, cases_dir: str, label: str):
        self.cases_dir = cases_dir
        self.label = label
        self.count = 0
        self.current_test = ""

    def record(self, root: str, stdin: str, env: dict, cwd: str, label: str = "") -> None:
        self.count += 1
        case_dir = os.path.join(self.cases_dir, "%s-%04d" % (self.label, self.count))
        os.makedirs(case_dir)
        shutil.copytree(root, os.path.join(case_dir, SNAPSHOT_DIR), symlinks=True, copy_function=copy_even_if_unreadable)
        with open(os.path.join(case_dir, CASE_FILE), "w", encoding="utf-8") as stream:
            json.dump({"test": self.current_test, "label": label, "script": SHIP_GATE, "args": [], "cwd": cwd, "stdin": stdin,
                       "env": env, "python": sys.executable}, stream)


class RecordingResult(unittest.TextTestResult):
    recorder = None

    def startTest(self, test):
        self.recorder.current_test = test.id()
        super().startTest(test)


def fixed_root_factory(sandbox_root: str):
    def fixed_root(prefix="tmp"):
        shutil.rmtree(sandbox_root, ignore_errors=True)
        os.makedirs(sandbox_root)
        return sandbox_root
    return fixed_root


def run_suite(recorder: Recorder, names: list) -> dict:
    RecordingResult.recorder = recorder
    suite = unittest.defaultTestLoader.loadTestsFromNames(names)
    result = unittest.TextTestRunner(stream=open(os.devnull, "w"), resultclass=RecordingResult).run(suite)
    for test, trace in result.failures + result.errors:
        sys.stderr.write("%s\n%s\n" % (test.id(), trace))
    return {"testsRun": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
            "skipped": len(result.skipped)}


def record_ship_gate_tests(recorder: Recorder, ts_keel: bool) -> dict:
    sys.path.insert(0, HERE)
    import helpers
    import test_stacked_chains

    original_hook_raw = helpers.Sandbox.hook_raw

    def recording_hook_raw(self, stdin, extra_env=None):
        recorder.record(self.root, stdin, dict(self.env, **(extra_env or {})), os.getcwd())
        return original_hook_raw(self, stdin, extra_env)

    helpers.Sandbox.hook_raw = recording_hook_raw
    if ts_keel:
        def node_keel(self, *args, cwd=None, stdin=None):
            completed = subprocess.run(["node", TS_KEEL] + list(args), input=stdin, capture_output=True, text=True,
                                       env=self.env, cwd=cwd or self.root)
            return helpers.Run(completed.returncode, completed.stdout, completed.stderr)
        helpers.Sandbox.keel = node_keel
    test_stacked_chains.ship_gate_timeout = lambda: UNLIMITED_HOOK_SECONDS
    return run_suite(recorder, TEST_MODULES)


def record_message_contract(recorder: Recorder) -> dict:
    sys.path.insert(0, os.path.join(KEEL_HOME, "tests", "hooks"))
    import helpers

    original_run_hook = helpers.HookSandbox.run_hook

    def recording_run_hook(self, script, payload=None, args=(), cwd=None, raw=None):
        if script == SHIP_GATE:
            stdin = raw if raw is not None else ("" if payload is None else json.dumps(payload))
            recorder.record(self.root, stdin, dict(self.env), cwd or self.root)
        return original_run_hook(self, script, payload, args, cwd, raw)

    helpers.HookSandbox.run_hook = recording_run_hook
    return run_suite(recorder, ["test_message_contract"])


def record_extra(recorder: Recorder) -> dict:
    sys.path.insert(0, HERE)
    import extra_cases
    extra_cases.record_all(recorder)
    return {"testsRun": 0, "failures": 0, "errors": 0, "skipped": 0}


def tolerate_missing_chmod_targets() -> None:
    original_chmod = os.chmod

    def chmod(path, mode, *args, **kwargs):
        try:
            original_chmod(path, mode, *args, **kwargs)
        except FileNotFoundError:
            pass

    os.chmod = chmod


def main() -> int:
    cases_dir, sandbox_root, label = os.path.abspath(sys.argv[1]), os.path.realpath(sys.argv[2]), sys.argv[3]
    os.makedirs(cases_dir, exist_ok=True)
    recorder = Recorder(cases_dir, label)
    tempfile.mkdtemp = fixed_root_factory(sandbox_root)
    tolerate_missing_chmod_targets()
    started = time.monotonic()
    if label == "python-keel":
        summary = record_ship_gate_tests(recorder, ts_keel=False)
    elif label == "ts-keel":
        summary = record_ship_gate_tests(recorder, ts_keel=True)
    elif label == "message-contract":
        summary = record_message_contract(recorder)
    else:
        summary = record_extra(recorder)
    summary.update(label=label, recorded=recorder.count, seconds=round(time.monotonic() - started))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
