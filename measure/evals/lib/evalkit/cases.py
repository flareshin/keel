"""Case files of one eval: keel's and the overlay's `measure/evals/<id>/{train,holdout}.tsv`, merged and checked."""
from __future__ import annotations

import os
from dataclasses import dataclass

from measurekit.datafiles import TsvError, read_tsv_records

COLUMNS = ("id", "kind", "expect", "prompt")
TRAIN, HOLDOUT = "train", "holdout"
SPLITS = (TRAIN, HOLDOUT)
AMBIGUOUS, CLEAR_CHANGE, CLEAR_ANSWER = "ambiguous", "clear-change", "clear-answer"
KINDS = (AMBIGUOUS, CLEAR_CHANGE, CLEAR_ANSWER)
NO_EXPECT = "-"


class CaseError(Exception):
    pass


@dataclass(frozen=True)
class Case:
    id: str
    split: str
    kind: str
    expect: str
    prompt: str

    @property
    def is_clear(self) -> bool:
        return self.kind != AMBIGUOUS


def load_cases(eval_id: str, checkouts: list[str]) -> list[Case]:
    """Every case of every checkout's split files, in file order; one id twice anywhere is an error."""
    cases: list[Case] = []
    first_file_of: dict[str, str] = {}
    for checkout in checkouts:
        for split in SPLITS:
            path = os.path.join(checkout, "measure", "evals", eval_id, split + ".tsv")
            if not os.path.isfile(path):
                continue
            for case in _read_cases(path, split):
                if case.id in first_file_of:
                    raise CaseError("%s: duplicate case id %r (first in %s)" % (path, case.id, first_file_of[case.id]))
                first_file_of[case.id] = path
                cases.append(case)
    return cases


def _read_cases(path: str, split: str) -> list[Case]:
    try:
        records = read_tsv_records(path, COLUMNS)
    except TsvError as error:
        raise CaseError(str(error))
    cases = []
    for record in records:
        if record["kind"] not in KINDS:
            raise CaseError("%s: case %s has unknown kind %r (want one of %s)" % (path, record["id"], record["kind"], ", ".join(KINDS)))
        if record["kind"] == CLEAR_ANSWER and record["expect"] == NO_EXPECT:
            raise CaseError("%s: clear-answer case %s needs an expect token" % (path, record["id"]))
        cases.append(Case(record["id"], split, record["kind"], record["expect"], record["prompt"]))
    return cases


def select_cases(cases: list[Case], split: str | None, case_id: str | None) -> list[Case]:
    return [case for case in cases if (split is None or case.split == split) and (case_id is None or case.id == case_id)]


def split_gaps(cases: list[Case]) -> list[str]:
    """Why a full run over these cases would not be representative: a split lacking an ambiguous or a clear case."""
    gaps = []
    for split in SPLITS:
        in_split = [case for case in cases if case.split == split]
        if not any(not case.is_clear for case in in_split):
            gaps.append("%s has no ambiguous case" % split)
        if not any(case.is_clear for case in in_split):
            gaps.append("%s has no clear case" % split)
    return gaps
