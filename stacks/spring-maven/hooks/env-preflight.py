#!/usr/bin/env python3
"""env-preflight: a Maven build runs on the JDK its repo requires ([S-jdk]).

A `mvn` / `mvnw` build in a repo listed in overlay `stack-data/spring-maven/jdk.tsv` must pin
JAVA_HOME to that JDK major in the command line itself: a JAVA_HOME assignment on the mvn command
(it alone decides), or an exported JAVA_HOME written before it. A wrapper that drops the environment
(env -i, env -u JAVA_HOME, exec -c, sudo) lets only an assignment after its options count.
"""
from __future__ import annotations

import collections
import copy
import fnmatch
import os
import platform
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "hooks", "lib"))

from hookkit import protocol  # noqa: E402
from hookkit.env import overlay_path  # noqa: E402
from hookkit.fires import FireLog  # noqa: E402
from hookkit.overlay import read_tsv  # noqa: E402
from hookkit.repo import find_repo_key, find_superproject, find_toplevel  # noqa: E402
from hookkit.shell import parse_commands, unwrap  # noqa: E402

HOOK = "env-preflight"
RULE = "S-jdk"
JDK_MAP_HEADER = ("origin_glob", "jdk")
MAVEN_COMMANDS = {"mvn", "mvnw"}
VERSION_QUERY_FLAGS = {"-v", "--version", "-version"}
DIRECTORY_MOVING_OPTIONS = {"-C", "--chdir", "-D", "-R", "--chroot", "-i", "--login"}  # env -C, sudo -D/-R/-i
EXPORT_COMMANDS = {"export", "declare", "typeset"}
JAVA_HOME = "JAVA_HOME"
VARIABLE_REFERENCE_RE = re.compile(r"\A\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\Z")
JDK_VENDOR_WORDS = r"(?:jdk|java|temurin|zulu|corretto|openjdk)"


class ShellState:
    """JAVA_HOME as the shell sees it, statement by statement, before a given command."""

    def __init__(self):
        self.java_home = None
        self.exported = False
        self.variables = {}

    def apply(self, command) -> None:
        invocation = unwrap(command)
        if not invocation.argv:
            self.variables.update(command.assignments)
            self.java_home = dict(command.assignments).get(JAVA_HOME, self.java_home)
            return
        name, args = invocation.name, invocation.argv[1:]
        if name in EXPORT_COMMANDS:
            self._apply_export(name, args)
        elif name == "unset" and JAVA_HOME in args:
            self.java_home, self.exported = None, False

    def _apply_export(self, name: str, args: list) -> None:
        if name != "export" and "-x" not in args:
            return
        if "-n" in args and JAVA_HOME in args:
            self.exported = False
            return
        for arg in args:
            variable, has_value, value = arg.partition("=")
            if variable == JAVA_HOME:
                self.exported = True
                if has_value:
                    self.java_home = value

    def resolve(self, value: str) -> str:
        """Follow one `$VAR` indirection to a value assigned earlier in the command line."""
        reference = VARIABLE_REFERENCE_RE.match(value)
        return self.variables.get(reference.group(1), value) if reference else value


def main() -> int:
    try:
        payload = protocol.parse_payload(sys.stdin.read())
    except ValueError:
        return protocol.EXIT_PASS  # unparseable payload: nothing to check
    fires = FireLog(HOOK, payload.get("session_id"))
    try:
        return check_maven_jdk(payload, fires)
    except Exception as error:  # noqa: BLE001 - registered as "pass, logged" (DESIGN (g))
        fires.append(RULE, "error", detail="%s: %s" % (type(error).__name__, error))
        return protocol.EXIT_PASS


def check_maven_jdk(payload: dict, fires: FireLog) -> int:
    command_line = str(protocol.tool_input(payload).get("command") or "")
    if protocol.tool_name(payload) != "bash" or "mvn" not in command_line:
        return protocol.EXIT_PASS
    cwd = str(payload.get("cwd") or os.getcwd())
    builds = find_maven_builds(parse_commands(command_line), cwd)
    if not builds:
        return protocol.EXIT_PASS
    for build in builds:
        required = required_jdk(build.directory)
        if required is None:
            continue
        repo_key, major = required
        if not pins_jdk(build, major):
            fires.append(RULE, "deny", repo=repo_key, detail="mvn without JDK %s" % major)
            retry = retry_command(command_line, build, major, cwd)
            return protocol.deny(deny_message(build, major, repo_key, retry))
        fires.append(RULE, "pass", repo=repo_key)
    return protocol.EXIT_PASS


MavenBuild = collections.namedtuple("MavenBuild", "command invocation state directory is_first")


