### Fixed

- A TAP test point whose name reads like a runner summary (`ok 1 - 1 failed, 2 passed in 0.5s`) was counted as a summary, adding passes or failures that never ran. `keel test` now reads summary shapes only outside TAP test-point and diagnostic lines.
- A multi-module Maven build was counted from its last `Tests run:` line only, so every module but the last was dropped. `keel test` now adds up the total that follows each module's `Results:` (or older surefire's `Results :`) heading, and falls back to the last line when the output has no heading.
