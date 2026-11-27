### Fixed

- lens-review writes every invisible or non-ASCII space character in a report line (a tab, U+3000, U+FEFF and the like) as its `U+XXXX` code point, so the reporter agent can copy the report line for line instead of failing the run with "line N differs from the expected report".
