"""Read a Bash command line into simple commands without running it: the one parser every hook uses.

Covers separators, quoting, `$(...)` and backtick bodies, heredocs and here-strings (code only when a
shell reads them), `bash -c` / `eval` strings, prefix assignments, redirects and wrapper words such as
`env` or `timeout`. A reader for policy checks, not a shell grammar: what it cannot follow stays words.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
SEPARATOR_OPS = ("&&", "||", "|&", ";;", ";", "|", "&", "(", ")")
REDIRECT_OPS = ("&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<>", "<&", ">", "<")
PIPE_OPS = {"|", "|&"}
WORD_BREAK = set(" \t\n;&|()<>")
KEYWORDS_AT_COMMAND_START = {"if", "then", "else", "elif", "fi", "while", "until", "do", "done", "!", "{", "}", "esac"}
IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
HEREDOC_START_RE = re.compile(r"<<(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|\\?([A-Za-z0-9_.-]+))")

FILE_WRITE_REDIRECTS = {">", ">>", ">|", "&>", "&>>", "<>"}
COPY_VERBS = {"cp", "mv", "install", "ln", "rsync"}
REMOVE_VERBS = {"rm", "rmdir", "unlink", "shred"}
CREATE_VERBS = {"touch", "truncate", "tee"}
IN_PLACE_EDITORS = {"sed", "perl"}
DASHED_GIT_PROGRAM_RE = re.compile(r"git-([a-z0-9][a-z0-9-]*)\Z")
RUN_TIME_WORD_RE = re.compile(r"[$`]")
TIME_FLAGS = {"-p"}
COMMAND_FLAGS = {"-p"}
EXEC_FLAGS, EXEC_VALUE_OPTIONS = {"-c", "-l"}, {"-a"}
NICE_VALUE_OPTIONS = {"-n", "--adjustment"}
TIMEOUT_FLAGS = {"--preserve-status", "--foreground", "-v", "--verbose"}
TIMEOUT_VALUE_OPTIONS = {"-k", "-s", "--kill-after", "--signal"}
# Not -D/--chdir, -R/--chroot or -i/--login: they move the command out of the call's directory, so they stay
# unattributable options.
SUDO_FLAGS = {"-A", "-b", "-E", "-H", "-k", "-n", "-P", "-S", "-s", "--askpass", "--background", "--preserve-env",
              "--set-home", "--reset-timestamp", "--non-interactive", "--preserve-groups", "--stdin", "--shell"}
SUDO_VALUE_OPTIONS = {"-C", "-g", "-h", "-p", "-r", "-T", "-t", "-U", "-u", "--close-from", "--group", "--host",
                      "--prompt", "--role", "--command-timeout", "--type", "--other-user", "--user"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path"}  # global options taking a value
PUSH_VALUE_OPTIONS = {"--push-option", "--receive-pack", "--exec"}
PUSH_OPTION_LETTER = "o"  # `-o <value>`, `-o<value>`, `-uo <value>`: the rest of the cluster, else the next word
PUSH_REPO_OPTION = "--repo"
WHOLE_REPO_PUSH_OPTIONS = {"--all", "--branches", "--mirror"}
GH_REPO_OPTIONS = {"-R", "--repo"}
GH_SUBCOMMAND_DEPTH = 2  # `pr merge`, `pr create`
CONFIG_READ_SUBCOMMANDS = {"get", "list"}
CONFIG_READ_OPTIONS = {"-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color",
                       "--get-colorbool"}
CONFIG_WRITE_SUBCOMMANDS = {"set", "unset", "rename-section", "remove-section", "edit"}
CONFIG_WRITE_OPTIONS = {"--unset", "--unset-all", "--remove-section", "--rename-section", "--add", "--replace-all",
                        "-e", "--edit"}
CONFIG_VALUE_OPTIONS = {"-f", "--file", "--blob", "-t", "--type", "--default", "--comment", "--value"}
VARIABLE_RE = re.compile(r"\$\{(\w+)\}|\$(\w+)")
VALUE_OPTIONS = {
    "cp": {"-t", "-S"},
    "mv": {"-t", "-S"},
    "install": {"-t", "-m", "-o", "-g", "-S"},
    "ln": {"-t", "-S"},
    "truncate": {"-s", "-r"},
    "sed": {"-e", "-f"},
    "perl": {"-e", "-E", "-M", "-I"},
}
# Inline Python/Node writes usually sit in a heredoc body or a -c string.
INLINE_WRITE_RE = re.compile(
    r"\bopen\((?:[^()\n]|\([^()\n]*\))*,\s*(?:mode\s*=\s*)?['\"][wax][tb+]*['\"]"
    r"|\.open\(\s*(?:mode\s*=\s*)?['\"][wax][tb+]*['\"]"
    r"|\.write_(?:text|bytes)\(|\b(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\("
)


@dataclass
class Redirect:
    op: str
    target: str


class _Named:
    @property
    def name(self) -> str:
        """The command word without its directory."""
        return os.path.basename(self.argv[0]) if self.argv else ""


@dataclass
class SimpleCommand(_Named):
    argv: list = field(default_factory=list)
    assignments: list = field(default_factory=list)  # [(name, value)] written before the command word
    redirects: list = field(default_factory=list)
    heredocs: list = field(default_factory=list)  # bodies, in order
    nested: bool = False  # inside $(...), backticks, bash -c, eval or a shell-fed heredoc
    pipes_to_next: bool = False
    parent: "SimpleCommand | None" = None  # the command whose code string or substitution this one came from


@dataclass
class Step(_Named):
    """One simple command as the hooks judge it: wrappers off, with the directory and environment it runs in."""

    argv: list
    environment: dict  # variables exported earlier in the call, then this command's own prefix assignments
    directory: str
    command: SimpleCommand
    expansion: dict = field(default_factory=dict)  # shell variables bash expands this command's words with
    unattributable_options: list = field(default_factory=list)  # see Invocation

    @property
    def heredocs(self) -> list:
        return self.command.heredocs


@dataclass
class Invocation(_Named):
    """A command with its wrapper words (`env`, `nohup`, `timeout`, ...) taken off."""

    argv: list
    assignments: list
    clears_env: bool = False
    removed_names: set = field(default_factory=set)
    # Wrapper options read past as flags: unknown ones, and sudo's -D, -R and -i, which run the command elsewhere.
    # With any, argv and the directory are a best guess.
    unattributable_options: list = field(default_factory=list)

    def drops_inherited(self, variable: str) -> bool:
        return self.clears_env or variable in self.removed_names


@dataclass
class PushArguments:
    """The words after `git push`, read the way git reads them."""

    remote: str | None = None  # a remote name or URL; None: the current branch's push remote
    refspecs: list = field(default_factory=list)  # as given, `+` and `:` included
    long_options: list = field(default_factory=list)  # `--force`, `--force-with-lease=main`, ...
    short_flags: str = ""  # the letters of every `-xyz` cluster

    @property
    def whole_repo(self) -> bool:
        return bool(WHOLE_REPO_PUSH_OPTIONS.intersection(self.long_options))


@dataclass
class WriteTargets:
    written: list = field(default_factory=list)
    removed: list = field(default_factory=list)
    sources: list = field(default_factory=list)  # files whose content the written targets receive (cp, mv, ln, ...)
    unknown: bool = False  # writes files it does not name (git apply, patch)

    def any(self) -> bool:
        return bool(self.written or self.removed or self.unknown)


def parse_commands(text: str) -> list:
    """Every simple command in `text`: top-level ones first in order, then nested ones (after their parent)."""
    commands = []
    _Reader(text, nested=False, out=commands).read()
    _expand_code_strings(commands)
    return commands


def steps(text: str, cwd: str) -> list:
    """Every simple command of a Bash call with the directory and environment it runs in.

    `cd`, `pushd`/`popd` and `export` are followed within each shell; a script a command runs
    (`bash -c`, `eval`, `$(...)`, a shell-fed heredoc) starts where that command stood.
    """
    scopes = {None: _ShellScope(cwd, {})}  # id of the command whose script it is (None: the call) -> scope
    step_of = {}  # id of a command -> its step, in call order
    for command in parse_commands(text):
        script = None if command.parent is None else id(command.parent)
        if script not in scopes:
            scopes[script] = _ShellScope(step_of[script].directory, step_of[script].environment)
        scope = scopes[script]
        invocation = unwrap(command)
        environment = {} if invocation.clears_env else dict(scope.exported)
        environment.update(invocation.assignments)
        step_of[id(command)] = Step(invocation.argv, environment, scope.directory, command, scope.expansion(),
                                    invocation.unattributable_options)
        scope.follow(invocation)
    return list(step_of.values())


class _ShellScope:
    """Directory and exported variables of one shell: the call itself, or a script a command runs."""

    def __init__(self, directory: str, exported: dict):
        self.directory = directory
        self.exported = dict(exported)
        self.variables = {}  # plain `NAME=value` assignments: expanded in later words, never passed to a child
        self.pushed = []

    def expansion(self) -> dict:
        return {**self.variables, **self.exported}

    def follow(self, invocation: "Invocation") -> None:
        name, args = invocation.name, invocation.argv[1:]
        if name == "cd":
            self.directory = self._changed_directory(args)
        elif name == "pushd" and args:
            self.pushed.append(self.directory)
            self.directory = self._changed_directory(args)
        elif name == "popd" and self.pushed:
            self.directory = self.pushed.pop()
        elif name == "export":
            self._export(args)
        elif not invocation.argv:
            self._assign(invocation.assignments)

    def _export(self, args: list) -> None:
        """`export NAME=value` sets and exports; `export NAME` exports the plain variable's current value."""
        for arg in args:
            variable, has_value, value = arg.partition("=")
            if has_value:
                self.exported[variable] = value
            elif variable in self.variables:
                self.exported[variable] = self.variables.pop(variable)

    def _assign(self, assignments: list) -> None:
        """A plain `NAME=value`: the last assignment wins, so an exported NAME keeps being exported with it."""
        for variable, value in assignments:
            target = self.exported if variable in self.exported else self.variables
            target[variable] = value

    def _changed_directory(self, args: list) -> str:
        target = args[0] if args else "~"
        if target == "-":
            return self.directory
        return resolve_directory(self.directory, target, self.expansion())


