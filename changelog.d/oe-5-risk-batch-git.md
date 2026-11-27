### Fixed

- `measure/metrics/risk` no longer spawns one git process per pair. It finds the checkout holding each ship head with one `cat-file --batch-check` per review root, answers ancestry from one `rev-list --parents` read per checkout, diffs every candidate base of a fast-forwarded ship in one `diff-tree --stdin`, and checks which shipped files remain at the horizon from one cached `ls-tree` listing per horizon. It also runs the overlay `defects-*` runners at the same time instead of one after the other. Its output is unchanged.
