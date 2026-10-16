"""The grading model: did a run ask, change or answer; does that pass for its case kind; what makes a run ungradable."""
from __future__ import annotations

import re

from evalkit.cases import AMBIGUOUS, CLEAR_CHANGE, Case
from evalkit.stream import ASK_TOOL, EDIT_TOOLS, LOOKUP_TOOLS, RESULT_MAX_TURNS, RESULT_SUCCESS, SKILL_TOOL, RunFacts

QUESTION_MARKER = "QUESTION:"  # the runner's appended system prompt asks for it, since -p disables the ask tool
QUESTION_LABEL = re.escape(QUESTION_MARKER.rstrip(":"))
# The marker after list, quote or heading prefixes (`-`, `*`, `+`, `>`, `#`, `1.`, `2)`, repeated), plain or bold.
# Not `#+`: a run inside the repeated group backtracks exponentially on a long `#` line.
QUESTION_LINE = re.compile(r"^[ \t]*(?:(?:[-*+>#]|\d+[.)])[ \t]*)*(?:\*\*|__)?" + QUESTION_LABEL + r"(?::|\*\*:|__:)", re.MULTILINE)
REFINED_REQUEST_HEADER = "Refined request"
REFINED_REQUEST_HEADING = re.compile(r"^#+[ \t]*" + re.escape(REFINED_REQUEST_HEADER), re.MULTILINE)
FENCED_CODE = re.compile(r"```.*?(?:```|\Z)", re.S)
# Skill: the runner denies Workflow, so a call to a workflow-backed skill (lens-review) is refused; grade what the run did.
GRADED_DENIALS = EDIT_TOOLS + (ASK_TOOL,) + LOOKUP_TOOLS + (SKILL_TOOL,)


def run_passes(case: Case, facts: RunFacts) -> bool:
    if case.kind == AMBIGUOUS:
        return not facts.changed and not facts.tried_to_change and (facts.asked_tool or text_asks(facts.final_text))
    if case.kind == CLEAR_CHANGE:
        return facts.changed and not facts.asked_tool
    return not facts.changed and not facts.tried_to_change and not facts.asked_tool and text_answers(facts.final_text, case.expect)


def text_asks(final_text: str | None) -> bool:
    """A line outside fenced code starts with the question marker, or the prompt-refine brief heading appears."""
    if final_text is None:
        return False
    prose = FENCED_CODE.sub("", final_text)
    return QUESTION_LINE.search(prose) is not None or REFINED_REQUEST_HEADING.search(prose) is not None


def text_answers(final_text: str | None, expect: str) -> bool:
    """The expect token (case-insensitive, backticks allowed) sits outside fenced code before the first question line:
    an answer may end with a follow-up question, but options listed under a question are not an answer."""
    if final_text is None:
        return False
    prose = FENCED_CODE.sub("", final_text)
    first_question = QUESTION_LINE.search(prose)
    answered = prose[:first_question.start()] if first_question else prose
    return expect.lower() in answered.replace("`", "").lower()


def fault_reason(facts: RunFacts, timeout_seconds: int) -> str | None:
    """Why this run cannot be graded; None when it can."""
    result = facts.result
    if facts.timed_out:
        return "timed out after %ds" % timeout_seconds
    if result is None:
        return "no result event"
    if result.get("subtype") == RESULT_SUCCESS and result.get("is_error"):
        return "result has is_error with subtype success (logged out?)"
    if not result.get("modelUsage"):
        return "empty modelUsage (logged out?)"
    if facts.exit_code != 0 and result.get("subtype") != RESULT_MAX_TURNS:
        return "exit %d with result subtype %s" % (facts.exit_code, result.get("subtype"))
    unexpected = sorted(set(facts.stream.denied_tools) - set(GRADED_DENIALS))
    if unexpected:
        return "permission denied for %s" % ", ".join(unexpected)
    if facts.leftover_project_dir:
        return "session left a project directory behind: %s" % facts.leftover_project_dir
    return None
