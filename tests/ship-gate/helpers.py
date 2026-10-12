"""Fixtures for the ship-gate tests: temp bare remotes, clones, a temp data dir and overlay, stubs."""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from typing import Dict, List, NamedTuple, Optional

TESTS_DIR = os.path.dirname(os.path.realpath(__file__))
KEEL_HOME = os.path.dirname(os.path.dirname(TESTS_DIR))
SHIP_GATE = os.path.join(KEEL_HOME, "hooks", "ship-gate", "ship-gate.py")
KEEL = os.path.join(KEEL_HOME, "bin", "keel")
DEFAULT_REGISTRY = ["acme/app\tcode\tmain\tacme\trequired"]
PUSH_APPROVAL_REGISTRY = ["acme/app\tcode\tmain\tacme\trequired\ttrue"]  # a push itself deploys: approval at push
REGISTRY_HEADER = "origin\tgate\tintegration_base\trisk_rules\ttests"
REGISTRY_OPTIONAL_COLUMN = "push_approval"
DEFAULT_RULES = ["acme\tsrc/*/billing/*\theavy", "acme\tdocs/*\tlight", "acme\t*.md\tlight",
                 "overlay\tsettings/*\tsmoke-only", "overlay\tledger.tsv\tsmoke-only"]
# K3 as written: logic ships with a test in the same range, so a passing change carries one.
LOGIC_WITH_TEST = {"src/a.py": "print(1)\n", "tests/test_a.py": "def test_a():\n    assert True\n"}
GH_STUB = """#!/bin/bash
printf '%s\\n' "${GH_REPO:+GH_REPO=$GH_REPO }$*" >> "$KEEL_TEST_GH_LOG"
cat "$KEEL_TEST_GH_RESPONSE"
"""
CLAUDE_STUB = "#!/bin/bash\necho '9.9.9 (Claude Code)'\n"
GIT_CONFIG = """[user]
\tname = Keel Test
\temail = keel-test@example.com
[init]
\tdefaultBranch = main
[protocol "file"]
\tallow = always
"""


def read_json(path: str) -> dict:
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


class Run(NamedTuple):
    rc: int
    stdout: str
    stderr: str

    @property
    def json(self) -> dict:
        return json.loads(self.stdout)

    @property
    def context(self) -> str:
        if not self.stdout.strip():
            return ""
        return self.json["hookSpecificOutput"]["additionalContext"]


