"""Sandbox for measure tests: a temp keel checkout, overlay, data dir, HOME and git config per test."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from datetime import date, timedelta
from typing import Dict, List, Optional

CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
MEASURE_DIR = os.path.join(CHECKOUT, "measure")
GITHOOKS_DIR = os.path.join(CHECKOUT, "githooks")
LEDGER_COLUMNS = (
    "id", "scope", "type", "statement", "layer", "enforced_at", "why_not_stronger",
    "justification", "incidents", "metric", "review_by", "grace_until", "status",
)
TODAY = date.today()
FUTURE = (TODAY + timedelta(days=30)).isoformat()
PAST = (TODAY - timedelta(days=30)).isoformat()
NOW_TS = TODAY.isoformat() + "T09:00:00Z"
LINK_STUB_CLEAN = '#!/bin/bash\necho \'{"actions":[],"problems":[]}\'\n'
CLAUDE_STUB = '#!/bin/bash\necho "$*" >> "$(dirname "$0")/claude.calls"\ncat "$(dirname "$0")/plugins.json"\n'
DEMO_HOOK = (
    "import json, os, sys\n"
    "command = json.load(sys.stdin)['tool_input']['command']\n"
    "if not command.startswith('bad '):\n"
    "    sys.exit(0)\n"
    "logs = os.path.join(os.environ['KEEL_DATA_DIR'], 'logs')\n"
    "os.makedirs(logs, exist_ok=True)\n"
    "with open(os.path.join(logs, 'keel-fires.jsonl'), 'a') as handle:\n"
    "    handle.write(json.dumps({'rule_id': command.split()[1], 'outcome': 'deny', 'hook': 'demo'}) + '\\n')\n"
    "sys.exit(2)\n"
)


def read_text(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def ledger_row(row_id: str, **overrides: str) -> Dict[str, str]:
    """A valid core row by default; tests override only the columns they exercise."""
    row = {
        "id": row_id, "scope": "core", "type": "knowledge", "statement": "A demo rule.",
        "layer": "hook", "enforced_at": "hook:demo", "why_not_stronger": "-", "justification": "-",
        "incidents": "docs/incidents/one.md,docs/incidents/two.md", "metric": "fires:" + row_id,
        "review_by": FUTURE, "grace_until": "-", "status": "active",
    }
    row.update(overrides)
    return row


def charter_row(row_id: str = "K1", **overrides: str) -> Dict[str, str]:
    values = dict(scope="charter", justification="Evidence from the previous harness.", incidents="-", review_by="-")
    values.update(overrides)
    return ledger_row(row_id, **values)


class MeasureSandbox:
    def __init__(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="keel-measure-test-"))
        self.keel = os.path.join(self.root, "keel")
        self.overlay = os.path.join(self.root, "overlay")
        self.data = os.path.join(self.root, "data")
        for path in (self.keel, self.overlay, self.data, os.path.join(self.root, "home")):
            os.makedirs(path)
        self._write_git_config()
        self.link_stub = self.write("stubs/link", LINK_STUB_CLEAN, executable=True)
        self.claude_stub = self.write("stubs/claude", CLAUDE_STUB, executable=True)
        self.install_plugins([])
        self.env = self._isolated_env()
        assert self.env["KEEL_DATA_DIR"].startswith(self.root + os.sep), "data dir must be inside the sandbox"

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def _write_git_config(self) -> None:
        self.gitconfig = os.path.join(self.root, "gitconfig")
        with open(self.gitconfig, "w", encoding="utf-8") as handle:
            handle.write("[user]\n\tname = Test User\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n")

    def _isolated_env(self) -> Dict[str, str]:
        env = {key: value for key, value in os.environ.items() if not key.startswith(("KEEL_", "GIT_"))}
        env.update(
            KEEL_HOME=self.keel, KEEL_OVERLAY_DIR=self.overlay, KEEL_DATA_DIR=self.data,
            HOME=os.path.join(self.root, "home"), GIT_CONFIG_GLOBAL=self.gitconfig, GIT_CONFIG_NOSYSTEM="1",
            KEEL_GH=os.path.join(self.root, "stubs", "gh"), KEEL_LINK=self.link_stub, KEEL_CLAUDE=self.claude_stub,
        )
        return env

    def install_plugins(self, plugins: List[Dict[str, str]]) -> None:
        """Sets what the stub `claude plugin list --json` prints."""
        self.write("stubs/plugins.json", json.dumps(plugins))

    def write(self, relative_path: str, content: str, executable: bool = False) -> str:
        path = os.path.join(self.root, relative_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        if executable:
            os.chmod(path, 0o755)
        return path

    def write_ledger(self, relative_path: str, rows: List[Dict[str, str]]) -> str:
        lines = ["\t".join(LEDGER_COLUMNS)] + ["\t".join(row[column] for column in LEDGER_COLUMNS) for row in rows]
        return self.write(relative_path, "\n".join(lines) + "\n")

    def append_log(self, name: str, record: dict) -> None:
        path = os.path.join(self.data, "logs", name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")

    def fire(self, rule_id: str, ts: str = NOW_TS, outcome: str = "deny") -> None:
        self.append_log("keel-fires.jsonl", {"ts": ts, "rule_id": rule_id, "hook": "ship-gate", "outcome": outcome, "session": "-"})

    def write_lexicon(self) -> None:
        self.write("overlay/boundary/lexicon.txt", "ACMECORP\nTKT-\n")
        self.write("overlay/boundary/regex.txt", "\\bTKT-\\d{3,}\\b\n\\b10\\.250\\.\\d{1,3}\\.\\d{1,3}\\b\n")

    def git(self, repo: str, *args: str, stdin_text: Optional[str] = None) -> str:
        completed = subprocess.run(["git", "-C", repo] + list(args), input=stdin_text, capture_output=True, text=True, env=self.env)
        if completed.returncode != 0:
            raise AssertionError("git %s failed: %s" % (" ".join(args), completed.stderr))
        return completed.stdout

    def init_repo(self, repo: str, origin: str = "https://example.invalid/example/keel.git") -> None:
        self.git(repo, "init", "-q")
        self.git(repo, "remote", "add", "origin", origin)

    def commit_all(self, repo: str, message: str = "Add files") -> str:
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-q", "--no-verify", "-m", message)
        return self.git(repo, "rev-parse", "HEAD").strip()

    def bash_fixture(self, command: str, expect: Optional[str] = None) -> str:
        fixture = {"payload": {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "cwd": "{{TMP}}"}}
        if expect:
            fixture["expect"] = expect
        return json.dumps(fixture)

    def register_hooks(self, hooks: dict) -> None:
        self.write("data/settings.json", json.dumps({"hooks": hooks}))

    def seed_demo_hook(self) -> None:
        """hook:demo registered for Bash, firing on `bad <rule_id>`, with bad fixtures for K1 and C-demo and a good one."""
        script = self.write("keel/hooks/demo/demo.py", DEMO_HOOK)
        self.register_hooks({"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 " + script}]}]})
        for rule_id in ("K1", "C-demo"):
            self.write("keel/tests/hooks/fixtures/%s.bad.json" % rule_id, self.bash_fixture("bad " + rule_id, expect="deny"))
        self.write("keel/tests/hooks/fixtures/demo.good.json", self.bash_fixture("ls"))

    def seed_clean_keel(self) -> None:
        """A keel checkout on which every smoke check passes."""
        self.write_ledger("keel/ledger.tsv", [charter_row("K1"), ledger_row("C-demo")])
        self.seed_demo_hook()
        self.write("keel/docs/incidents/one.md", "First incident.\n")
        self.write("keel/docs/incidents/two.md", "Second incident.\n")
        self.write("keel/PRINCIPLES.md", "# Principles\n\n- [K1] An author never judges its own output.\n")
        self.write("keel/skills/demo/SKILL.md", "# Demo\n\n## Rules\n\n- [K1] Tagged.\n")
        self.fire("K1")
        self.fire("C-demo")
        self.write_lexicon()
        self.init_repo(self.keel)
        self.commit_all(self.keel)

    def last_log_line(self, name: str) -> dict:
        with open(os.path.join(self.data, "logs", name), encoding="utf-8") as handle:
            return json.loads(handle.readlines()[-1])

    def run_measure(self, tool: str, *args: str, cwd: Optional[str] = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [os.path.join(MEASURE_DIR, tool)] + list(args),
            capture_output=True, text=True, env=self.env, cwd=cwd or self.root,
        )

    def run_json(self, tool: str, *args: str, cwd: Optional[str] = None):
        completed = self.run_measure(tool, *args, cwd=cwd)
        return completed, json.loads(completed.stdout) if completed.stdout.strip() else None
