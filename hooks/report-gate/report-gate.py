#!/usr/bin/env python3
"""report-gate: judge a subagent's final report, and write review evidence for reviewer verdicts.

Checks, in order: [K5] changes outside the brief's `[SCOPE]`, [K2] a report under the evidence
contract with no evidence token (denied once per turn), [K1] a `VERDICT:` report's `KEEL-EVIDENCE:`
lines piped to `keel evidence write-review`. A report handed back this turn is judged at the
hand-back; the SubagentStop that follows only runs the scope check.
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "lib"))

from hookkit import contract, protocol  # noqa: E402
from hookkit.env import data_dir, keel_cli  # noqa: E402
from hookkit.fires import FireLog  # noqa: E402
from hookkit.shell import command_writes_files  # noqa: E402
from hookkit.transcript import content_of, iter_entries, role_of, text_of, tool_uses  # noqa: E402

HOOK = "report-gate"
CLI_TIMEOUT_SECONDS = 20

# `BUILD SUCCESS` alone is not evidence: Maven prints it when every test was skipped.
EVIDENCE_RE = re.compile(
    r"Tests run:\s*\d|\b\d+\s+pass(?:ed|ing)\b"
    r"|\b\d[\d,]*\s+(?:[a-z]+\s+)?(?:tests?|specs?|checks?|cases?|suites?)\s+pass(?:ed|ing)\b"
    r"|\b\d+\s*/\s*\d+\s+(?:tests?\s+|checks?\s+)?pass(?:ed|ing)\b"
    r"|\bRan \d+ tests?\b|#\s*pass\s+\d"
    r"|exit(?:ed)?(?:\s+(?:with\s+)?(?:code|status))?[:= ]*0\b|\$\?\s*=?\s*0"
    r"|grep\s+-c|wc\s+-[lc]|diff --git|files? changed|[\w./~\-]+\.[A-Za-z]{1,5}:\d+"
    r"|UNVERIFIED\s*:|NOT VERIFIED",
    re.I,
)
# Case-sensitive on purpose: lowercase prose ("pass the value") would false-trigger.
VERDICT_RE = re.compile(
    r"\b(PASS|BLOCK|ASK|READY_TO_MERGE|NEEDS_FIXES|SHIP_READY|BUGS_FOUND|BLOCKED|INVESTIGATE_FURTHER)\b|VERDICT\s*:"
)
REVIEW_VERDICTS = {"VERDICT: PASS": "PASS", "VERDICT: NEEDS_FIXES": "NEEDS_FIXES"}
KEEL_EVIDENCE_RE = re.compile(r"^\s*KEEL-EVIDENCE: (\{.*\})\s*$", re.M)
# The lines lens-review.js frames its reporter's report with; a reporter that echoes them still records.
REPORT_START = "<<<KEEL-REPORT"
REPORT_END = "KEEL-REPORT>>>"
SCOPE_RE = re.compile(r"\[SCOPE\][ \t]*([^\n]+)")
SCOPE_EXEMPT_PREFIXES = ("/tmp/", "/private/tmp/", "/var/folders/")
SCRATCH_PREFIXES = SCOPE_EXEMPT_PREFIXES + tuple(  # writes a reviewer may make
    prefix for prefix in (os.environ.get("TMPDIR"),) if prefix)
PATH_EDIT_TOOLS = {"edit", "write", "notebookedit", "multiedit"}
EVIDENCE_MARKER = "[EVIDENCE]"
NO_TRANSCRIPT = "review evidence skipped: no subagent transcript"

# Must hold no literal EVIDENCE_RE accepts, or a parroting retry self-passes. Exception: "UNVERIFIED:",
# which, even parroted, labels the report unverified.
EVIDENCE_TEXT = (
    "This report is under the evidence contract (the brief carries an [EVIDENCE] marker, the agent "
    "changed files, or the report claims a verdict) and holds no evidence token. Re-emit the full "
    "report citing an actual output line from a check you ran: a test-runner summary with its count, "
    "the command's zero exit status, a grep or wc count, a file path with line number, or a diff "
    "summary. If you did not verify, say so in one line starting 'UNVERIFIED:' with the reason."
)
SCOPE_TEXT = (
    "The brief's [SCOPE] does not cover files you changed: %s. Revert them. If one was genuinely "
    "needed, keep it reverted and name it with the reason in your report; widening the scope is the "
    "caller's decision."
)
HANDBACK_TAIL = "Then hand back the corrected full report (SubagentHandback or your final message)."


class TurnState:
    """Per (session, agent) turn memory shared by the hand-back and stop events: scope paths already
    reported (a revert is another write to the same path), whether the evidence check already denied
    once, and whether the report went out through SubagentHandback."""

    def __init__(self, payload: dict):
        session_id, agent_id = payload.get("session_id"), payload.get("agent_id")
        name = re.sub(r"[^\w.-]", "_", "%s-%s" % (session_id, agent_id)) + ".json"
        self.path = os.path.join(data_dir(), "state", "keel", "report-gate", name) if session_id and agent_id else None
        self.flagged_paths, self.evidence_denied, self.handed_back = [], False, False
        if not self.path or not os.path.exists(self.path):
            return
        try:
            with open(self.path, encoding="utf-8") as stream:
                data = json.load(stream)
        except (OSError, ValueError):
            # Unknown whether this turn handed back: assume it did, so delivered wrap-up text is not re-judged.
            self.handed_back = True
            return
        self.flagged_paths = list(data.get("paths") or [])
        self.evidence_denied, self.handed_back = bool(data.get("ev")), bool(data.get("hb"))

    def save(self) -> None:
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as stream:
            json.dump({"paths": self.flagged_paths, "ev": self.evidence_denied, "hb": self.handed_back}, stream)


class AgentTranscript:
    """What the subagent's own transcript shows: brief scope, whether it mutated, what it wrote."""

    def __init__(self, path: str | None):
        self.scopes, self.out_of_scope = [], []
        self.needs_evidence = False
        self.edited_files = False  # an edit tool, or Bash writing outside a scratch dir: the agent is an author
        self.used_structured_output = False
        brief_seen = False
        for entry in iter_entries(path) if path else ():
            role = role_of(entry)
            if role == "user" and not brief_seen:
                brief_seen = True
                self._read_brief(text_of(content_of(entry)) or "")
            if role == "assistant":
                for block in tool_uses(entry):
                    self._read_tool_use(str(block.get("name") or "").lower(), block.get("input"))

    def _read_brief(self, brief: str) -> None:
        self.needs_evidence |= EVIDENCE_MARKER in brief
        # Every [SCOPE] occurrence adds paths: a quoted one can widen the scope, never replace it.
        for match in SCOPE_RE.finditer(brief):
            for raw in re.split(r"[,\s]+", match.group(1)):
                token = raw.strip("`'\"<>;")
                if token.startswith(("/", "~")):
                    self.scopes.append(_normalize(token))

    def _read_tool_use(self, name: str, tool_args) -> None:
        tool_args = tool_args if isinstance(tool_args, dict) else {}
        if name == "structuredoutput":
            self.used_structured_output = True
        command = str(tool_args.get("command") or "") if name == "bash" else ""
        edits = name in PATH_EDIT_TOOLS
        self.needs_evidence |= edits or command_writes_files(command)
        self.edited_files |= edits or command_writes_files(command, except_under=SCRATCH_PREFIXES)
        target = tool_args.get("file_path") or tool_args.get("notebook_path")
        if edits and target and self.scopes and not _in_scope(target, self.scopes) \
                and _normalize(target) not in self.out_of_scope:
            self.out_of_scope.append(_normalize(target))


