"""Sandbox for black-box hook tests: temp data/overlay/home dirs, git fixtures, payload builders.

Payload builders mirror the recorded Claude Code hook shapes (DESIGN Interfaces (g)): every event has
session_id, transcript_path, cwd, permission_mode, hook_event_name; agent_id/agent_type only inside
a subagent; PreToolUse adds tool_name, tool_input, tool_use_id; SubagentStop adds
agent_transcript_path, last_assistant_message, stop_hook_active.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

KEEL_HOME = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EXAMPLES = os.path.join(KEEL_HOME, "examples", "hooks")
REPORT_GATE = "hooks/report-gate/report-gate.py"
GIT_GUARD = "hooks/git-guard/git-guard.py"
MODEL_ASSIGN = "hooks/model-assign/model-assign.py"
HANDOFF = "hooks/handoff/handoff.py"
ENV_PREFLIGHT = "stacks/spring-maven/hooks/env-preflight.py"
SESSION_ID = "11111111-2222-3333-4444-555555555555"
AGENT_ID = "a1b2c3d4e5f6"
SEEDED_RULE_IDS = {
    "K1", "K2", "K3", "K4", "K5", "risk", "F-irreversible", "F-secrets", "F-attribution",
    "F-force-push", "F-hookskip", "C-dispatch", "C-handoff", "C-isolation", "S-jdk",
}

sys.path.insert(0, os.path.join(KEEL_HOME, "hooks", "lib"))


class HookResult:
    def __init__(self, completed: subprocess.CompletedProcess):
        self.code = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr

    def json(self) -> dict:
        return json.loads(self.stdout)


class HookSandbox:
    def __init__(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="keel-hooks-"))
        self.data = os.path.join(self.root, "data")
        self.overlay = os.path.join(self.root, "overlay")
        self.home = os.path.join(self.root, "home")
        for path in (self.data, self.overlay, self.home):
            os.makedirs(path)
        self.gitconfig = os.path.join(self.root, "gitconfig")
        with open(self.gitconfig, "w") as stream:
            stream.write("[user]\n\tname = Test User\n\temail = test@example.invalid\n"
                         "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n")
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(("KEEL_", "GIT_"))}
        self.env.update({
            "KEEL_HOME": KEEL_HOME,
            "KEEL_DATA_DIR": self.data,
            "KEEL_OVERLAY_DIR": self.overlay,
            "HOME": self.home,
            "GIT_CONFIG_GLOBAL": self.gitconfig,
            "GIT_CONFIG_NOSYSTEM": "1",
            "KEEL_GH": self.stub("gh", stdout="{}"),
        })
        assert self.env["KEEL_DATA_DIR"].startswith(self.root + os.sep), "KEEL_DATA_DIR must be inside the sandbox"

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def run_hook(self, script: str, payload=None, args=(), cwd: str | None = None, raw: str | None = None) -> HookResult:
        stdin = raw if raw is not None else ("" if payload is None else json.dumps(payload))
        completed = subprocess.run(
            [sys.executable, os.path.join(KEEL_HOME, script)] + list(args),
            input=stdin, capture_output=True, text=True, env=self.env, cwd=cwd or self.root, timeout=60,
        )
        return HookResult(completed)

    def fires(self) -> list:
        path = os.path.join(self.data, "logs", "keel-fires.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as stream:
            return [json.loads(line) for line in stream if line.strip()]

    def write(self, path: str, text: str) -> str:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as stream:
            stream.write(text)
        return path

    def use_example_overlay(self, relative: str) -> None:
        target = os.path.join(self.overlay, relative)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy(os.path.join(EXAMPLES, relative), target)

    def stub(self, name: str, stdout: str = "", exit_code: int = 0) -> str:
        """An executable that records argv and stdin, prints `stdout` and exits with `exit_code`."""
        path = os.path.join(self.root, "stubs", name)
        record = path + ".calls"
        self.write(path, (
            "#!%s\nimport json, sys\n"
            "with open(%r, 'a') as s: s.write(json.dumps({'argv': sys.argv[1:], 'stdin': sys.stdin.read()}) + '\\n')\n"
            "sys.stdout.write(%r)\nsys.exit(%d)\n"
        ) % (sys.executable, record, stdout, exit_code))
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        return path

    def stub_claude(self, version: str = "9.9.9") -> None:
        """A `claude --version` first on PATH, so a contract-miss line never runs the real binary."""
        path = self.write(os.path.join(self.root, "stubs", "claude"), "#!/bin/bash\necho '%s (Claude Code)'\n" % version)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        self.env["PATH"] = os.path.dirname(path) + os.pathsep + self.env.get("PATH", "/usr/bin:/bin")

    def stub_calls(self, name: str) -> list:
        record = os.path.join(self.root, "stubs", name + ".calls")
        if not os.path.exists(record):
            return []
        with open(record) as stream:
            return [json.loads(line) for line in stream if line.strip()]

    def git(self, cwd: str, *args: str) -> str:
        completed = subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, text=True, env=self.env, check=True)
        return completed.stdout.strip()

    def make_repo(self, owner: str, name: str) -> str:
        """A clone of `<root>/remotes/<owner>/<name>.git` with one pushed commit on main."""
        remote = os.path.join(self.root, "remotes", owner, name + ".git")
        os.makedirs(remote)
        self.git(remote, "init", "--bare", "-q")
        clone = os.path.join(self.root, "work", owner, name)
        os.makedirs(os.path.dirname(clone), exist_ok=True)
        self.git(self.root, "clone", "-q", remote, clone)
        self.write(os.path.join(clone, "README.txt"), "start\n")
        self.git(clone, "add", "README.txt")
        self.git(clone, "commit", "-q", "-m", "Start")
        self.git(clone, "push", "-q", "-u", "origin", "main")
        return clone

    def commit_file(self, repo: str, relative: str, text: str, message: str) -> None:
        self.write(os.path.join(repo, relative), text)
        self.git(repo, "add", relative)
        self.git(repo, "commit", "-q", "-m", message)

    def main_transcript(self) -> str:
        return os.path.join(self.data, "projects", "-work-app", SESSION_ID + ".jsonl")

    def agent_transcript(self, brief: str, tool_uses=(), subdir: str = "workflows/wf-1") -> str:
        """Write the subagent's own transcript where Claude Code puts it, under the main one's dir."""
        path = os.path.join(self.data, "projects", "-work-app", SESSION_ID, "subagents", subdir, "agent-%s.jsonl" % AGENT_ID)
        lines = [{"type": "user", "message": {"role": "user", "content": brief}}]
        for name, tool_args in tool_uses:
            lines.append({"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_1", "name": name, "input": tool_args}]}})
        self.write(path, "".join(json.dumps(line) + "\n" for line in lines))
        self.write(self.main_transcript(), "")
        return path


def base_payload(event: str, cwd: str, transcript_path: str, in_subagent: bool) -> dict:
    payload = {
        "session_id": SESSION_ID,
        "transcript_path": transcript_path,
        "cwd": cwd,
        "permission_mode": "default",
        "hook_event_name": event,
    }
    if in_subagent:
        payload.update({"agent_id": AGENT_ID, "agent_type": "general-purpose"})
    return payload


def pre_tool_use(tool_name: str, tool_input: dict, cwd: str, transcript_path: str = "/dev/null", in_subagent: bool = False) -> dict:
    payload = base_payload("PreToolUse", cwd, transcript_path, in_subagent)
    payload.update({"tool_name": tool_name, "tool_input": tool_input, "tool_use_id": "toolu_01"})
    return payload


def bash(command: str, cwd: str) -> dict:
    return pre_tool_use("Bash", {"command": command, "description": "test"}, cwd)


def subagent_stop(cwd: str, transcript_path: str, agent_transcript_path: str, message, stop_hook_active: bool = False) -> dict:
    payload = base_payload("SubagentStop", cwd, transcript_path, in_subagent=True)
    payload.update({
        "agent_transcript_path": agent_transcript_path,
        "stop_hook_active": stop_hook_active,
    })
    if message is not None:
        payload["last_assistant_message"] = message
    return payload


class SandboxTestCase(unittest.TestCase):
    def setUp(self):
        self.sandbox = HookSandbox()
        self.addCleanup(self.sandbox.close)

    def assertFired(self, rule_id: str, outcome: str, hook: str):
        matching = [fire for fire in self.sandbox.fires() if (fire["rule_id"], fire["outcome"], fire["hook"]) == (rule_id, outcome, hook)]
        self.assertTrue(matching, "no %s/%s fire from %s in %r" % (rule_id, outcome, hook, self.sandbox.fires()))
        return matching

    def assertBulletIdsSeeded(self, message: str, overlay_ids=()):
        bullets = [line for line in message.splitlines() if line.startswith("- ")]
        self.assertTrue(bullets, "message has no bullet lines: %r" % message)
        for line in bullets:
            rule_id = line[3:line.index("]")] if line.startswith("- [") else None
            self.assertIn(rule_id, SEEDED_RULE_IDS.union(overlay_ids), line)
