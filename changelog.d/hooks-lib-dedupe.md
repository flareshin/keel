### Changed

- The hook library keeps one `isFile`, one `isDirectory`, one `describeError` and one rule for joining a subagent's final text, so `overlay.ts`, `repo.ts`, `fires.ts` and report-gate no longer carry their own copies. A hook that cannot append `keel-fires.jsonl` now reports the error as `Name: message`, like every other hook diagnostic, instead of `Name(message)`.
