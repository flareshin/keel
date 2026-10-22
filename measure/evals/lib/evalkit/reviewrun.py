"""One reviewer run: the case as a two-commit repo, `claude -p` asked to run lens-review on it, then the workflow's own record."""
from __future__ import annotations

import glob
import json
import os
import shutil
import tempfile
from dataclasses import dataclass

from evalkit.liveconfig import project_dir_for
from evalkit.reviewcases import ReviewCase
from evalkit.runner import CLAUDE_BINARY, NEUTRAL_PROJECT_NAME, UNSIGNED, project_identity, run_claude
from measurekit.gitutil import GitError, run_git

WORKFLOW = "lens-review"
COMPLETED = "completed"
ERROR_VERDICT = "ERROR"
MAX_TURNS = 20
ALLOWED_TOOLS = "Workflow,Skill,Read,Grep,Glob,Bash"
DENIED_TOOLS = "Edit,Write,NotebookEdit,WebFetch,WebSearch"


class BuildError(Exception):
    pass


@dataclass
class ReviewRun:
    stream_text: str
    workflow_record: dict | None
    exit_code: int
    timed_out: bool
    repo: str


def review_command(model: str) -> list[str]:
    """Hooks stay on: keel's git-guard refuses a child claude that switches them off, and production reviews run with them."""
    return [
        CLAUDE_BINARY, "-p", "--model", model, "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
        "--allowedTools", ALLOWED_TOOLS, "--disallowedTools", DENIED_TOOLS, "--max-turns", str(MAX_TURNS),
    ]


def review_prompt(case: ReviewCase, repo: str, base: str, head: str) -> str:
    workflow_args = {"diffs": [{"repo": repo, "base": base, "head": head}]}
    if case.requirement:
        workflow_args["requirement"] = case.requirement
    lines = ["Run the saved workflow named %s with these args (JSON):" % WORKFLOW, json.dumps(workflow_args)]
    if case.caller_skill:
        lines.append("Before running it, load the skill %s and follow it for this diff: pass the lenses it says fire as args.lenses." % case.caller_skill)
    lines.append("I explicitly ask you to run this workflow. Wait until it completes, then reply with the first line of its report. Do not edit any file.")
    return "\n".join(lines)


def build_case_repo(case: ReviewCase, parent: str) -> tuple[str, str, str]:
    """`<parent>/app` holding the case's base tree as one commit and its change as the next; returns (repo, base, head)."""
    repo = os.path.join(parent, NEUTRAL_PROJECT_NAME)
    if os.path.isdir(case.base_dir):
        shutil.copytree(case.base_dir, repo)
    else:
        os.makedirs(repo)
    identity = project_identity(NEUTRAL_PROJECT_NAME)
    try:
        run_git(repo, ["init", "-q"])
        run_git(repo, ["add", "-A"])
        run_git(repo, UNSIGNED + ["commit", "-q", "--allow-empty", "-m", "base"], extra_env=identity)
        run_git(repo, ["apply", "--whitespace=nowarn", case.change_path])
        run_git(repo, ["add", "-A"])
        run_git(repo, UNSIGNED + ["commit", "-q", "-m", "change"], extra_env=identity)
        base, head = run_git(repo, ["rev-parse", "HEAD~1", "HEAD"]).split()
    except GitError as error:
        raise BuildError("%s: %s" % (case.id, error))
    missing = [str(location) for location in case.locations if not _has_line(repo, location.file, location.line)]
    if missing:
        raise BuildError("%s: no such line after the change: %s" % (case.id, ", ".join(missing)))
    return repo, base, head


def _has_line(repo: str, relative_path: str, line: int) -> bool:
    try:
        with open(os.path.join(repo, relative_path), encoding="utf-8") as handle:
            return sum(1 for _ in handle) >= line
    except (OSError, UnicodeDecodeError):
        return False


def run_review(case: ReviewCase, command: list[str], config_dir: str, timeout_seconds: int) -> ReviewRun:
    parent = os.path.realpath(tempfile.mkdtemp())
    try:
        repo, base, head = build_case_repo(case, parent)
        prompt = review_prompt(case, repo, base, head)
        exit_code, timed_out, stream_text = run_claude(command, prompt, repo, timeout_seconds)
        project_dir = project_dir_for(repo, config_dir)
        record = find_workflow_record(project_dir, session_id_of(stream_text))
        shutil.rmtree(project_dir, ignore_errors=True)
        return ReviewRun(stream_text, record, exit_code, timed_out, repo)
    finally:
        shutil.rmtree(parent, ignore_errors=True)


def session_id_of(stream_text: str) -> str | None:
    for line in stream_text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "system" and event.get("subtype") == "init":
            return event.get("session_id")
    return None


def find_workflow_record(project_dir: str, session_id: str | None) -> dict | None:
    """The session's last lens-review record, by its start time; None when the session ran none or left no id."""
    if not session_id:
        return None
    records = []
    for path in glob.glob(os.path.join(project_dir, session_id, "workflows", "*.json")):
        try:
            with open(path, encoding="utf-8") as handle:
                record = json.load(handle)
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("workflowName") == WORKFLOW:
            records.append(record)
    return max(records, key=lambda record: record.get("startTime") or 0, default=None)


def run_fault(run: ReviewRun, timeout_seconds: int) -> str | None:
    """Why a run measures nothing; such a run is never counted as a miss or as noise."""
    if run.timed_out:
        return "timed out after %ds" % timeout_seconds
    record = run.workflow_record
    if record is None:
        return "no %s workflow record for the session (exit %d)" % (WORKFLOW, run.exit_code)
    if record.get("status") != COMPLETED:
        return "%s workflow status %r" % (WORKFLOW, record.get("status"))
    result = record.get("result")
    if not isinstance(result, dict) or result.get("verdict") in (None, ERROR_VERDICT):
        return "%s returned no verdict: %s" % (WORKFLOW, str((result or {}).get("error") if isinstance(result, dict) else result)[:200])
    if not isinstance(result.get("blocking"), list):
        return "%s result has no blocking list" % WORKFLOW
    return None
