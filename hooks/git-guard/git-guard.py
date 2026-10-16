#!/usr/bin/env python3
"""git-guard: floor rules on the agent's tool path (PreToolUse Bash|Edit|Write|NotebookEdit).

Denies, collecting every violation of one call into a single message:
  [F-attribution]  AI-tool attribution in a commit message, a PR title/body or merge commit message (or
                   a heredoc the call writes for it), or the pushed commits (every branch on --all).
  [F-secrets]      `measure/boundary --staged --generic-only` hits on `git commit`; a commit that stages
                   files in its own call (the index is read before that staging runs); overlay-listed
                   known secret values in anything the agent writes or commits.
  [F-force-push]   --force, -f, +refspec; --force-with-lease onto main, master or the integration base.
  [F-hookskip]     skipping hooks (`--no-verify`, `commit -n`, `core.hooksPath`, disableAllHooks in an
                   inline child `claude --settings` or a `.claude/settings*.json` write); writes to
                   keel-fires.jsonl.
  [K1]             writes into the evidence store; `keel approve` and `keel evidence write-review` from
                   an agent's shell.
  [C-isolation]    writes and state-moving git commands inside the live keel or overlay checkout.
  [<row id>]       overlay `git-guard/repo-rules.tsv` rows (deny-commit, deny-path).
Fails closed: on its own error it denies a call that looks like a commit, push, PR text, keel command,
hook skip or protected write, and passes the rest. A person's own terminal is the escape hatch.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "lib"))

from hookkit import knownvalues, protocol  # noqa: E402
from hookkit.env import boundary_scanner, data_dir, keel_home, overlay_dir, overlay_path  # noqa: E402
from hookkit.fires import FireLog  # noqa: E402
from hookkit.overlay import read_tsv  # noqa: E402
from hookkit.repo import current_branch, find_repo_key, find_toplevel, git, git_output, is_commit  # noqa: E402
from hookkit.shell import (Step, gh_subcommand_argv, git_directory, git_subcommand_index, is_config_read,  # noqa: E402
                           read_push_arguments, resolve_directory, steps, write_targets)

HOOK = "git-guard"
K1 = "K1"
F_ATTRIBUTION = "F-attribution"
F_SECRETS = "F-secrets"
F_FORCE_PUSH = "F-force-push"
F_HOOKSKIP = "F-hookskip"
C_ISOLATION = "C-isolation"
EDIT_TOOLS = {"edit", "write", "notebookedit", "multiedit"}
REPO_RULES_HEADER = ("origin_glob", "action", "pattern", "rule_id", "message")
GATED_REPOS_HEADER = ("origin", "gate", "integration_base", "risk_rules", "tests")
GATED_REPOS_OPTIONAL = ("push_approval",)
ACTION_DENY_COMMIT = "deny-commit"
ACTION_DENY_PATH = "deny-path"
ALWAYS_PROTECTED_BRANCHES = {"main", "master"}
BOUNDARY_TIMEOUT_SECONDS = 8  # below the registered 10 s timeout (settings/core.json)
BOUNDARY_EXIT_CLEAN = 0
BOUNDARY_EXIT_HITS = 1
COMMIT_MESSAGE_OPTIONS = {"-m", "--message"}
COMMIT_FILE_OPTIONS = {"-F", "--file"}
COMMIT_STAGING_LONG_OPTIONS = {"--all"}
COMMIT_LONG_VALUE_OPTIONS = {
    "--message", "--file", "--author", "--date", "--cleanup", "--fixup", "--squash", "--reuse-message",
    "--reedit-message", "--template", "--trailer", "--pathspec-from-file",
}
COMMIT_STAGING_SHORT_FLAGS = {"a"}
COMMIT_SHORT_VALUE_FLAGS = {"m", "F", "C", "c", "t"}
COMMIT_SHORT_ATTACHED_VALUE_FLAGS = {"S", "u"}
COMMIT_NO_VERIFY_SHORT_FLAG = "n"
STAGING_SUBCOMMANDS = {"add", "stage"}
PR_FILE_OPTIONS = {"-F", "--body-file"}
PR_TEXT_SUBCOMMANDS = {"create", "edit", "merge"}  # `merge`: the merge commit's --subject/--body
UNPUSHED = ["--not", "--remotes"]  # with no remote-tracking refs at all: the whole history
STDIN_PATH = "-"
KEEL_CLI_NAME = "keel"
HOOKED_SUBCOMMANDS = {"commit", "merge", "push"}
LIVE_MOVING_SUBCOMMANDS = {
    "checkout", "switch", "restore", "reset", "add", "rm", "mv", "commit", "cherry-pick", "revert", "am", "apply",
    "merge", "rebase", "pull", "stash", "clean",
}
HOOKS_PATH_KEY = "core.hookspath"
DISABLE_HOOKS_KEY = "disableAllHooks"
DISABLE_HOOKS_RE = re.compile(r'"?disableAllHooks"?\s*[:=]\s*true')  # JSON or a jq filter
SETTINGS_OPTIONS = ("--settings",)
DISALLOWED_TOOLS_OPTIONS = ("--disallowedTools", "--disallowed-tools")
AGENT_WRITE_TOOLS = {"Bash", "Edit", "Write"}
FIRES_LOG = os.path.join("logs", "keel-fires.jsonl")
KNOWN_VALUES_FILE = ("git-guard", "known-values.tsv")
PROTECTED_TEXT = {
    K1: "Evidence is written only by keel itself, never by a tool call: %s.",
    F_HOOKSKIP: "keel-fires.jsonl is written only by the hooks, never by a tool call: %s.",
}

ATTRIBUTION_RE = re.compile(
    r"co-authored-by:\s*(claude|anthropic|codex|openai)"
    r"|(generated|created|written|authored|co-authored|assisted|aided|helped|powered|built|made|developed"
    r"|drafted|produced|crafted|implemented|reviewed)\s+(with|by|using|via)\s.{0,24}(claude|anthropic|codex|openai)"
    r"|(claude|anthropic|codex|openai)[\s._-]+(generated|assisted|authored|written|created|powered)"
    r"|(help|assistance|thanks)\s+(of|from|to)\s.{0,16}(claude|anthropic|codex|openai)"
    r"|(https?://|//|@)(anthropic|claude)\.(com|ai)|(anthropic|claude)\.(com|ai)/"
    "|\U0001F916",
    re.I,
)
LOOKS_GUARDED_RE = re.compile(
    r"\bgit\b[^\n]*\b(commit|push)\b|\bgh\b[^\n]*\bpr\b[^\n]*\b(create|edit|merge)\b"
    r"|\bkeel[\s\"'\\]+(approve|evidence)\b|state/keel"
    r"|no-verify|hooksPath|disableAllHooks|keel-fires",
    re.I,
)


@dataclass
class Violation:
    rule_id: str
    text: str
    repo: str | None = None


@dataclass
class CommitOption:
    """What one `git commit` option word means for the guard."""

    stages: bool = False
    skips_hooks: bool = False
    value_name: str | None = None  # the value-taking option this word names, e.g. "-m" or "--file"
    attached_value: str | None = None  # its value when inside the word: `-mText`, `-sm…`'s rest, `--file=x`

    @property
    def value_follows(self) -> bool:
        return self.value_name is not None and self.attached_value is None


class GuardError(Exception):
    pass


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = protocol.parse_payload(raw)
        fires = FireLog(HOOK, payload.get("session_id"))
        violations = find_violations(payload)
    except Exception as error:  # noqa: BLE001 - fail closed below, never silently
        return fail_closed(raw, error)
    if not violations:
        return protocol.EXIT_PASS
    for violation in violations:
        fires.append(violation.rule_id, "deny", repo=violation.repo, detail=violation.text)
    bullets = [(violation.rule_id, violation.text) for violation in violations]
    return protocol.deny(protocol.format_message(HOOK, "blocked", bullets, next_step_for(payload)))


def next_step_for(payload: dict) -> str:
    """A Bash command is the user's to run; an edit of a protected file has no step the user should take."""
    if protocol.tool_name(payload) != "bash":
        return protocol.ASK_USER
    command = str(protocol.tool_input(payload).get("command") or "")
    return protocol.run_yourself("cd %s && %s" % (shlex.quote(str(payload.get("cwd") or os.getcwd())), command))


