### Fixed

- `keel test` reads a long output line that ends like a pytest summary in linear time. 1.1.6 still read such a line in quadratic time when it held no summary, or held one after a long tally run. Timed on 1.1.6 with `'1 a, '` repeated 20,000 times:
  - Before `x in 1s`: about 8 s.
  - Before `x; 1 passed in 1s`: about 7 s.
  - Inside a TAP `# ` diagnostic ending `1 a in 1s`: about 2 s.

  Each now takes a few milliseconds. The summary patterns are unchanged. A start inside a tally run that already failed is skipped, and the TAP-diagnostic check runs only once a summary matched, skipping the rest of a `# ` diagnostic up to its carriage return. What is counted is unchanged: 403,021 generated and captured outputs read the same as 1.1.6. A run of 20,000 `=` with no blank after it is still read in quadratic time: 0.35 s, down from 0.83 s on 1.1.6.
