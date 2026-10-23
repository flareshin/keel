# Changelog

All notable changes to keel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-23

The first released version, and the Node-only release. TypeScript replaces the Python in every hook, command, workflow
call and test, and Python is no longer needed. Node runs the `.ts` files directly through type stripping, with no build
step. The tests compare the TypeScript with outputs recorded from the Python before it was removed.

### Changed
- `settings/core.json` and `stacks/spring-maven/settings.json` register every hook as
  `node {{KEEL}}/hooks/<name>/<name>.ts` (env-preflight under `stacks/spring-maven/hooks/`), with the timeouts and flags
  the Python registrations had.
- Every extensionless executable is a short bash shim that follows its own symlinks and execs node on the `.ts` entry
  beside it: `bin/keel`, `bin/link`, `codex/bin/config`, `codex/bin/link`, `measure/{boundary,propose,run,smoke,weekly}`
  and `measure/evals/{eval,review-eval}`. `githooks/pre-commit` and `githooks/pre-push` call the `measure/boundary` shim.
- The Codex adapter registers and spawns the TypeScript hooks with node only, with no `python3` fallback.
- The `lens-review` workflow and the Codex review path run `skills/readable-code/scripts/rule-checks.ts` with node.
- `tests/run-all.sh` runs the node suites and the workflow tests; the Python suites are gone.
- `README.md`: the repository is public, the requirements are Node, bash, git and jq, and there is a Contributing
  section. Contributions come only as pull requests against `main`; only the owner (flareshin) reviews and merges them,
  and direct pushes to `main` are blocked for everyone else. No license has been chosen, so all rights remain reserved.
- A registered hook script that does not exist now makes `node` exit 1, where `python3` exited 2. Exit 1 does not block,
  so a missing script of a fail-open hook (report-gate, model-assign, handoff, env-preflight) no longer blocks every
  event. ship-gate and git-guard stay blocking through `"onFailure": "block"`. `link --check` and the smoke `dangling`
  check still report a missing script.

### Added
- TypeScript implementations of every keel component, with node:test suites:
  - `hooks/lib/hookkit` (shell parser, payload protocol, fires log, transcript, overlay and repo helpers) and the hooks
    `git-guard`, `ship-gate`, `report-gate`, `handoff`, `model-assign` and `stacks/spring-maven/hooks/env-preflight`.
  - `lib/evidence` and `bin/keel.ts` (`keel test`, `approve`, `snapshot`, `review prepare`, `evidence`).
  - `lib/link` and `bin/link.ts`.
  - `measure/lib/measurekit`, `measure/evals/lib/evalkit` and the entries `measure/{boundary,propose,run,smoke,weekly}.ts`
    and `measure/evals/{eval,review-eval}.ts`. The review-eval sample cases are TypeScript.
  - The Codex adapter (`codex/hooks/pre-tool-use.ts`, `codex/lib/*.ts`, `codex/bin/*.ts`) and
    `skills/readable-code/scripts/rule-checks.ts`.
- Python-compatibility helpers for the behaviors the port reproduces exactly: `json.dumps` spelling, number fidelity,
  `splitlines`, code-point slicing, `re.I` folding of U+0130 and U+0131, argparse wrapping and Python 3.15 colour,
  TextIOWrapper chunked decoding, errno wording, and locale and UTF-8 mode rules.
- Parity harnesses that run the TypeScript on the inputs the Python once saw and require 0 mismatches against the
  Python's recorded output (Python 3.15.0 on macOS). They cover the shell parser, every hook, ship-gate including a
  deny-to-pass count, keel evidence, link, measure, rule-checks and the Codex adapter. The recordings are fixtures in
  `tests/fixtures/python`, `tests/hooks/fixtures`, `tests/ship-gate/fixtures` and `tests/skills/fixtures`; a listed
  divergence is checked against the required outcome only. The errno-wording checks were recorded on macOS and skip on
  other platforms.
