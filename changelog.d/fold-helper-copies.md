### Changed

- The hook protocol module and the ship gate now call the shared `printLine`/`writeStderr` and `nextWord` helpers instead of carrying private copies of them; hook output and gate decisions are unchanged.
