"""Review chains: a root review plus deltas, folded into the set of paths the chain saw."""
from __future__ import annotations

from typing import Dict, List, NamedTuple, Optional, Tuple


class Chain(NamedTuple):
    root_run_id: str
    links: Tuple[dict, ...]  # root first, head last
    reviewed: Dict[str, Tuple[Optional[str], str]]  # path -> (blob or None when deleted, mode)

    @property
    def head(self) -> dict:
        return self.links[-1]

    @property
    def root(self) -> dict:
        return self.links[0]


def build_chains(reviews: List[dict]) -> List[Chain]:
    """One chain per head (a review no later review points at), newest head first. A head whose `since`
    trail does not reach a root (an expired or missing link) is dropped: an incomplete chain cannot say
    what it reviewed."""
    by_id = {review["evidence_id"]: review for review in reviews}
    followed = {review["since"] for review in reviews if review.get("since")}
    chains = []
    for head in reviews:
        links = None if head["evidence_id"] in followed else _trail(head, by_id)
        if links:
            reviewed = {entry["path"]: (entry["blob"], entry["mode"]) for link in links for entry in link["paths"]}
            chains.append(Chain(head["root_run_id"], tuple(links), reviewed))
    chains.sort(key=lambda chain: (chain.head["created_at"], chain.head["evidence_id"]), reverse=True)
    return chains


def _trail(head: dict, by_id: Dict[str, dict]) -> Optional[List[dict]]:
    """Root-first links from `head` back along `since`; None when a link is missing, loops or leaves the root."""
    links = [head]
    seen = {head["evidence_id"]}
    while links[-1].get("since"):
        previous = by_id.get(links[-1]["since"])
        if previous is None or previous["evidence_id"] in seen or previous["root_run_id"] != head["root_run_id"]:
            return None
        links.append(previous)
        seen.add(previous["evidence_id"])
    root = links[-1]
    return links[::-1] if root["root_run_id"] == root["run_id"] else None