def resolve_directory(directory: str, target: str, environment: dict) -> str:
    """`target` (a `cd` or `git -C` directory, a file a command writes or reads) as a path from `directory`: `~`,
    `$VAR` and `${VAR}` spelled out from `environment` over the hook's own; a variable neither knows stays as written."""
    # Not the hook's own PWD/OLDPWD: those name the hook process's directory, not the step's.
    known = {**{name: value for name, value in os.environ.items() if name not in ("PWD", "OLDPWD")}, "PWD": directory,
             **environment}
    expanded = VARIABLE_RE.sub(lambda match: known.get(match.group(1) or match.group(2), match.group(0)), target)
    return os.path.normpath(os.path.join(directory, os.path.expanduser(expanded)))


def git_directory(argv: list, directory: str, environment: dict) -> str:
    """The checkout a `git …` argv acts on: `directory` moved by each `-C` before the subcommand."""
    words = iter(argv[1:git_subcommand_index(argv)])
    for word in words:
        if word == "-C":
            directory = resolve_directory(directory, next(words, "."), environment)
    return directory


def gh_subcommand_argv(argv: list) -> list:
    """A `gh …` argv with each -R/--repo given before the subcommand words moved behind them, so
    `gh -R o/r pr merge 7` and `gh pr -R o/r merge 7` both read as `gh pr merge 7 -R o/r`."""
    head, moved, rest = argv[:1], [], argv[1:]
    while rest and len(head) <= GH_SUBCOMMAND_DEPTH:
        if rest[0] in GH_REPO_OPTIONS:
            moved, rest = moved + rest[:2], rest[2:]
        elif attached_gh_repo(rest[0]) is not None:
            moved, rest = moved + rest[:1], rest[1:]
        else:
            head, rest = head + rest[:1], rest[1:]
    return head + rest + moved