def main() -> int:
    try:
        payload = protocol.parse_payload(sys.stdin.read())
    except ValueError as error:  # unparseable payload: nothing to judge, logged as the (g) table says
        FireLog(HOOK, None).append("K2", "error", detail="payload is not JSON: %s" % error)
        return protocol.EXIT_PASS
    fires = FireLog(HOOK, payload.get("session_id"))
    try:
        if payload.get("hook_event_name") == "PreToolUse":
            return judge_handback(payload, fires)
        if payload.get("hook_event_name") == "SubagentStop":
            return judge_stop(payload, fires)
        return protocol.EXIT_PASS
    except Exception as error:  # noqa: BLE001 - registered as "pass, logged" (DESIGN (g))
        fires.append("K2", "error", detail="%s: %s" % (type(error).__name__, error))
        return protocol.EXIT_PASS


def judge_handback(payload: dict, fires: FireLog) -> int:
    if protocol.tool_name(payload) != "subagenthandback":
        return protocol.EXIT_PASS
    missing = contract.missing_fields(payload, "tool_input.message", "agent_id")
    if missing:
        fires.append("K2", contract.OUTCOME, detail=contract.miss_detail(payload, missing))
        return protocol.EXIT_PASS
    report = without_report_markers(str(protocol.tool_input(payload).get("message")))
    state = TurnState(payload)
    state.handed_back = True
    state.save()
    agent_transcript = find_handback_transcript(payload)
    if agent_transcript is None:
        fires.append("K2", contract.OUTCOME, detail=contract.miss_detail(payload, ["agent_transcript_path (derived)"]))
    transcript = AgentTranscript(agent_transcript)

    fresh = flag_scope_violations(transcript, state, fires)
    if fresh:
        return protocol.deny(_scope_message(fresh))
    if not state.evidence_denied and _lacks_evidence(report, transcript.needs_evidence, fires):
        state.evidence_denied = True
        state.save()
        return protocol.deny(_evidence_message())
    write_review_evidence(report, payload, agent_transcript, transcript, "SubagentHandback", fires)
    return protocol.EXIT_PASS


