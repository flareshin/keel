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
from evalkit.stream import summarize_stream
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
        record = find_workflow_record(project_dir, (summarize_stream(stream_text.splitlines()).init or {}).get("session_id"))
        shutil.rmtree(project_dir, ignore_errors=True)
        return ReviewRun(stream_text, record, exit_code, timed_out, repo)
    finally:
        shutil.rmtree(parent, ignore_errors=True)


def find_workflow_record(project_dir: str, session_id: str | None) -> dict | None:
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
