"""Smoke checks over files around the ledger: size caps, [ID] tagging, fires log, boundary, links."""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import tempfile

from measurekit.boundary import BoundaryUsageError, file_lines, load_rules, scan
from measurekit.datafiles import TsvError, read_jsonl, read_tsv_records
from measurekit.gitutil import GitError, is_git_repo, run_git
from measurekit.hook_settings import iter_registrations
from measurekit.metrics import FAIL, PASS, WARN, stderr_excerpt
from measurekit.smoke_context import SmokeContext, assertion, first_items

HOOK_SCRIPT_CAP = 8
MEMORY_INDEX_CAP_BYTES = 8192
K5_SUBCHECK_IDS = {"K5.%d" % number for number in range(1, 17)}
BULLET = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+")
ID_TAG = re.compile(r"^\[([A-Za-z0-9.-]+)\]")
# `## Rules`, `## Rules (hard)`, `## Rules:`; not `## Rule list`, which names no rules section.
RULES_HEADING_PATTERN = r"(?i)^##\s+Rules\b"
RULES_HEADING = re.compile(RULES_HEADING_PATTERN)
FENCE = "```"
LINKED_DIRS = ("skills", "commands", "agents", "workflows", "bin", "mcp")
REPO_RULES_HEADER = ("origin_glob", "action", "pattern", "rule_id", "message")
LINK_CHECK_TIMEOUT_SECONDS = 60
# What bin/link's plan reports for any valid checkout when KEEL_DATA_DIR is empty (lib/link/plan.py).
EMPTY_DATA_DIR_KINDS = frozenset({"link-missing", "copy-missing", "settings-drift"})
EMPTY_DATA_DIR_CLAUDE_MD = ("claude-md-drift", "generated CLAUDE.md is missing")


def check_file_caps(ctx: SmokeContext) -> list[dict]:
    return [_hook_script_cap(ctx), _memory_index_cap(ctx)]


def _hook_script_cap(ctx: SmokeContext) -> dict:
    settings_path = os.path.join(ctx.data_dir, "settings.json")
    if not os.path.isfile(settings_path):
        return assertion("caps", "hook-scripts", PASS, "no settings.json")
    try:
        with open(settings_path, encoding="utf-8") as handle:
            hooks = json.load(handle).get("hooks", {})
    except (ValueError, AttributeError) as error:
        return assertion("caps", "hook-scripts", FAIL, "settings.json unreadable: %s" % error)
    scripts = sorted({registration.script for registration in iter_registrations(hooks)})
    status = PASS if len(scripts) <= HOOK_SCRIPT_CAP else FAIL
    return assertion("caps", "hook-scripts", status, "%d/%d: %s" % (len(scripts), HOOK_SCRIPT_CAP, first_items(scripts, 10)))


def _memory_index_cap(ctx: SmokeContext) -> dict:
    indexes = ctx.memory_indexes()
    oversized = ["%s %d bytes" % (path, os.path.getsize(path)) for path in indexes if os.path.getsize(path) > MEMORY_INDEX_CAP_BYTES]
    if not oversized:
        return assertion("caps", "memory-index", PASS, "%d indexes within %d bytes" % (len(indexes), MEMORY_INDEX_CAP_BYTES))
    return assertion("caps", "memory-index", WARN, "over %d bytes: %s" % (MEMORY_INDEX_CAP_BYTES, first_items(oversized)))


def check_id_tagging(ctx: SmokeContext) -> list[dict]:
    known_ids = {row.id for row in ctx.counted_rows} | K5_SUBCHECK_IDS
    results = [
        _tagging_assertion("principles", os.path.join(ctx.keel_home, "PRINCIPLES.md"), known_ids, False, WARN),
        _tagging_assertion("personal", os.path.join(ctx.overlay_dir, "PERSONAL.md"), known_ids, False, PASS),
    ]
    skill_paths = []
    for root, prefix in ((ctx.keel_home, "skill:"), (ctx.overlay_dir, "skill:overlay/")):
        for path in sorted(glob.glob(os.path.join(root, "skills", "*", "SKILL.md"))):
            skill_paths.append(path)
            results.append(_tagging_assertion(prefix + os.path.basename(os.path.dirname(path)), path, known_ids, True, PASS))
    results.append(_skill_rules_total(skill_paths))
    return results