def find_violations(payload: dict) -> list:
    name = protocol.tool_name(payload)
    tool_args = protocol.tool_input(payload)
    cwd = str(payload.get("cwd") or os.getcwd())
    if name in EDIT_TOOLS:
        return check_edit(tool_args, cwd)
    if name == "bash":
        return check_bash(str(tool_args.get("command") or ""), cwd)
    return []


def check_edit(tool_args: dict, cwd: str) -> list:
    target = tool_args.get("file_path") or tool_args.get("notebook_path")
    if not target:
        return []
    path = os.path.normpath(os.path.join(cwd, os.path.expanduser(str(target))))  # the tool writes the path as given
    text = edited_text(tool_args)
    violations = []
    rule = ProtectedStore().rule_for(path)
    if rule:
        violations.append(Violation(rule, PROTECTED_TEXT[rule] % target))
    live_root = LiveCheckouts().root_of(path)
    if live_root:
        violations.append(live_violation(str(target), live_root))
    if is_claude_settings_file(path) and DISABLE_HOOKS_RE.search(text):
        violations.append(disable_hooks_violation(str(target)))
    return violations + known_value_violations(lambda: knownvalues.numbered_lines(str(target), text))


def edited_text(tool_args: dict) -> str:
    """What the edit tool writes: a Write's content, an Edit's new string, a notebook cell, a MultiEdit's strings."""
    parts = [tool_args.get(key) for key in ("content", "new_string", "new_source")]
    for edit in tool_args.get("edits") or []:
        parts.append(edit.get("new_string") if isinstance(edit, dict) else None)
    return "\n".join(str(part) for part in parts if isinstance(part, str))


