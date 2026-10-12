"""Known secret values the agent must never write out (F-secrets; overlay `git-guard/known-values.tsv`).

Rows are `source<TAB>pattern`: `file` globs config files whose secret-named keys supply values; `env`
names a variable whose value counts. Values stay in memory: a hit names file, line and key, never the value.
"""
from __future__ import annotations

import glob
import os
import re
from typing import Iterator, List, NamedTuple, Tuple

from hookkit.overlay import OverlayDataError, read_tsv

HEADER = ("source", "pattern")
SOURCE_FILE = "file"
SOURCE_ENV = "env"
MIN_LENGTH = 6
SECRET_KEY_RE = re.compile(r"pass|pwd|secret|token|key|credential|auth", re.I)
KEY_VALUE_RE = re.compile(r"""^\s*(?:export\s+)?["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?(.+?)["']?\s*,?\s*$""")
TRAILING_COMMENT_RE = re.compile(r"\s+#.*$")
HUNK_RE = re.compile(r"^@@ -\S+ \+(\d+)")

Line = Tuple[str, int, str]  # (path, line number, text)


class KnownValue(NamedTuple):
    value: str
    key: str
    origin: str  # config file basename, or "env"


class Hit(NamedTuple):
    path: str
    line: int
    known: KnownValue

    def describe(self) -> str:
        return "%s:%d holds the value of %s (%s)" % (self.path, self.line, self.known.key, self.known.origin)


def load(path: str) -> List[KnownValue]:
    values = []
    for row in read_tsv(path, HEADER):
        if row["source"] == SOURCE_ENV:
            values.append(KnownValue(os.environ.get(row["pattern"], ""), row["pattern"], SOURCE_ENV))
        elif row["source"] == SOURCE_FILE:
            for file in sorted(glob.glob(os.path.expanduser(row["pattern"]))):
                values.extend(_file_values(file))
        else:
            raise OverlayDataError("%s: source must be %s or %s, not %r" % (path, SOURCE_FILE, SOURCE_ENV, row["source"]))
    return [known for known in values if len(known.value) >= MIN_LENGTH]


def find(lines: Iterator[Line], values: List[KnownValue]) -> List[Hit]:
    return [Hit(path, number, known) for path, number, text in lines for known in values if known.value in text]


def numbered_lines(path: str, text: str) -> Iterator[Line]:
    for number, line in enumerate(text.splitlines(), 1):
        yield path, number, line


def added_lines(diff: str) -> Iterator[Line]:
    """Every added line of a unified diff with its path and new line number."""
    path, number, previous = None, 0, ""
    for raw in diff.splitlines():
        hunk = HUNK_RE.match(raw)
        if raw.startswith("+++ ") and previous.startswith("--- "):
            path = raw[4:].split("\t", 1)[0]
            path = path[2:] if path.startswith("b/") else path
        elif hunk:
            number = int(hunk.group(1))
        elif raw.startswith("+") and path:
            yield path, number, raw[1:]
            number += 1
        elif raw.startswith(" "):
            number += 1
        previous = raw


def _file_values(file: str) -> List[KnownValue]:
    try:
        with open(file, encoding="utf-8", errors="replace") as stream:
            lines = stream.read().splitlines()
    except OSError:
        return []
    values = []
    for line in lines:
        match = KEY_VALUE_RE.match(line)
        if match and SECRET_KEY_RE.search(match.group(1)):
            value = TRAILING_COMMENT_RE.sub("", match.group(2)).strip("\"'")
            values.append(KnownValue(value, match.group(1), os.path.basename(file)))
    return values
