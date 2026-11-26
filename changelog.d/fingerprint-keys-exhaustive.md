### Changed

- `CONFIG_FINGERPRINT_KEYS` is derived from a record keyed by every `ConfigFingerprint` field, so tsc fails when a new fingerprint field is not copied onto eval lines.