def check_bash(command: str, cwd: str) -> list:
    call = steps(command, cwd)
    call_heredocs = [body for step in call for body in step.heredocs]
    violations = (check_keel_commands(call) + check_protected_writes(call)
                  + check_live_checkouts(call) + check_hook_skips(call)
                  + check_hook_disabling_writes(call))
    for index, step in enumerate(call):
        violations.extend(check_git_or_pr(step, call, index, call_heredocs))
    return _unique(violations)


def check_keel_commands(call: list) -> list:
    violations = []
    for step in call:
        keel_args = _keel_arguments(step.argv)
        if keel_args[:1] == ["approve"]:
            violations.append(Violation(K1, "`keel approve` is the user's act; it runs only in the user's own terminal."))
        if keel_args[:2] == ["evidence", "write-review"]:
            violations.append(Violation(K1, "Review evidence is written by report-gate from a reviewer's report, never by a command."))
    return violations


def _keel_arguments(argv: list) -> list:
    """The words after the `keel` word, wherever it sits (`python3 -I <path>/keel …`, `xargs keel …`)."""
    for index, word in enumerate(argv):
        if os.path.basename(word) == KEEL_CLI_NAME:
            return argv[index + 1:]
    return []


def check_protected_writes(call: list) -> list:
    store = ProtectedStore()
    hits = {}
    for step in call:
        targets = write_targets(step.command)
        for path in targets.written + targets.removed:
            _collect(hits, store.rule_for(resolve_directory(step.directory, path, step.expansion)), path)
        if targets.unknown:
            _collect(hits, store.rule_for(step.directory), step.directory)
    return [Violation(rule, PROTECTED_TEXT[rule] % protocol.listed(paths)) for rule, paths in hits.items()]


def _collect(hits: dict, rule: str | None, path: str) -> None:
    if rule:
        hits.setdefault(rule, []).append(path)


def check_live_checkouts(call: list) -> list:
    live = LiveCheckouts()
    if not live.roots:
        return []
    found = []  # (what, live root)
    for step in call:
        targets = write_targets(step.command)
        for path in targets.written + targets.removed:
            root, unresolved_cd = _live_root_of_write(live, step, path, call[0].directory)
            found.append(("%s (after a `cd` the hook cannot resolve, judged where the call starts)" % path if unresolved_cd else path,
                          root))
        index = git_subcommand_index(step.argv)
        if index is not None and step.argv[index] in LIVE_MOVING_SUBCOMMANDS:
            toplevel = find_toplevel(git_directory(step.argv, step.directory, step.expansion))
            if toplevel and live.root_of(toplevel) == toplevel and is_approved_fast_forward(step.argv[index:], toplevel):
                continue
            found.append(("git " + step.argv[index], live.root_of(toplevel) if toplevel else None))
    return [live_violation(what, root) for what, root in found if root]