def judge_stop(payload: dict, fires: FireLog) -> int:
    state = TurnState(payload)
    handed_back = state.handed_back
    if state.evidence_denied:
        # Reopened before the stop_hook_active return: if another Stop hook blocked first, a flag
        # left set here would switch the evidence check off for every later turn.
        state.evidence_denied = False
        state.save()
    if payload.get("stop_hook_active"):
        return protocol.EXIT_PASS
    if handed_back:
        state.handed_back = False
        state.save()
    missing = contract.missing_fields(payload, "agent_id", "agent_transcript_path", "last_assistant_message")
    if missing:
        fires.append("K2", contract.OUTCOME, detail=contract.miss_detail(payload, missing))
    agent_transcript = payload.get("agent_transcript_path")
    report = without_report_markers(text_of(payload.get("last_assistant_message")))
    if not agent_transcript or not os.path.exists(agent_transcript):
        # Claude Code's internal agents fire SubagentStop with a transcript that is never written.
        if report and _verdict_of(report) and KEEL_EVIDENCE_RE.search(report):
            fires.append("K1", "warn", detail=NO_TRANSCRIPT)
        return protocol.EXIT_PASS
    transcript = AgentTranscript(agent_transcript)

    fresh = flag_scope_violations(transcript, state, fires)
    if fresh:
        return protocol.block_stop(_scope_message(fresh))
    if handed_back:
        return protocol.EXIT_PASS
    if not report or not report.strip():
        if transcript.needs_evidence:
            fires.append("K2", "warn", detail="no final text to judge")
        return protocol.EXIT_PASS
    if transcript.used_structured_output:
        return protocol.EXIT_PASS
    if _lacks_evidence(report, transcript.needs_evidence, fires):
        return protocol.block_stop(_evidence_message())
    write_review_evidence(report, payload, agent_transcript, transcript, "SubagentStop", fires)
    return protocol.EXIT_PASS


def find_handback_transcript(payload: dict) -> str | None:
    """Inside a subagent `transcript_path` is the MAIN session's; the agent's own sits below it."""
    main_path, session_id, agent_id = payload.get("transcript_path"), payload.get("session_id"), payload.get("agent_id")
    if not (main_path and session_id and agent_id):
        return None
    base = os.path.join(os.path.dirname(os.path.expanduser(str(main_path))), str(session_id), "subagents")
    pattern = os.path.join(glob.escape(base), "**", "agent-%s.jsonl" % glob.escape(str(agent_id)))
    return min(glob.glob(pattern, recursive=True), default=None)


