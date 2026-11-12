# Running the tests

Requirements: `node` 24 or newer (the `engines` field; tested on 26.12), `bash`, `git` and `jq`. keel does not use Python.

```bash
bash tests/run-all.sh
```

Tests run in temporary directories (`KEEL_DATA_DIR`, `KEEL_OVERLAY_DIR`, `HOME`). They never touch the network or a real `~/.claude`, except that `run-all.sh` holds the full-suite lock `$KEEL_DATA_DIR/state/keel/full-suite.lock` (default `~/.claude`) while it runs, so a second full run on the machine waits. To run a single component:

```bash
node --test 'tests/ship-gate/*.test.ts'
node --test 'tests/workflows/*.test.mjs'
npm ci   # once, before the typecheck
npx tsc -p tsconfig.json
```

No `py*.ts` module and no argparse clone is left; `measure`, `bin/link` and `lib/evidence` read JSON, paths, files, dates and command lines with plain Node behavior. Some Python semantics are kept on purpose in `hooks/lib/hookkit`, `codex/` and `skills/writing-readable-code/scripts/rule-checks.ts`: the `splitlines` and `strip` character sets (`hooks/lib/hookkit/text.ts`, `apply_patch` text and guard output), CPython's recursion limit in the Codex TOML reader (`codex/lib/toml.ts`), the hooks' JSON spacing and error class names, and the exception names `rule-checks.ts` prints. The changelog's Unreleased section describes the ones that changed behavior.

The parity harnesses of the shell parser, `rule-checks`, and the Codex TOML port and path helpers compare the TypeScript with outputs recorded from the earlier Python implementation (Python 3.15.0, macOS) and stored as fixtures under `tests/fixtures/python` and `tests/skills/fixtures`. Each case whose outcome changed since is listed with the result it must give. The parity tests of the hooks, the ship-gate hook and the Codex adapter replay the recorded runs and payloads in `tests/hooks/fixtures`, `tests/ship-gate/fixtures` and `tests/fixtures/python/codex-{hook,cli}-parity` and compare the node code with a golden snapshot of its own output; `node tests/hooks/hook-parity-record.ts`, `node tests/ship-gate/ship-gate-parity-record.ts`, `node codex/tests/hook-parity-record.ts` and `node codex/tests/cli-parity-record.ts` re-record it. The ship-gate, hooks and Codex hook replays skip the recorded cases that tests of their own cover except one case of each outcome class they share; `SHIP_GATE_PARITY_FULL=1`, `HOOK_PARITY_FULL=1` and `CODEX_HOOK_PARITY_FULL=1` replay them all. Each replay is split over eight shard files (`tests/ship-gate/ship-gate-parity-shard-<n>.test.ts`, `tests/hooks/hook-parity-shard-<n>.test.ts`) that `node --test` runs in parallel; `node tests/hooks/hook-parity.ts` still replays the hooks as one run. `measure`, `bin/link` and `lib/evidence` keep only the recorded outcomes (exit code, JSON fields, written files) in `tests/fixtures/measure`, `tests/fixtures/link` and `tests/fixtures/evidence`, and the Codex adapter keeps a golden snapshot of its input boundaries in `tests/fixtures/codex`, re-recorded with `node codex/tests/boundary-record.ts`. The Python recordings are frozen: the tools that recorded them needed the Python, which is gone, and survive only in the git history of the commits that introduced the fixtures. The Codex path test that resolves through `/tmp` and `/private` was recorded on macOS and skips on other platforms.

To enable the boundary-scan git hooks in a checkout, run `git config core.hooksPath githooks`.