def is_approved_fast_forward(args: list, repo: str) -> bool:
    if len(args) != 3 or args[:2] != ['merge', '--ff-only']:
        return False
    from evidence.activation import approved_fast_forward
    return approved_fast_forward(repo, args[2])


def live_violation(what: str, root: str) -> Violation:
    return Violation(C_ISOLATION, (
        "%s is inside the live checkout %s. Work in a worktree: `git -C %s worktree add ../%s-wt/<topic> -b <topic>`; "
        "the live checkout needs an exact-commit owner-approved, gate-verified fast-forward; otherwise the user runs `git -C %s merge --ff-only <branch>`."
        % (what, root, root, os.path.basename(root), root)))


def check_hook_disabling_writes(call: list) -> list:
    """A Bash write into a `.claude/settings*.json` whose call text spells disableAllHooks (`echo`, `tee`,
    `jq … > tmp && mv tmp …`, a heredoc)."""
    targets = [path for path in written_paths(call) if is_claude_settings_file(path)]
    if not targets or not DISABLE_HOOKS_RE.search(call_text(call)):
        return []
    return [disable_hooks_violation(protocol.listed(targets))]


def disable_hooks_violation(target: str) -> Violation:
    return Violation(F_HOOKSKIP, "%s would set %s, switching keel's hooks off." % (target, DISABLE_HOOKS_KEY))


def written_paths(call: list) -> list:
    """Every file the call writes, resolved against the directory its command runs in."""
    return [resolve_directory(step.directory, path, step.expansion)
            for step in call for path in write_targets(step.command).written]


def call_text(call: list) -> str:
    """Everything the call spells out: argv words, heredoc bodies and assignment values."""
    parts = [part for step in call for part in step.argv + step.heredocs]
    parts += [value for step in call for _, value in step.command.assignments]
    return "\n".join(parts)


def check_hook_skips(call: list) -> list:
    violations = []
    for step in call:
        if step.name == "claude" and child_claude_disables_hooks(step.argv[1:]):
            violations.append(Violation(F_HOOKSKIP, (
                "A child `claude --settings` carrying %s runs with keel's hooks off; drop it, or disallow Bash, Edit "
                "and Write for that child." % DISABLE_HOOKS_KEY)))
        index = git_subcommand_index(step.argv)
        why = git_hook_skip(step, index) if index is not None else None
        if why:
            violations.append(Violation(F_HOOKSKIP, why + " The repo's hooks run keel's checks; run the command without it."))
    return violations


def child_claude_disables_hooks(args: list) -> bool:
    inline_settings = [value for value in _option_values(args, SETTINGS_OPTIONS) if value.lstrip().startswith("{")]
    if not any(_settings_disable_hooks(text) for text in inline_settings):
        return False
    disallowed = {tool for value in _option_values(args, DISALLOWED_TOOLS_OPTIONS) for tool in re.split(r"[,\s]+", value) if tool}
    return not AGENT_WRITE_TOOLS <= disallowed


def _option_values(args: list, names: tuple) -> list:
    """Values of `--opt value…` (every word up to the next option) and `--opt=value`."""
    values = []
    index = 0
    while index < len(args):
        word = args[index]
        if word in names:
            index += 1
            while index < len(args) and not args[index].startswith("-"):
                values.append(args[index])
                index += 1
            continue
        if any(word.startswith(name + "=") for name in names):
            values.append(word.split("=", 1)[1])
        index += 1
    return values


def _settings_disable_hooks(text: str) -> bool:
    try:
        settings = json.loads(text)
    except ValueError:
        return bool(DISABLE_HOOKS_RE.search(text))
    return isinstance(settings, dict) and settings.get(DISABLE_HOOKS_KEY) is True