def find_maven_builds(commands: list, cwd: str) -> list:
    """Each mvn build with the shell state and directory it runs in."""
    builds = []
    state = ShellState()
    directory = cwd
    top_level_index = 0
    for command in commands:
        invocation = unwrap(command)
        is_build = invocation.name in MAVEN_COMMANDS and not VERSION_QUERY_FLAGS.intersection(invocation.argv[1:2])
        if is_build and not runs_elsewhere(invocation):
            builds.append(MavenBuild(command, invocation, copy.deepcopy(state), cwd if command.nested else directory,
                                     is_first=not command.nested and top_level_index == 0))
        if command.nested:
            continue
        state.apply(command)
        if invocation.name == "cd" and len(invocation.argv) > 1:
            directory = os.path.normpath(os.path.join(directory, os.path.expanduser(invocation.argv[1])))
        top_level_index += 1
    return builds


def runs_elsewhere(invocation) -> bool:
    """A wrapper option the parser read past moves the command out of the call's directory (`env --chdir=…`,
    `sudo -nD/tmp`); any letter of a short cluster counts."""
    for option in invocation.unattributable_options:
        names = {option.partition("=")[0]} if option.startswith("--") else {"-" + letter for letter in option[1:]}
        if names & DIRECTORY_MOVING_OPTIONS:
            return True
    return False


def required_jdk(directory: str):
    """(repo key, JDK major) from overlay data for the repo (or its superproject), else None."""
    if not os.path.isdir(directory):
        return None
    toplevel = find_toplevel(directory)
    if toplevel is None:
        return None
    rows = read_tsv(overlay_path("stack-data", "spring-maven", "jdk.tsv"), JDK_MAP_HEADER)
    if not rows:
        return None
    superproject = find_superproject(toplevel)
    for candidate in (toplevel, superproject):
        key = find_repo_key(candidate) if candidate else None
        for row in rows:
            if key and fnmatch.fnmatchcase(key, row["origin_glob"]):
                return key, row["jdk"]
    return None


def pins_jdk(build: MavenBuild, major: str) -> bool:
    own = [value for name, value in build.invocation.assignments if name == JAVA_HOME]
    if own:
        return names_jdk(build.state.resolve(own[-1]), major)
    if build.invocation.drops_inherited(JAVA_HOME):
        return False
    return build.state.exported and build.state.java_home is not None and names_jdk(
        build.state.resolve(build.state.java_home), major)


def names_jdk(value: str, major: str) -> bool:
    """`java_home -v N` (a lookup tool answering N) or a JDK path naming major N (jdk-N, temurin-N...)."""
    escaped = re.escape(major)
    lookup = re.search(r"java_home\s+(?:-v\s*|--version[\s=]+)%s(?:\.0)?(?![0-9.+*])" % escaped, value)
    path = re.search(r"%s[-_.@/]?%s(?![0-9])" % (JDK_VENDOR_WORDS, escaped), value, re.I)
    return bool(lookup or path)


def retry_command(command_line: str, build: MavenBuild, major: str, cwd: str):
    """The first rewrite of the line under which every mvn build in it pins JDK `major`, else None."""
    pin = java_home_pin(major)
    line = command_line.strip()
    candidates = ["%s=%s %s" % (JAVA_HOME, pin, line), "export %s=%s; %s" % (JAVA_HOME, pin, line)]
    candidates += [line.replace("%s=%s" % (JAVA_HOME, value), "%s=%s" % (JAVA_HOME, pin), 1)
                   for name, value in build.invocation.assignments if name == JAVA_HOME]
    for candidate in candidates:
        builds = find_maven_builds(parse_commands(candidate), cwd)
        if builds and all(pins_jdk(rebuilt, major) for rebuilt in builds):
            return candidate
    return None


def deny_message(build: MavenBuild, major: str, repo_key: str, retry) -> str:
    pin = java_home_pin(major)
    has_own_assignment = any(name == JAVA_HOME for name, _ in build.invocation.assignments)
    if has_own_assignment:
        hint = "The JAVA_HOME on the mvn command is not JDK %s; replace its value with %s." % (major, pin)
    elif build.invocation.drops_inherited(JAVA_HOME):
        hint = ("This wrapper drops the inherited environment, so an export never reaches mvn; put "
                "JAVA_HOME=%s after the wrapper's options (env -i also drops PATH, keep it)." % pin)
    elif build.is_first and not build.command.assignments and build.invocation.argv == build.command.argv:
        hint = "Put JAVA_HOME=%s in front of the command." % pin
    else:
        hint = ("Put JAVA_HOME=%s right before mvn (an assignment at the start of the line only reaches "
                "the first command)." % pin)
    return protocol.format_message(
        HOOK, "mvn in %s must run on JDK %s" % (repo_key, major),
        [(RULE, "Pin JAVA_HOME to JDK %s on this command. %s" % (major, hint))],
        protocol.run_yourself(retry) if retry else protocol.ASK_USER,
    )


def java_home_pin(major: str) -> str:
    if platform.system() == "Darwin":
        return "$(/usr/libexec/java_home -v %s)" % major
    return "<path to JDK %s>" % major


if __name__ == "__main__":
    sys.exit(main())
