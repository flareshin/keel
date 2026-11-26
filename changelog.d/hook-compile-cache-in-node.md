### Fixed

- Every registered hook turns on Node's compile cache through a preload (`node --import=<keel>/hooks/lib/hookkit/compile-cache.ts`) that puts it under the expanded data directory. The old shell prefix `NODE_COMPILE_CACHE="${KEEL_DATA_DIR:-$HOME/.claude}/..."` left a `KEEL_DATA_DIR` starting with `~` unexpanded, so Node made a literal `~` directory in the hook's working directory. A `NODE_COMPILE_CACHE` already set in the environment still wins, and `NODE_DISABLE_COMPILE_CACHE` still turns the cache off. Relink installed settings after updating.
