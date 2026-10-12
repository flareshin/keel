"""Claude Code JSONL transcripts: entries and their text."""
from __future__ import annotations

import json


def text_of(content) -> str | None:
    """Text of a string, a content-block list, or a message wrapper; None when it holds no text."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        if "content" in content:
            return text_of(content.get("content"))
        if "message" in content:
            return text_of(content.get("message"))
        return None
    if isinstance(content, list):
        chunks = [
            block["text"]
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        ]
        return "\n".join(chunks)
    return None


def iter_entries(path: str):
    """Yield each JSON object line; blank and malformed lines are skipped. OSError reaches the caller."""
    with open(path, encoding="utf-8") as stream:
        for line in stream:
            try:
                entry = json.loads(line.strip())
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                yield entry


def role_of(entry: dict) -> str | None:
    message = entry.get("message") if isinstance(entry.get("message"), dict) else {}
    return message.get("role") or entry.get("type")


def content_of(entry: dict):
    message = entry.get("message") if isinstance(entry.get("message"), dict) else {}
    return message.get("content")


def tool_uses(entry: dict) -> list:
    content = content_of(entry)
    if not isinstance(content, list):
        return []
    return [block for block in content if isinstance(block, dict) and block.get("type") == "tool_use"]
