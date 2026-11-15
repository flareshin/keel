### Added

- `measure/weekly` reports `recurring_findings`: Merge-blocking findings from `logs/keel-findings.jsonl` keyed by (repo, path, lens), with the keys that two or more review roots logged listed as recurring (top 20), so a finding that keeps coming back can be moved down with `/descending-findings`.
