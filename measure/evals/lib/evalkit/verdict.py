"""Pass rules: two thirds of a case's runs; every clear case and two thirds of the ambiguous ones per split; both splits."""
from __future__ import annotations

from dataclasses import dataclass

from evalkit.cases import Case


@dataclass
class CaseVerdict:
    case: Case
    runs: list[bool]

    @property
    def passed(self) -> bool:
        return sum(self.runs) >= passes_needed(len(self.runs))


@dataclass
class SplitVerdict:
    split: str
    cases: int
    passed_cases: int
    passed: bool


def passes_needed(total: int) -> int:
    """Two thirds rounded up: 2 of 3, 1 of 1, 3 of 4."""
    return -(-2 * total // 3)


def split_verdict(split: str, verdicts: list[CaseVerdict]) -> SplitVerdict:
    in_split = [verdict for verdict in verdicts if verdict.case.split == split]
    clear = [verdict for verdict in in_split if verdict.case.is_clear]
    ambiguous = [verdict for verdict in in_split if not verdict.case.is_clear]
    passed = all(verdict.passed for verdict in clear) and sum(verdict.passed for verdict in ambiguous) >= passes_needed(len(ambiguous))
    return SplitVerdict(split, len(in_split), sum(verdict.passed for verdict in in_split), passed)


def suite_passes(splits: list[SplitVerdict]) -> bool:
    return all(split.passed for split in splits)
