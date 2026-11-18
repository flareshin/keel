### Changed

- ship-gate asks git once, not once per review chain, whether each chain's review base is an ancestor of the outgoing merge base or head (`git rev-list --stdin`), so judging a push or a Stop no longer slows as live review evidence accumulates; when git cannot resolve a candidate, the per-pair query runs as before and reports its error.
