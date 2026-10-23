# Changelog

All notable changes to keel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

`measure` and `bin/link` drop their Python emulation and run on plain Node behavior: `JSON.parse` and
`JSON.stringify`, `node:path`, `node:fs`, `RegExp` and `node:util` `parseArgs`.

### Changed
- What stays the same: exit codes for every documented outcome, the field names and values of every JSON and JSONL
  line the tools print or write (`measure/{run,smoke,propose,weekly,boundary}`, `measure/evals/{eval,review-eval}`,
  `bin/link`, the `keel-*.jsonl` logs and raw-dir files), the `[ID]` tags in messages, and the CLI flags with their
  meaning, including exit 2 with a `usage:` line on bad arguments.
- What may differ and does: JSON is compact `JSON.stringify` output with non-ASCII written as is (keys stay sorted
  where they were sorted, and indented files keep two spaces); help and usage text is a short hand-written usage
  string without wrapping or colour; error messages use Node's wording and JSON-style quoting instead of Python's
  `repr` (`unknown scope "x"` was `unknown scope 'x'`; `internal error: InvalidUtf8Error: <path> is not valid UTF-8`
  and `internal error: Error: EISDIR: ...` replace Python class names); the review-eval stderr summary prints
  numbers as JavaScript does (`recall 1`, `none`).
- Command lines: option prefixes are no longer expanded (`--gen`, `--sin=2020-1-1` and `--s` now exit 2 as unknown
  options); `--repeat` and `--timeout-seconds` take ASCII digits only (` 1_0 `, `+5` and other scripts' digits now exit 2,
  leading zeros such as `010` still work); `-h` given as an option value (`--since -h`) is a value, not a help request,
  so it still exits 2; `measure/boundary --range=` exits 2 with `--range takes <old>..<new>` (it was an internal error, 70);
  dates (`--since`, `review_by`, `grace_until`) take ASCII digits, one or two for month and day, and no space padding.
- `boundary/regex.txt` and `measure/boundary-generic.tsv` are JavaScript `RegExp` syntax; a leading `(?i)` still
  makes a line case-insensitive. Python-only forms change meaning or exit 2 (`x{,3}` is literal text, `(?P<n>...)` and
  `(?x)` do not compile), `\d`, `\w` and `\b` are ASCII, and case folding no longer equates `İ` or `ı` with `i`.
- Text files are split into lines at `\r\n`, `\r` and `\n` only. A `\u2028`, `\f` or `\v` no longer starts a line, which
  moves boundary hit line numbers and keeps a bullet after one of them out of the `[ID]` tagging check.
- Metric runners must print a JSON integer count: `true` and `false` are now an error (FAIL, a `recheck` proposal, a
  weekly `error` entry), `1.0` counts as 1, and a count beyond 2^53 is printed as the nearest double
  (`12345678901234567890` becomes `12345678901234567000`). Floats in runner items print in JavaScript form (`1.0` is `1`).
- A `fires:` or `evals:` metric no longer counts a log record whose `ts` is not a string (Python counted it by its text,
  so `"ts": null` read as `None` and fell inside every window).
- The files read through `readUtf8` (ledgers, TSV and JSONL data, link manifests, settings, fragments, link state,
  `CLAUDE.md`, `PRINCIPLES.md`, skills, eval cases and fixtures) are decoded as strict UTF-8 in full. A `CLAUDE.md` with
  an invalid byte past its first 8 KiB now makes `bin/link --check`, `--unlink` and `measure/evals/eval --dry-run`
  exit 70, as an invalid byte earlier already did. The boundary scan alone decodes leniently on purpose: it replaces
  invalid bytes so it can still scan such a file, as before.
- `bin/link`: a `settings.json` holding `NaN` or `Infinity` is refused as invalid JSON (exit 3, was a drift report);
  a lone surrogate in a settings value is written as a `\udXXX` escape (`--write` exit 0, was 70) and shown as U+FFFD
  on stderr; integer-like keys inside an owned object (`env`, `permissions`) are written first, in ascending order;
  a drift report counts a non-list value where a list belongs as 0 items instead of failing or counting characters.
- The `settings_owned_sha256` digests in `state/keel/link-state.json` hash the same text as before (keys sorted
  by code point, `", "` and `": "` separators, non-ASCII as is) for strings, integers (also beyond 2^53, which settings and
  fragments keep exact), booleans, null, lists and objects; only floats are written differently (`10.0` is `10`, `1e-07` is `1e-7`).

### Removed
- The Python-emulation modules `measure/lib/measurekit/{pydate,pydict,pyerrno,pyerrors,pyio,pyjson,pypath,pyregex,
  pystr,pytextwrap,pyvalue}.ts` and the argparse clone `measure/lib/measurekit/{argparse,arghelp,argcolor}.ts`. Their
  place is taken by `measure/lib/measurekit/{json,files,dates}.ts`, `parseCommandLine` in `measurekit/cli.ts` and
  `lib/link/json_spans.ts`.
- The byte-for-byte Python recordings of measure and link (`tests/fixtures/python/measure-{parity,pty,pycompat,pyerrno}`
  and `link-{compat,cross-impl,failure-paths,settings-parity}`) and the tests that compared against them
  (`tests/measure/{pycompat,pyerrno,pyio_encode,pty}.test.ts`, `tests/link/compat.test.ts`). The outcomes they
  recorded live on in `tests/fixtures/measure` and `tests/fixtures/link` and in `tests/measure/cli_outcomes.test.ts`,
  `tests/link/{failure_paths,cross_impl,settings_functions}.test.ts` and new tests for each kept helper; the cases whose
  outcome changed are tested with explicit expectations.

### Upgrading
- No step is needed for a live `~/.claude` whose owned settings hold no floats. If one does, the first
  `bin/link --check` after the upgrade may report `<key> changed since the last --write`; when you have not edited
  it and the dry run (`bin/link`) lists no other problem that `--force` would act on, run `bin/link --write --force` once.
- Check an overlay `boundary/regex.txt` written for Python `re` with `measure/boundary --paths <any file>`: exit 2 names
  the line that no longer compiles.

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
