from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from evalkit.cases import SPLITS, CaseError

CASES_PATH = os.path.join("measure", "evals", "review", "cases")
EXPECT_FILE = "expect.json"
CHANGE_FILE = "change.diff"
BASE_DIR = "base"
CLEAN_LENS = "control"
REQUIRED_KEYS = ("lens", "must_find", "source", "split", "locations")
OPTIONAL_KEYS = ("caller_skill", "requirement")
CASE_ID = re.compile(r"^[a-z0-9-]+-\d+$")


@dataclass(frozen=True)
class Location:
    file: str
    line: int


@dataclass(frozen=True)
class ReviewCase:
    id: str
    split: str
    lens: str
    locations: tuple[Location, ...]
    directory: str
    caller_skill: str | None
    requirement: str | None

    @property
    def is_clean(self) -> bool:
        return self.lens == CLEAN_LENS

    @property
    def change_path(self) -> str:
        return os.path.join(self.directory, CHANGE_FILE)

    @property
    def base_dir(self) -> str:
        return os.path.join(self.directory, BASE_DIR)


def load_review_cases(checkouts: list[str]) -> list[ReviewCase]:
    cases: list[ReviewCase] = []
    seen: dict[str, str] = {}
    for checkout in checkouts:
        root = os.path.join(os.path.abspath(checkout), CASES_PATH)
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            directory = os.path.join(root, name)
            if not os.path.isdir(directory):
                continue
            if name in seen:
                raise CaseError("case %s is in both %s and %s" % (name, seen[name], directory))
            seen[name] = directory
            cases.append(_read_case(name, directory))
    return cases


def select_review_cases(cases: list[ReviewCase], split: str | None, case_id: str | None) -> list[ReviewCase]:
    return [case for case in cases if (split is None or case.split == split) and (case_id is None or case.id == case_id)]


def _read_case(name: str, directory: str) -> ReviewCase:
    if not CASE_ID.match(name):
        raise CaseError("%s: a case directory is named <words>-<n>, lowercase" % directory)
    expect = _read_expect(os.path.join(directory, EXPECT_FILE))
    if not os.path.isfile(os.path.join(directory, CHANGE_FILE)):
        raise CaseError("%s: no %s" % (directory, CHANGE_FILE))
    if expect["split"] not in SPLITS:
        raise CaseError("%s: split must be one of %s" % (directory, ", ".join(SPLITS)))
    locations = tuple(_location(directory, item) for item in expect["locations"])
    if (expect["lens"] == CLEAN_LENS) != (not locations):
        raise CaseError("%s: a %s case has no locations and every other case has at least one" % (directory, CLEAN_LENS))
    return ReviewCase(
        id=name, split=expect["split"], lens=expect["lens"], locations=locations, directory=directory,
        caller_skill=expect.get("caller_skill"), requirement=expect.get("requirement"),
    )


def _read_expect(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            expect = json.load(handle)
    except (OSError, ValueError) as error:
        raise CaseError("cannot read %s: %s" % (path, error))
    if not isinstance(expect, dict):
        raise CaseError("%s is not a JSON object" % path)
    missing = [key for key in REQUIRED_KEYS if key not in expect]
    unknown = sorted(set(expect) - set(REQUIRED_KEYS) - set(OPTIONAL_KEYS))
    if missing or unknown:
        raise CaseError("%s: missing %s, unknown %s" % (path, missing, unknown))
    if not isinstance(expect["locations"], list):
        raise CaseError("%s: locations is a list" % path)
    for key in OPTIONAL_KEYS:
        if key in expect and not (isinstance(expect[key], str) and expect[key].strip()):
            raise CaseError("%s: %s is a non-empty string when given" % (path, key))
    return expect


def _location(directory: str, item: object) -> Location:
    if not (isinstance(item, dict) and set(item) == {"file", "line"} and isinstance(item["file"], str)
            and isinstance(item["line"], int) and item["line"] > 0):
        raise CaseError("%s: each location is {\"file\": relative path, \"line\": positive int}, got %r" % (directory, item))
    if os.path.isabs(item["file"]) or ".." in item["file"].split("/"):
        raise CaseError("%s: location file %r must be relative to the repo root" % (directory, item["file"]))
    return Location(item["file"], item["line"])
