### Added
- `keel evidence check --repo <path>` runs ship-gate's push judgment on HEAD without pushing and prints each missing piece (review, tests, approval) as JSON, exiting 1 when the push would be denied, so a multi-repo ship finds an untested or stale repo before its first push instead of at a K3 deny.
