"""Risk classification of an outgoing change (DESIGN 5.4), recomputed from the diff every time."""
from __future__ import annotations

import fnmatch
from typing import Dict, List, NamedTuple

from evidence.gitcmd import PathEntry, PathStat
from evidence.registry import RiskRule

SMOKE_ONLY = "smoke-only"
LIGHT = "light"
STANDARD = "standard"
HEAVY = "heavy"
CLASS_ORDER = (SMOKE_ONLY, LIGHT, STANDARD, HEAVY)
LOGIC_CLASSES = (STANDARD, HEAVY)
TEST_SEGMENTS = {"test", "tests", "__tests__"}
TEST_BASENAME_GLOBS = ("test_*.py", "*_test.*", "*.test.*", "*.spec.*")


class PathRisk(NamedTuple):
    path: str
    risk_class: str
    why: str
    is_test: bool
    is_gitlink: bool


class Risk(NamedTuple):
    risk_class: str
    paths: List[PathRisk]
    files: int
    lines: int

    def logic_paths(self) -> List[str]:
        """Non-test, non-submodule paths classed standard or heavy: the paths K3 wants a test for."""
        return [risk.path for risk in self.paths
                if not risk.is_test and not risk.is_gitlink and risk.risk_class in LOGIC_CLASSES]

    def has_test_path(self) -> bool:
        return any(risk.is_test for risk in self.paths)


def is_test_path(path: str) -> bool:
    segments = path.split("/")
    if any(segment in TEST_SEGMENTS for segment in segments[:-1]):
        return True
    basename = segments[-1]
    return any(fnmatch.fnmatchcase(basename, glob) for glob in TEST_BASENAME_GLOBS)


def classify_path(entry: PathEntry, rules: List[RiskRule]) -> PathRisk:
    """A test path adds nothing to the tier (light); else the heaviest matching rule, else standard."""
    if is_test_path(entry.path):
        return PathRisk(entry.path, LIGHT, "test", True, entry.is_gitlink)
    matching = [rule for rule in rules if fnmatch.fnmatchcase(entry.path, rule.path_glob)]
    if not matching:
        return PathRisk(entry.path, STANDARD, "no rule", False, entry.is_gitlink)
    heaviest = max(matching, key=lambda rule: CLASS_ORDER.index(rule.risk_class))
    return PathRisk(entry.path, heaviest.risk_class, "rule " + heaviest.path_glob, False, entry.is_gitlink)


def classify(entries: List[PathEntry], stats: Dict[str, PathStat], rules: List[RiskRule]) -> Risk:
    paths = [classify_path(entry, rules) for entry in entries]
    lines = sum(stat.added + stat.deleted for stat in stats.values())
    return Risk(_push_class(paths), paths, len(entries), lines)


def _push_class(paths: List[PathRisk]) -> str:
    """Heaviest path; smoke-only only when every path is, otherwise those count as light."""
    if not paths:
        return STANDARD
    if all(risk.risk_class == SMOKE_ONLY for risk in paths):
        return SMOKE_ONLY
    ranks = [max(CLASS_ORDER.index(risk.risk_class), CLASS_ORDER.index(LIGHT)) for risk in paths]
    return CLASS_ORDER[max(ranks)]