def attached_gh_repo(word: str) -> str | None:
    """The repo of a gh repo flag that carries its value: `--repo=o/r`, `-Ro/r` or `-R=o/r`; None for any other word."""
    if word.startswith("--repo="):
        return word.partition("=")[2]
    if word.startswith("-R") and len(word) > 2:
        return word[2:].removeprefix("=")
    return None


def read_push_arguments(args: list) -> PushArguments:
    """The words after `git push`: a value-taking option drops its value; every word after `--` is positional;
    `--repo` names the remote only when no remote word is given (git-push(1))."""
    pushed, positional, repo_option = PushArguments(), [], None
    words = iter(args)
    for word in words:
        if word == PUSH_REPO_OPTION:
            repo_option = next(words, None)
        elif word.startswith(PUSH_REPO_OPTION + "="):
            repo_option = word.partition("=")[2]
        elif word in PUSH_VALUE_OPTIONS:
            next(words, None)
        elif word == "--":
            positional.extend(words)
        elif word.startswith("--"):
            pushed.long_options.append(word)
        elif word.startswith("-"):
            flags, takes_value, attached_value = word[1:].partition(PUSH_OPTION_LETTER)
            pushed.short_flags += flags
            if takes_value and not attached_value:
                next(words, None)
        else:
            positional.append(word)
    pushed.remote, pushed.refspecs = (positional[0], positional[1:]) if positional else (repo_option, [])
    return pushed


