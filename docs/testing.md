# Running the tests

Requirements: `node` 24 or newer (the `engines` field; tested on 26.12), `bash`, `git` and `jq`. keel does not use Python. Run `npm ci` once before the tests: the precheck tests and `keel precheck` need `typescript`, found in the checkout's `node_modules` or a parent folder's (a worktree under a checkout that has run `npm ci` finds it there), and `run-all.sh` stops before any suite when it cannot resolve it.

```bash
npm ci
bash tests/run-all.sh
```

Tests run in temporary directories (`KEEL_DATA_DIR`, `KEEL_OVERLAY_DIR`, `HOME`). They never touch the network or a real `~/.claude`, except that `run-all.sh` holds the full-suite lock `$KEEL_DATA_DIR/state/keel/full-suite.lock` (default `~/.claude`) while it runs, so a second full run on the machine waits, and points `NODE_COMPILE_CACHE` at `state/keel/node-compile-cache` there unless it is already set, so test processes reuse compiled modules (the daily ship-gate gc caps that folder, see DESIGN.md); a run past 30 minutes is stopped and leaves its process stacks under `state/keel/suite-hangs/` there. To run a single component:

```bash
node --test 'tests/ship-gate/*.test.ts'
node --test 'tests/workflows/*.test.mjs'
npx tsc -p tsconfig.json
```

No `py*.ts` module and no argparse clone is left; `measure`, `bin/link` and `lib/evidence` read JSON, paths, files, dates and command lines with plain Node behavior. Some Python semantics are kept on purpose in `hooks/lib/hookkit`, `codex/` and `skills/writing-readable-code/scripts/rule-checks.ts`: the `splitlines` and `strip` character sets (`hooks/lib/hookkit/text.ts`, `apply_patch` text and guard output), CPython's recursion limit in the Codex TOML reader (`codex/lib/toml.ts`), the hooks' JSON spacing and error class names, and the exception names `rule-checks.ts` prints. The unreleased changelog fragments in `changelog.d/` describe the ones that changed behavior.

The `rule-checks` parity test compares the TypeScript with outputs recorded from the earlier Python implementation (Python 3.15.0, macOS) and stored as the fixture `tests/skills/fixtures/rule-checks-parity.json`; each case whose outcome changed since is listed with the result it must give. The parity tests of the hooks and the ship-gate hook replay the recorded runs and payloads in `tests/hooks/fixtures` and `tests/ship-gate/fixtures` and compare the node code with a golden snapshot of its own output; `node tests/hooks/hook-parity-record.ts` and `node tests/ship-gate/ship-gate-parity-record.ts` re-record it. The ship-gate and hooks replays skip the recorded cases that tests of their own cover and the repeats of an outcome class inside each group of generated cases (the ship-gate `extra` cases by test, the hook adversarial payloads), replaying the first case of each outcome class in every group, so every outcome class of the corpus is replayed; `SHIP_GATE_PARITY_FULL=1` and `HOOK_PARITY_FULL=1` replay them all. Each replay is split over eight shard files (`tests/ship-gate/ship-gate-parity-shard-<n>.test.ts`, `tests/hooks/hook-parity-shard-<n>.test.ts`) that `node --test` runs in parallel; `node tests/hooks/hook-parity.ts` still replays the hooks as one run. `measure`, `bin/link` and `lib/evidence` keep only the recorded outcomes (exit code, JSON fields, written files) in `tests/fixtures/measure`, `tests/fixtures/link` and `tests/fixtures/evidence`, and the Codex adapter keeps a golden snapshot of its input boundaries in `tests/fixtures/codex`, re-recorded with `node codex/tests/boundary-record.ts`. The Python recordings of the shell parser, the Codex TOML port and path helpers, and the Codex adapter and installer are deleted: the tools that recorded them needed the Python, which is gone, and survive only in the git history of the commits that introduced the fixtures.

GitHub Actions (`.github/workflows/test.yml`) runs the typecheck and `tests/run-all.sh` on macOS for every pull request and every push to `main`.

To enable the boundary-scan git hooks in a checkout, run `git config core.hooksPath githooks`.
