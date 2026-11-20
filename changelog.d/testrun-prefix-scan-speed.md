### Fixed

- `keel test` reads a runner summary in linear time on a long output line that carries no summary. The summary patterns now run only on lines that end in a summary ending, one line at a time, so a 20,000-tally comma list with no `in Ns` ending takes about 3 ms instead of 7.5 s. A long line that does end in a summary ending is still read by the full pattern.