class Repo:
    def __init__(self, sandbox: "Sandbox", path: str, key: str):
        self.sandbox = sandbox
        self.path = path
        self.key = key

    def git(self, *args: str, check: bool = True) -> str:
        completed = subprocess.run(["git", "-C", self.path] + list(args), capture_output=True, text=True,
                                   env=self.sandbox.env)
        if check and completed.returncode != 0:
            raise AssertionError("git %s failed: %s" % (" ".join(args), completed.stderr))
        return completed.stdout.strip()

    def write(self, relative: str, content, executable: bool = False) -> str:
        full = os.path.join(self.path, relative)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(full, mode) as stream:
            stream.write(content)
        if executable:
            os.chmod(full, os.stat(full).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return full

    def commit(self, files: Dict[str, object], message: str = "change") -> str:
        for relative, content in files.items():
            if content is None:
                os.unlink(os.path.join(self.path, relative))
            else:
                self.write(relative, content)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.head()

    def head(self) -> str:
        return self.git("rev-parse", "HEAD")

    def tree(self, rev: str = "HEAD") -> str:
        return self.git("rev-parse", rev + "^{tree}")

    def branch(self, name: str, start: Optional[str] = None) -> None:
        self.git("checkout", "-q", "-b", name, *([start] if start else []))


class Sandbox:
    def __init__(self, case: unittest.TestCase, registry: Optional[List[str]] = None, rules: Optional[List[str]] = None):
        self.case = case
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="keel-ship-gate-"))
        case.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.data = os.path.join(self.root, "data")
        self.overlay = os.path.join(self.root, "overlay")
        self.home = os.path.join(self.root, "home")
        self.remotes = os.path.join(self.root, "remotes")
        for directory in (self.data, self.overlay, self.home, self.remotes):
            os.makedirs(directory)
        gitconfig = os.path.join(self.root, "gitconfig")
        with open(gitconfig, "w") as stream:
            stream.write(GIT_CONFIG)
        self.gh_log = os.path.join(self.root, "gh.log")
        self.gh_response = os.path.join(self.root, "gh.json")
        gh_stub = os.path.join(self.root, "gh")
        with open(gh_stub, "w") as stream:
            stream.write(GH_STUB)
        os.chmod(gh_stub, 0o755)
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": self.home, "LC_ALL": "C",
            "KEEL_DATA_DIR": self.data, "KEEL_OVERLAY_DIR": self.overlay, "KEEL_HOME": KEEL_HOME,
            "GIT_CONFIG_GLOBAL": gitconfig, "GIT_CONFIG_NOSYSTEM": "1", "KEEL_GH": gh_stub,
            "KEEL_TEST_GH_LOG": self.gh_log, "KEEL_TEST_GH_RESPONSE": self.gh_response,
        }
        assert self.env["KEEL_DATA_DIR"].startswith(self.root + os.sep), "KEEL_DATA_DIR must be inside the temp dir"
        self.registry(DEFAULT_REGISTRY if registry is None else registry)
        self.risk_rules(DEFAULT_RULES if rules is None else rules)

    # --- overlay data ---

    def registry(self, rows: List[str]) -> None:
        """Rows with a sixth cell write the optional `push_approval` column."""
        header = REGISTRY_HEADER
        if any(row.count("\t") == REGISTRY_HEADER.count("\t") + 1 for row in rows):
            header += "\t" + REGISTRY_OPTIONAL_COLUMN
            rows = [row if row.count("\t") == header.count("\t") else row + "\tfalse" for row in rows]
        self._write_tsv("gated-repos.tsv", header, rows)

    def stub_claude(self) -> None:
        """A `claude --version` on PATH for contract-miss lines, so no test runs the real binary."""
        stubs = os.path.join(self.root, "stubs")
        os.makedirs(stubs, exist_ok=True)
        path = os.path.join(stubs, "claude")
        with open(path, "w") as stream:
            stream.write(CLAUDE_STUB)
        os.chmod(path, 0o755)
        self.env["PATH"] = stubs + os.pathsep + self.env["PATH"]

    def risk_rules(self, rows: List[str]) -> None:
        self._write_tsv("risk-rules.tsv", "set\tpath_glob\tclass", rows)

    def remove_registry(self) -> None:
        os.unlink(os.path.join(self.overlay, "gated-repos.tsv"))

    def make_logs_unwritable(self) -> None:
        """No hook run may precede this: an existing keel-fires.jsonl would still take appends."""
        logs = os.path.join(self.data, "logs")
        os.makedirs(logs, exist_ok=True)
        self.case.addCleanup(os.chmod, logs, 0o700)
        os.chmod(logs, 0o500)

    def _write_tsv(self, name: str, header: str, rows: List[str]) -> None:
        with open(os.path.join(self.overlay, name), "w") as stream:
            stream.write("\n".join([header] + rows) + "\n")

    # --- repos ---

    def remote(self, owner: str, repo: str) -> str:
        path = os.path.join(self.remotes, owner, repo + ".git")
        if not os.path.isdir(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            subprocess.run(["git", "init", "-q", "--bare", path], check=True, env=self.env)
        return path

    def clone(self, owner: str, repo: str, name: Optional[str] = None, seed: Optional[Dict[str, str]] = None) -> Repo:
        """A clone with `main` seeded on the remote (first clone seeds it), fetched so FETCH_HEAD is fresh."""
        remote = self.remote(owner, repo)
        path = os.path.join(self.root, "repos", name or repo)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        subprocess.run(["git", "clone", "-q", remote, path], check=True, env=self.env, capture_output=True)
        clone = Repo(self, path, "%s/%s" % (owner, repo))
        if not clone.git("ls-remote", "--heads", "origin", "main"):
            clone.git("checkout", "-q", "-b", "main")
            clone.commit(seed or {"README.md": "seed\n", "src/app.py": "print('seed')\n"}, "seed")
            clone.git("push", "-q", "-u", "origin", "main")
        clone.git("fetch", "-q", "origin")
        return clone

    def clone_with_submodule(self) -> "tuple[Repo, Repo]":
        """Parent acme/platform holding submodule acme/lib at `lib`; both pushed to their remotes."""
        lib = self.clone("acme", "lib", seed={"lib.py": "LIB = 1\n"})
        parent = self.clone("acme", "platform", seed={"README.md": "platform\n"})
        parent.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", self.remote("acme", "lib"), "lib")
        parent.git("commit", "-q", "-m", "add lib submodule")
        parent.git("push", "-q", "origin", "main")
        parent.git("fetch", "-q", "origin")
        submodule = Repo(self, os.path.join(parent.path, "lib"), "acme/lib")
        submodule.git("fetch", "-q", "origin")
        return parent, submodule

    # --- running keel and the hook ---

    def hook(self, payload: dict, extra_env: Optional[Dict[str, str]] = None) -> Run:
        return self.hook_raw(json.dumps(payload), extra_env)

    def hook_raw(self, stdin: str, extra_env: Optional[Dict[str, str]] = None) -> Run:
        env = dict(self.env, **(extra_env or {}))
        completed = subprocess.run([sys.executable, SHIP_GATE], input=stdin, capture_output=True, text=True, env=env)
        return Run(completed.returncode, completed.stdout, completed.stderr)

    def keel(self, *args: str, cwd: Optional[str] = None, stdin: Optional[str] = None) -> Run:
        completed = subprocess.run([sys.executable, KEEL] + list(args), input=stdin, capture_output=True, text=True,
                                   env=self.env, cwd=cwd or self.root)
        return Run(completed.returncode, completed.stdout, completed.stderr)

    def bash_payload(self, repo: Repo, command: str, agent_id: Optional[str] = None, session: str = "s1") -> dict:
        payload = {
            "session_id": session, "transcript_path": self.main_transcript(session), "cwd": repo.path,
            "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": command}, "tool_use_id": "tu1",
        }
        if agent_id:
            payload["agent_id"] = agent_id
            payload["agent_type"] = "general-purpose"
        return payload

    def push(self, repo: Repo, command: str = "git push origin HEAD", **kwargs) -> Run:
        return self.hook(self.bash_payload(repo, command, **kwargs))

    def fires(self, rule_id: Optional[str] = None, outcome: Optional[str] = None) -> List[dict]:
        path = os.path.join(self.data, "logs", "keel-fires.jsonl")
        if not os.path.isfile(path):
            return []
        with open(path) as stream:
            lines = [json.loads(line) for line in stream if line.strip()]
        return [line for line in lines if (rule_id is None or line["rule_id"] == rule_id)
                and (outcome is None or line["outcome"] == outcome)]

    def evidence_files(self, kind: str) -> List[str]:
        found = []
        root = os.path.join(self.data, "state", "keel", "evidence", kind)
        for directory, _dirs, files in os.walk(root):
            found += [os.path.join(directory, name) for name in files if name.endswith(".json")]
        return sorted(found)

    # --- evidence ---

    def main_transcript(self, session: str = "s1") -> str:
        path = os.path.join(self.data, "projects", "proj", session + ".jsonl")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "a").close()
        return path

    def agent_transcript(self, session: str = "s1", agent_id: str = "ag1", subdir: str = "") -> str:
        path = os.path.join(self.data, "projects", "proj", session, "subagents", subdir, "agent-%s.jsonl" % agent_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "a").close()
        return path

    def review_request(self, repo: Repo, run_id: str = "rv-root-0001", root_run_id: Optional[str] = None,
                       since: Optional[str] = None, verdict: str = "PASS", kind: str = "lens-review",
                       head: Optional[str] = None, review_base: Optional[str] = None, agent_id: str = "ag1",
                       session: str = "s1", base_branch: str = "origin/main",
                       no_test_reason: Optional[str] = None) -> dict:
        snapshot = None if head else self.keel("snapshot", repo.path).json["tree"]
        keel_evidence = {
            "v": 1, "repo_root": repo.path,
            "review_base": review_base or repo.git("merge-base", base_branch, head or "HEAD"),
            "head": head, "snapshot_tree": snapshot, "since": since, "run_id": run_id,
            "root_run_id": root_run_id or run_id, "review_kind": kind,
        }
        if no_test_reason is not None:
            keel_evidence["no_test_reason"] = no_test_reason
        return {
            "keel_evidence": keel_evidence,
            "verdict": verdict,
            "source": {
                "session_id": session, "agent_id": agent_id, "agent_type": "general-purpose",
                "transcript_path": self.main_transcript(session),
                "agent_transcript_path": self.agent_transcript(session, agent_id), "via": "SubagentHandback",
            },
        }

    def review(self, repo: Repo, **kwargs) -> Run:
        run = self.keel("evidence", "write-review", stdin=json.dumps(self.review_request(repo, **kwargs)))
        if run.rc != 0:
            raise AssertionError("write-review failed (%d): %s" % (run.rc, run.stderr))
        return run

    def tests_evidence(self, repo: Repo, output: str = "Ran 3 tests") -> Run:
        run = self.keel("test", "--", "bash", "-c", "echo '%s'" % output, cwd=repo.path)
        if run.rc != 0:
            raise AssertionError("keel test failed (%d): %s" % (run.rc, run.stderr))
        return run

    def smoke_evidence(self, repo: Repo, ok: bool = True, tree: Optional[str] = None, run_id: str = "sm-0001") -> Run:
        self.smoke_line(repo, ok, tree, run_id)
        return self.keel("evidence", "write-smoke", "--repo", repo.path)

    def smoke_line(self, repo: Repo, ok: bool = True, tree: Optional[str] = None, run_id: str = "sm-0001") -> None:
        logs = os.path.join(self.data, "logs")
        os.makedirs(logs, exist_ok=True)
        line = {"ts": "2026-10-11T00:00:00Z", "run_id": run_id, "ok": ok, "count": 1, "failed": [],
                "trees": {repo.key: tree or repo.tree()}}
        with open(os.path.join(logs, "keel-smoke.jsonl"), "a") as stream:
            stream.write(json.dumps(line) + "\n")

    def approve(self, root_run_id: str) -> Run:
        run = self.keel("approve", root_run_id)
        if run.rc != 0:
            raise AssertionError("keel approve failed (%d): %s" % (run.rc, run.stderr))
        return run

    def full_bundle(self, repo: Repo, root_run_id: str = "rv-root-0001") -> None:
        """Review PASS + tests + approval for the repo's current state."""
        self.review(repo, run_id=root_run_id)
        self.tests_evidence(repo)
        self.approve(root_run_id)

    def push_bundle(self, repo: Repo, root_run_id: str = "rv-root-0001") -> None:
        """What a push needs: review PASS + tests, no approval (approval is the merge's)."""
        self.review(repo, run_id=root_run_id)
        self.tests_evidence(repo)
