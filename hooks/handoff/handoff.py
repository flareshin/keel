#!/usr/bin/env python3
"""handoff: snapshot where work stopped, so the next session can resume ([C-handoff]).

One file per main repo at `$KEEL_DATA_DIR/handoff/<slug>.md` (keyed on the main repo, not the
worktree: a worktree can vanish, the handoff must survive; a submodule keys on its own tree).

Usage:
  handoff.py "next: start from the failing repro test"   record a resume note (overwrites)
  handoff.py --read | --clear | --path | --status        print / delete / locate / JSON facts
  handoff.py --auto                                      PreCompact hook: payload JSON on stdin
--auto never fails the compaction, and keeps a hand-written note: it appends to it when the note
was written at the same branch and worktree, and writes nothing when it was written elsewhere.
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "lib"))

from hookkit import protocol  # noqa: E402
from hookkit.env import data_dir  # noqa: E402
from hookkit.fires import FireLog, utc_now  # noqa: E402
from hookkit.repo import find_toplevel, find_upstream, git_output  # noqa: E402

HOOK = "handoff"
RULE = "C-handoff"
RESUME_HEADING = "## Resume point"
LOCATION_HEADING = "## Location"
AUTO_PREFIX = "(auto-snapshot"
EMPTY_NOTE = "(not given — pass the resume point as an argument)"
SUBMODULE_GIT_DIR_RE = re.compile(r"/\.git/(worktrees/[^/]+/)?modules/")
EXIT_USAGE = 1


class RepoPlace:
    """The repo a handoff belongs to and where in it the work sits."""

    def __init__(self, toplevel: str):
        self.toplevel = toplevel
        self.main = _main_repo(toplevel)
        self.branch = git_output(["rev-parse", "--abbrev-ref", "HEAD"], toplevel) or "?"
        self.file = os.path.join(data_dir(), "handoff", re.sub(r"[^A-Za-z0-9]", "-", self.main) + ".md")

    def location_lines(self) -> list:
        worktree = ["- Working worktree: `%s`" % self.toplevel] if self.toplevel != self.main else []
        return worktree + ["- Branch: `%s`" % self.branch]


def main(argv: list) -> int:
    mode = argv[0] if argv else ""
    if mode == "--auto":
        return snapshot_before_compaction(sys.stdin.read())
    toplevel = find_toplevel(os.getcwd())
    if toplevel is None:
        sys.stderr.write("handoff: run this inside a git repo (currently: %s)\n" % os.getcwd())
        return EXIT_USAGE
    place = RepoPlace(toplevel)
    if mode == "--path":
        print(place.file)
    elif mode == "--status":
        print(json.dumps({"path": place.file, "hasResumePoint": has_resume_point(place.file)}))
    elif mode == "--read":
        print(_read(place.file) if os.path.isfile(place.file) else "no handoff: %s" % place.file)
    elif mode == "--clear":
        if os.path.isfile(place.file):
            os.remove(place.file)
        print("handoff deleted: %s" % place.file)
    else:
        write_handoff(place, " ".join(argv) or EMPTY_NOTE, session=None)
    return protocol.EXIT_PASS


def snapshot_before_compaction(raw: str) -> int:
    try:
        payload = protocol.parse_payload(raw)
    except ValueError:
        payload = {}
    fires = FireLog(HOOK, payload.get("session_id"))
    try:
        cwd = str(payload.get("cwd") or os.getcwd())
        toplevel = find_toplevel(cwd) if os.path.isdir(cwd) else None
        if toplevel is None:
            return protocol.EXIT_PASS  # nothing to snapshot outside a repo
        place = RepoPlace(toplevel)
        note = "%s before %s compaction · transcript: %s)" % (
            AUTO_PREFIX, payload.get("trigger") or "?", payload.get("transcript_path") or "?")
        if has_resume_point(place.file):
            if not _written_here(place):
                return protocol.EXIT_PASS  # the hand-written note belongs to another branch or worktree
            note = resume_note(place.file).rstrip("\n") + "\n" + note
        write_handoff(place, note, session=payload.get("session_id"))
    except Exception as error:  # noqa: BLE001 - a hook must never fail the compaction; logged
        fires.append(RULE, "error", detail="%s: %s" % (type(error).__name__, error))
    return protocol.EXIT_PASS


def write_handoff(place: RepoPlace, note: str, session: str | None) -> None:
    os.makedirs(os.path.dirname(place.file), exist_ok=True)
    with open(place.file, "w", encoding="utf-8") as stream:
        stream.write(render_handoff(place, note))
    FireLog(HOOK, session).append(RULE, "record", detail="snapshot %s" % os.path.basename(place.file))
    print("handoff recorded: %s" % place.file)


def render_handoff(place: RepoPlace, note: str) -> str:
    toplevel = place.toplevel
    dirty = git_output(["status", "--porcelain"], toplevel) or ""
    dirty_count = sum(1 for line in dirty.splitlines() if line)
    lines = [
        "# HANDOFF — %s" % os.path.basename(place.main),
        "",
        "> Generated %s · overwritten by `hooks/handoff/handoff.py`. **Once you have resumed, delete it "
        "with `--clear`** (a stale handoff = false state)." % utc_now(),
        "",
        RESUME_HEADING,
        note,
        "",
        LOCATION_HEADING,
        "- Main repo: `%s`" % place.main,
    ]
    lines.extend(place.location_lines())
    lines.append("- HEAD: `%s`" % (git_output(["log", "-1", "--pretty=%h %s"], toplevel) or "?"))
    upstream_position = _upstream_position(toplevel)
    lines.extend(["- upstream: %s" % upstream_position] if upstream_position else [])
    lines.extend(["", "## Uncommitted (%d)" % dirty_count])
    lines.extend(["```", dirty, "```"] if dirty_count else ["(none — working tree clean)"])
    recent = git_output(["log", "-3", "--pretty=%h %ad %s", "--date=short"], toplevel) or "?"
    return "\n".join(lines + ["", "## Recent commits", "```", recent, "```", ""])


def resume_note(path: str) -> str:
    """Lines under the resume heading up to the location heading, without lines --auto wrote."""
    note_lines = []
    inside = False
    for line in _read(path).splitlines():
        if line == RESUME_HEADING:
            inside = True
        elif line == LOCATION_HEADING:
            inside = False
        elif inside and not line.startswith(AUTO_PREFIX):
            note_lines.append(line)
    return "\n".join(note_lines).strip("\n") + "\n"


def has_resume_point(path: str) -> bool:
    """True when a person wrote the note: its first non-blank line is not one this script writes."""
    if not os.path.isfile(path):
        return False
    first = next((line for line in resume_note(path).splitlines() if line.strip()), "")
    return bool(first) and not first.startswith((AUTO_PREFIX, "(not given"))


def _written_here(place: RepoPlace) -> bool:
    recorded = []
    inside = False
    for line in _read(place.file).splitlines():
        if line == LOCATION_HEADING:
            inside = True
        elif line.startswith("## "):
            inside = False
        elif inside and line.startswith(("- Branch: ", "- Working worktree: ")):
            recorded.append(line)
    return recorded == place.location_lines()


def _main_repo(toplevel: str) -> str:
    common = git_output(["rev-parse", "--path-format=absolute", "--git-common-dir"], toplevel)
    if not common or SUBMODULE_GIT_DIR_RE.search(common + "/"):
        return toplevel
    return os.path.dirname(common)


def _upstream_position(toplevel: str) -> str | None:
    upstream = find_upstream(toplevel, "HEAD")
    counts = upstream and git_output(["rev-list", "--left-right", "--count", "%s...HEAD" % upstream], toplevel)
    if not counts:
        return None
    behind, ahead = counts.split()
    return "%s behind / %s ahead (vs %s)" % (behind, ahead, upstream)


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as stream:
        return stream.read()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