def is_config_read(args: list) -> bool:
    """`git config <args>` only reads: the get or list subcommand, a read option, or at most one name with no
    write subcommand or option (git-config(1))."""
    subcommand = args[0] if args else None
    if subcommand in CONFIG_READ_SUBCOMMANDS or CONFIG_READ_OPTIONS.intersection(args):
        return True
    writes = subcommand in CONFIG_WRITE_SUBCOMMANDS or CONFIG_WRITE_OPTIONS.intersection(args)
    return not writes and len(_config_operands(args)) <= 1


def config_key(args: list) -> str | None:
    """The key (or section) `git config <args>` names: its first operand after a leading subcommand, option values
    skipped; None when it names none."""
    subcommands = CONFIG_READ_SUBCOMMANDS | CONFIG_WRITE_SUBCOMMANDS
    rest = args[1:] if args and args[0] in subcommands else args
    return next(iter(_config_operands(rest)), None)


def _config_operands(args: list) -> list:
    """The words of `git config <args>` that are neither an option nor an option's separate value."""
    operands, words = [], iter(args)
    for word in words:
        if word in CONFIG_VALUE_OPTIONS:
            next(words, None)
        elif not word.startswith("-"):
            operands.append(word)
    return operands


def unwrap(command: SimpleCommand) -> Invocation:
    invocation = Invocation(argv=list(command.argv), assignments=list(command.assignments))
    while invocation.argv:
        before = list(invocation.argv)
        _drop_one_wrapper(invocation)
        if invocation.argv == before:
            break
    _read_dashed_git_as_git(invocation)
    return invocation


def _read_dashed_git_as_git(invocation: Invocation) -> None:
    """`git-push …` runs as `git push …`; a program word resolved at run time stays as written."""
    if not invocation.argv or RUN_TIME_WORD_RE.search(invocation.argv[0]):
        return
    subcommand = dashed_git_subcommand(invocation.argv[0])
    if subcommand:
        invocation.argv = ["git", subcommand] + invocation.argv[1:]


def write_targets(command: SimpleCommand) -> WriteTargets:
    targets = WriteTargets(written=_redirect_targets(command))
    invocation = unwrap(command)
    verb = invocation.name
    args = invocation.argv[1:]
    if verb in COPY_VERBS:
        _add_copy_targets(targets, verb, args)
    elif verb in REMOVE_VERBS:
        targets.removed.extend(_operands(verb, args))
    elif verb in CREATE_VERBS:
        targets.written.extend(_operands(verb, args))
    elif verb in IN_PLACE_EDITORS and _edits_in_place(args):
        targets.written.extend(operand for operand in _operands(verb, args) if operand)
    elif verb == "dd":
        targets.written.extend(arg[len("of="):] for arg in args if arg.startswith("of="))
    elif verb == "patch" or _git_subcommand(invocation.argv) in {"apply", "am"}:
        targets.unknown = True
    return targets


