"""Overlay TSV data files (DESIGN Interfaces (a): header must match, `#` and blank lines skipped)."""
from __future__ import annotations

import os


class OverlayDataError(ValueError):
    pass


def read_tsv(path: str, header: tuple, optional: tuple = ()) -> list:
    """Rows as dicts keyed by the file's header, which is `header` optionally followed by `optional`;
    a missing file means no data."""
    if not os.path.isfile(path):
        return []
    rows = []
    columns = None
    with open(path, encoding="utf-8") as stream:
        for number, line in enumerate(stream, start=1):
            line = line.rstrip("\n")
            if not line.strip() or line.startswith("#"):
                continue
            cells = tuple(line.split("\t"))
            if columns is None:
                if cells not in (header, header + optional):
                    raise OverlayDataError("%s:%d: header must be %s" % (path, number, "\\t".join(header + optional)))
                columns = cells
                continue
            if len(cells) != len(columns):
                raise OverlayDataError("%s:%d: expected %d columns" % (path, number, len(columns)))
            rows.append(dict(zip(columns, cells)))
    return rows
