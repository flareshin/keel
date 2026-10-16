
from __future__ import annotations

import json
import os
import sys
from typing import List, Optional

from evidence import gc, gitcmd, registry, store, testrun, verify, writers
from evidence.chain import build_chains
from evidence.writers import Refused, Usage

USAGE = """usage:
  keel test -- <command…>
  keel approve <root_run_id> [--read]
  keel snapshot <repo>
  keel review prepare                 (stdin: workflow args; stdout: prepared metadata)
  keel evidence write-review          (stdin: {"keel_evidence":{…},"verdict":…,"source":{…}})
  keel evidence write-smoke [--repo <path>] [--run <smoke run_id>]
  keel evidence show [--repo <path>] [--root <root_run_id>]
  keel evidence compatibility         (read-only retirement inventory across repos)
  keel evidence record-codex --repo <path> --audits <UUID,UUID,...> [--verifiers <UUID,UUID,...>]
  keel evidence gc"""
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_REFUSED = 3
EXIT_INTERNAL = 70


def main(argv: List[str]) -> int:
    try:
        return _dispatch(argv)
    except Usage as error:
        print("keel: %s\n%s" % (error, USAGE), file=sys.stderr)
        return EXIT_USAGE
    except Refused as error:
        print("keel: refused: %s" % error, file=sys.stderr)
        return EXIT_REFUSED
    except Exception as error:
        print("keel: internal error: %s: %s" % (type(error).__name__, error), file=sys.stderr)
        return EXIT_INTERNAL


def _dispatch(argv: List[str]) -> int:
    if not argv:
        raise Usage("missing command")
    command = {"test": _test, "approve": _approve, "snapshot": _snapshot, "evidence": _evidence, "review": _review}.get(argv[0])
    if command is None:
        raise Usage("unknown command " + argv[0])
    return command(argv[1:])


def _test(rest: List[str]) -> int:
    if rest[:1] != ["--"]:
        raise Usage("keel test -- <command…>")
    return testrun.run(rest[1:], os.getcwd())


def _review(rest: List[str]) -> int:
    if rest != ['prepare']:
        raise Usage('keel review prepare reads workflow args from stdin')
    from evidence import prepare
    _print(prepare.review(_stdin_json()))
    return EXIT_OK


def _approve(rest: List[str]) -> int:
    flags = [arg for arg in rest if arg.startswith("--")]
    positional = [arg for arg in rest if not arg.startswith("--")]
    if len(positional) != 1 or any(flag != "--read" for flag in flags):
        raise Usage("keel approve <root_run_id> [--read]")
    kind = "ack" if "--read" in flags else "approval"
    _print(writers.write_approval(positional[0], kind))
    return EXIT_OK


def _snapshot(rest: List[str]) -> int:
    if len(rest) != 1:
        raise Usage("keel snapshot <repo>")
    repo_root = gitcmd.toplevel(rest[0])
    if repo_root is None:
        raise Usage("%s is not inside a git repository" % rest[0])
    _print({"repo_root": repo_root, "tree": gitcmd.snapshot_tree(repo_root)})
    return EXIT_OK


def _evidence(rest: List[str]) -> int:
    if not rest:
        raise Usage("keel evidence <write-review|write-smoke|show|gc>")
    subcommand, options = rest[0], _options(rest[1:], {"--repo", "--run", "--root", "--audits", "--verifiers"})
    if subcommand == "record-codex":
        from evidence import codex_lenses
        if not {'--repo', '--audits'} <= set(options) or set(options) - {'--repo', '--audits', '--verifiers'}:
            raise Usage('registration requires --repo, --audits and optional --verifiers')
        verifiers = options['--verifiers'].split(',') if '--verifiers' in options else []
        _print(codex_lenses.register(options['--repo'], options['--audits'].split(','), verifiers))
    elif subcommand == "write-review":
        _print(writers.write_review(_stdin_json()))
    elif subcommand == "write-smoke":
        _print(writers.write_smoke(options.get("--repo") or os.getcwd(), options.get("--run")))
    elif subcommand == "show":
        _print(show(options.get("--repo") or os.getcwd(), options.get("--root")))
    elif subcommand == 'compatibility':
        if options:
            raise Usage('compatibility inventories all repositories; it takes no options')
        _print(compatibility())
    elif subcommand == "gc":
        _print({"deleted": gc.collect()})
    else:
        raise Usage("unknown evidence subcommand " + subcommand)
    return EXIT_OK


def show(repo_path: str, root_run_id: Optional[str]) -> dict:
    repo_root = gitcmd.toplevel(repo_path)
    repo_key = registry.origin_key(repo_root) if repo_root else None
    if repo_key is None:
        raise Usage("%s is not a git repository with an origin remote" % repo_path)
    chains = []
    for chain in build_chains(store.load("review", repo_key)):
        if root_run_id and chain.root_run_id != root_run_id:
            continue
        head = chain.head
        chains.append({
            "root_run_id": chain.root_run_id, "head_evidence_id": head["evidence_id"], "verdict": head["verdict"],
            "review_kind": head["review_kind"], "paths": len(chain.reviewed),
            "approved": verify.bound_evidence("approval", chain.root_run_id, repo_key, head["evidence_id"]) is not None,
            "acked": verify.bound_evidence("ack", chain.root_run_id, repo_key, head["evidence_id"]) is not None,
        })
    return {"repo": repo_key, "chains": chains,
            "tests": [evidence["evidence_id"] for evidence in store.load("tests", repo_key)],
            "smoke": [evidence["evidence_id"] for evidence in store.load("smoke", repo_key)]}


def compatibility() -> dict:
    from evidence import codex_review
    count, roots = 0, []
    for key in store.repo_keys('review'):
        reviews = store.load('review', key)
        old = {item['evidence_id'] for item in reviews if item.get('review_kind') == codex_review.KIND
               and (item.get('source') or {}).get('version') != 2}
        count += len(old)
        roots.extend(chain.root_run_id for chain in build_chains(reviews)
                     if any(link['evidence_id'] in old for link in chain.links))
    return {'read_only_records': count, 'chain_roots': sorted(set(roots)),
            'reader_removable': count == 0 and not roots}


def _options(args: List[str], allowed: set) -> dict:
    options = {}
    remaining = iter(args)
    for arg in remaining:
        if arg not in allowed:
            raise Usage("unexpected argument " + arg)
        value = next(remaining, None)
        if value is None:
            raise Usage("%s needs a value" % arg)
        options[arg] = value
    return options


def _stdin_json() -> dict:
    try:
        request = json.load(sys.stdin)
    except ValueError as error:
        raise Usage("stdin is not JSON: %s" % error) from error
    if not isinstance(request, dict):
        raise Usage("stdin must be a JSON object")
    return request


def _print(result: dict) -> None:
    print(json.dumps(result, sort_keys=True))
