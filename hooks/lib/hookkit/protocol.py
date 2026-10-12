"""Claude Code hook protocol: payload in, decision out (DESIGN Interfaces (g)).

Every deny or warn message reads `[<ID>] <hook>: <summary>`, then one `- [<ID>] …` line per finding; a
deny ends with what the user can do. Messages are capped so no channel truncates them.
"""
from __future__ import annotations

import json
import sys

EXIT_PASS = 0
EXIT_DENY = 2
MESSAGE_LIMIT = 2000
LIST_LIMIT = 10
RUN_YOURSELF = "Run it yourself in your terminal: "
ASK_USER = "Stop and ask the user."


def parse_payload(raw: str) -> dict:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("hook payload is not a JSON object")
    return payload


def tool_name(payload: dict) -> str:
    return str(payload.get("tool_name") or "").lower()


def tool_input(payload: dict) -> dict:
    value = payload.get("tool_input")
    return value if isinstance(value, dict) else {}


def is_subagent(payload: dict) -> bool:
    return bool(payload.get("agent_id"))


def format_message(hook: str, summary: str, bullets: list, next_step: str = ASK_USER) -> str:
    """A deny: `bullets` = [(rule_id, text)]; `next_step`, its last line, survives the cap."""
    message = _message(hook, summary, bullets) + "\n" + next_step
    if len(message) <= MESSAGE_LIMIT:
        return message
    body, last = message.rsplit("\n", 1)
    return body[: MESSAGE_LIMIT - len(last) - 2] + "…\n" + last


def format_warning(hook: str, summary: str, bullets: list) -> str:
    """A warn: the same shape without a next step, since nothing is refused."""
    message = _message(hook, summary, bullets)
    return message if len(message) <= MESSAGE_LIMIT else message[: MESSAGE_LIMIT - 1] + "…"


def _message(hook: str, summary: str, bullets: list) -> str:
    first_id = bullets[0][0] if bullets else hook
    return "\n".join(["[%s] %s: %s" % (first_id, hook, summary)] + ["- [%s] %s" % (rule_id, text) for rule_id, text in bullets])


def run_yourself(command: str) -> str:
    return RUN_YOURSELF + command


def listed(items: list) -> str:
    """Up to LIST_LIMIT items, comma-separated, then `…and N more`."""
    shown = ", ".join(str(item) for item in items[:LIST_LIMIT])
    if len(items) > LIST_LIMIT:
        shown += ", …and %d more" % (len(items) - LIST_LIMIT)
    return shown


def deny(message: str) -> int:
    sys.stderr.write(message + "\n")
    return EXIT_DENY


def warn(event: str, message: str) -> int:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": message}}, ensure_ascii=False))
    return EXIT_PASS


def block_stop(message: str) -> int:
    print(json.dumps({"decision": "block", "reason": message}, ensure_ascii=False))
    return EXIT_PASS


def rewrite_input(updated_input: dict, note: str) -> int:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated_input},
                      "systemMessage": note, "suppressOutput": True}, ensure_ascii=False))
    return EXIT_PASS
