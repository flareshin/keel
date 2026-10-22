"""Companion of shell-parity.ts: runs the Python hookkit.shell on the calls the TypeScript port is compared with.

usage: python3 -I shell_parity_py.py <hooks/lib dir> corpus <python file>...   -> JSON list of string literals
       python3 -I shell_parity_py.py <hooks/lib dir> run                       -> JSON calls on stdin, JSON results on stdout
"""
import ast
import json
import sys

MAX_LITERAL_LENGTH = 1000


def string_literals(paths):
    found = set()
    for path in paths:
        with open(path, encoding="utf-8") as stream:
            tree = ast.parse(stream.read())
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and 0 < len(node.value) <= MAX_LITERAL_LENGTH:
                found.add(node.value)
    return sorted(found)


def pairs(mapping):
    return [[key, value] for key, value in mapping.items()]


def command_view(command, index_of):
    return {
        "argv": command.argv, "assignments": [list(item) for item in command.assignments],
        "redirects": [[redirect.op, redirect.target] for redirect in command.redirects], "heredocs": command.heredocs,
        "nested": command.nested, "pipes_to_next": command.pipes_to_next,
        "parent": None if command.parent is None else index_of[id(command.parent)],
    }


def commands_view(text, shell):
    commands = shell.parse_commands(text)
    index_of = {id(command): index for index, command in enumerate(commands)}
    return commands, [command_view(command, index_of) for command in commands]


def steps_view(text, cwd, shell):
    found = shell.steps(text, cwd)
    index_of = {id(step.command): index for index, step in enumerate(found)}
    return [{
        "argv": step.argv, "environment": pairs(step.environment), "directory": step.directory,
        "command": command_view(step.command, index_of), "expansion": pairs(step.expansion),
        "unattributable_options": step.unattributable_options,
    } for step in found]


def invocation_view(invocation):
    return {
        "argv": invocation.argv, "assignments": [list(item) for item in invocation.assignments],
        "clears_env": invocation.clears_env, "removed_names": sorted(invocation.removed_names),
        "unattributable_options": invocation.unattributable_options, "moves_directory": invocation.moves_directory,
    }


def targets_view(targets):
    return {"written": targets.written, "removed": targets.removed, "sources": targets.sources, "unknown": targets.unknown,
            "any": targets.any()}


def push_view(pushed):
    return {"remote": pushed.remote, "refspecs": pushed.refspecs, "long_options": pushed.long_options,
            "short_flags": pushed.short_flags, "whole_repo": pushed.whole_repo}


def dispatch(shell):
    return {
        "parse_commands": lambda text: commands_view(text, shell)[1],
        "steps": lambda text, cwd: steps_view(text, cwd, shell),
        "unwrap_each": lambda text: [invocation_view(shell.unwrap(command)) for command in shell.parse_commands(text)],
        "write_targets_each": lambda text: [targets_view(shell.write_targets(command)) for command in shell.parse_commands(text)],
        "command_writes_files": lambda text, except_under: shell.command_writes_files(text, tuple(except_under)),
        "git_subcommand_index": shell.git_subcommand_index,
        "git_directory": lambda argv, directory, environment: shell.git_directory(argv, directory, dict(environment)),
        "gh_subcommand_argv": shell.gh_subcommand_argv,
        "attached_gh_repo": shell.attached_gh_repo,
        "read_push_arguments": lambda args: push_view(shell.read_push_arguments(args)),
        "is_config_read": shell.is_config_read,
        "config_key": shell.config_key,
        "dashed_git_subcommand": shell.dashed_git_subcommand,
        "resolve_directory": lambda directory, target, environment: shell.resolve_directory(directory, target, dict(environment)),
    }


def run(calls, shell):
    table = dispatch(shell)
    results = []
    for call in calls:
        try:
            results.append(table[call["fn"]](*call["args"]))
        except Exception:
            results.append({"error": True})
    return results


def main():
    hooks_lib, mode, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    sys.path.insert(0, hooks_lib)
    if mode == "corpus":
        print(json.dumps(string_literals(rest)))
        return
    from hookkit import shell
    print(json.dumps(run(json.load(sys.stdin), shell)))


main()
