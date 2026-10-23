# Changelog

All notable changes to keel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-23

The first released version. It adds a TypeScript port of every keel component beside the Python. Node runs the
`.ts` files directly through type stripping, with no build step. The Python still runs every hook and command: this
release adds the TypeScript side and proves it equal to the Python, and a later release switches the runtime over.

### Added
- TypeScript ports beside the Python originals, with matching node:test suites:
  - `hooks/lib/hookkit` (shell parser, payload protocol, fires log, transcript, overlay and repo helpers) and the hooks
    `git-guard`, `ship-gate`, `report-gate`, `handoff`, `model-assign` and `stacks/spring-maven/hooks/env-preflight`.
  - `lib/evidence` and `bin/keel.ts` (`keel test`, `approve`, `snapshot`, `review prepare`, `evidence`).
  - `lib/link` and `bin/link.ts`.
  - `measure/lib/measurekit`, `measure/evals/lib/evalkit` and the entries `measure/{boundary,propose,run,smoke,weekly}.ts`
    and `measure/evals/{eval,review-eval}.ts`. The review-eval sample cases are now TypeScript.
  - The Codex adapter (`codex/hooks/pre-tool-use.ts`, `codex/lib/*.ts`, `codex/bin/*.ts`) and
    `skills/readable-code/scripts/rule-checks.ts`.
- Python-compatibility helpers for the behaviors the port must reproduce exactly: `json.dumps` spelling, number
  fidelity, `splitlines`, code-point slicing, `re.I` folding of U+0130 and U+0131, argparse wrapping and Python 3.15
  colour, TextIOWrapper chunked decoding, errno wording, and locale and UTF-8 mode rules.
- Parity harnesses that run the Python and the TypeScript on the same inputs and require 0 mismatches. They cover
  the shell parser, every hook, ship-gate including a deny-to-pass count, keel evidence, link, measure and the Codex
  adapter.
- `package.json`, `tsconfig.json` (strict, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`) and `tests/run-all.sh`
  running the Python suites, the node suites and the workflow tests.
- This changelog and the package version.
- An Acknowledgements section in the README. It names the published skills that keel's `improve` and
  `readable-code` skills draw on (Matt Pocock's skills, Addy Osmani's agent-skills and pstack in cursor/plugins).

### Intended differences from the Python
Where the Python's result depends on its interpreter or machine, the TypeScript follows a fixed rule instead. Each
case is listed in a parity test, which fails if the TypeScript does not give the required outcome.
- Codex hook stdin: only UTF-8, ASCII, latin-1 and verified single-byte codecs are decoded. Any other codec Python
  knows is denied with `stdin encoding <codec> is not supported; set PYTHONUTF8=1`. An unknown codec name fails at
  startup like Python.
- JSON and `str` nesting is bounded at 10000 levels (`MAX_JSON_DEPTH`). Past it:
  - git-guard and ship-gate deny.
  - report-gate refuses a handback and blocks a stop when the payload, turn state or transcript nests too deep. It
    logs the error and lets the call through for a too-deep evidence line, for a payload that is neither a handback
    nor a stop, and for a stop that is already being retried.
  - model-assign and handoff log the error and let the call through.
- `link --unlink` refuses a non-string `pre_keel_settings_backup` in `link-state.json` with exit 70 and writes
  nothing. Python treats a number or a boolean there as a file descriptor.

### Requirements
- Node 24 or later for the TypeScript (`engines` in `package.json`); this release was tested on Node 26.12.
- Python 3.9 or later for the Python, as the README states. The parity tests compare against Python 3.15 behavior
  (for example argparse colour and locale rules), so run them with Python 3.15.
