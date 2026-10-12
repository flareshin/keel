"""keel's on-disk formats: TSV and line files (blank and '#' lines skipped) and JSONL logs (Interfaces (f))."""
from __future__ import annotations

import json
import os
from typing import Sequence


class TsvError(Exception):
    pass


def data_lines(path: str) -> list[tuple[int, str]]:
    """(line number, line) of every line that is neither blank nor a '#' comment."""
    with open(path, encoding="utf-8") as handle:
        numbered = [(number, line.rstrip("\n")) for number, line in enumerate(handle, start=1)]
    return [(number, line) for number, line in numbered if line.strip() and not line.startswith("#")]


def read_tsv_lines(path: str, header: Sequence[str]) -> list[tuple[int, list[str]]]:
    """(line number, cells) of every data line after the exact header; the caller checks the cell count."""
    content_lines = data_lines(path)
    if not content_lines:
        raise TsvError("%s: missing header" % path)
    header_number, header_line = content_lines[0]
    if header_line.split("\t") != list(header):
        raise TsvError("%s:%d: header must be exactly: %s" % (path, header_number, "\t".join(header)))
    return [(number, line.split("\t")) for number, line in content_lines[1:]]


def read_tsv_records(path: str, header: Sequence[str]) -> list[dict[str, str]]:
    records = []
    for number, cells in read_tsv_lines(path, header):
        if len(cells) != len(header):
            raise TsvError("%s:%d: expected %d columns, found %d" % (path, number, len(header), len(cells)))
        records.append(dict(zip(header, cells)))
    return records


def read_jsonl(path: str) -> tuple[list[dict], int]:
    """Returns (records, malformed line count). A missing file is an empty log."""
    if not os.path.exists(path):
        return [], 0
    records, malformed = [], 0
    with open(path, encoding="utf-8") as handle:
        for line in filter(str.strip, handle):
            try:
                record = json.loads(line)
            except ValueError:
                record = None
            if isinstance(record, dict):
                records.append(record)
            else:
                malformed += 1
    return records, malformed


def append_jsonl(path: str, record: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")

