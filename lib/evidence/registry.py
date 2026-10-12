"""Overlay data the gate reads: gated-repos.tsv and risk-rules.tsv (Interfaces (h))."""
from __future__ import annotations

import os
from typing import Dict, List, NamedTuple, Optional

from evidence import env, gitcmd

GATED_HEADER = ["origin", "gate", "integration_base", "risk_rules", "tests"]
GATED_OPTIONAL = ["push_approval"]  # absent in older registries: a push then needs no approval
RISK_HEADER = ["set", "path_glob", "class"]
GATE_OFF = "off"
GATE_VALUES = ("code", "smoke", GATE_OFF)
RISK_CLASSES = ("light", "heavy", "smoke-only")
FLAG_VALUES = ("true", "false")
EMPTY = "-"


class RegistryError(Exception):
    """An overlay TSV file does not follow the documented format."""


class GatedRepo(NamedTuple):
    origin: str
    gate: str
    integration_base: str
    risk_rules: str
    tests: str
    push_approval: str = "false"

    @property
    def tests_required(self) -> bool:
        return self.tests != "none"

    @property
    def push_needs_approval(self) -> bool:
        """True where a branch push itself deploys or notifies, so approval is due at push, not only at merge."""
        return self.push_approval == "true"


class RiskRule(NamedTuple):
    rule_set: str
    path_glob: str
    risk_class: str


def normalize_repo_key(origin: Optional[str]) -> Optional[str]:
    """`owner/repo` from any origin URL: lowercase, last two path segments, `.git` stripped."""
    if not origin:
        return None
    segments = [segment for segment in origin.strip().rstrip("/").removesuffix(".git").replace(":", "/").split("/")
                if segment]
    return "/".join(segments[-2:]).lower() if len(segments) >= 2 else None


def origin_key(repo_root: str) -> Optional[str]:
    return normalize_repo_key(gitcmd.origin_url(repo_root))


def registry_path() -> str:
    return os.path.join(env.overlay_dir(), "gated-repos.tsv")


def gated_repos() -> Dict[str, GatedRepo]:
    repos = {}
    for row in read_tsv(registry_path(), GATED_HEADER, GATED_OPTIONAL):
        if row["gate"] not in GATE_VALUES:
            raise RegistryError("gated-repos.tsv: unknown gate %r for %s" % (row["gate"], row["origin"]))
        if row.get("push_approval", "false") not in FLAG_VALUES:
            raise RegistryError("gated-repos.tsv: push_approval must be true or false for %s" % row["origin"])
        repos[row["origin"].lower()] = GatedRepo(**row)
    return repos


def is_gated(row: Optional[GatedRepo]) -> bool:
    """A registry row that gates its repo; None (unlisted) gates nothing."""
    return row is not None and row.gate != GATE_OFF


def gates_any_repo() -> bool:
    return any(is_gated(row) for row in gated_repos().values())


def lookup(repo_key: Optional[str]) -> Optional[GatedRepo]:
    if not repo_key:
        return None
    return gated_repos().get(repo_key)


def risk_rules(rule_set: str) -> List[RiskRule]:
    if rule_set == EMPTY:
        return []
    rules = []
    for row in read_tsv(os.path.join(env.overlay_dir(), "risk-rules.tsv"), RISK_HEADER):
        if row["set"] != rule_set:
            continue
        if row["class"] not in RISK_CLASSES:
            raise RegistryError("risk-rules.tsv: unknown class %r" % row["class"])
        rules.append(RiskRule(row["set"], row["path_glob"], row["class"]))
    return rules


def read_tsv(path: str, header: List[str], optional: List[str] = ()) -> List[Dict[str, str]]:
    """Rows as dicts; none when the file is absent; a header other than `header`, optionally followed by
    `optional`, raises."""
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as stream:
        content = [line.rstrip("\n") for line in stream if line.strip() and not line.startswith("#")]
    if not content:
        return []
    columns = content[0].split("\t")
    if columns not in (header, header + list(optional)):
        raise RegistryError("%s: header must be %s" % (path, "\t".join(header + list(optional))))
    rows = []
    for line in content[1:]:
        values = line.split("\t")
        if len(values) != len(columns):
            raise RegistryError("%s: expected %d columns: %r" % (path, len(columns), line))
        rows.append(dict(zip(columns, values)))
    return rows