- `package.json`, `tsconfig.json` (strict, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`) and the package version.
- This changelog.
- An Acknowledgements section in the README. It names the published skills that keel's `improve` and `readable-code`
  skills draw on (Matt Pocock's skills, Addy Osmani's agent-skills and pstack in cursor/plugins).

### Removed
- Every Python file: the hooks, `lib/evidence`, `lib/link`, `measure/lib/measurekit`, `measure/evals/lib/evalkit`, the
  Codex adapter, `rule-checks.py`, the `unittest` suites and their helpers.

### Upgrading
1. Fast-forward the dedicated keel checkout (`~/git/keel`) to the 1.0.0 commit.
2. At once, from a terminal outside Claude Code and Codex, run `bin/link --write` and then `codex/bin/link --write` in
   that checkout. Both rewrite the hook registrations in the settings from `python3 .../<name>.py` to
   `node .../<name>.ts`.
3. Start a new Codex session, open `/hooks` and trust the regenerated `pre-tool-use.ts` command (see
   `codex/README.md`).
4. Run `bin/link --check` and `codex/bin/link --check`. Both must report no drift.

Until step 2 is done, every keel hook blocks: the old settings still point at the `.py` files this release deletes, so
`python3` fails on each hook call. Run the two `link --write` commands from a terminal outside Claude Code and Codex,
whose blocked hooks would stop them.

### Intended differences from the Python
Where the Python's result depended on its interpreter or machine, the TypeScript follows a fixed rule instead. Each
case is listed in a parity test, which fails if the TypeScript does not give the required outcome.
- Codex hook stdin: only UTF-8, ASCII, latin-1 and verified single-byte codecs are decoded. Any other codec Python
  knew is denied with `stdin encoding <codec> is not supported; set PYTHONUTF8=1`. An unknown codec name fails at
  startup like Python.
- JSON and `str` nesting is bounded at 10000 levels (`MAX_JSON_DEPTH`). Past it:
  - git-guard and ship-gate deny.
  - report-gate refuses a handback and blocks a stop when the payload, turn state or transcript nests too deep. It
    logs the error and lets the call through for a too-deep evidence line, for a payload that is neither a handback
    nor a stop, and for a stop that is already being retried.
  - model-assign and handoff log the error and let the call through.
- `link --unlink` refuses a non-string `pre_keel_settings_backup` in `link-state.json` with exit 70 and writes
  nothing. Python treated a number or a boolean there as a file descriptor.
- A comment-only deletion in a `.py` file no longer keeps review and test evidence, because Python is no longer run to
  prove it; any `.py` change needs fresh evidence. `.js`, `.ts` and `.java` files keep the exemption.

### Known follow-ups
- The hook commands call `node` from `PATH`. With no `node` on the hook `PATH`, report-gate fails open (exit 127), while
  git-guard and ship-gate block through `"onFailure": "block"`. `link` renders the same commands as before, and the
  fixtures pin them.
- The Python-compatibility helpers still exist as separate copies, which this release does not merge:
  `hooks/lib/hookkit/{pycompat,pyfnmatch,pyjson,pypath,pyruntime}.ts`, `lib/evidence/pycompat.ts`,
  `measure/lib/measurekit/{pydate,pydict,pyerrno,pyerrors,pyio,pyjson,pypath,pyregex,pystr,pytextwrap,pyvalue}.ts`
  and `codex/lib/{pycodec_names,pycodecs,pyerrors,pyfs,pyjson,pyrepr,pystdin,pystr}.ts`.
- The fixtures cannot be re-recorded without a Python 3.15; the recording tools are in git history.
- Four judge scenarios in `tests/ship-gate/cross_impl.test.ts` (an unapproved first review, a gap between reviews and
  two stacked chains) compare only the verdict, counts, risk class and whether a reason exists. Which chain the judge
  names depends on the order of evidence ids written within the same second.
- `codex/tests/guard-depth.test.ts` now lists its deep-array `cwd` payload as denied by the TypeScript ship-gate, in line
  with the depth bound above; the test failed on that payload before this release.
- The Python-written profile, link and evidence state that the old tests read back is restored from the fixtures. The
  interleaved Python and TypeScript runs of the old cross-implementation tests are replaced by TypeScript runs resumed
  from the recorded Python state.

### Requirements
- Node 24 or later (`engines` in `package.json`); this release was tested on Node 26.12.
- bash, git and jq.
- No Python.