def _tagging_assertion(scope: str, path: str, known_ids: set[str], rules_section_only: bool, status_when_absent: str) -> dict:
    if not os.path.isfile(path):
        return assertion("id-tagging", scope, status_when_absent, "absent: %s" % path)
    checked = _checked_lines(path, rules_section_only)
    problems = [problem for problem in (_tag_problem(number, line, known_ids) for number, line in checked) if problem]
    if problems:
        return assertion("id-tagging", scope, FAIL, first_items(problems))
    return assertion("id-tagging", scope, PASS, "%d lines checked" % len(checked))


def _skill_rules_total(skill_paths: list[str]) -> dict:
    """Each skill passes on its own with no rules section; zero rule bullets across all of them means the check saw nothing."""
    bullets = sum(1 for path in skill_paths for _, line in _checked_lines(path, True) if BULLET.match(line))
    status = PASS if bullets else FAIL
    return assertion("id-tagging", "skills", status, "%d rule bullets across %d skills" % (bullets, len(skill_paths)))


def _checked_lines(path: str, rules_section_only: bool) -> list[tuple[int, str]]:
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    numbered = _rules_section(lines) if rules_section_only else list(enumerate(lines, start=1))
    return _outside_fences(numbered)


def _rules_section(lines: list[str]) -> list[tuple[int, str]]:
    """Lines after `## Rules` up to the next `## ` heading."""
    section, inside = [], False
    for number, line in enumerate(lines, start=1):
        if RULES_HEADING.match(line):
            inside = True
        elif line.startswith("## "):
            inside = False
        elif inside:
            section.append((number, line))
    return section


def _outside_fences(numbered: list[tuple[int, str]]) -> list[tuple[int, str]]:
    kept, in_fence = [], False
    for number, line in numbered:
        if line.lstrip().startswith(FENCE):
            in_fence = not in_fence
        elif not in_fence:
            kept.append((number, line))
    return kept


def _tag_problem(number: int, line: str, known_ids: set[str]) -> str | None:
    bullet = BULLET.match(line)
    if not bullet:
        return None
    tag = ID_TAG.match(line[bullet.end():])
    if not tag:
        return "line %d: bullet without [ID]" % number
    if tag.group(1) not in known_ids:
        return "line %d: unknown id [%s]" % (number, tag.group(1))
    return None


def check_fires_rule_ids(ctx: SmokeContext) -> list[dict]:
    records, _ = read_jsonl(os.path.join(ctx.data_dir, "logs", "keel-fires.jsonl"))
    try:
        valid_ids = {row.id for row in ctx.rows} | _repo_rule_ids(ctx.overlay_dir)
    except (OSError, TsvError) as error:
        return [assertion("fires-rule-ids", "all", FAIL, "git-guard/repo-rules.tsv unreadable: %s" % error)]
    unknown = sorted({str(record.get("rule_id")) for record in records if record.get("rule_id") not in valid_ids})
    if unknown:
        return [assertion("fires-rule-ids", "all", FAIL, "unknown rule_ids: " + ", ".join(unknown))]
    return [assertion("fires-rule-ids", "all", PASS, "%d fires lines" % len(records))]


def _repo_rule_ids(overlay_dir: str) -> set[str]:
    path = os.path.join(overlay_dir, "git-guard", "repo-rules.tsv")
    if not os.path.isfile(path):
        return set()
    return {record["rule_id"] for record in read_tsv_records(path, REPO_RULES_HEADER)}


def check_boundary(ctx: SmokeContext) -> list[dict]:
    if not is_git_repo(ctx.keel_home):
        return [assertion("boundary", "keel", FAIL, "KEEL_HOME is not a git checkout: %s" % ctx.keel_home)]
    lexicon_present = os.path.isfile(os.path.join(ctx.overlay_dir, "boundary", "lexicon.txt"))
    try:
        rules = load_rules(ctx.overlay_dir, generic_only=not lexicon_present)
        tracked = [path for path in run_git(ctx.keel_home, ["ls-files", "-z"]).split("\0") if path]
    except (BoundaryUsageError, GitError) as error:
        return [assertion("boundary", "keel", FAIL, str(error))]
    result = scan(file_lines(ctx.keel_home, tracked), rules)
    if result["hits"]:
        hits = ["%s:%d %s" % (hit["file"], hit["line"], hit["rule"]) for hit in result["hits"]]
        return [assertion("boundary", "keel", FAIL, "%d hits: %s" % (len(hits), first_items(hits)))]
    if not lexicon_present:
        return [assertion("boundary", "keel", FAIL, "overlay lexicon absent; generic rules only over %d lines" % result["scanned"])]
    return [assertion("boundary", "keel", PASS, "%d lines in %d tracked files" % (result["scanned"], len(tracked)))]


