### Fixed

- report-gate no longer exempts every report that starts with `[` or `{` from the K2 evidence check. A report under the evidence contract that is JSON now passes only with an evidence token in its text or a finding object that names a `file` or `path` and a positive integer `line`; an empty array or a finding with no line is refused like any other unproven report.
