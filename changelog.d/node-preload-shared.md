### Changed

- `lib/node-preload.ts` builds the `NODE_OPTIONS` `--import` line once for the precheck read trace and the frozen-clock and sleep-log test preloads; `tests/preload.ts` is gone.