def git_hook_skip(step: Step, index: int) -> str | None:
    """Why this git command skips the repo's hooks, or None."""
    git_globals, subcommand, args = step.argv[1:index], step.argv[index], step.argv[index + 1:]
    config_values = [word[2:] if word.startswith("-c") and len(word) > 2 else word for word in git_globals]
    if any(value.lower().startswith(HOOKS_PATH_KEY + "=") for value in config_values):
        return "`-c core.hooksPath=…` points git at other hooks for this command."
    if subcommand in HOOKED_SUBCOMMANDS and "--no-verify" in args:
        return "`git %s --no-verify` skips the repo's hooks." % subcommand
    if subcommand == "commit" and any(_read_commit_option(arg).skips_hooks for arg in args if arg.startswith("-")):
        return "`git commit -n` skips the repo's hooks."
    if subcommand == "config" and any(arg.lower() == HOOKS_PATH_KEY for arg in args) and not is_config_read(args):
        return "`git config core.hooksPath` points git at other hooks."
    return None


def check_git_or_pr(step: Step, call: list, index: int, call_heredocs: list) -> list:
    if step.name == "gh":
        return check_pr_text(gh_subcommand_argv(step.argv), step, call_heredocs)
    argv = step.argv
    position = git_subcommand_index(argv)
    if position is None:
        return []
    repo_dir = git_directory(argv, step.directory, step.expansion)
    if argv[position] == "commit":
        return check_commit(argv[position + 1:], step, repo_dir, call[:index], call_heredocs)
    if argv[position] == "push":
        return check_push(argv[position + 1:], repo_dir)
    return []


def check_pr_text(gh_argv: list, step: Step, call_heredocs: list) -> list:
    """A PR body or a merge commit made on GitHub has no push-range backstop, so any heredoc of the call counts
    with the arguments and body files (`cat > b.md <<EOF …; gh pr create --body-file b.md`)."""
    if gh_argv[1:2] != ["pr"] or len(gh_argv) < 3 or gh_argv[2] not in PR_TEXT_SUBCOMMANDS:
        return []
    args = gh_argv[3:]
    texts = list(args) + list(call_heredocs) + _read_message_files(args, PR_FILE_OPTIONS, step)
    if not ATTRIBUTION_RE.search("\n".join(texts)):
        return []
    return [Violation(F_ATTRIBUTION, "AI-tool attribution in a PR title or body, a merge commit message, or text this "
                                     "call writes for them; remove it.")]


def check_commit(args: list, step: Step, repo_dir: str, earlier_steps: list, call_heredocs: list) -> list:
    violations = []
    if ATTRIBUTION_RE.search("\n".join(_commit_message_texts(args, step, call_heredocs))):
        violations.append(Violation(F_ATTRIBUTION, "AI-tool attribution in the commit message; remove it."))
    toplevel = find_toplevel(repo_dir)
    if toplevel is None:
        return violations
    repo_key = find_repo_key(toplevel)
    if commit_stages_files(args) or is_staged_earlier_in_call(earlier_steps, toplevel):
        violations.append(Violation(F_SECRETS, "This commit stages files in its own call, so the secret and path checks cannot "
                                    "see them; stage in a separate call, then commit.", repo_key))
    staged = (git_output(["diff", "--cached", "--name-only"], toplevel) or "").splitlines()
    violations.extend(repo_rule_violations(repo_key, staged, {ACTION_DENY_COMMIT, ACTION_DENY_PATH}))
    violations.extend(scan_staged_secrets(toplevel, repo_key))
    return violations + known_value_violations(
        lambda: knownvalues.added_lines(_git_text_or_raise(["diff", "--cached", "-U0", "--no-color"], toplevel)), repo_key)


def check_push(args: list, repo_dir: str) -> list:
    toplevel = find_toplevel(repo_dir)
    if toplevel is None:
        return []
    push = read_push(args, current_branch(toplevel))
    repo_key = find_repo_key(toplevel)
    violations = []
    if push.force:
        violations.append(Violation(F_FORCE_PUSH, "Force push rewrites shared history; push without --force, -f or a +refspec.", repo_key))
    leased = sorted(push.destinations & set(protected_branches(repo_key))) if push.force_with_lease else []
    if leased:
        violations.append(Violation(F_FORCE_PUSH, "--force-with-lease onto %s is still a force push to a shared branch." % ", ".join(leased), repo_key))
    for revisions, label in pushed_ranges(toplevel, push):
        violations.extend(check_push_range(toplevel, repo_key, revisions, label))
    return violations


