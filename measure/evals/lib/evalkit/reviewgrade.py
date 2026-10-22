from __future__ import annotations

import re
import statistics
from dataclasses import dataclass

from evalkit.cases import SPLITS
from evalkit.reviewcases import Location, ReviewCase

LINE_TOLERANCE = 3
PATH_LINE_REF = re.compile(r"([^\s:`'\"(),\[\]]+):(\d+)(?:-(\d+))?")
BARE_LINE_REF = re.compile(r":(\d+)(?:-(\d+))?")


@dataclass(frozen=True)
class RunGrade:
    case: ReviewCase
    run: int
    blocking: int
    hit: bool

    @property
    def passed(self) -> bool:
        return self.blocking == 0 if self.case.is_clean else self.hit


def grade_result(case: ReviewCase, run: int, result: dict) -> RunGrade:
    blocking = result.get("blocking") or []
    hit = not case.is_clean and any(_at_location(finding, location) for finding in blocking for location in case.locations)
    return RunGrade(case, run, len(blocking), hit)


def _at_location(finding: object, location: Location) -> bool:
    if not isinstance(finding, dict):
        return False
    low, high = location.line - LINE_TOLERANCE, location.line + LINE_TOLERANCE
    return any(start <= high and end >= low for start, end in _quoted_lines(finding, location.file))


def _quoted_lines(finding: dict, expected_file: str) -> list[tuple[int, int]]:
    quote = str(finding.get("quote") or "")
    ranges = [_range(start, end) for path, start, end in PATH_LINE_REF.findall(quote) if _same_file(path, expected_file)]
    if _same_file(str(finding.get("file") or ""), expected_file):
        ranges += [_range(start, end) for start, end in BARE_LINE_REF.findall(quote)]
    return ranges


def _same_file(path: str, expected_file: str) -> bool:
    path = path.strip().replace("\\", "/")
    return bool(path) and (path == expected_file or path.endswith("/" + expected_file) or expected_file.endswith("/" + path))


def _range(start: str, end: str) -> tuple[int, int]:
    return int(start), int(end or start)


def suite_numbers(grades: list[RunGrade]) -> dict:
    numbers = {split: _split_numbers([grade for grade in grades if grade.case.split == split]) for split in SPLITS}
    train = numbers[SPLITS[0]]
    numbers["headroom"] = not (train["recall"] == 1.0 and train["noise_rate"] == 0.0)
    numbers["case_agreement"] = _case_agreement(grades)
    return numbers


def _split_numbers(grades: list[RunGrade]) -> dict:
    defect = [grade for grade in grades if not grade.case.is_clean]
    clean = [grade for grade in grades if grade.case.is_clean]
    return {
        "defect_runs": len(defect), "hits": sum(grade.hit for grade in defect), "recall": _ratio(sum(grade.hit for grade in defect), len(defect)),
        "clean_runs": len(clean), "noisy_runs": sum(grade.blocking > 0 for grade in clean),
        "noise_rate": _ratio(sum(grade.blocking > 0 for grade in clean), len(clean)),
        "blocking_per_clean_run": _ratio(sum(grade.blocking for grade in clean), len(clean)),
        "recall_stdev": _recall_stdev(defect),
    }


def _recall_stdev(defect: list[RunGrade]) -> float | None:
    by_run: dict[int, list[bool]] = {}
    for grade in defect:
        by_run.setdefault(grade.run, []).append(grade.hit)
    recalls = [sum(hits) / len(hits) for hits in by_run.values()]
    return round(statistics.pstdev(recalls), 4) if len(recalls) > 1 else None


def _case_agreement(grades: list[RunGrade]) -> float | None:
    outcomes: dict[str, set[bool]] = {}
    counts: dict[str, int] = {}
    for grade in grades:
        outcomes.setdefault(grade.case.id, set()).add(grade.passed)
        counts[grade.case.id] = counts.get(grade.case.id, 0) + 1
    repeated = [case_id for case_id, count in counts.items() if count > 1]
    return _ratio(sum(len(outcomes[case_id]) == 1 for case_id in repeated), len(repeated))


def _ratio(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None