def write_review_evidence(report: str, payload: dict, agent_transcript: str | None, transcript: AgentTranscript,
                          via: str, fires: FireLog) -> None:
    verdict = _verdict_of(report)
    evidence_lines = KEEL_EVIDENCE_RE.findall(report)
    if verdict is None or not evidence_lines:
        return
    if not protocol.is_subagent(payload) or not agent_transcript:
        fires.append("K1", "warn", detail=NO_TRANSCRIPT)
        return
    if transcript.edited_files:
        fires.append("K1", "warn", detail="reviewer-mutated: review evidence refused, the reviewer edited files "
                                          "(an author never judges its own output)")
        return
    source = {key: payload.get(key) for key in ("session_id", "agent_id", "agent_type", "transcript_path")}
    source.update(agent_transcript_path=agent_transcript, via=via)
    for line in evidence_lines:
        _send_to_cli(line, verdict, source, fires)


def _send_to_cli(evidence_line: str, verdict: str, source: dict, fires: FireLog) -> None:
    try:
        request = json.dumps({"keel_evidence": json.loads(evidence_line), "verdict": verdict, "source": source})
    except ValueError:
        fires.append("K1", "warn", detail="KEEL-EVIDENCE line is not JSON")
        return
    try:
        result = subprocess.run([keel_cli(), "evidence", "write-review"], input=request,
                                capture_output=True, text=True, timeout=CLI_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        fires.append("K1", "warn", detail="keel evidence write-review did not run: %s" % type(error).__name__)
        return
    if result.returncode != 0:
        fires.append("K1", "warn", detail="write-review exit %d: %s" % (result.returncode, result.stderr.strip()))
        return
    try:
        evidence_id = str(json.loads(result.stdout).get("evidence_id"))
    except (ValueError, AttributeError):
        evidence_id = "(unparsed stdout)"
    fires.append("K1", "record", detail="review evidence %s" % evidence_id)


# Same rule as withoutReportMarkers in workflows/lens-review.js for ASCII whitespace: _comparable_lines drops
# trailing whitespace per line and blank lines at either end, then a marker line matches with its own whitespace
# trimmed. Not for U+FEFF or U+0085: Python strip and JS \s/trim disagree on them.
def without_report_markers(report: str | None) -> str | None:
    if not report:
        return report
    lines = _comparable_lines(report)
    start = 1 if lines[0].strip() == REPORT_START else 0
    end = len(lines) - 1 if len(lines) > start and lines[-1].strip() == REPORT_END else len(lines)
    return "\n".join(lines[start:end])


def _comparable_lines(text: str) -> list[str]:
    return "\n".join(line.rstrip() for line in text.split("\n")).strip("\n").split("\n")


def _verdict_of(report: str) -> str | None:
    return REVIEW_VERDICTS.get(report.lstrip().split("\n", 1)[0].rstrip())


def _lacks_evidence(report: str, needs_evidence: bool, fires: FireLog) -> bool:
    stripped = report.strip()
    if not (needs_evidence or VERDICT_RE.search(stripped)) or stripped.startswith(("{", "[")):
        return False
    has_token = bool(EVIDENCE_RE.search(stripped))
    fires.append("K2", "pass" if has_token else "deny")
    return not has_token


def flag_scope_violations(transcript: AgentTranscript, state: TurnState, fires: FireLog) -> list:
    """Out-of-scope paths not reported yet this turn; they are remembered and logged."""
    fresh = [path for path in transcript.out_of_scope if path not in state.flagged_paths]
    if fresh:
        state.flagged_paths = sorted(set(state.flagged_paths).union(fresh))
        state.save()
        fires.append("K5", "deny", detail="%d path(s) outside [SCOPE]" % len(fresh))
    return fresh


def _scope_message(paths: list) -> str:
    return protocol.format_message(
        HOOK, "changes outside the brief's scope", [("K5", SCOPE_TEXT % protocol.listed(paths))], HANDBACK_TAIL
    )


def _evidence_message() -> str:
    return protocol.format_message(HOOK, "report has no evidence token", [("K2", EVIDENCE_TEXT)], HANDBACK_TAIL)


def _normalize(path: str) -> str:
    return os.path.normpath(os.path.expanduser(str(path).strip().strip("'\"")))


def _in_scope(path: str, scopes: list) -> bool:
    target = _normalize(path)
    return target.startswith(SCOPE_EXEMPT_PREFIXES) or any(
        target == scope or target.startswith(scope.rstrip("/") + "/") for scope in scopes)


if __name__ == "__main__":
    sys.exit(main())