def pushed_ranges(toplevel: str, push: PushRequest) -> list:
    """(revisions, label) of what the push sends that no remote holds yet: every local branch on a whole-repo
    push, else each source; a source naming no commit sends nothing (git refuses that push)."""
    if push.whole_repo:
        return [(["--branches"] + UNPUSHED, "a local branch (not yet on a remote)")]
    return [([source] + UNPUSHED, "%s (not yet on a remote)" % source) for source in push.sources
            if is_commit(toplevel, source)]


def check_push_range(toplevel: str, repo_key: str | None, revisions: list, label: str) -> list:
    violations = []
    if ATTRIBUTION_RE.search(git_output(["log", "--pretty=%B"] + revisions, toplevel) or ""):
        violations.append(Violation(F_ATTRIBUTION, "AI-tool attribution in a commit message of %s; reword it (last commit: "
                                    "`git commit --amend`) before pushing." % label, repo_key))
    paths = sorted(set((git_output(["log", "--name-only", "--pretty="] + revisions, toplevel) or "").split()))
    return violations + repo_rule_violations(repo_key, paths, {ACTION_DENY_PATH})


def commit_stages_files(args: list) -> bool:
    """`commit -a`, `--all` or a pathspec operand stage files at commit time."""
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            return index + 1 < len(args)
        if not arg.startswith("-") or arg == STDIN_PATH:
            return True
        option = _read_commit_option(arg)
        if option.stages:
            return True
        index += 2 if option.value_follows else 1
    return False


def is_staged_earlier_in_call(earlier_steps: list, toplevel: str) -> bool:
    for step in earlier_steps:
        index = git_subcommand_index(step.argv)
        if index is None or step.argv[index] not in STAGING_SUBCOMMANDS:
            continue
        if find_toplevel(git_directory(step.argv, step.directory, step.expansion)) == toplevel:
            return True
    return False


