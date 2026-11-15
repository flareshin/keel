### Fixed

- The node compile cache under `$KEEL_DATA_DIR/state/keel/node-compile-cache` no longer grows without bound. The daily gc that ship-gate runs on a push or merge now removes the version folders of other node versions, and removes the current one too when its files total more than 64 MiB (the owner's cache had reached 837 MB in 131,153 files); node recreates the cache on its next start. The deletion runs in a detached process, so the push is not held for it. When it removes anything, ship-gate records `compile cache removed <files> files <bytes> bytes`.