def command_writes_files(text: str, except_under: tuple = ()) -> bool:
    """True when a Bash command line writes or removes files (report-gate's mutation signal).

    `except_under` lists directory prefixes whose files do not count; an inline write, a write the
    parser cannot place (`git apply`, `patch`) or a relative target always counts.
    """
    if INLINE_WRITE_RE.search(text):
        return True
    for command in parse_commands(text):
        targets = write_targets(command)
        expanded = [os.path.expanduser(os.path.expandvars(path)) for path in targets.written + targets.removed]
        if targets.unknown or any(not path.startswith(except_under) for path in expanded):
            return True
    return False


def git_subcommand_index(argv: list) -> int | None:
    """Index of the subcommand word of a `git ...` argv, global options skipped; None for any other command."""
    if not argv or os.path.basename(argv[0]) != "git":
        return None
    index = 1
    while index < len(argv):
        if argv[index] in GIT_VALUE_OPTIONS:
            index += 2
        elif argv[index].startswith("-"):
            index += 1
        else:
            return index
    return None


def dashed_git_subcommand(word: str) -> str | None:
    """`push` for git's own `git-push` program at any path; None for any other word."""
    match = DASHED_GIT_PROGRAM_RE.match(os.path.basename(word))
    return match.group(1) if match else None


def _git_subcommand(argv: list) -> str | None:
    index = git_subcommand_index(argv)
    return None if index is None else argv[index]


def _redirect_targets(command: SimpleCommand) -> list:
    """Files the redirects write; `>&` onto a descriptor number or `-` writes none."""
    return [redirect.target for redirect in command.redirects
            if redirect.target != "/dev/null" and (redirect.op in FILE_WRITE_REDIRECTS or (
                redirect.op == ">&" and not (redirect.target.isdigit() or redirect.target == "-")))]


def _add_copy_targets(targets: WriteTargets, verb: str, args: list) -> None:
    explicit_dir = _target_directory_option(args)
    operands = _operands(verb, args)
    if explicit_dir:
        destination, sources = explicit_dir, operands
    elif len(operands) >= 2:
        destination, sources = operands[-1], operands[:-1]
    else:
        destination, sources = None, []
    if destination:
        # Not knowing whether the destination is a directory, name both readings: a file
        # copied into a directory lands at destination/<its basename>.
        targets.written.append(destination)
        targets.written.extend(os.path.join(destination, os.path.basename(source.rstrip("/"))) for source in sources)
    targets.sources.extend(sources)
    if verb == "mv":
        targets.removed.extend(sources)


def _target_directory_option(args: list) -> str | None:
    for index, arg in enumerate(args):
        if arg == "-t" and index + 1 < len(args):
            return args[index + 1]
        if arg.startswith("--target-directory="):
            return arg.split("=", 1)[1]
    return None


def _operands(verb: str, args: list) -> list:
    takes_value = VALUE_OPTIONS.get(verb, set())
    operands = []
    index = 0
    options_done = False
    while index < len(args):
        arg = args[index]
        if not options_done and arg == "--":
            options_done = True
        elif not options_done and arg in takes_value:
            index += 1
        elif options_done or not arg.startswith("-") or arg == "-":
            operands.append(arg)
        index += 1
    return operands


def _edits_in_place(args: list) -> bool:
    return any(arg.startswith("--in-place") or (re.match(r"-[a-zA-Z]*i", arg) and not arg.startswith("--")) for arg in args)


def _drop_one_wrapper(invocation: Invocation) -> None:
    name = invocation.name
    rest = invocation.argv[1:]
    if name == "time":
        invocation.argv = _command_after_options(invocation, rest, TIME_FLAGS, set())
    elif name == "nohup":
        invocation.argv = _command_after_options(invocation, rest, set(), set())
    elif name == "command" and not (rest and rest[0] in {"-v", "-V"}):
        invocation.argv = _command_after_options(invocation, rest, COMMAND_FLAGS, set())
    elif name == "exec":
        invocation.argv = _exec_command(invocation, rest)
    elif name == "nice":
        invocation.argv = _nice_command(invocation, rest)
    elif name == "env":
        invocation.argv = _env_command(invocation, rest)
    elif name in {"timeout", "gtimeout"}:
        invocation.argv = _command_after_options(invocation, rest, TIMEOUT_FLAGS, TIMEOUT_VALUE_OPTIONS)[1:]  # then the duration
    elif name == "sudo":
        invocation.clears_env = True
        invocation.argv = _command_after_options(invocation, rest, SUDO_FLAGS, SUDO_VALUE_OPTIONS)