def scan_staged_secrets(toplevel: str, repo_key: str | None) -> list:
    try:
        result = subprocess.run([boundary_scanner(), "--staged", "--generic-only"], cwd=toplevel, capture_output=True, text=True,
                                timeout=BOUNDARY_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GuardError("boundary scanner did not run: %s" % type(error).__name__) from error
    if result.returncode == BOUNDARY_EXIT_CLEAN:
        return []
    if result.returncode != BOUNDARY_EXIT_HITS:
        raise GuardError("boundary scanner exit %d" % result.returncode)
    hits = json.loads(result.stdout).get("hits") or []
    shown = protocol.listed(["%s:%s (%s)" % (hit.get("file"), hit.get("line"), hit.get("rule")) for hit in hits])
    return [Violation(F_SECRETS, "Staged lines match a secret or private-address pattern: %s. Unstage or redact them." % shown, repo_key)]


def known_value_violations(read_lines, repo_key: str | None = None) -> list:
    """Overlay-listed secret values in the (path, line, text) triples `read_lines()` yields, called only when
    the overlay lists values; a hit never shows the value."""
    values = knownvalues.load(overlay_path(*KNOWN_VALUES_FILE))
    hits = knownvalues.find(read_lines(), values) if values else []
    if not hits:
        return []
    shown = protocol.listed([hit.describe() for hit in hits])
    return [Violation(F_SECRETS, "Known secret values written out: %s. Redact them." % shown, repo_key)]


def repo_rule_violations(repo_key: str | None, paths: list, actions: set) -> list:
    """The overlay repo-rules rows for this repo whose action is in `actions`; a deny-path row names the
    `paths` it matches and is met only when it matches one."""
    if repo_key is None:
        return []
    violations = []
    for rule in read_tsv(overlay_path("git-guard", "repo-rules.tsv"), REPO_RULES_HEADER):
        if rule["action"] not in actions or not fnmatch.fnmatchcase(repo_key, rule["origin_glob"]):
            continue
        matched = [path for path in paths if fnmatch.fnmatchcase(path, rule["pattern"])]
        if rule["action"] == ACTION_DENY_COMMIT:
            violations.append(Violation(rule["rule_id"], rule["message"], repo_key))
        elif matched:
            violations.append(Violation(rule["rule_id"], "%s (%s)" % (rule["message"], protocol.listed(matched)), repo_key))
    return violations


def protected_branches(repo_key: str | None) -> list:
    """The repo's integration base when the registry names one, then main and master."""
    base = find_integration_base(repo_key)
    return ([base] if base else []) + sorted(ALWAYS_PROTECTED_BRANCHES)


def find_integration_base(repo_key: str | None) -> str | None:
    for row in read_tsv(overlay_path("gated-repos.tsv"), GATED_REPOS_HEADER, GATED_REPOS_OPTIONAL):
        if repo_key and row["origin"].lower() == repo_key and row["integration_base"] != "-":
            return row["integration_base"]
    return None


@dataclass
class PushRequest:
    sources: list = field(default_factory=list)  # what the push sends: HEAD, branches, shas
    destinations: set = field(default_factory=set)  # the branch names it lands on
    force: bool = False
    force_with_lease: bool = False
    whole_repo: bool = False  # --all, --branches, --mirror


def read_push(args: list, branch: str | None) -> PushRequest:
    pushed = read_push_arguments(args)
    deletes = "--delete" in pushed.long_options or "d" in pushed.short_flags
    push = PushRequest(
        force="--force" in pushed.long_options or "f" in pushed.short_flags
        or any(spec.startswith("+") for spec in pushed.refspecs),
        force_with_lease=any(option.startswith("--force-with-lease") for option in pushed.long_options),
        whole_repo=pushed.whole_repo)
    if not pushed.refspecs and not deletes:
        push.sources, push.destinations = ["HEAD"], ({branch} if branch else set())
    for source, _, destination in (spec.lstrip("+").partition(":") for spec in pushed.refspecs):
        if deletes or not source:
            continue  # a deletion pushes no commits
        push.sources.append(source)
        destination = destination or source
        if destination == "HEAD":
            destination = branch or destination
        push.destinations.add(re.sub(r"^refs/heads/", "", destination))
    return push


class ProtectedStore:
    """Files only keel writes: the evidence store (K1) and the fires log the hooks stand on
    (F-hookskip), both under the data dir."""

    def __init__(self):
        roots = _spellings(data_dir())
        self.trees = [(os.path.join(root, "state", "keel"), K1) for root in roots]
        self.files = [(os.path.join(root, FIRES_LOG), F_HOOKSKIP) for root in roots]

    def rule_for(self, path: str) -> str | None:
        """The rule a write to `path` breaks, or None."""
        for candidate in _spellings(path):
            for tree, rule in self.trees:
                if candidate == tree or candidate.startswith(tree + os.sep):
                    return rule
            for file, rule in self.files:
                if candidate == file:
                    return rule
        return None


class LiveCheckouts:
    def __init__(self):
        checkouts = [path for path in (keel_home(), overlay_dir()) if os.path.isdir(path)]
        self.roots = [os.path.realpath(path) for path in checkouts]

    def root_of(self, path: str) -> str | None:
        for candidate in _spellings(path):
            for root in self.roots:
                if candidate == root or candidate.startswith(root + os.sep):
                    return root
        return None


def is_claude_settings_file(path: str) -> bool:
    directory, name = os.path.split(path)
    return os.path.basename(directory) == ".claude" and name.startswith("settings") and name.endswith(".json")


def fail_closed(raw: str, error: Exception) -> int:
    try:
        payload = json.loads(raw)
        session, command = payload.get("session_id"), protocol.tool_input(payload).get("command") or None
    except (ValueError, AttributeError):
        session = command = None
    FireLog(HOOK, session).append(F_ATTRIBUTION, "error", detail="%s: %s" % (type(error).__name__, error))
    if not LOOKS_GUARDED_RE.search(raw):
        return protocol.EXIT_PASS
    bullet = (F_ATTRIBUTION, "The guard could not check this commit, push, PR text or protected write (%s)." % type(error).__name__)
    return protocol.deny(protocol.format_message(HOOK, "internal error on a guarded command; refusing it", [bullet],
                                                 protocol.run_yourself(command) if command else protocol.ASK_USER))


def _commit_message_texts(args: list, step: Step, call_heredocs: list) -> list:
    """Every text the message can come from; any heredoc in the call may become it (`cat > m <<EOF`; `commit -F m`)."""
    texts = list(call_heredocs)
    for name, value in _commit_option_values(args):
        if name in COMMIT_MESSAGE_OPTIONS:
            texts.append(value)
        elif name in COMMIT_FILE_OPTIONS:
            texts.extend(_message_source_texts(value, step))
    return texts


def _commit_option_values(args: list) -> list:
    """(option name, value) for each value-taking `git commit` option before `--`."""
    pairs = []
    index = 0
    while index < len(args) and args[index] != "--":
        arg = args[index]
        option = _read_commit_option(arg) if arg.startswith("-") and arg != STDIN_PATH else CommitOption()
        if option.value_follows and index + 1 < len(args):
            pairs.append((option.value_name, args[index + 1]))
            index += 1
        elif option.attached_value is not None:
            pairs.append((option.value_name, option.attached_value))
        index += 1
    return pairs


def _read_message_files(args: list, options: set, step: Step) -> list:
    texts = []
    for index, arg in enumerate(args):
        if arg in options and index + 1 < len(args):
            texts.extend(_message_source_texts(args[index + 1], step))
        elif any(arg.startswith(option + "=") for option in options if option.startswith("--")):
            texts.extend(_message_source_texts(arg.split("=", 1)[1], step))
    return texts


def _message_source_texts(path: str, step: Step) -> list:
    resolved = resolve_directory(step.directory, path, step.expansion)
    if not os.path.isfile(resolved):
        return []
    with open(resolved, encoding="utf-8", errors="replace") as stream:
        return [stream.read()]


def _read_commit_option(arg: str) -> CommitOption:
    if arg.startswith("--"):
        name, has_inline_value, inline_value = arg.partition("=")
        value_name = name if name in COMMIT_LONG_VALUE_OPTIONS else None
        attached = inline_value if value_name and has_inline_value else None
        return CommitOption(stages=name in COMMIT_STAGING_LONG_OPTIONS, value_name=value_name, attached_value=attached)
    option = CommitOption()
    flags = arg[1:]
    for position, flag in enumerate(flags):
        if flag in COMMIT_STAGING_SHORT_FLAGS:
            option.stages = True
        elif flag == COMMIT_NO_VERIFY_SHORT_FLAG:
            option.skips_hooks = True
        elif flag in COMMIT_SHORT_VALUE_FLAGS:
            option.value_name = "-" + flag
            option.attached_value = flags[position + 1:] or None
            return option
        elif flag in COMMIT_SHORT_ATTACHED_VALUE_FLAGS:
            return option
    return option


def _git_text_or_raise(args: list, toplevel: str) -> str:
    """Output of a git command the scan cannot do without; a failure fails the guard closed."""
    result = git(args, toplevel)
    if result.returncode != 0:
        raise GuardError("git %s failed: %s" % (args[0], result.stderr.strip()[:120]))
    return result.stdout


def _live_root_of_write(live: LiveCheckouts, step: Step, path: str, call_directory: str) -> tuple[str | None, bool]:
    """(the live checkout a write lands in, whether it was judged where the call starts). A target that is itself
    unresolved cannot be placed; a target whose directory the hook cannot resolve (`cd "$(…)"`) is judged where
    the call starts, so a write that may land in the live checkout is not waved through."""
    if _is_unresolved(resolve_directory(os.sep, path, step.expansion)):
        return None, False
    resolved = resolve_directory(step.directory, path, step.expansion)
    if _is_unresolved(resolved):
        return live.root_of(call_directory), True
    return live.root_of(resolved), False


def _is_unresolved(resolved_path: str) -> bool:
    """A path that still holds a variable or command substitution after the call's and the hook's environment."""
    return "`" in resolved_path or "$" in resolved_path


def _spellings(path: str) -> list:
    """The path as given and as the filesystem resolves it (symlinked data dirs, /var vs /private/var)."""
    normalized = os.path.normpath(path)
    real = os.path.realpath(path)
    return [normalized] if real == normalized else [normalized, real]


def _unique(violations: list) -> list:
    """The first violation of each (rule, text)."""
    first = {}
    for violation in violations:
        first.setdefault((violation.rule_id, violation.text), violation)
    return list(first.values())


if __name__ == "__main__":
    sys.exit(main())
