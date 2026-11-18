### Changed

- ship-gate asks git once per direction, not once per review chain, how each chain's review base relates to the outgoing merge base, head or series boundary (`git rev-list --stdin`), so judging a push or a Stop no longer slows by one `git merge-base --is-ancestor` per live review base; when git cannot resolve a candidate, the per-pair query runs as before and reports its error.