def _command_after_options(invocation: Invocation, args: list, flags: set, value_options: set) -> list:
    return _options_and_command(invocation, args, flags, value_options)[1]


def _options_and_command(invocation: Invocation, args: list, flags: set, value_options: set) -> tuple:
    """The known options a wrapper puts before its command, as {option: value, or None for a flag}, and `args` after
    them. An option outside `flags` and `value_options` (a cluster such as `-iu` included) is read past as a flag and
    recorded as unattributable."""
    options = {}
    while args and args[0].startswith("-"):
        word = args[0]
        if word == "--":
            return options, args[1:]
        if word in value_options:
            options[word] = args[1] if len(args) > 1 else ""
            args = args[2:]
            continue
        known = _known_option(word, flags, value_options)
        if known:
            options[known[0]] = known[1]
        else:
            invocation.unattributable_options.append(word)
        args = args[1:]
    return options, args


def _known_option(word: str, flags: set, value_options: set) -> tuple | None:
    """(option, value) for a flag or a known option with its value attached (`--user=bob`, `--preserve-env=PATH`,
    `-ubob`); None for any other word."""
    if word in flags:
        return word, None
    if word.startswith("--"):
        name, has_value, value = word.partition("=")
        return (name, value) if has_value and name in flags | value_options else None
    return (word[:2], word[2:]) if word[:2] in value_options else None


def _exec_command(invocation: Invocation, args: list) -> list:
    options, command = _options_and_command(invocation, args, EXEC_FLAGS, EXEC_VALUE_OPTIONS)
    if "-c" in options:
        invocation.clears_env = True
        invocation.assignments = []
    argv0 = options.get("-a", "")
    if command and os.path.basename(command[0]) == "git":
        if dashed_git_subcommand(argv0):
            return [argv0] + command[1:]  # git runs the subcommand its argv[0] names: `exec -a git-push git …`
        if RUN_TIME_WORD_RE.search(argv0):
            invocation.unattributable_options.append("-a")  # the subcommand git runs is known only at run time
    return command


def _nice_command(invocation: Invocation, args: list) -> list:
    if args and re.fullmatch(r"--?\d+", args[0]):
        return args[1:]
    return _command_after_options(invocation, args, set(), NICE_VALUE_OPTIONS)


def _env_command(invocation: Invocation, args: list) -> list:
    """env's command after its assignments and options; one it does not read (`--chdir`, `-S`) is read past as a flag
    and recorded as unattributable."""
    while args:
        word = args[0]
        if word in {"-i", "-", "--ignore-environment"}:
            invocation.clears_env = True
            invocation.assignments = []
            args = args[1:]
        elif word == "-u" and len(args) > 1:
            invocation.removed_names.add(args[1])
            args = args[2:]
        elif word.startswith("-u") and len(word) > 2:
            invocation.removed_names.add(word[2:])
            args = args[1:]
        elif word == "--":
            return args[1:]
        elif word.startswith("-"):
            invocation.unattributable_options.append(word)
            args = args[1:]
        elif "=" in word and IDENTIFIER_RE.match(word.split("=", 1)[0]):
            invocation.assignments.append(tuple(word.split("=", 1)))
            args = args[1:]
        else:
            break
    return args


def _expand_code_strings(commands: list) -> None:
    """Parse the strings a shell runs (bash -c, eval, a heredoc fed to a shell) as nested commands."""
    index = 0
    while index < len(commands):
        command = commands[index]
        for code in _code_strings(commands, index):
            nested = []
            _Reader(code, nested=True, out=nested, parent=command).read()
            commands.extend(nested)
        index += 1


def _code_strings(commands: list, index: int) -> list:
    command = commands[index]
    invocation = unwrap(command)
    name = invocation.name
    args = invocation.argv[1:]
    if name == "eval":
        return [" ".join(args)]
    if name in {"source", "."} and args and args[0] in {"/dev/stdin", "/dev/fd/0"}:
        return list(command.heredocs)
    if name not in SHELLS:
        return []
    for position, arg in enumerate(args):
        if re.fullmatch(r"-[a-zA-Z]*c[a-zA-Z]*", arg) and position + 1 < len(args):
            return [args[position + 1]]
    if any(not arg.startswith("-") for arg in args):
        return []  # runs a script file
    here_strings = [redirect.target for redirect in command.redirects if redirect.op == "<<<"]
    return list(command.heredocs) + here_strings + _heredocs_piped_into(commands, index)


