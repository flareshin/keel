import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

KEEL_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
LINK_BIN = os.path.join(KEEL_ROOT, "bin", "link")
EXAMPLES = os.path.join(KEEL_ROOT, "examples", "link")
sys.path.insert(0, os.path.join(KEEL_ROOT, "lib"))
sys.path.insert(0, os.path.join(KEEL_ROOT, "measure", "lib"))

PRINCIPLES = "# Principles\n\n- [K1] Review before shipping.\n"
CORE_LINKS = "source\ttarget\n{{KEEL}}/skills/demo\tskills/demo\n{{KEEL}}/bin/keel\tbin/keel\n"
CORE_SETTINGS = {
    "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 {{KEEL}}/hooks/demo.py"}]}]},
    "permissions": {"deny": ["Bash(git push --force:*)"]},
}


class LinkSandbox:
    """A temp HOME with a fake keel checkout, an overlay copied from examples/link, and an empty data dir."""

    def __init__(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="keel-link-test-"))
        self.keel = os.path.join(self.root, "keel")
        self.overlay = os.path.join(self.root, "overlay")
        self.data = os.path.join(self.root, "data")
        self.home = os.path.join(self.root, "home")
        os.makedirs(self.data)
        os.makedirs(self.home)
        shutil.copytree(EXAMPLES, self.overlay)
        self.write_keel("PRINCIPLES.md", PRINCIPLES)
        self.write_keel("settings/links.tsv", CORE_LINKS)
        self.write_keel("settings/core.json", json.dumps(CORE_SETTINGS))
        self.write_keel("skills/demo/SKILL.md", "# demo\n")
        self.write_keel("bin/keel", "#!/bin/sh\n")
        with open(os.path.join(self.root, "gitconfig"), "w") as f:
            f.write("[user]\n\tname = Test\n\temail = test@example.com\n")
        self.git(self.keel, "init", "-q")

    def env(self):
        env = dict(os.environ)
        env.update(
            KEEL_HOME=self.keel,
            KEEL_OVERLAY_DIR=self.overlay,
            KEEL_DATA_DIR=self.data,
            HOME=self.home,
            GIT_CONFIG_GLOBAL=os.path.join(self.root, "gitconfig"),
            GIT_CONFIG_NOSYSTEM="1",
        )
        assert env["KEEL_DATA_DIR"].startswith(self.root + os.sep), "KEEL_DATA_DIR must stay inside the temp dir"
        return env

    def run_link(self, *args):
        result = subprocess.run([LINK_BIN, *args], env=self.env(), capture_output=True, text=True)
        result.json = json.loads(result.stdout) if result.stdout.strip() else None
        return result

    def git(self, cwd, *args):
        return subprocess.run(["git", "-C", cwd, *args], env=self.env(), capture_output=True, text=True, check=True).stdout

    def write_keel(self, relative, text):
        _write(os.path.join(self.keel, relative), text)

    def write_overlay(self, relative, text):
        _write(os.path.join(self.overlay, relative), text)

    def write_data(self, relative, text):
        _write(os.path.join(self.data, relative), text)

    def data_path(self, relative):
        return os.path.join(self.data, relative)

    def read_data(self, relative):
        with open(self.data_path(relative), encoding="utf-8", newline="") as f:
            return f.read()

    def remove(self):
        shutil.rmtree(self.root)


class LinkTestCase(unittest.TestCase):
    def setUp(self):
        self.box = LinkSandbox()
        self.addCleanup(self.box.remove)

    def assertExit(self, result, code):
        self.assertEqual(result.returncode, code, f"stdout={result.stdout}\nstderr={result.stderr}")

    def problem_kinds(self, result):
        return sorted(problem["kind"] for problem in result.json["problems"])

    def ops(self, result):
        return sorted(action["op"] for action in result.json["actions"])

    def listed_drops(self, result):
        prefix = "link: adopt drops: "
        return sorted(line[len(prefix):] for line in result.stderr.splitlines() if line.startswith(prefix))

    def write_adopting_every_drop(self):
        """--write --adopt, accepting exactly the drops a first --adopt run lists."""
        drops = self.listed_drops(self.box.run_link("--write", "--adopt"))
        accepted = os.path.join(self.box.root, "accept-all.txt")
        with open(accepted, "w", encoding="utf-8") as f:
            f.write("".join(drop + "\n" for drop in drops))
        return self.box.run_link("--write", "--adopt", "--accept-drops", accepted)

    def only_backup(self, relative):
        """The single copy of `relative` that --write --force moved aside."""
        found = glob.glob(os.path.join(self.box.data, "state", "keel", "link-backup", "*", relative))
        self.assertEqual(len(found), 1, found)
        return found[0]


def read_file(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
