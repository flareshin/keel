"""One run: a fresh copy of the fixture under git, `claude -p` fed the prompt, then what the run left behind."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

from evalkit.grade import QUESTION_MARKER
from evalkit.liveconfig import project_dir_for
from evalkit.stream import RunFacts, summarize_stream
from measurekit.gitutil import run_git

CLAUDE_BINARY = "claude"
MAX_TURNS = 8
ALLOWED_TOOLS = "Skill,Read,Grep,Glob,Edit,Write,AskUserQuestion"
DENIED_TOOLS = "Bash,NotebookEdit,Agent,Task,Workflow,WebFetch,WebSearch"
TIMEOUT_EXIT = 124  # what GNU timeout would have reported; kept in the raw record only
UNSIGNED = ["-c", "commit.gpgsign=false"]
NEUTRAL_PROJECT_NAME = "app"
HARNESS_WORDS = ("eval", "test", "judge", "fixture", "keel", "candidate")
README_TITLE = re.compile(r"^#[ \t]+(.+)$", re.MULTILINE)
NON_SLUG_CHARS = re.compile(r"[^a-z0-9]+")
OUTSIDE_FIXTURE = [".", ":!.claude"]  # the CLI may write .claude/ into its cwd; that is not the model changing files
QUESTION_PROTOCOL = ("This session is non-interactive and the AskUserQuestion tool is unavailable. To ask the user something, "
                     "write each question on its own line starting with \"%s\"." % QUESTION_MARKER)


@dataclass
class RunRecord:
    facts: RunFacts
    stream_text: str
    diff: str


def claude_command(model: str) -> list[str]:
    return [
        CLAUDE_BINARY, "-p", "--model", model, "--output-format", "stream-json", "--verbose",
        "--settings", '{"disableAllHooks":true}',
        "--tools", ALLOWED_TOOLS, "--disallowedTools", DENIED_TOOLS,
        "--permission-mode", "acceptEdits", "--strict-mcp-config",
        "--max-turns", str(MAX_TURNS), "--no-session-persistence", "--append-system-prompt", QUESTION_PROTOCOL,
    ]


def run_once(prompt: str, fixture: str, command: list[str], config_dir: str, timeout_seconds: int) -> RunRecord:
    project = resolve_project_name(fixture)
    parent = tempfile.mkdtemp()
    work = os.path.join(parent, project)
    try:
        _prepare_fixture_repo(fixture, work, project)
        exit_code, timed_out, stream_text = run_claude(command, prompt, work, timeout_seconds)
        changed = bool(run_git(work, ["status", "--porcelain", "--"] + OUTSIDE_FIXTURE).strip())
        leftover = project_dir_for(work, config_dir)
        facts = RunFacts(
            stream=summarize_stream(stream_text.splitlines()), exit_code=exit_code, timed_out=timed_out,
            changed=changed, leftover_project_dir=leftover if os.path.isdir(leftover) else None,
        )
        return RunRecord(facts, stream_text, _diff_of_changes(work))
    finally:
        shutil.rmtree(parent, ignore_errors=True)


def resolve_project_name(fixture: str) -> str:
    """The README's first `# ` title as a folder name; NEUTRAL_PROJECT_NAME when there is none or it holds a HARNESS_WORDS entry.

    The session sees its cwd and git identity, so neither may tell it that it is being graded.
    """
    slug = NON_SLUG_CHARS.sub("-", _readme_title(fixture).lower()).strip("-")
    if not slug or any(word in slug for word in HARNESS_WORDS):
        return NEUTRAL_PROJECT_NAME
    return slug


def _readme_title(fixture: str) -> str:
    try:
        with open(os.path.join(fixture, "README.md"), encoding="utf-8") as handle:
            match = README_TITLE.search(handle.read())
    except (OSError, UnicodeDecodeError):
        return ""
    return match.group(1) if match else ""


def _prepare_fixture_repo(fixture: str, work: str, project: str) -> None:
    shutil.copytree(fixture, work)
    run_git(work, ["init", "-q"])
    run_git(work, ["add", "-A"])
    run_git(work, UNSIGNED + ["commit", "-q", "-m", "init"], extra_env=project_identity(project))


def project_identity(project: str) -> dict[str, str]:
    """Set through the environment, not `-c user.*`: a host GIT_AUTHOR_* or GIT_COMMITTER_* would override config."""
    name, email = project, "dev@%s.invalid" % project
    return {"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email, "GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": email}


def run_claude(command: list[str], prompt: str, cwd: str, timeout_seconds: int) -> tuple[int, bool, str]:
    env = {**os.environ, "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}
    try:
        completed = subprocess.run(command, input=prompt + "\n", capture_output=True, text=True, cwd=cwd, env=env, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as expired:
        return TIMEOUT_EXIT, True, _as_text(expired.stdout)
    return completed.returncode, False, completed.stdout


def _as_text(partial_output: bytes | str | None) -> str:
    """TimeoutExpired carries the partial stdout as bytes even in text mode."""
    if partial_output is None:
        return ""
    return partial_output.decode("utf-8", "replace") if isinstance(partial_output, bytes) else partial_output


def _diff_of_changes(work: str) -> str:
    run_git(work, ["add", "-A", "--"] + OUTSIDE_FIXTURE)
    return run_git(work, ["diff", "--cached"])