def _heredocs_piped_into(commands: list, index: int) -> list:
    bodies = []
    previous = index - 1
    while previous >= 0 and commands[previous].pipes_to_next:
        bodies = list(commands[previous].heredocs) + bodies
        previous -= 1
    return bodies


class _Reader:
    """Single pass over one command string; appends finished SimpleCommands to `out`."""

    def __init__(self, text: str, nested: bool, out: list, parent: SimpleCommand | None = None):
        self.text = text
        self.position = 0
        self.nested = nested
        self.out = out
        self.parent = parent
        self.substitutions = []  # [(body, the command whose word holds it)]
        self.pending_heredocs = []
        self.current = SimpleCommand(nested=nested, parent=parent)

    def read(self) -> None:
        while self.position < len(self.text):
            self._read_next()
        self._finish_command(pipes_to_next=False)
        for body, owner in self.substitutions:
            _Reader(body, nested=True, out=self.out, parent=owner).read()

    def _read_next(self) -> None:
        text, position = self.text, self.position
        char = text[position]
        if text.startswith("\\\n", position):
            self.position += 2
        elif char == "\n":
            self._finish_command(pipes_to_next=False)
            self.position += 1
            self._read_heredoc_bodies()
        elif char in " \t":
            self.position += 1
        elif char == "#":
            end = text.find("\n", position)
            self.position = len(text) if end < 0 else end
        elif text.startswith(("<(", ">("), position):
            body, self.position = _read_balanced(text, position + 2)
            self._own_substitutions([body])
            self._add_word(text[position:self.position], quoted=True)
        elif self._read_operator():
            return
        else:
            self._read_word_or_fd()

    def _read_operator(self) -> bool:
        text, position = self.text, self.position
        for op in REDIRECT_OPS:
            if text.startswith(op, position) and not text.startswith("&&", position):
                self.position += len(op)
                self._read_redirect_target(op)
                return True
        for op in SEPARATOR_OPS:
            if text.startswith(op, position):
                self.position += len(op)
                self._finish_command(pipes_to_next=op in PIPE_OPS)
                return True
        return False

    def _read_redirect_target(self, op: str) -> None:
        while self.position < len(self.text) and self.text[self.position] in " \t":
            self.position += 1
        word, _, self.position = self._read_word_here()
        if op in {"<<", "<<-"}:
            self.pending_heredocs.append((self.current, word, op == "<<-"))
            return
        self.current.redirects.append(Redirect(op=op, target=word))

    def _read_word_or_fd(self) -> None:
        start = self.position
        word, quoted, self.position = self._read_word_here()
        is_fd_number = word.isdigit() and not quoted and self.text[self.position:self.position + 1] in ("<", ">")
        if not is_fd_number:
            self._add_word(word, quoted, assignment_name=_assignment_name(self.text[start:self.position]))

    def _read_word_here(self):
        found = []
        word, quoted, end = _read_word(self.text, self.position, found)
        self._own_substitutions(found)
        return word, quoted, end

    def _own_substitutions(self, bodies: list) -> None:
        self.substitutions.extend((body, self.current) for body in bodies)

    def _add_word(self, word: str, quoted: bool, assignment_name: str | None = None) -> None:
        command = self.current
        at_start = not command.argv
        if at_start and not command.assignments and not quoted and word in KEYWORDS_AT_COMMAND_START:
            return
        if at_start and assignment_name:
            command.assignments.append((assignment_name, word[len(assignment_name) + 1:]))
            return
        command.argv.append(word)

    def _finish_command(self, pipes_to_next: bool) -> None:
        if self.current.argv or self.current.assignments or self.current.redirects:
            self.current.pipes_to_next = pipes_to_next
            self.out.append(self.current)
        self.current = SimpleCommand(nested=self.nested, parent=self.parent)

    def _read_heredoc_bodies(self) -> None:
        for command, delimiter, strip_tabs in self.pending_heredocs:
            body, self.position = _read_heredoc_body(self.text, self.position, delimiter, strip_tabs)
            command.heredocs.append(body)
        self.pending_heredocs = []


