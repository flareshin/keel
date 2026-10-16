# keel principles

Five principles, each enforced at the strongest layer that can hold it. Rules enter and leave only through a ledger row; the `[ID]` on a line names that row.

## Charter
- [K1] An author never judges its own output. A separate context judges every diff, report or artifact (a new reviewer agent; `/lens-review` for code); an author's self-PASS is void.
- [K2] Every done or pass claim carries machine-verifiable evidence: a runner summary (`Ran N tests`, `Tests run: N`), an exit code, a count, a diff stat or quoted output. A check that recognized zero items is not a pass.
- [K3] Changed logic ships with tests in the same diff. A bug gets a red reproduction test first, then one fix at the root cause. Run tests as `keel test -- <cmd>` so they count as evidence.
- [K4] Ask when ambiguous; act when clear. Two or more plausible readings: load `/prompt-refine` and ask only what changes the work. A clear request: no permission-seeking.
- [K5] Change only what the request needs, minimally, in code a person can follow. Load `/readable-code` before writing code or a coding-agent brief.

## Risk
- [risk] Use `docs/review-policy.md` for ready-candidate per-lens audits, batched finding checks and snapshot deltas. smoke-only needs smoke evidence; other tiers need `/lens-review` and tests (light per registry). Merge or deploying/notifying push needs owner's `keel approve <root_run_id>`; `--read` is ack only. PRs require owner `keel approve` then explicit `/ship1`; PASS is not consent.

## Floor
Hook-enforced, not principles.
- [F-irreversible] Merge, deploy and deletes need the user's explicit approval; so does a branch push where the push itself deploys or notifies. A blocked command goes to the user verbatim; never retry it or route around it.
- [F-secrets] No secrets in commits, PR bodies, logs or docs; cite the config path or a `<placeholder>`.
- [F-attribution] No AI attribution in commits or PRs.
- [F-force-push] No force push to shared branches.
- [F-hookskip] Never switch hooks off: no `--no-verify`, `core.hooksPath` change or `disableAllHooks`.
