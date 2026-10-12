#!/usr/bin/env python3
"""model-assign: every agent dispatch names a model and an effort ([C-dispatch]).

Agent/Task: a model or effort main left out is filled in, keeping the model inside the band
sonnet <= model <= opus (the read-only Explore type may run on haiku). Workflow: a script that calls
`agent(` with no `model:` or no `effort:` anywhere is denied, since a script cannot be rewritten per call.
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "lib"))

from hookkit import protocol  # noqa: E402
from hookkit.env import data_dir  # noqa: E402
from hookkit.fires import FireLog  # noqa: E402

HOOK = "model-assign"
RULE = "C-dispatch"
FORK_TYPE = "fork"  # a fork always runs on the parent's model
READ_ONLY_TYPES = {"explore"}
JUDGMENT_RE = re.compile(r"\bVERDICT\b|\bNEEDS_FIXES\b|\breview-lenses\b")
REQUIRED_SCRIPT_OPTIONS = {key: re.compile(r"\b%s\b[\"']?\s*:" % key) for key in ("model", "effort")}
EFFORT_PIN_RE = re.compile(r"^effort\s*:", re.M)
FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---", re.S)
OPUS, SONNET, HAIKU, ABOVE_BAND = "opus", "sonnet", "haiku", "fable"
WORKFLOW_GUIDE = (
    "Set opts per agent: model 'haiku' for read-only census or probing, 'sonnet' for implementation, "
    "'opus' for review or judgment, 'fable' only for long unattended orchestration; effort 'medium' "
    "for census and implementation, 'high' for review. Any explicit value passes."
)


def main() -> int:
    try:
        payload = protocol.parse_payload(sys.stdin.read())
    except ValueError:
        return protocol.EXIT_PASS  # unparseable payload: nothing to assign
    fires = FireLog(HOOK, payload.get("session_id"))
    try:
        return assign_dispatch(payload, fires)
    except Exception as error:  # noqa: BLE001 - registered as "pass, logged" (DESIGN (g))
        fires.append(RULE, "error", detail="%s: %s" % (type(error).__name__, error))
        return protocol.EXIT_PASS


def assign_dispatch(payload: dict, fires: FireLog) -> int:
    name = protocol.tool_name(payload)
    tool_args = protocol.tool_input(payload)
    if name == "workflow":
        return check_workflow_script(tool_args, fires)
    if name not in {"agent", "task"}:
        return protocol.EXIT_PASS
    agent_type = str(tool_args.get("subagent_type") or "").lower()
    judgment = JUDGMENT_RE.search(" ".join(str(tool_args.get(key) or "") for key in ("prompt", "description")))
    choices = {} if agent_type == FORK_TYPE else {
        "model": resolve_model(tool_args.get("model"), agent_type, bool(judgment)),
        "effort": resolve_effort(tool_args.get("effort"), agent_type, bool(judgment)),
    }
    assigned = {key: choice for key, choice in choices.items() if choice}
    if not assigned:
        fires.append(RULE, "pass")
        return protocol.EXIT_PASS
    note = ", ".join("%s -> %s (%s)" % (key, value, why) for key, (value, why) in assigned.items())
    fires.append(RULE, "record", detail=note)
    return protocol.rewrite_input(dict(tool_args, **{key: value for key, (value, _) in assigned.items()}), note)


def resolve_model(model, agent_type: str, judgment: bool):
    """(model, why) to write, or None to leave the dispatch's model as it is."""
    tier = next((tier for tier in (OPUS, SONNET, HAIKU, ABOVE_BAND) if tier in str(model or "").lower()), None)
    if tier in {OPUS, SONNET}:
        return None
    if tier == ABOVE_BAND:
        return OPUS, "ceiling"
    if judgment:
        return OPUS, "judgment marker"
    read_only = agent_type in READ_ONLY_TYPES
    if tier == HAIKU:
        return None if read_only else (SONNET, "floor")
    return (HAIKU, "read-only type") if read_only else (SONNET, "default")


def resolve_effort(effort, agent_type: str, judgment: bool):
    """(effort, why) to write, or None to leave the dispatch's effort as it is."""
    if effort or _type_pins_effort(agent_type):
        return None
    return ("high", "judgment marker") if judgment else ("medium", "default")


def check_workflow_script(tool_args: dict, fires: FireLog) -> int:
    if tool_args.get("resumeFromRunId"):
        return protocol.EXIT_PASS  # a resume replays journaled agents
    script = _workflow_script(tool_args)
    if not script or "agent(" not in script:
        return protocol.EXIT_PASS
    missing = [key for key, pattern in REQUIRED_SCRIPT_OPTIONS.items() if not pattern.search(script)]
    if not missing:
        fires.append(RULE, "pass")
        return protocol.EXIT_PASS
    fires.append(RULE, "deny", detail="workflow script names no %s" % "/".join(missing))
    text = "The agent() calls name no opts.%s, so every agent inherits main's. %s" % (" / opts.".join(missing), WORKFLOW_GUIDE)
    if tool_args.get("scriptPath"):
        text += " Edit %s and invoke it again." % tool_args["scriptPath"]
    return protocol.deny(protocol.format_message(HOOK, "workflow agents need a model and an effort", [(RULE, text)]))


def _type_pins_effort(agent_type: str) -> bool:
    """True when `<data dir>/agents/<type>.md` frontmatter sets `effort:`, which a call value would override."""
    path = os.path.join(data_dir(), "agents", agent_type + ".md")
    if not agent_type or not os.path.isfile(path):
        return False
    with open(path, encoding="utf-8", errors="replace") as stream:
        frontmatter = FRONTMATTER_RE.match(stream.read())
    return bool(frontmatter and EFFORT_PIN_RE.search(frontmatter.group(1)))


def _workflow_script(tool_args: dict) -> str | None:
    script, script_path = tool_args.get("script"), tool_args.get("scriptPath")
    if isinstance(script, str):
        return script
    if not isinstance(script_path, str) or not os.path.isfile(script_path):
        return None  # a named workflow, or a path the Workflow tool itself will report
    with open(script_path, encoding="utf-8", errors="replace") as stream:
        return stream.read()


if __name__ == "__main__":
    sys.exit(main())
