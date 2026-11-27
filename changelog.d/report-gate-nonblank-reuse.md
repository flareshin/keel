### Fixed

- report-gate's K2 check of a JSON finding now judges a blank `file` or `path` by the same rule as the codex review writers (`nonblank`, now in `lib/evidence/text.ts`), so a file name made only of a byte-order mark no longer counts as a file-and-line finding.
