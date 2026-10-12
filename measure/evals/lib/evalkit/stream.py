"""What one `claude -p --output-format stream-json` run did, read from its events plus its temp repo."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable, Iterator

ASK_TOOL = "AskUserQuestion"
SKILL_TOOL = "Skill"
EDIT_TOOLS = ("Edit", "Write")
LOOKUP_TOOLS = ("Read", "Grep", "Glob")
RESULT_SUCCESS = "success"
RESULT_MAX_TURNS = "error_max_turns"


@dataclass
class StreamSummary:
    init: dict | None = None
    result: dict | None = None
    ask_calls: int = 0
    skill_calls: list[str] = field(default_factory=list)
    denied_tools: list[str] = field(default_factory=list)


@dataclass
class RunFacts:
    stream: StreamSummary
    exit_code: int
    timed_out: bool
    changed: bool
    leftover_project_dir: str | None

    @property
    def result(self) -> dict | None:
        return self.stream.result

    @property
    def asked_tool(self) -> bool:
        """The model called the ask tool, or tried to and headless mode refused it."""
        return self.stream.ask_calls > 0 or ASK_TOOL in self.stream.denied_tools

    @property
    def tried_to_change(self) -> bool:
        return any(tool in EDIT_TOOLS for tool in self.stream.denied_tools)

    @property
    def final_text(self) -> str | None:
        """The answer text; absent unless the result is a clean success."""
        result = self.stream.result
        if result is None or result.get("subtype") != RESULT_SUCCESS or result.get("is_error"):
            return None
        text = result.get("result")
        return text if isinstance(text, str) else None

    def fired(self, skill: str) -> bool:
        return skill in self.stream.skill_calls


def summarize_stream(lines: Iterable[str]) -> StreamSummary:
    """Tool uses of the main conversation only (parent_tool_use_id null), the init event and the result event."""
    summary = StreamSummary()
    for event in _json_events(lines):
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            summary.init = event
        elif kind == "assistant" and event.get("parent_tool_use_id") is None:
            _count_tool_uses(event, summary)
        elif kind == "result":
            summary.result = event
            denials = event.get("permission_denials")
            summary.denied_tools = [str(denial.get("tool_name")) for denial in denials if isinstance(denial, dict)] if isinstance(denials, list) else []
    return summary


def _json_events(lines: Iterable[str]) -> Iterator[dict]:
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue  # --verbose interleaves non-JSON lines with the events
        if isinstance(event, dict):
            yield event


def _count_tool_uses(event: dict, summary: StreamSummary) -> None:
    content = (event.get("message") or {}).get("content")
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        if block.get("name") == ASK_TOOL:
            summary.ask_calls += 1
        elif block.get("name") == SKILL_TOOL:
            skill = (block.get("input") or {}).get("skill")
            if isinstance(skill, str):
                summary.skill_calls.append(skill.rsplit(":", 1)[-1])
