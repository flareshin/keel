"""Hook registrations read out of a Claude Code settings `hooks` object; shared by smoke and bin/link."""
from __future__ import annotations

import os
import shlex
from dataclasses import dataclass
from typing import Iterator

SCRIPT_INTERPRETERS = {"python3", "python", "bash", "sh", "node"}
MATCH_ALL = ("", "*")


@dataclass(frozen=True)
class Registration:
    event: str
    matcher: str
    hook: dict

    @property
    def command(self) -> str:
        return self.hook["command"]

    @property
    def script(self) -> str:
        """The first word that is not an interpreter: `python3 /k/hooks/x.py --auto` -> `/k/hooks/x.py`."""
        try:
            words = shlex.split(self.command)
        except ValueError:
            return self.command
        return next((word for word in words if os.path.basename(word) not in SCRIPT_INTERPRETERS), self.command)

    @property
    def hook_name(self) -> str:
        """`python3 /k/hooks/git-guard/git-guard.py` -> `git-guard`, the name ledger rows use in `hook:<name>`."""
        return os.path.splitext(os.path.basename(self.script))[0]

    def covers_tool(self, tool_name: str) -> bool:
        return self.matcher in MATCH_ALL or tool_name in self.matcher.split("|")


def iter_registrations(hooks: object) -> Iterator[Registration]:
    """Every command hook, skipping entries whose shape Claude Code would not run either."""
    return (entry for entry in iter_hook_entries(hooks) if is_command_hook(entry.hook))


def iter_hook_entries(hooks: object) -> Iterator[Registration]:
    """Every hook object of any type (command, prompt, agent, ...); `command` is valid only on command hooks."""
    if not isinstance(hooks, dict):
        return
    for event, groups in hooks.items():
        for group in groups if isinstance(groups, list) else []:
            if not isinstance(group, dict):
                continue
            matcher = group.get("matcher") or ""
            for hook in group.get("hooks", []):
                if isinstance(hook, dict):
                    yield Registration(event, matcher, hook)


def is_command_hook(hook: dict) -> bool:
    return isinstance(hook.get("command"), str)