def check_link_integrity(ctx: SmokeContext) -> list[dict]:
    tool = os.environ.get("KEEL_LINK") or os.path.join(ctx.keel_home, "bin", "link")
    if not os.access(tool, os.X_OK):
        return [assertion("link-integrity", "all", FAIL, "link tool not executable: %s" % tool)]
    if ctx.candidate:
        return [_check_candidate_link_plan(tool, ctx)]
    try:
        completed = subprocess.run([tool, "--check"], capture_output=True, text=True, timeout=LINK_CHECK_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        return [assertion("link-integrity", "all", FAIL, "link --check could not run: %s" % error)]
    if completed.returncode == 0:
        return [assertion("link-integrity", "all", PASS, "link --check clean")]
    return [assertion("link-integrity", "all", FAIL, _describe_link_problems(completed))]


def _describe_link_problems(completed: subprocess.CompletedProcess) -> str:
    try:
        problems = json.loads(completed.stdout).get("problems", [])
    except (ValueError, AttributeError):
        return "link --check exited %d: %s" % (completed.returncode, stderr_excerpt(completed))
    described = ["%s %s" % (problem.get("kind"), problem.get("path")) for problem in problems if isinstance(problem, dict)]
    return "link --check exited %d: %s" % (completed.returncode, first_items(described) or "no problems listed")


def _check_candidate_link_plan(tool: str, ctx: SmokeContext) -> dict:
    """The link dry run against a fresh empty data dir, so the live dir's links and drift do not count against the candidate."""
    with tempfile.TemporaryDirectory(prefix="keel-smoke-candidate-") as empty_data_dir:
        link_env = dict(os.environ, KEEL_HOME=ctx.keel_home, KEEL_OVERLAY_DIR=ctx.overlay_dir, KEEL_DATA_DIR=empty_data_dir)
        try:
            completed = subprocess.run([tool], capture_output=True, text=True, timeout=LINK_CHECK_TIMEOUT_SECONDS, env=link_env)
        except (OSError, subprocess.TimeoutExpired) as error:
            return assertion("link-integrity", "all", FAIL, "link dry run could not run: %s" % error)
    problems = _dry_run_problems(completed)
    if problems is None:
        return assertion("link-integrity", "all", FAIL, "link dry run exited %d: %s" % (completed.returncode, stderr_excerpt(completed)))
    unexpected = ["%s: %s" % (problem.get("kind"), problem.get("detail")) for problem in problems if not _is_empty_data_dir_problem(problem)]
    if unexpected:
        return assertion("link-integrity", "all", FAIL, "candidate link plan: %s" % first_items(unexpected))
    return assertion("link-integrity", "all", PASS, "candidate link plan clean against an empty data dir")


def _dry_run_problems(completed: subprocess.CompletedProcess) -> list[dict] | None:
    """The problems a successful dry run printed; None when it was refused, crashed or printed no problem list."""
    if completed.returncode != 0:
        return None
    try:
        problems = json.loads(completed.stdout)["problems"]
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(problems, list) or not all(isinstance(problem, dict) for problem in problems):
        return None
    return problems


def _is_empty_data_dir_problem(problem: dict) -> bool:
    kind = problem.get("kind")
    return kind in EMPTY_DATA_DIR_KINDS or (kind, problem.get("detail")) == EMPTY_DATA_DIR_CLAUDE_MD


def check_dangling(ctx: SmokeContext) -> list[dict]:
    dangling = []
    for name in LINKED_DIRS:
        dangling += _dangling_links(ctx.data_dir, os.path.join(ctx.data_dir, name))
    if dangling:
        return [assertion("dangling", "data", FAIL, "%d dangling links: %s" % (len(dangling), first_items(dangling)))]
    return [assertion("dangling", "data", PASS, "no dangling links under %s" % ", ".join(LINKED_DIRS))]


def _dangling_links(data_dir: str, top: str) -> list[str]:
    if os.path.islink(top):
        return [] if os.path.exists(top) else [os.path.relpath(top, data_dir)]
    found = []
    for current, dir_names, file_names in os.walk(top):
        for name in sorted(dir_names + file_names):
            path = os.path.join(current, name)
            if os.path.islink(path) and not os.path.exists(path):
                found.append(os.path.relpath(path, data_dir))
    return found