def _assignment_name(raw_word: str) -> str | None:
    """`NAME` when the raw word begins `NAME=` with no quoting before the `=`."""
    match = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=", raw_word)
    return match.group(1) if match else None


def _read_word(text: str, start: int, substitutions: list):
    """(word with quotes removed, whether any part was quoted, end index). `$(...)` stays verbatim."""
    parts = []
    quoted = False
    position = start
    while position < len(text):
        char = text[position]
        if char in WORD_BREAK:
            break
        if char == "\\":
            if text.startswith("\\\n", position):
                position += 2
                continue
            parts.append(text[position + 1:position + 2])
            position += 2
        elif char == "'":
            end = text.find("'", position + 1)
            end = len(text) if end < 0 else end
            parts.append(text[position + 1:end])
            quoted = True
            position = end + 1
        elif char == '"':
            content, position = _read_double_quoted(text, position + 1, substitutions)
            parts.append(content)
            quoted = True
        elif text.startswith("$((", position):
            _, end = _read_balanced(text, position + 2)
            parts.append(text[position:end])
            position = end
        elif text.startswith("${", position):
            end = text.find("}", position)
            end = len(text) if end < 0 else end + 1
            parts.append(text[position:end])
            position = end
        else:
            part, position = _read_substitution(text, position, substitutions) or (char, position + 1)
            parts.append(part)
    return "".join(parts), quoted, position


def _read_double_quoted(text: str, start: int, substitutions: list):
    parts = []
    position = start
    while position < len(text):
        char = text[position]
        if char == '"':
            return "".join(parts), position + 1
        if char == "\\" and position + 1 < len(text):
            following = text[position + 1]
            parts.append(following if following in '"\\$`' else "\\" + following)
            position += 2
        else:
            part, position = _read_substitution(text, position, substitutions) or (char, position + 1)
            parts.append(part)
    return "".join(parts), position


def _read_substitution(text: str, position: int, substitutions: list):
    """(verbatim text, end index) of the `$(...)` or backtick substitution starting at `position`, its body
    added to `substitutions`; None when none starts there."""
    if text.startswith("$(", position) and not text.startswith("$((", position):
        body, end = _read_balanced(text, position + 2)
        verbatim = text[position:end]
    elif text[position] == "`":
        close = text.find("`", position + 1)
        close = len(text) if close < 0 else close
        body, verbatim, end = text[position + 1:close], text[position:close + 1], close + 1
    else:
        return None
    substitutions.append(body)
    return verbatim, end


def _read_balanced(text: str, start: int):
    """(body, index after the closing paren) for a `(` opened just before `start`; heredoc-aware."""
    depth = 1
    position = start
    pending_delimiters = []
    while position < len(text):
        char = text[position]
        heredoc = HEREDOC_START_RE.match(text, position)
        if heredoc:
            pending_delimiters.append((next(group for group in heredoc.groups()[1:] if group is not None), heredoc.group(1) == "-"))
            position = heredoc.end()
        elif char == "\n" and pending_delimiters:
            position += 1
            for delimiter, strip_tabs in pending_delimiters:
                _, position = _read_heredoc_body(text, position, delimiter, strip_tabs)
            pending_delimiters = []
        elif char == "\\":
            position += 2
        elif char == "'":
            end = text.find("'", position + 1)
            position = len(text) if end < 0 else end + 1
        elif char == '"':
            _, position = _read_double_quoted(text, position + 1, [])
        elif char == "(":
            depth += 1
            position += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return text[start:position], position + 1
            position += 1
        else:
            position += 1
    return text[start:], len(text)


def _read_heredoc_body(text: str, start: int, delimiter: str, strip_tabs: bool):
    lines = []
    position = start
    while position < len(text):
        end = text.find("\n", position)
        end = len(text) if end < 0 else end
        line = text[position:end]
        position = end + 1
        if (line.lstrip("\t") if strip_tabs else line) == delimiter:
            return "\n".join(lines), position
        lines.append(line)
    return "\n".join(lines), len(text)
