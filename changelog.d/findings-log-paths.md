### Fixed

- `keel evidence write-review` logs a Merge-blocking finding at `At: N/A` with `path: null` instead of the literal `N/A`, keeps a single-repo finding whose absolute `At:` file lies outside the repository instead of dropping it, and appends a review's finding lines in one write.
