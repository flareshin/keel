#!/usr/bin/env python3
"""ship-gate hook: holds `git push` and `gh pr merge` until one evidence bundle covers the change.

PreToolUse[Bash]: push and merge verdicts, merge preflight, `gh pr create` warning.
Every other event passes.
Fail-closed (DESIGN 5.7): an error while judging a push or merge in a gated repo or, while any repo is
gated, before its repo is known; a push or merge the parser cannot pin to one repo and branch; and a crash
while a push or merge may be on the table all deny.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import time
from typing import List, NamedTuple, Optional, Tuple

HERE = os.path.dirname(os.path.realpath(__file__))
KEEL_HOME = os.environ.get("KEEL_HOME") or os.path.dirname(os.path.dirname(HERE))
sys.path[:0] = [os.path.join(KEEL_HOME, "hooks", "lib"), os.path.join(KEEL_HOME, "lib")]

from hookkit import contract, protocol, shell  # noqa: E402
from evidence import env, gc, gitcmd, registry, verify  # noqa: E402
from evidence.registry import GatedRepo  # noqa: E402
from evidence.verify import K1, RISK, Decision, Outgoing, Reason  # noqa: E402

HOOK = "ship-gate"
FIRES_DETAIL_LIMIT = 200
F_IRREVERSIBLE = "F-irreversible"
DECISION_HINT = re.compile(r"\b(git|gh|push|merge)\b")
SPELLED_PUSH_OR_MERGE = re.compile(r"\bgit\s+push\b|\bgh\s+pr\s+merge\b|/pulls/\d+/merge\b")
PUSH_OR_MERGE_WORD = re.compile(r"\b(push|merge)\b")
PUSH_OR_MERGE_WORDS = {"push", "merge"}
PUSH_OR_MERGE_WITHOUT_THE_WORD = re.compile(r"\bsend-pack\b|/merges\b|\bgit/refs\b")
PUSHES_OUTSIDE_GIT_PUSH = {"send-pack", "http-push"}  # git plumbing that updates a remote's refs
QUOTING = re.compile(r"""['"\\]""")
PULL_URL = re.compile(r"^https?://[^/]+/([^/]+/[^/]+)/pull/\d+")
PULL_MERGE_ENDPOINT = re.compile(r"/pulls/\d+/merge/?$")
BRANCH_MERGE_ENDPOINT = re.compile(r"(?:^|/)repos/[^/]+/[^/]+/merges/?(?:\?|$)")
REF_ENDPOINT = re.compile(r"(?:^|/)repos/[^/]+/[^/]+/git/refs(?:/|\?|$)")
GRAPHQL_BRANCH_CHANGE = re.compile(r"\b(?:mergePullRequest|mergeBranch|enablePullRequestAutoMerge|createRef|updateRefs?|deleteRef)\b")
GH_API_METHOD_OPTIONS = {"-X", "--method"}
GH_API_BODY_OPTIONS = ("-f", "-F", "--field", "--raw-field", "--input")  # any of them makes gh send POST
READ_METHODS = {"GET", "HEAD"}
RUNTIME_NAME = re.compile(r"[$`]")
URL_FORM = re.compile(r"^[^/]*:")  # scheme://…, scp-like host:path, transport::address; any other word is a path
ARGV_FORWARDERS = {"xargs", "parallel", "env", "sudo", "exec", "nice", "nohup", "time", "timeout", "gtimeout", "command"}
PR_VIEW_FIELDS = "statusCheckRollup,baseRefName"
FAILED_CHECKS = {"FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "STARTUP_FAILURE", "ACTION_REQUIRED"}
PENDING_CHECKS = {"IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED", "WAITING", "REQUESTED"}
GH_TIMEOUT_SECONDS = 12
GC_INTERVAL_SECONDS = 24 * 3600
MERGE_VALUE_FLAGS = {"-A", "--author-email", "-b", "--body", "-F", "--body-file", "-t", "--subject"}
REPOINTING_OPTIONS = {"--git-dir", "--work-tree"}
REPOINTING_VARIABLES = ("GIT_DIR", "GIT_WORK_TREE")
CONFIG_OVERRIDE_OPTIONS = {"-c", "--config-env"}
GH_DEFAULT_VIEW_OPTIONS = {"-v", "--view"}
PUSH_ROUTING_SECTIONS = {"remote", "branch", "url", "push", "include", "includeif"}  # config that moves a push elsewhere
CONFIG_VARIABLE_PREFIX = "GIT_CONFIG"
REMOTE_EDITS = {"set-url", "add", "rename"}
TAG_PREFIX = "refs/tags/"
HEAD = "HEAD"


class GateError(Exception):
    """The gate cannot reach a verdict (fail-closed in a gated repo)."""


class UnclearTarget(Exception):
    """The repo a push or merge reaches cannot be named; the user runs it, with `added_words` when they name it."""

    def __init__(self, why: str, added_words: Tuple[str, ...] = ()):
        super().__init__(why)
        self.added_words = list(added_words)


class Refspec(NamedTuple):
    source: str
    destination: Optional[str]  # None: git picks the ref kind from the source, so a tag stays a tag


class Push(NamedTuple):
    workdir: str
    words: List[str]
    remote: Optional[str]  # a remote name or URL; None = the current branch's push remote
    refspecs: List[Refspec]  # empty = the current HEAD
    deletes_only: bool
    tags_only: bool  # --tags with no refspec
    whole_repo: bool  # --all / --branches / --mirror
    dry_run: bool

    @property
    def sources(self) -> List[str]:
        return [spec.source for spec in self.refspecs]


class Merge(NamedTuple):
    workdir: str
    words: List[str]
    selector: Optional[str]
    repo_flag: Optional[str]  # --repo/-R as given
    repo_env: Optional[str]  # GH_REPO= on the command
    auto: bool
    match_head: Optional[str]


class Unattributable(NamedTuple):
    """A push or merge the parser sees but cannot pin to one repo and branch; always denied."""
    workdir: str
    words: List[str]
    why: str
    user_command: Optional[str] = None  # when the words alone do not run as written (a name resolved at run time)


class PrCreate(NamedTuple):
    workdir: str
    words: List[str]


class Report:
    """Collects the verdicts of one hook call, logs each as a fires line, and prints the outcome."""

    def __init__(self, payload: dict, event: str):
        self.session = payload.get("session_id") or "-"
        self.event = event
        self.blocks: List[str] = []
        self.context: List[str] = []

    def deny(self, reasons: List[Reason], summary: str, hint: str, **where) -> None:
        self._log_each(reasons, "deny", **where)
        self.blocks.append(_message(summary, reasons, hint))

    def warn(self, reasons: List[Reason], summary: str, **where) -> None:
        self._log_each(reasons, "warn", **where)
        self.context.append(_message(summary, reasons))

    def passed(self, repo: Optional[str], **where) -> None:
        self._fire(RISK, "pass", repo=repo, **where)

    def record(self, detail: str, **where) -> None:
        self._fire(K1, "record", detail=detail, **where)

    def decide(self, decision: Decision, summary: str, hint: str, repo: str, head: str) -> None:
        where = dict(head=head, risk=decision.risk_class, root_run_id=decision.root_run_id, files=decision.files,
                     lines=decision.lines)
        if decision.ok:
            self.passed(repo, detail="K3 waived: " + decision.k3_waiver if decision.k3_waiver else None, **where)
            return
        self.deny(list(decision.reasons), "%s (risk %s)" % (summary, decision.risk_class or "none"), hint,
                  repo=repo, **where)

    def contract_miss(self, missing: List[str], payload: dict) -> None:
        self._fire(K1, contract.OUTCOME, detail=contract.miss_detail(payload, missing))

    def error(self, error: Exception, fail_closed: bool, hint: str, repo: Optional[str] = None) -> None:
        detail = "%s: %s" % (type(error).__name__, error)
        if fail_closed:
            self.blocks.append(_message("internal error; failing closed for a gated repo", [Reason(K1, detail)], hint))
        self._fire(K1, "error", repo=repo, detail=detail)

    def emit(self) -> int:
        if self.blocks:
            return protocol.deny("\n\n".join(self.blocks))
        if self.context:
            return protocol.warn(self.event, "\n".join(self.context))
        return protocol.EXIT_PASS

    def _log_each(self, reasons: List[Reason], outcome: str, **where) -> None:
        """One fires line per rule id, carrying the text of its first reason."""
        first_text = {}
        for reason in reasons:
            first_text.setdefault(reason.rule_id, reason.text)
        for rule_id, text in first_text.items():
            self._fire(rule_id, outcome, detail=text, **where)

    def _fire(self, rule_id: str, outcome: str, **where) -> None:
        line = {"ts": env.iso(env.utc_now()), "rule_id": rule_id, "hook": HOOK, "outcome": outcome,
                "session": self.session}
        line.update((key, value) for key, value in where.items() if value not in (None, ""))
        if "detail" in line:
            line["detail"] = line["detail"][:FIRES_DETAIL_LIMIT]
        env.append_log_line("keel-fires.jsonl", line)


def main() -> int:
    raw = sys.stdin.read()
    try:
        return dispatch(json.loads(raw))
    except Exception as error:
        return fail_closed(raw, error)


def dispatch(payload: dict) -> int:
    event = payload.get("hook_event_name") or ""
    tool = payload.get("tool_name")
    report = Report(payload, event)
    if event == "PreToolUse" and tool == "Bash":
        guard_bash(payload, report)
    return report.emit()


def fail_closed(raw: str, error: Exception) -> int:
    """The last resort for a crash: deny when the payload may ask for a push or merge, else pass (DESIGN 5.7)."""
    detail = "%s: %s" % (type(error).__name__, error)
    command = _bash_command_of(raw)
    if not may_push_or_merge(command):
        print("ship-gate: internal error on a command that is not a push or merge: " + detail, file=sys.stderr)
        return protocol.EXIT_PASS
    return protocol.deny(_message("internal error; failing closed", [Reason(K1, detail)], command))


def _bash_command_of(raw: str) -> str:
    """The command of a PreToolUse[Bash] payload; "" for any other event; the raw text when it is not JSON."""
    try:
        payload = json.loads(raw)
    except ValueError:
        return raw
    if not isinstance(payload, dict):
        return ""
    if payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") != "Bash":
        return ""
    return str(protocol.tool_input(payload).get("command") or "")


def guard_bash(payload: dict, report: Report) -> None:
    missing = contract.missing_fields(payload, "tool_input.command")
    if missing:
        report.contract_miss(missing, payload)
    command = str(protocol.tool_input(payload).get("command") or "")
    if not DECISION_HINT.search(command):
        return
    cwd = payload.get("cwd") or os.getcwd()
    actions = [action for step in shell.steps(command, cwd) for action in actions_of(step, command, cwd)]
    for action in actions:
        judge_action(action, report)
    if any(isinstance(action, (Push, Merge)) for action in actions):
        collect_garbage_if_due(report)


def may_push_or_merge(call: str) -> bool:
    """The crash fallback's reading of a call from its text alone, true for every call actions_of reads as a push
    or merge: a push or merge spelled anywhere, or git or gh beside a name resolved at run time (`git $S`)."""
    unquoted = _unquoted(call)
    runtime_git_or_gh = DECISION_HINT.search(unquoted) and RUNTIME_NAME.search(unquoted)
    return bool(_spells_push_or_merge(call) or runtime_git_or_gh)


def _spells_push_or_merge(call: str) -> bool:
    """A push or merge word anywhere in the call, a push or merge spelled without one (`send-pack`, a REST merges or
    git/refs endpoint), or a GraphQL merge or ref mutation."""
    unquoted = _unquoted(call)
    return bool(PUSH_OR_MERGE_WORD.search(unquoted) or PUSH_OR_MERGE_WITHOUT_THE_WORD.search(unquoted)
                or GRAPHQL_BRANCH_CHANGE.search(call))


def _unquoted(command: str) -> str:
    """Quote characters removed, so `pu''sh` and `"push"` still read as push."""
    return QUOTING.sub("", command)


def actions_of(step: shell.Step, call: str = "", call_cwd: str = "") -> list:
    """The decision points one simple command holds; wrappers are already stripped by the parser.
    `call`: the whole Bash call text, which decides whether a name the shell resolves only at run time
    (`$CMD push …`, `$(which git) push …`, `git $S …`) may be a push or merge, so is unattributable;
    `call_cwd`: the directory the call starts in, where the user runs such a call whole."""
    words, workdir = step.argv, step.directory
    if not words:
        return []
    program = os.path.basename(words[0])
    if program == "git":
        return _git_actions(step, call, call_cwd)
    if program == "gh":
        return _gh_actions(shell.gh_subcommand_argv(words), workdir, step.environment, call, call_cwd)
    if _hides_push_or_merge(step.command.name, words):
        return [Unattributable(workdir, words, "`%s` wraps it" % step.command.name)]
    if RUNTIME_NAME.search(words[0]) and _runtime_name_may_push_or_merge(words, call):
        return [_resolved_at_run_time(workdir, words, "`%s` is resolved only at run time" % words[0], call, call_cwd)]
    return []


def _gh_actions(words: List[str], workdir: str, environment: dict, call: str, call_cwd: str) -> list:
    if words[1:3] == ["pr", "merge"]:
        merge = parse_merge(words, workdir, environment.get("GH_REPO"))
        names_repo = any(name for _, name in _repo_naming_sources(merge))
        redirected = None if names_repo else _gh_default_change_in(call, call_cwd)
        if redirected:
            return [_resolved_at_run_time(workdir, words, "`%s` changes the repo gh merges in" % redirected, call, call_cwd)]
        return [merge]
    if words[1:3] == ["pr", "create"]:
        return [PrCreate(workdir, words)]
    if words[1:2] == ["api"] and _gh_api_changes_a_branch(words[2:]):
        return [Unattributable(workdir, words, "`gh api` merges or moves a branch outside the gate")]
    return []


def _gh_api_changes_a_branch(args: List[str]) -> bool:
    """A `gh api` call that merges a PR or a branch, or writes a branch ref, through REST or GraphQL."""
    branch_changes = (PULL_MERGE_ENDPOINT, BRANCH_MERGE_ENDPOINT, GRAPHQL_BRANCH_CHANGE)
    if any(pattern.search(arg) for arg in args for pattern in branch_changes):
        return True
    return any(REF_ENDPOINT.search(arg) for arg in args) and _gh_api_writes(args)


def _gh_api_writes(args: List[str]) -> bool:
    """gh api sends GET unless a method option names another method or a body option makes it POST."""
    method = _gh_api_method(args)
    if method is not None:
        return method.upper() not in READ_METHODS
    return any(arg.startswith(GH_API_BODY_OPTIONS) for arg in args)


def _gh_api_method(args: List[str]) -> Optional[str]:
    """The method the last `-X`/`--method` option names, as gh reads it; None when there is none."""
    method = None
    for index, arg in enumerate(args):
        if arg in GH_API_METHOD_OPTIONS:
            method = args[index + 1] if index + 1 < len(args) else ""
        elif arg.startswith("--method="):
            method = arg.split("=", 1)[1]
        elif arg.startswith("-X"):
            method = arg[2:]
    return method


def _runtime_name_may_push_or_merge(words: List[str], call: str) -> bool:
    """A command name the shell resolves at run time may push or merge when its own text holds a push or merge
    word (`$CORE/git-push`), the call spells one anywhere, an argument is a push/merge word, or an argument is
    resolved at run time too (`$GIT $S …`) while the call holds a push or merge word anywhere (`S=push`)."""
    program, args = words[0], words[1:]
    unquoted = _unquoted(call)
    if PUSH_OR_MERGE_WORD.search(_unquoted(program)):
        return True
    if SPELLED_PUSH_OR_MERGE.search(unquoted) or PUSH_OR_MERGE_WORDS.intersection(args):
        return True
    return any(RUNTIME_NAME.search(arg) for arg in args) and bool(PUSH_OR_MERGE_WORD.search(unquoted))


def _hides_push_or_merge(program: str, words: List[str]) -> bool:
    """A program that runs its arguments as a command the parser did not unwrap (`xargs git push …`,
    `env --chdir=… git push …`), when those arguments spell out a push or a merge."""
    if os.path.basename(program) not in ARGV_FORWARDERS:
        return False
    names = {os.path.basename(word) for word in words}
    return {"git", "push"} <= names or {"gh", "pr", "merge"} <= names


def _git_actions(step: shell.Step, call: str, call_cwd: str) -> list:
    index = shell.git_subcommand_index(step.argv)
    if index is None:
        return []
    subcommand, args = step.argv[index], step.argv[index + 1:]
    workdir = shell.git_directory(step.argv, step.directory, step.expansion)
    words = _without_directory_options(step.argv[:index]) + step.argv[index:]
    if RUNTIME_NAME.search(subcommand):
        return [_resolved_at_run_time(workdir, words, "the git subcommand `%s` is resolved only at run time" % subcommand,
                                      call, call_cwd)]
    if subcommand in PUSHES_OUTSIDE_GIT_PUSH or (subcommand == "subtree" and "push" in args):
        return [Unattributable(workdir, words, "`git %s` pushes outside the gate" % subcommand)]
    if subcommand == "push":
        repointed = _repointing(step.argv[1:], step.environment)
        if repointed:
            return [Unattributable(workdir, words, "`%s` points git at another repository" % repointed)]
        reconfigured = _config_override(step.argv[1:index], step.environment) or _config_change_in(call, call_cwd)
        if reconfigured:
            return [_resolved_at_run_time(workdir, words, "`%s` changes git config the gate reads from the clone"
                                          % reconfigured, call, call_cwd)]
        push = parse_push(words, args, workdir)
        if push.remote and RUNTIME_NAME.search(push.remote):
            return [_resolved_at_run_time(workdir, words, "the push remote `%s` is resolved only at run time" % push.remote,
                                          call, call_cwd)]
        return [push]
    return []


def _resolved_at_run_time(workdir: str, words: List[str], why: str, call: str, call_cwd: str) -> Unattributable:
    """The user runs the whole call from where it started: only its own assignments give the names their values."""
    user_command = "cd %s && %s" % (shlex.quote(call_cwd or workdir), call) if call else None
    return Unattributable(workdir, words, why, user_command)


def _without_directory_options(git_words: List[str]) -> List[str]:
    """`git` and its global options minus each `-C <dir>`: the user's command runs from that directory."""
    kept, words = [], iter(git_words)
    for word in words:
        if word == "-C":
            next(words, None)
        else:
            kept.append(word)
    return kept


def _repointing(args: List[str], environment: dict) -> Optional[str]:
    """The `--git-dir`/`--work-tree` word or `GIT_DIR`/`GIT_WORK_TREE` variable that points git away from
    the clone the gate judges (the cwd), or None."""
    for word in args:
        if word.split("=", 1)[0] in REPOINTING_OPTIONS:
            return word
    for name in REPOINTING_VARIABLES:
        if name in environment:
            return "%s=%s" % (name, environment[name])
    return None


def _config_override(global_words: List[str], environment: dict) -> Optional[str]:
    """The `-c`/`--config-env` setting of a section that routes pushes, or the `GIT_CONFIG*` variable, through which
    this git run reads config that is not in the clone, or None."""
    words = iter(global_words)
    for word in words:
        option, _, attached = word.partition("=")
        if option not in CONFIG_OVERRIDE_OPTIONS:
            continue
        setting = attached or next(words, "")
        if _routes_pushes(setting):
            return "%s %s" % (option, setting)
    variable = next((name for name in environment if name.startswith(CONFIG_VARIABLE_PREFIX)), None)
    return variable and "%s=%s" % (variable, environment[variable])


def _config_change_in(call: str, call_cwd: str) -> Optional[str]:
    """A `git config` write of a key that routes pushes or a `git remote set-url|add|rename` anywhere in the call, or
    None: the gate reads the clone's config before the call runs, so a push in the same call may go where that
    config no longer says."""
    for step in shell.steps(call, call_cwd) if call else []:
        index = shell.git_subcommand_index(step.argv)
        if index is not None and _changes_config(step.argv[index], step.argv[index + 1:]):
            return shlex.join(step.argv)
    return None


def _gh_default_change_in(call: str, call_cwd: str) -> Optional[str]:
    """`gh repo set-default <repo>` or a config change that moves a remote anywhere in the call, or None: a merge that
    names no repo goes where gh's default points once the call has run, not where the gate read it."""
    for step in shell.steps(call, call_cwd):
        words = shell.gh_subcommand_argv(step.argv)
        if step.name == "gh" and words[1:3] == ["repo", "set-default"] and not GH_DEFAULT_VIEW_OPTIONS.intersection(words[3:]):
            return shlex.join(step.argv)
    return _config_change_in(call, call_cwd)


def _changes_config(subcommand: str, args: List[str]) -> bool:
    if subcommand == "config":
        return _writes_push_routing(args)
    if subcommand == "remote":
        return next((arg for arg in args if not arg.startswith("-")), None) in REMOTE_EDITS
    return False


def _writes_push_routing(config_args: List[str]) -> bool:
    """`git config <config_args>` may write a key that routes pushes: never a read; a write when its key's section
    routes pushes, or when it names no key (an editor run, `-e`/`edit`, may write any)."""
    if shell.is_config_read(config_args):
        return False
    key = shell.config_key(config_args)
    return key is None or _routes_pushes(key)


def _routes_pushes(key: str) -> bool:
    """A config key (`section.…`, `-c`'s `section.…=value`) whose section can send a push somewhere else."""
    return key.split(".", 1)[0].lower() in PUSH_ROUTING_SECTIONS


def parse_push(words: List[str], args: List[str], workdir: str) -> Push:
    pushed = shell.read_push_arguments(args)
    given = [spec.lstrip("+") for spec in pushed.refspecs]
    refspecs = [Refspec(source, destination or None)
                for source, _, destination in (spec.partition(":") for spec in given if not spec.startswith(":"))]
    deletes = "--delete" in pushed.long_options or "d" in pushed.short_flags
    return Push(workdir, words, pushed.remote, refspecs,
                deletes_only=deletes or (bool(given) and not refspecs),
                tags_only="--tags" in pushed.long_options and not given,
                whole_repo=pushed.whole_repo,
                dry_run="--dry-run" in pushed.long_options or "n" in pushed.short_flags)


def parse_merge(words: List[str], workdir: str, repo_env: Optional[str]) -> Merge:
    repo_flag = selector = match_head = None
    auto = False
    remaining = iter(words[3:])
    for arg in remaining:
        if arg in shell.GH_REPO_OPTIONS:
            repo_flag = next(remaining, None)
        elif shell.attached_gh_repo(arg) is not None:
            repo_flag = shell.attached_gh_repo(arg)
        elif arg == "--match-head-commit":
            match_head = next(remaining, None)
        elif arg.startswith("--match-head-commit="):
            match_head = arg.split("=", 1)[1]
        elif arg == "--auto":
            auto = True
        elif arg in MERGE_VALUE_FLAGS:
            next(remaining, None)
        elif not arg.startswith("-") and selector is None:
            selector = arg
    return Merge(workdir, words, selector, repo_flag, repo_env, auto, match_head)


def judge_action(action, report: Report) -> None:
    whole_call = action.user_command if isinstance(action, Unattributable) else None
    hint = whole_call or _user_command(action.workdir, action.words)
    irreversible = isinstance(action, (Push, Merge, Unattributable))
    try:
        repo_root, repo_key, row = resolve_target(action, report)
    except UnclearTarget as unclear:
        deny_unclear_target(action, unclear, report)
        return
    except Exception as error:
        report.error(error, fail_closed=irreversible and registry.gates_any_repo(), hint=hint)
        return
    gated = registry.is_gated(row)
    try:
        if isinstance(action, Push):
            judge_push(action, repo_root, repo_key, row, report, hint)
        elif isinstance(action, Merge):
            judge_merge(action, repo_root, repo_key, row, report, hint)
        elif isinstance(action, Unattributable):
            deny_unattributable(action, repo_key, report, hint)
        else:
            early_warning(repo_root, repo_key, row, report)
    except Exception as error:
        report.error(error, fail_closed=irreversible and gated, hint=hint, repo=repo_key)


def _user_command(workdir: str, words: List[str]) -> str:
    return "cd %s && %s" % (shlex.quote(workdir), shlex.join(words))


def resolve_target(action, report: Report) -> Tuple[str, Optional[str], Optional[GatedRepo]]:
    """(clone root, key and registry row of the repo the action changes) (DESIGN 5.2, 5.3)."""
    repo_root = gitcmd.toplevel(action.workdir)
    if repo_root is None:
        raise GateError("not a git repository: " + action.workdir)
    repo_key = target_key(action, repo_root)
    if not os.path.isfile(registry.registry_path()):
        warn_registry_absent_once(report)
        return repo_root, repo_key, None
    return repo_root, repo_key, registry.lookup(repo_key)


def target_key(action, repo_root: str) -> Optional[str]:
    """The remote a push reaches; the repo a merge names, else the one gh resolves; the clone's origin otherwise."""
    if isinstance(action, Push):
        return push_target_key(action, repo_root)
    if isinstance(action, Merge):
        return merge_target_key(action) or gh_default_key(repo_root)
    return registry.origin_key(repo_root)


def push_target_key(push: Push, repo_root: str) -> str:
    """The repo a push is judged on, of all it reaches: every push URL of the remote it names (else of the current
    branch's push remote), or the remote argument itself as a URL or a path."""
    remote = push.remote or gitcmd.push_remote(repo_root)
    keys = [registry.normalize_repo_key(_located(url, repo_root))
            for url in gitcmd.push_urls(repo_root, remote) or [remote]]
    if None in keys:
        raise UnclearTarget("the push target `%s` resolves to no URL or existing path" % remote)
    return _judged_key(keys, registry.origin_key(repo_root))


def _located(url: str, repo_root: str) -> Optional[str]:
    """`url` the way git reaches it: a URL as written, else a path from the clone's top level; None when no such
    path exists."""
    if URL_FORM.match(url):
        return url
    path = os.path.normpath(os.path.join(repo_root, url))
    return path if os.path.exists(path) else None


def _judged_key(keys: List[str], own_key: Optional[str]) -> str:
    """Of the repos one push reaches, the one its verdict needs: a gated repo other than this clone's (denied as
    foreign), else this clone's gated repo, else the first."""
    gated = [key for key in keys if registry.is_gated(registry.lookup(key))]
    return next((key for key in gated if key != own_key), (gated or keys)[0])


def _repo_naming_sources(merge: Merge) -> list:
    """(source, name) for each way a merge can name its repo: `--repo`, `GH_REPO=`, a PR URL; name None when unused."""
    pull_url = PULL_URL.match(merge.selector or "")
    return [("--repo", merge.repo_flag), ("GH_REPO", merge.repo_env), ("the PR URL", pull_url and pull_url.group(1))]


def merge_target_key(merge: Merge) -> Optional[str]:
    """The repo `--repo`, else `GH_REPO=`, else the PR URL names; None when the command names none."""
    for source, name in _repo_naming_sources(merge):
        if not name:
            continue
        key = registry.normalize_repo_key(name)
        if key is None:
            raise GateError("%s %s does not name owner/repo" % (source, name))
        return key
    return None


def gh_default_key(repo_root: str) -> Optional[str]:
    """The repo gh merges in when the command names none: gh's default (the owner/repo it stored, else the URL of the
    remote it marked), else the one repo the clone's remotes name; several repos with one gated cannot be attributed
    (UnclearTarget)."""
    default = gitcmd.gh_default_remote(repo_root)
    if default and default.resolved != gitcmd.GH_RESOLVED_BASE:
        stored = registry.normalize_repo_key(default.resolved)
        if stored is None:
            raise GateError("gh's default repo %r on remote %s names no owner/repo" % (default.resolved, default.remote))
        return stored
    if default:
        return registry.normalize_repo_key(gitcmd.remote_url(repo_root, default.remote))
    keys = sorted({registry.normalize_repo_key(gitcmd.remote_url(repo_root, name)) for name in gitcmd.remotes(repo_root)}
                  - {None})
    if len(keys) <= 1:
        return keys[0] if keys else None
    gated = [key for key in keys if registry.is_gated(registry.lookup(key))]
    if gated:
        raise UnclearTarget("gh pr merge names no repo and this clone's remotes point at %s; add `--repo <owner/repo>`"
                            % ", ".join(keys), ("--repo", gated[0]))
    return registry.origin_key(repo_root)


def warn_registry_absent_once(report: Report) -> None:
    stamp = os.path.join(env.state_dir(), "sessions", "%s.registry-warned" % report.session)
    if os.path.exists(stamp):
        return
    os.makedirs(os.path.dirname(stamp), exist_ok=True)
    open(stamp, "w").close()
    report.warn([Reason(K1, "no gated-repos.tsv in the overlay (%s): every repo is off" % registry.registry_path())],
                "registry absent")


def judge_push(push: Push, repo_root: str, repo_key: Optional[str], row: Optional[GatedRepo], report: Report,
               hint: str) -> None:
    if not registry.is_gated(row) or push.deletes_only or push.tags_only or push.dry_run:
        report.passed(repo_key, head=gitcmd.commit_sha(repo_root, push.sources[0] if push.sources else HEAD))
        return
    foreign = foreign_clone_reason(repo_root, repo_key, "git push")
    if foreign:
        report.deny([foreign], "push to %s denied" % repo_key, hint, repo=repo_key)
        return
    if push.whole_repo:
        report.deny([Reason(F_IRREVERSIBLE, "git push --all/--mirror cannot be attributed to one branch; push one branch")],
                    "push of every branch in %s denied" % repo_key, hint, repo=repo_key)
        return
    for spec in push.refspecs or [Refspec(HEAD, None)]:
        head = gitcmd.commit_sha(repo_root, spec.source)
        if head is None:
            raise GateError("refspec source %s does not name a commit" % spec.source)
        if _pushes_tag(repo_root, spec):
            report.passed(repo_key, head=head)
            continue
        base_ref = resolve_base(repo_root, row)
        outgoing = _outgoing(repo_root, repo_key, row, head, base_ref, row.push_needs_approval)
        report.decide(verify.judge(outgoing), "push of %s in %s denied" % (spec.source, repo_key), hint, repo_key, head)


def _pushes_tag(repo_root: str, spec: Refspec) -> bool:
    """A tag reaches the remote as a tag only when the destination is one (or is left to git and the
    source names a tag); `tag:branch` ships that commit as a branch and is gated."""
    if spec.destination is not None:
        return spec.destination.startswith(TAG_PREFIX)
    return spec.source.startswith(TAG_PREFIX) or gitcmd.ref_exists(repo_root, TAG_PREFIX + spec.source)


def judge_merge(merge: Merge, repo_root: str, repo_key: Optional[str], row: Optional[GatedRepo], report: Report,
                hint: str) -> None:
    if not registry.is_gated(row):
        report.passed(repo_key)
        return
    summary = "merge of PR %s in %s denied" % (merge.selector or "(current branch)", repo_key)
    foreign = foreign_clone_reason(repo_root, repo_key, "gh pr merge")
    if foreign:
        report.deny([foreign], summary, hint, repo=repo_key)
        return
    if not merge.match_head:
        report.deny([Reason(F_IRREVERSIBLE, "gh pr merge needs --match-head-commit <sha> so the gate knows what merges")],
                    summary, hint, repo=repo_key)
        return
    pull_request = fetch_pull_request(merge)
    not_green = checks_not_green(pull_request, merge.auto)
    if not_green:
        report.deny([Reason(F_IRREVERSIBLE, "checks not green: " + ", ".join(not_green))], summary, hint,
                    repo=repo_key, head=merge.match_head)
        return
    head = _fetched_commit(repo_root, merge.match_head)
    base_ref = _fetched_remote_branch(repo_root, pull_request["baseRefName"])
    outgoing = _outgoing(repo_root, repo_key, row, head, base_ref, needs_approval=True)
    report.decide(verify.judge(outgoing), summary, hint, repo_key, head)


def foreign_clone_reason(repo_root: str, repo_key: str, command: str) -> Optional[Reason]:
    """Why `command` must run from a clone of the gated repo it changes, or None when this clone is one: the gate
    reads that repo's base (and a PR's head) from its own clone."""
    clone = registry.origin_key(repo_root)
    if clone == repo_key:
        return None
    return Reason(F_IRREVERSIBLE, "run %s from a clone of %s (this clone is %s); the gate reads the head and base "
                                  "there" % (command, repo_key, clone or "without an origin"))


def fetch_pull_request(merge: Merge) -> dict:
    """`gh pr view` resolving the PR the way the merge will: same selector, `--repo` flag and `GH_REPO` env."""
    argv = [os.environ.get("KEEL_GH") or "gh", "pr", "view"]
    if merge.selector:
        argv.append(merge.selector)
    if merge.repo_flag:
        argv += ["--repo", merge.repo_flag]
    argv += ["--json", PR_VIEW_FIELDS]
    environment = dict(os.environ, GH_REPO=merge.repo_env) if merge.repo_env else None
    completed = subprocess.run(argv, cwd=merge.workdir, env=environment, capture_output=True, text=True,
                               timeout=GH_TIMEOUT_SECONDS)
    if completed.returncode != 0:
        raise GateError("gh pr view failed: " + completed.stderr.strip())
    pull_request = json.loads(completed.stdout)
    if not isinstance(pull_request, dict) or not pull_request.get("baseRefName"):
        raise GateError("gh pr view returned no baseRefName")
    return pull_request


def checks_not_green(pull_request: dict, auto: bool) -> List[str]:
    """`name=outcome` of each red check and, without --auto, each unfinished one. GitHub itself refuses to
    merge a closed, draft or conflicting PR."""
    blocking = FAILED_CHECKS if auto else FAILED_CHECKS | PENDING_CHECKS
    not_green = []
    for check in pull_request.get("statusCheckRollup") or []:
        outcome = check.get("conclusion") or check.get("status") or check.get("state") or ""
        if outcome in blocking:
            not_green.append("%s=%s" % (check.get("name") or check.get("context") or "?", outcome))
    return not_green


def deny_unattributable(action: Unattributable, repo_key: Optional[str], report: Report, hint: str) -> None:
    report.deny([Reason(K1, "cannot attribute this push or merge to one repo and branch: %s; run "
                            "`git push <remote> <branch>` or `gh pr merge <number> --match-head-commit <sha>` plainly"
                        % action.why)],
                "unattributable push or merge in %s denied" % (repo_key or action.workdir), hint, repo=repo_key)


def deny_unclear_target(action, unclear: UnclearTarget, report: Report) -> None:
    words = action.words + unclear.added_words
    deny_unattributable(Unattributable(action.workdir, words, str(unclear)), None, report,
                        _user_command(action.workdir, words))


def resolve_base(repo_root: str, row: GatedRepo) -> str:
    """`origin/<integration_base>`; without it the gate cannot tell what the push adds."""
    base_ref = "origin/" + row.integration_base
    if not gitcmd.ref_exists(repo_root, "refs/remotes/" + base_ref):
        raise GateError("base %s is missing: run `git fetch origin`" % base_ref)
    return base_ref


def _outgoing(repo_root: str, repo_key: str, row: GatedRepo, head: str, base_ref: str, needs_approval: bool) -> Outgoing:
    merge_base = gitcmd.merge_base(repo_root, base_ref, head)
    if merge_base is None:
        raise GateError("no merge base between %s and %s" % (base_ref, head[:10]))
    return Outgoing(repo_root, repo_key, row, head, merge_base, needs_approval)


def _fetched_commit(repo_root: str, sha: str) -> str:
    if gitcmd.commit_sha(repo_root, sha) is None:
        gitcmd.fetch(repo_root, "origin")
    head = gitcmd.commit_sha(repo_root, sha)
    if head is None:
        raise GateError("commit %s is not in this clone even after fetching origin" % sha)
    return head


def _fetched_remote_branch(repo_root: str, name: str) -> str:
    if not gitcmd.ref_exists(repo_root, "refs/remotes/origin/" + name):
        gitcmd.fetch(repo_root, "origin")
    if not gitcmd.ref_exists(repo_root, "refs/remotes/origin/" + name):
        raise GateError("origin/%s is not in this clone even after fetching origin" % name)
    return "origin/" + name


def early_warning(repo_root: str, repo_key: Optional[str], row: Optional[GatedRepo], report: Report) -> None:
    """What the current branch still lacks before it can merge (never blocks)."""
    if not registry.is_gated(row):
        return
    head = gitcmd.commit_sha(repo_root, HEAD)
    if head is None:
        return
    branch = gitcmd.current_branch(repo_root)
    base_ref = resolve_base(repo_root, row)
    decision = verify.judge(_outgoing(repo_root, repo_key, row, head, base_ref, needs_approval=True))
    label = "%s of %s (risk %s)" % (branch or head[:10], repo_key, decision.risk_class or "none")
    where = dict(repo=repo_key, head=head, risk=decision.risk_class, root_run_id=decision.root_run_id)
    if decision.ok:
        report.warn([Reason(K1, "review, tests and approval cover the outgoing change")], "ready to ship " + label, **where)
    else:
        report.warn(list(decision.reasons), "not ready to ship " + label, **where)


def collect_garbage_if_due(report: Report) -> None:
    stamp = os.path.join(env.state_dir(), "gc.stamp")
    try:
        if os.path.exists(stamp) and time.time() - os.path.getmtime(stamp) < GC_INTERVAL_SECONDS:
            return
        os.makedirs(os.path.dirname(stamp), exist_ok=True)
        pathlib.Path(stamp).touch()
        report.record("evidence gc deleted %d" % gc.collect())
    except Exception as error:  # gc never changes a verdict; the error line keeps it visible
        report.error(error, fail_closed=False, hint="")


def _message(summary: str, reasons: List[Reason], user_command: Optional[str] = None) -> str:
    """A deny names the command the user can run instead; a warn (no command) ends with its bullets."""
    bullets = [(reason.rule_id, reason.text) for reason in reasons]
    if user_command is None:
        return protocol.format_warning(HOOK, summary, bullets)
    return protocol.format_message(HOOK, summary, bullets, protocol.run_yourself(user_command))


if __name__ == "__main__":
    sys.exit(main())
