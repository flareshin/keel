# Changelog

All notable changes to keel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

`measure`, `bin/link`, `lib/evidence` (the `keel` command, the evidence store and the verdict the ship-gate reads) and the
Codex adapter (`codex/`) drop their Python-emulation modules and use plain Node behavior: `JSON.parse` and `JSON.stringify`,
`node:path`, `node:fs`, `RegExp`, a fatal `TextDecoder` and `node:util` `parseArgs`. The hooks' shared kit (`hooks/lib/hookkit`) loses its Python runtime modules too (see Removed). Some Python semantics stay on purpose: the `splitlines` and `strip` character sets (`hooks/lib/hookkit/text.ts`, `apply_patch` text and guard output), CPython's recursion limit in the Codex TOML reader (`codex/lib/toml.ts`), the hooks' JSON spacing and error class names, and the exception names `rule-checks.ts` prints.

### Changed
- lens-review refuses a single-repo root review that comes without a precheck when the diff changes three or more non-test TS/JS sources in a repo with tests `keel precheck run` can run; the error names the `keel precheck run` command to run first. The new `keel precheck required --repo <path> --base <sha> --end <sha>` prints `{"required", "sources"}`, and both Prepare paths carry it as the target's `precheck_required` (`keel review prepare` and the fallback prepare agent). Delta reviews, multi-repo reviews and repos without such tests (FE vitest, Java) are not refused. Ledger row C-precheck moves from prose to skill:lens-review.
- `tests/run-all.sh` (`npm test`) runs one full suite at a time per machine: a second run waits for the first and says which pid holds the lock, and a lock left by a run that died is taken over.
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

- Codex adapter (`codex/hooks/pre-tool-use.ts`, `codex/bin/{link,config}`):
  - What stays the same: the exit codes (hook 0 with a JSON decision or empty output, link `0`, `1` for a pending
    `--check`, `3` for a refusal, `2` for bad arguments, config `0`, `3`, `2`), the JSON field names and values of the hook
    decision, the link and config reports, `hooks.json`, `keel-codex-state.json`, the shared skill registry's fields
    and layout, the `[ID]` tags in messages, the flag names and meanings, which tool calls the hook denies, passes or sends to git-guard and
    ship-gate, and the TOML reader's accepted and refused documents (`codex/lib/toml.ts` is unchanged apart from quoting
    in its messages). The ownership digests in the state file hash the same text as before.
  - What may differ and does: JSON is compact `JSON.stringify` output with non-ASCII written as is (the indented files keep
    two spaces; `hooks.json` and the state file are unchanged byte for byte when their content is ASCII, and so is the
    shared skill registry unless another tool's skill record holds a float, see the next item);
    the text sent to git-guard and ship-gate is compact and still escapes every character outside space to `~`; help and
    usage text is a short hand-written usage string; error messages use Node's wording and JSON-style quoting instead of
    Python's (`invalid JSON: Unexpected end of JSON input` replaces `Expecting value: line 1 column 1 (char 0)`, an OS error
    reads `ENOENT: no such file or directory, open '<path>'`, a non-string tool name is shown as JSON).
  - Rewriting the shared skill registry (`keel-codex-skills.json`) writes the float fields of another tool's skill record
    the way JavaScript prints numbers: `100.0` becomes `100`, `-0.0` becomes `0`, `1e-07` becomes `1e-7` and `1e+16`
    becomes `10000000000000000`. The values stay numerically equal, so a reader that parses the file sees no change.
  - Hook stdin is strict UTF-8 and nothing else. `PYTHONUTF8`, `PYTHONIOENCODING`, `PYTHONCOERCECLOCALE` and the locale
    variables no longer change how it is read, an invalid `PYTHONUTF8` no longer exits 1 with `Fatal Python error`, and the
    `stdin encoding <codec> is not supported; set PYTHONUTF8=1` denial is gone. Stdin that is not valid UTF-8 (a stray byte,
    a truncated sequence, an encoded surrogate) is now denied with `keel Codex guard: stdin is not valid UTF-8` before any
    guard runs; the default Python decoding turned such a byte into a lone surrogate and the call went on to the guards.
  - A payload, guard answer or state file holding the literal `NaN`, `Infinity` or `-Infinity` is refused as invalid JSON
    (the hook denies, link and config exit 3); Python accepted them. An integer of more than 4300 digits is still refused.
    Integers beyond 2^53 are rounded to the nearest double in the hook payload and relayed that way to the guards, as
    `1e400` becomes `null` there; a registry or state file keeps its integers exact when `link` writes it back.
  - A `cwd` that is not a string is refused (`keel Codex guard: cwd must be a string`) instead of being turned into a
    directory name with Python's `str`; a missing, `null` or empty `cwd` still means the process directory, but `0`, `false`, `[]`
    and `{}` are refused too (they were read as no `cwd`).
  - A path holding a NUL character or an unpaired surrogate is refused, including the `\udc80`-`\udcff` escapes that Python read
    as raw bytes. A symlink met while resolving a path is refused when its target is not valid UTF-8; Python read such a
    target with surrogate escapes and kept resolving. A `..` still follows the physical directory after a symlink, and
    resolution still stops after 40 links.
  - `apply_patch` text and guard output are still split and trimmed with Python's `splitlines` and `strip` (`\r`, `\v`, `\f`,
    U+001C-U+001E, U+0085, U+2028 and U+2029 break a line; U+00A0, U+1680, U+2000-U+200A, U+202F, U+205F and U+3000 are
    space, U+FEFF is not): `splitlines` and `trimSpace` in `hooks/lib/hookkit/text.ts`.
  - `keel_partial` and `replace_all` in an `Edit` or `Write` of `config.toml` are read as booleans. A `keel_partial` that is
    anything but `false`, `null` or absent refuses the edit as a partial patch (`0`, `""`, `[]` and `{}` used to pass as unset),
    and `replace_all` replaces every match only when it is `true` (`"yes"`, `1`, `[1]` and `{"k": 1}` used to count, so an
    edit that matched more than once went on to be validated; it is now refused as ambiguous).
  - Registry and state files: a key such as `"2"` inside the skill registry is written in ascending order before the other
    keys; a `version` of `true` or `1.0` is still accepted.
  - Command lines: option prefixes and stacked short options are no longer expanded (`--wr`, `--fil x`, `-hh` and `--he` exit
    2); `-h` is honoured wherever it appears (`link --write --check -h` prints help and exits 0, it
    exited 2); a value that starts with `-` after `--home` or `--file` (`--home -5`) exits 2, it was read as a value when it
    looked like a number.
  - The files and tests that checked the Python emulation are replaced by comparisons with golden snapshots of the adapter's
    own output (see the golden entry under Changed below): the hook corpus (587 payloads), the link and config scenarios
    (56 scenarios, 149 invocations, the steps whose arguments changed included) and `codex/tests/boundary.test.ts`, which pins 823 input
    boundaries (line breaks, Unicode spaces, number forms, invalid UTF-8, symlink chains, sort order, command lines). The 65
    boundaries whose outcome differs from the old adapter's (58, and 7 more with the `cwd` values `0`, `false`, `[]` and `{}`) are recorded as the adapter now gives them.
- `keel` (`bin/keel`, `lib/evidence`), what stays the same: the exit codes (0, 2 usage, 3 refused, 4 for a green run
  with no recognized tests, 70 internal error, otherwise the test command's own code), the `keel` subcommands and flags,
  the field names and values of every evidence record under `state/keel/evidence`, of `keel-tests.jsonl`, of the
  `KEEL-TEST` line and of the JSON the subcommands print, the evidence ids, the tree ids and the digests (the Codex
  review digests hash raw rollout bytes), the usage and refusal text, and the `[ID]` rule ids and reason text of the verdict.
- `keel`, what may differ and does: JSON is compact `JSON.stringify` text with non-ASCII written as is. Evidence files,
  `keel-tests.jsonl` and the JSON the subcommands print keep their keys sorted by code point; the `KEEL-TEST` line and the
  `diff_outputs` of `review prepare` keep the order they were built in. Error wording uses Node's: an unreadable
  evidence file in `keel evidence gc` reads `EISDIR: illegal operation on a directory, read` where it read
  `[Errno 21] Is a directory: '<path>'`, a stdin that is not JSON carries V8's message, and a test command that cannot
  start reports `keel: internal error: Error: cannot run ./x.sh: spawn ENOEXEC` (it was `OSError: [Errno 8] Exec format
  error: './x.sh'`; the exit code is still 70).
- `keel`, numbers: the JSON that `keel` re-emits (`review-lenses.json`, the `source` of a review) prints numbers as
  JavaScript does (`1.0` is `1`, `-0.0` is `0`, `1e16` is `10000000000000000`); integers beyond 2^53 stay exact. A runner
  count beyond 2^53 (`Ran 12345678901234567890 tests`) is recorded as the nearest double.
- `keel`, stdin (`evidence write-review`, `review prepare`): standard JSON only. `NaN`, `Infinity` and `-Infinity` exit 2 as
  `stdin is not JSON` (they parsed before); bytes that are not UTF-8 exit 2 as `stdin is not valid UTF-8`; stdin is read as deep as
  `JSON.parse` allows; only nesting beyond about two thousand levels that also holds an integer beyond 2^53 exits 70 with a
  `RangeError` (the old limit was 10,000 levels, then exit 70 with a `RecursionError`). An evidence file on disk keeps a
  10,000 level bound: past it the read raises `EvidenceTooDeepError`, which the ship-gate denies like a too-deep payload.
- `keel evidence write-review`: `keel_evidence.v` must be the JSON number 1 in any spelling (`1.0`, `1e0`, `10e-1`); `true`
  is now refused with exit 2 (it was accepted). `run_id`, `root_run_id`, `review_base`, `head`, `snapshot_tree` and `since` must be JSON
  strings (a number whose digits read like an id was accepted), and an id followed by a newline is refused with exit 2
  (the `$` of the old pattern let it through), as is `keel approve '<id>\n'`. `write-smoke` counts a smoke run as passed only
  when its `ok` is JSON `true` (exit 3 otherwise; `1`, `"yes"`, `[]` and `{}` counted before).
- Numbers read back from a stored evidence file are plain JSON numbers: `keel evidence show` prints a stored `1.5` as `1.5` and
  a stored integer beyond 2^53 exactly, and a `"version": 2.0` still counts as version 2. Codex review evidence: a rollout counts
  as complete only when its turn id is the same non-empty string at start and completion (a number counted before).
  Rollouts and the rule-checks output are split into lines at `\r\n`, `\r` and `\n` only, and the rule-checks summary is
  matched with `\S`.
- Whitespace follows JavaScript only where that cannot accept what the base refused. Where a guard asks whether a text is blank
  (`no_test_reason`, the lens, decision and finding texts of a Codex review, the stored waiver, a repo key's edges)
  the characters either reading strips count as blank: JavaScript's plus U+001C to U+001F and U+0085. A
  `no_test_reason` of only those characters is refused with exit 2 (as before), and a repo key ending in U+0085 or U+FEFF is the
  same key as without it. Where blank means "skip" (a registry line, the text around a comment) only characters both readings
  call whitespace count, so a registry line of only U+001C or only a BOM is a row with too few columns, an error. Runner output
  leaves out a `Test Files` or `Test Suites` line led by U+0085 or U+FEFF as well, and a comment holding U+0085 is not prose,
  so deleting it no longer keeps review evidence.
- Git output is data: only its final newline is removed, nothing is trimmed. A toplevel path and a config value read through the
  plain reader keep a trailing U+0085, U+001C, U+FEFF or no-break space, and a repo key is stripped only when it is normalized. The
  `diff_stat` of `review prepare` is the one value trimmed, as before.
- Git output holding a line break other than `\n` refuses. Every git output that feeds a gate decision (remote names, the gh
  default repo, the push urls and origin url of a remote, branch and commit ids, the submodule roots, the first-parent
  ancestors) is split at `\n` only after its single final newline, and a piece holding `\r`, `\v`, `\f`, U+001C to U+001E, U+0085,
  U+2028 or U+2029, or an empty piece anywhere in the output, raises a `GitError` that the gate reports as a refusal. Nothing is
  dropped and no reading is guessed. A name or url with a trailing U+FEFF or no-break space is read exactly.
- Truthiness is strict where Python's let odd values through: a review link has agent provenance only with a non-empty
  string `agent_id`, a stored `no_test_reason` waives K3 only as a non-blank string, and a smoke run covers a repo only with a
  non-empty string tree.
- Paths from `git diff-tree` must be valid UTF-8: a path that is not now stops the command with
  `a path in the git diff is not valid UTF-8` (exit 70) instead of being kept as lone surrogates, which already made the
  push judgment fail. A tree listing leaves out names that are not UTF-8, since no checked path can match one. `KEEL_DATA_DIR`, `KEEL_OVERLAY_DIR` and a review's transcript path expand `~` and `~/` only, not
  `~user`.
- `risk-rules.tsv` globs are `*`, `?`, `[...]` and `[!...]` with the star crossing slashes, as before. A character range
  written backwards (`[z-a]`) is now an error that blocks the gate; it used to match nothing.
- The ship-gate hook and `lib/evidence` no longer spell anything the Python way. What may differ from 1.0.0:
  - A ship-gate payload holding `NaN` or `Infinity` is malformed JSON: a push or merge fails closed with an internal error
    (exit 2, it used to pass), any other command passes with an internal-error line on stderr. A `gh pr view` answer
    holding them makes a merge fail closed the same way.
  - A stored evidence file holding `NaN`, starting with a byte order mark, or not valid UTF-8 is an `EvidenceError`
    (unreadable evidence, deny). A stored integer longer than 4,300 digits is read exactly; a payload or `gh` answer holding
    one is read too, so the gate decides on the fields it uses instead of denying on Python's digit limit.
  - Wording: `JsonSyntaxError` with the `JSON.parse` message for unreadable JSON, `InvalidUtf8Error: <source> is not
    valid UTF-8`, `RecursionError: JSON nesting is deeper than 10000 levels`, `EvidenceTooDeepError`, and `JSON.stringify`
    quoting (`"bogus"`, `["gh","pr","view"]`) in `RegistryError`, `GateError` and `TimeoutExpired` text. Numbers in messages
    render as JavaScript does (`1.0` is `1`). A system error prints as `Error: <Node message>` (for example `Error: ENOENT: no such file or directory, open '<path>'`
    or `Error: ELOOP: too many symbolic links encountered, open '<path>'`) instead of the Python
    `FileNotFoundError: [Errno 2] No such file or directory: '<path>'` or `OSError: [Errno N] <text>` form.
  - `keel-fires.jsonl` lines are compact sorted-key JSON (`stringifySorted`) with non-ASCII characters written as is.
  - `stringifySorted` and `parseJsonKeepingIntegers` (`measure/lib/measurekit/json.ts`) handle the full 10,000 level nesting
    without running out of stack, except text nested past about two thousand levels that also holds an integer beyond
    2^53: parsing it runs out of stack, so an evidence file like that is an `EvidenceError` and stdin like that exits 70.
  - The ship-gate parity tests replay a sample of the 1,757 recorded hook runs, split over eight shard files
    (`tests/ship-gate/ship-gate-parity-shard-<n>.test.ts`) that `node --test` runs in parallel, and compare each with a golden
    snapshot of the node hook's own output (`cases.jsonl.gz`) instead of the retired Python hook's recorded answers. The golden
    holds exit code, stdout, stderr and every file written or removed outside `.git` and `remotes` (inside `.git` only `HEAD`,
    `config`, `packed-refs`, `FETCH_HEAD` and `refs`), with the sandbox root and checkout paths tokenized and only the
    `keel-fires.jsonl` timestamp, `cc_version`, the checkout's repo key and the JSON syntax error wording masked. An intended behavior change re-records it with
    `node tests/ship-gate/ship-gate-parity-record.ts`, and the diff of `cases.jsonl.gz` is reviewed like any other change.
    The recorder still records all 1,757. The replay drops, from the golden at load time and before sharding, the cases that
    tests of their own already cover: a `python-keel` case unless its masked outcome differs from its `ts-keel` twin (then both
    stay), and a case of the `ts-keel` scenario tests, of its `everySpelling` test, of its bundle test or of the `merge_spellings`
    payloads with a complete `gh` answer unless it is the first of its outcome class within that group (exit code, stderr without
    the retry hint, the hook, outcome, rule and detail of the last two fires lines, and the written and removed files, with hashes
    and timestamps masked); every other case stays. `SHIP_GATE_PARITY_FULL=1` replays all 1,757, and is needed to replay a case
    the sample dropped with `SHIP_GATE_PARITY_CASES`: a filter that matches recorded cases but none the sample kept fails and names the switch. A run reports `golden: N of M cases (sample), K mismatches`, or `golden: N cases, K mismatches` with the switch.
    `ship-gate-parity.test.ts` checks that every case it replays falls in exactly one shard and that the sample keeps every outcome
    class. `EXPECTED_DIVERGENCES` and the deny-to-pass
    count are gone. `codex/tests/hook-parity.ts` compared the fires lines it replays by content (until its corpus became a golden of the adapter).
  - The hook parity test (`tests/hooks/hook-parity.test.ts`) replays the 334 recorded runs of the former Python hook tests and
    the 736 adversarial payloads and compares each with a golden snapshot of the node hooks' own output (`cases.jsonl` and
    `adversarial.json` under `tests/hooks/fixtures/hook-parity`) instead of the retired Python hooks' recorded answers. The golden
    holds exit code, stdout, stderr and every file written or removed outside `.git` and `remotes`, with the sandbox root and
    checkout paths tokenized and only the `keel-fires.jsonl` and handoff timestamps and the JSON syntax error wording of a
    fire detail masked. An intended behavior change re-records it with `node tests/hooks/hook-parity-record.ts`, and the diff
    of the two fixtures is reviewed like any other change. The replay reports `golden: N cases, 0 mismatches`.
    `EXPECTED_DIVERGENCES`, the per-payload expected outcomes of the adversarial set
    (`tests/hooks/hook-parity-wrong-type-divergences.ts` and the `divergence` of each JSON limit payload) and the deny-to-pass count are gone.
  - The Codex adapter's parity tests compare it with golden snapshots of its own output instead of the retired Python
    adapter's recorded answers. `codex/tests/hook-parity.test.ts` replays the 587 payloads of `hook-parity-corpus.ts` through
    `codex/hooks/pre-tool-use.ts` and compares exit code, stdout, stderr and every file of the sandbox with
    `tests/fixtures/python/codex-hook-parity.json.gz`; `codex/tests/cli-parity.test.ts` replays the 56 link and config scenarios
    (every step, including the ones whose arguments changed) against `codex-cli-parity.json`; `codex/tests/boundary.test.ts`
    replays the 823 input boundaries against `tests/fixtures/codex/boundary-recorded.json`. The sandbox root and checkout paths are
    tokenized and only nondeterministic text is masked: timestamps in written files, the runtime path, hook digests and temporary
    file names in link and config output, the wording of a JSON syntax error in a denial reason or a `link` refusal (it differs
    between node versions), and for a hook that crashes the error line of the stack trace (its frames carry paths
    and line numbers). The recorders write the answers sorted by key. An intended behavior change re-records them with `node codex/tests/hook-parity-record.ts`,
    `node codex/tests/cli-parity-record.ts` and `node codex/tests/boundary-record.ts`, and the diff of the fixtures is reviewed like any other change.
    Each replay reports `golden: N cases, 0 mismatches`. The divergence lists (`DenyDivergence`, `JsonDepthDivergence`,
    `WRONG_TYPE_DIVERGENCES`, `PYTHON_WORDING`, `FOREIGN_FLOAT_SPELLINGS`, `changedByNativeParsing`, `EXPECTED_CHANGES`) and the
    deny-to-pass count are gone. The tests of the TOML port, the path helpers and the crash depths of the TOML
    parser (`toml.test.ts`, `paths.test.ts`, `hook-recursion.test.ts` and the crash-depth cases of `cli-parity.test.ts`) still compare with the recorded Python
    answers, which are their specification.
  - `keel review prepare` reads deeply nested stdin: 200,000 nested arrays exit 2 as `stdin must be a JSON object`
    instead of exit 70.
- `git-guard` `repo-rules.tsv` and `env-preflight` `jdk.tsv` globs match through the same `globMatches` as
  `risk-rules.tsv`. A backwards character range there is now an error: `git-guard` refuses the guarded command as an
  internal error (fail closed), and `env-preflight` logs an `error` fire and lets the command run, where both used to
  treat the rule as matching nothing.
- The hooks read handoff notes, agent definitions and report-gate state as UTF-8 text without turning a lone CR or a
  CRLF into a newline. An agent definition's frontmatter still opens and closes with `---` on a CRLF line. `git-guard`
  still turns a lone CR and a CRLF into a newline in commit message files (`git commit -F`, `gh pr --body-file`), so an
  attribution phrase wrapped at one is denied as before.
- The hooks (`git-guard`, `report-gate`, `model-assign`, `env-preflight`) read JSON with `JSON.parse` behind a
  10,000 level nesting bound (`hooks/lib/hookkit/json.ts`). What stays the same: text nested past 10,000 levels raises
  `RecursionError`, now also when it is malformed as well, so the hooks that fail closed on it still do; malformed JSON
  takes the same path in every hook as before; the JSON the hooks send on (the report-gate review request) is written
  by the same `dumpsAscii`.
- What may differ and does, in the hooks:
  - A stdin payload holding `NaN`, `Infinity` or `-Infinity` is malformed JSON (Python accepted it): `git-guard`
    refuses it as an internal error when the text looks like a guarded command and passes it otherwise, `report-gate` logs a K2 `error` fire and passes, `model-assign`
    and `env-preflight` pass without acting. A report-gate state file holding one counts as unreadable, as other
    malformed state does.
  - An integer of more than 4,300 digits is no longer refused; it reads as the nearest double (`Infinity` past the
    double range), in payloads, transcript lines and settings.
  - `git-guard` still reads a `--settings` JSON value holding `NaN` or `Infinity`: those values read as 0 there, so a
    `disableAllHooks: true` in it, with an escaped key or not, is still denied.
  - `report-gate`: an agent transcript line that is valid JSON apart from a `NaN` or `Infinity` value makes the gate
    refuse the report as uncheckable (K2), as nesting past the bound does; such a line used to be read with the number.
    A line that is malformed otherwise is still skipped. A `KEEL-EVIDENCE` line holding one, or a number past the double
    range (`1e400`, an integer of 310 digits or more), is not JSON to the hand-back: it warns K1 (`KEEL-EVIDENCE line is not JSON`)
    and sends no review request, where it used to forward `NaN` or `Infinity`, which `keel evidence write-review` refuses.
  - The detail of a fire for malformed JSON names `JsonSyntaxError` and V8's message (it named `JSONDecodeError` with
    Python's message); a `RecursionError:` detail keeps its prefix.
  - `tests/hooks/hook-parity.test.ts` compared the recorded Python runs with the decode error message masked on both sides
    (`JSONDecodeError` reads as `JsonSyntaxError`) and listed 31 more payloads whose outcome changed, until its corpus became a golden of the node hooks: the non-finite
    numbers above and the integers of more than 4,300 digits, which the hooks now judge like any other payload.
  - Error text in every hook (`describeError`, the `detail` of an `error` fire and the `internal error` line a hook
    prints) is `<name>: <message>` with Node's own message, and the errno-to-Python-class table is gone. What stays the
    same: the exit codes, the `[ID]` tags, which calls are denied, passed or failed closed, and the class names
    `ValueError`, `RecursionError`, `AttributeError`, `JsonSyntaxError` and `GuardError`. What differs:
    `FileExistsError: [Errno 17] File exists: '<path>'` is `Error: EEXIST: file already exists, mkdir '<path>'`,
    `PermissionError: [Errno 13] Permission denied: '<path>'` is `Error: EACCES: permission denied, open '<path>'`,
    `IsADirectoryError: [Errno 21] Is a directory: '<path>'` is `Error: EISDIR: illegal operation on a directory, read`,
    and `FileNotFoundError: [Errno 2] No such file or directory: '<path>'` is `Error: ENOENT: no such file or directory, <call> '<path>'`.
    A scanner or `keel` command that cannot start is named by its class: `boundary scanner did not run: OSError` (it was
    `FileNotFoundError`) in git-guard's `error` fire and `keel evidence write-review did not run: OSError` in report-gate's
    `warn` fire. The deny line of git-guard (`The guard could not check this commit, push, PR text or protected write (<name>)`)
    names a raw system error `Error` where it named `FileNotFoundError` or `PermissionError`. A non-`Error` value that is thrown prints as its own text and is named `Error`, not `Exception` (the hooks throw only
    `Error` subclasses, so this keeps the `<name>: <text>` shape of the line and is not reachable today).
  - `git-guard`: an `edits` field of a `MultiEdit` call, or a `hits` field in the boundary scanner's report, that holds a
    non-empty string or object is an internal error (`TypeError: edits is not a list: 'str'`; a guarded command fails closed).
    For `edits` the path checks still decide first: a call aimed at the live checkout, the overlay or `state/keel` is denied
    with `[C-isolation]` or `[K1]` as before, and so is one whose `content` sets `disableAllHooks` in a Claude settings
    file (`[F-hookskip]`); the error applies only when nothing else denies the call. Python's `list()` read a string as its
    characters and an object as its keys, so a string or object `edits` used to pass unread (a `hits` one already failed
    closed, with an `AttributeError`). A number or `true` `edits` used to raise before the path checks ran, so a call aimed
    at the live checkout or the overlay passed; it is now denied like the string. A missing, `null` or `[]` value is still an
    empty list (`0`, `false`, `""` and `{}` are no longer one, see the wrong-type fields below).
  - `report-gate`: a turn-state file whose `paths` is a string, number or `true` is read as no flagged paths, so an
    outside edit is flagged again (a string was read as its characters and a number as an error, which passed). An object
    still reads as its keys.
  - Fields of the wrong type. The hooks no longer use Python's truthiness (`isTruthy`) or `str()` (`pythonStr`) on payload, state or
    `gh` fields. Each field has one type and is read as that type (`textField`, `textOrEmpty` and `isNonEmptyString` in
    `hooks/lib/hookkit/fields.ts`): a missing or `null` text reads as empty, a value of any other type raises `FieldTypeError`
    (a `TypeError`), and a flag that relaxes a gate counts only when it is exactly `true` (or a non-empty string for an id). A
    wrong-typed value never turns a deny into a pass: where raising would pass (the fail-open hooks), the hook denies, refuses
    or judges the strict reading instead. What changes, hook by hook (the old reading is in brackets):
    - `git-guard`: a `command` that is not text is an internal error: a payload that looks guarded is denied
      (`internal error on a guarded command`), any other passes with an `error` fire [it was rendered with Python's `str()` and
      judged as text; `["git", "commit", "-m", "..."]` passed, and a nested list holding a quote was judged on its repr].
      A `cwd` that is not text is judged as the process directory and raises only when nothing denied [a number, `true`, a list
      or an object became a relative directory named after its repr; `0`, `false`, `[]` and `{}` were the process directory].
      The edit target is chosen by one rule shared with `report-gate` (`editTarget` in `fields.ts`): a text `file_path` wins; when
      it is missing, `null`, `""` or not text, a text `notebook_path` is the target. Every rule (protected store, live checkout,
      overlay, Claude settings, known values) judges that target, and a `file_path` or `notebook_path` that is not text is also
      judged as the call's `cwd` (shown as `(a path that is not text)`), so a call from or into the live checkout, the overlay or
      `state/keel` is still denied. A non-text path raises only when nothing denied [`0`, `false`, `[]` and `{}` read as no path, so
      the `notebook_path` beside them decided; a truthy one was judged as a relative path named after its repr, and the
      `notebook_path` beside it was never read, so it passed]. An `edits` of `0`, `false`, `""` or `{}` is malformed like a string [an empty list]. A boundary
      report whose `hits` is `false`, `0`, `""` or `{}` fails closed like any other non-list [it was an empty list], and a hit
      whose `file`, `line` or `rule` is neither a string nor a number fails closed [it was printed with `str()`]. A `tool_name`
      that is not text names no tool, as before.
    - `ship-gate`: a `command` that is not text fails closed: a push or merge, judged on the payload text, is denied (a
      list `["git", "push", "origin", "main"]` used to pass, and a list nested 3,000 deep was judged on its `str()` text), any other command passes with a line on stderr. A `cwd` that
      is not text fails closed [only a truthy one did; `0`, `false`, `[]` and `{}` were the process directory]. A `session_id` that is
      not text reads as `-` [the value itself was logged and named a state file]. In a `gh pr view` answer
      `baseRefName` must be non-empty text, `statusCheckRollup` a list or `null` [`0`, `false`, `""` and `{}` were no checks, and
      a string or object was read per character or key], and a check's `conclusion`, `status` and `state` text or `null`
      [`1` and `true` read as not blocking and `0` and `false` as absent, so a merge could go through]. A check whose `name` is not
      text is shown as `?` (or by its `context`).
    - `report-gate`: a `session_id`, `agent_id`, `transcript_path` or `agent_transcript_path` that is not text, a
      `tool_input.message` that is not text, and a transcript entry whose `message.role`, tool name, Bash `command` or edited
      path (the same `editTarget` rule: a non-text `file_path` or `notebook_path` of an edit tool) is not text, are refused as unreadable (a handback is denied, a stop is blocked, `could not read this report`, K2) [they
      were read through `str()`; `0`, `false`, `[]` and `{}` as absent, so an agent whose id was `0` was not checked at all].
      A `stop_hook_active`, or a stored `ev` or `hb`, excuses the report only as exactly `true` [`"yes"`, `1`, `[1]` and `{"k": 1}`
      counted]. A fire's `session` is `-` unless it is non-empty text. The fire for a written review records `review evidence (unparsed stdout)`
      when the `keel evidence write-review` answer has no text `evidence_id` [it recorded `None` or the number].
    - `model-assign`: `resumeFromRunId` skips the workflow check only as a non-empty string [`true`, a number, a list or an
      object did, so a script without a model passed]; a `scriptPath` that is not text is left out of the deny message. A
      `subagent_type`, `prompt`, `description`, `model` or `effort` of an `Agent` or `Task` call that is not text logs an `error`
      fire and rewrites nothing [it was read through `str()`].
    - `env-preflight`: a `command` that is not text logs an `error` fire and passes; a `cwd` that is not text is the process
      directory, so a `mvn` without the JDK pin is denied there [a number, `true`, a list or an object named a directory that
      does not exist, and the build passed].
    - Codex adapter (`keel_partial`, `replace_all`, `cwd`): see the Codex section above.
    - `expandUser` expands `~`, `~/...` and `~<name>` only for the current account (`~root/x` stays `~root/x` and is joined to
      the working directory); it no longer asks directory services or `/etc/passwd` for other accounts. `shell-parity` lists the
      six `resolve_directory` calls this changes.
  - `tests/hooks/hook-parity.test.ts` listed the four recorded runs whose fire text changed with this wording
    (`EXPECTED_DIVERGENCES`, each with the exit code the hook must give and the start of the new detail). Everything else
    of those runs, stderr, stdout and every written file, was still compared, and the test failed on a recorded Python
    deny that passes in node (until its corpus became a golden of the node hooks). Its adversarial set adds four `MultiEdit` payloads with a string or object `edits` aimed at the
    overlay and at `state/keel`, with the outcome of the previous release's hook recorded for them (until its corpus became a golden of the node hooks). `tests/ship-gate/ship-gate-parity.test.ts` listed 25 more rows the same way, until its corpus became a golden of the node hook.
    The wrong-type payloads (494 in `tests/hooks/hook-parity-wrong-types.ts` for `git-guard`, `ship-gate`, `env-preflight`,
    `model-assign`, `handoff` and `report-gate`: each field that holds text or a flag, set to an object, a list, a number,
    `true`, `false`, `0`, `[]`, `{}` or `null`) were recorded from the hooks as they were before the typed readers. 325 end
    differently and were listed in `tests/hooks/hook-parity-wrong-type-divergences.ts` with the exit and a text the hook must give (until its corpus became a golden of the node hooks)
    (every unchanged one was compared in full, and none of the 494 let a recorded deny pass; the corpus includes an `Edit` whose `file_path` is of the wrong type beside an absolute `notebook_path` in the overlay or in `state/keel`, from a `cwd` that protects nothing). The three `git-guard command nested
    in N lists` payloads below the depth bound were listed too: a command that is a list used to be judged on its Python `str()`
    text, in which a quote inside an element let the rest of the element run as shell words (`F-hookskip` denied it), and it is
    now refused as an internal error. The run reported 344 recorded + 784 adversarial cases, 465 listed divergences (137 before),
    0 mismatches, deny-to-pass 0 (the golden run now reports `golden: 1070 cases, 0 mismatches`); fire logs written with compact JSON (`ship-gate`) now have their `ts` masked as well.
    `tests/ship-gate/ship-gate-parity.test.ts` listed 61 more rows (146 in all): a `command`, `cwd` or `session_id` that is not
    text, and `gh` answers whose `statusCheckRollup`, a check or `baseRefName` has the wrong type; 1,757 cases, 0 mismatches,
    deny-to-pass 0 (those listings are replaced by the golden snapshot). `codex/tests/hook-parity-corpus.ts` adds 42 wrong-type payloads (recorded from the adapter as it was) and listed
    28 changed ones (587 cases, 99 listed, until its corpus became a golden of the adapter). `tests/hooks/shell-parity.test.ts` gains a listed-divergence set of its own for the
    six `resolve_directory` calls on `~root`.

### Fixed
- `git-guard` (`[C-isolation]`) no longer treats a linked worktree of a live checkout as the live checkout when the
  worktree sits inside it, such as `~/git/keel/.claude/worktrees/<name>` made by the desktop app. Edit, Write, Bash
  writes and state-moving git commands in it pass. A directory counts as such a worktree only when its `.git` file names
  an entry under that checkout's `.git/worktrees/` whose own `gitdir` file names this `.git` file back; any other, a
  `.git` that is a symlink, an unreadable `.git` file and a plain repository below it are still denied.
- `env-preflight` (`[S-jdk]`) accepts a `java_home` lookup that names a patch release of the required major, such as
  `-v 17.0.20` or `--version=17.0.2`; it already accepted `-v 17` and `-v 17.0`. An open range (`17.0.20+`), a wildcard
  (`17.0.*`), a trailing dot or another major is still denied.
- `report-gate` on `SubagentStop` judges the subagent's final text again. Claude Code no longer sends
  `last_assistant_message`, so the hook reads the text the agent wrote after its last tool use from
  `agent_transcript_path` when the field is absent, `null` or empty; a non-empty field still wins. An assistant entry
  after that text with nothing readable in it does not discard it. It no longer logs a K2
  `contract-miss` for the missing field when that text is found, when the report was handed back this turn, or when
  the agent answered with `StructuredOutput`, and a `StructuredOutput` agent no longer logs `no final text to judge`.
- A `fires:<rule_id>` metric no longer counts `warn` lines, alongside `error` and `contract-miss`: a warn records a
  hook that let the action through without judging it (for K2, `no final text to judge`), so 2,552 such lines had
  made K2 look exercised. Every keel and overlay `fires:` row that logged warn lines on the owner's machine also
  logs deny, pass or record lines, so none drops to zero.

### Added
- `no-comments` skill and `keel-comment-reviewer` agent (C-no-comments): before `keel review prepare`, a read-only reviewer that did not write the code judges every comment in the files the diff changes against K5.14; the author deletes what it lists as a comment-only commit, reshapes each `MUST KILL` symbol with a test and offers each `ENCODE` check to the owner. K5.14 now covers the pre-existing comments of changed files through this pass. Adapted from pstack (cursor/plugins at 4dd1d05, MIT).
- `rule-checks.ts --module-repo <repo>` (repeatable): a changed gitlink whose submodule is not checked out (a parent repo
  that holds the module as a plain copy, or a deinitialized submodule) is scanned from the old to the new pinned commit in
  the first given repo that holds both commits, with its signals labelled under the gitlink path. It applies only when
  `--head` is a commit or tree; without a matching repo, or over the working tree, the gitlink stays `blocked` and exit 2.
  `lens-review` passes every other reviewed repo as `--module-repo` to each rule-checks command, so a parent-repo review
  that bumps a gitlink to a module reviewed in the same run can pass. The rule-checks parity test compares the recorded
  usage and help text with `--module-repo` added (32 of the 66 recorded runs print it); nothing else in them changes.
- `measure/smoke` starts every `run:` metric runner of the ledger rows before it judges the rows, at most 6 at a time,
  instead of running them one after another inside the metrics check. On the owner's machine the 13 overlay runners took
  about 360 s in sequence (the slowest alone 55 s) and now finish together in about 70 s. Each runner keeps its 120 s
  timeout, and a runner that passes it is killed with its whole process group, so a grandchild holding its output cannot keep
  the check waiting; rows are judged in ledger order, and the `metrics` assertion and every error text are the ones a sequential
  run prints. `measure/run`, `measure/propose` and `measure/weekly` still run a runner when they need it.
- `measure/metrics/C-review-command`, the runner behind the `C-review-command` row: it counts the distinct `run_id`s of
  review evidence whose `review_kind` is `codex-lens-review` and that were created in the window. The row's metric was
  `exists:~/git/keel:HEAD:codex/AGENTS.md`, which passed for as long as the file existed; it now reads zero until a
  formal Codex review is registered, so the row leaves grace only when the rule's occasion has happened. It counts
  occasions, not whether the explanation and command were in the final response, and the evidence files expire after 14
  days, so a quiet fortnight reads zero. `F-mod-trust` and `C-verbatim-fix` keep their `exists:` metrics: smoke records
  only the checks that FAIL (a mod-trust WARN looks like a PASS in `keel-smoke.jsonl`), and no log records a verbatim fix.
- `measure/smoke` check `contract-miss-cap`: more than 20 `contract-miss` fires lines dated today or yesterday FAILs,
  with the count per hook, so a Claude Code payload change shows up within a day instead of in a later review. Every
  `contract-miss` line logged so far came from the `last_assistant_message` drift fixed above; ship-gate has logged
  none, so 20 over two days leaves room for a stray miss and still catches drift, which logged 96 to 1,046 a day.
  The check reads red on a machine until the `report-gate` fix above is linked and two days have passed.

### Removed
- The hook module `hooks/lib/hookkit/pyruntime.ts`, its Python error-class table and the `pythonList` and `stripChars`
  helpers. The error classes and `describeError` moved to `hooks/lib/hookkit/errors.ts`, `readStdin`, `printLine` and
  `writeStderr` to `hooks/lib/hookkit/stdio.ts` unchanged, and `trimCharacters` (the old `stripChars`) to
  `hooks/lib/hookkit/text.ts`. The unread recording `tests/fixtures/python/ship-gate-strerror.json` is deleted with it.
  `tests/hooks/pyhook-compat.test.ts` (now `tests/hooks/jsonout.test.ts`) loses its `pyruntime` tests, which
  `tests/hooks/errors.test.ts` replaces; the import-order test for `pyruntime` in `tests/hooks/json.test.ts` went
  with it, as `errors.ts` imports nothing.
- The hook module `hooks/lib/hookkit/pyjson.ts` and its tests in `tests/hooks/pyhook-compat.test.ts` (now `tests/hooks/jsonout.test.ts`). Its place is taken by
  `parseJson`, `parsePayload`, `parseTranscriptLine` and `parseJsonReadingNonFiniteNumbersAsZero` in `hooks/lib/hookkit/json.ts`;
  `dumpsAscii` moved to `hooks/lib/hookkit/jsonout.ts` unchanged.
- The hook module `hooks/lib/hookkit/pycompat.ts`. `isTruthy` and `pythonStr` are gone (see the wrong-type fields above); `strip` is
  `trimSpace`. What stays moved to modules without a Python name, unchanged: `splitlines`, `trimSpace`, `truncate`,
  `codePointLength`, `rstripChar`, `lstripChar`, `partition`, `isDigits` and `arraysEqual` to `hooks/lib/hookkit/text.ts`;
  `basename`, `joinPath`, `normalizePath`, `splitPath`, `glob`, `expandVars`, `environmentValue` and `expandUser` (now the
  current account only) to `hooks/lib/hookkit/paths.ts`; `isSystemError` and `tryReadText` to `hooks/lib/hookkit/files.ts`;
  `isRecord` and `getField` to `hooks/lib/hookkit/fields.ts`; `pythonJsonDumps` and `dumpsAscii` to `hooks/lib/hookkit/jsonout.ts`
  (without the `str()` rendering that `pythonStr` shared with them). The directory-services and `/etc/passwd` lookups of
  `expandUser` and their `dscl` tests are removed.
- The hook modules `hooks/lib/hookkit/{pyfnmatch,pypath}.ts`. Their place is taken by `globMatches` from
  `lib/evidence/glob.ts`, `shlexQuote` from `measure/lib/measurekit/shlex.ts`, `node:path` `dirname`, `readFileSync` and
  `realpathSync`, and `isFile`, `isDirectory` and `resolveSymlinksKeepingMissingTail` in the new
  `hooks/lib/hookkit/files.ts`.
- The Python-emulation modules `codex/lib/{argparse,pycodec_names,pycodecs,pyerrors,pyfs,pyjson,pyrepr,pystdin,pystr}.ts`
  and the tests that compared them with Python (`codex/tests/{pycompat,stdin-decoding}.test.ts`, `pyref.ts`,
  `stdin-policy.ts`, `locale-env.ts`). Their place is taken by `codex/lib/{json,paths,refusal}.ts`, `readText` and
  `writeAtomic` in `codex/lib/files.ts`, the `node:path` calls and `parseCommandLine` from `measurekit/cli.ts`, and
  `decodeStrict` from `measurekit/files.ts` (the strict decoder `readUtf8` and `lib/evidence` use). `tests/fuzz.ts` holds the seeded mutation helpers that
  `pyref.ts` held.
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
- The `lib/evidence/pycompat.ts` exports that no hook, Codex or evidence module imports any more: `compareCodePoints`,
  `pySplitWhitespace`, `pySplitLines`, `decodeReplacing`, `decodeSurrogateEscape`, `expandUser`, `pyEquals`, `fnmatchCase`,
  `isSystemError`, `isDirectory`, `isFile`, `pyRealpath`, `PYTHON_SPACE_PATTERN` and `pyOsErrorMessage`, `pythonErrnoName`,
  `jsonNumber` and `pyFloatRepr` as exports, and the `OSError` class of `subprocess.ts`. `lib/evidence` now uses `measure/lib/measurekit/{json,files}.ts` and the
  new `lib/evidence/{glob,text}.ts`.
- `lib/evidence/pycompat.ts`, `lib/evidence/hook_pinned.ts` and `tests/ship-gate/pycompat.test.ts`. The ship-gate hook
  now uses `parseJson` from `hooks/lib/hookkit/json.ts`, `appendRecord` from `lib/evidence/env.ts` and
  `measure/lib/measurekit/{json,files}.ts`.
- The byte-for-byte Python recordings of the evidence code (`tests/fixtures/python/ship-gate-{cross-impl,cross-impl-codex,parity}.json`)
  and `tests/ship-gate/parity.test.ts`. The outcomes they recorded live on in `tests/fixtures/evidence/{cross-impl,helper-outcomes}.json`
  and in `tests/ship-gate/{cross_impl,cross_impl_codex,helper_outcomes,native_input}.test.ts`; the cases whose outcome changed are
  tested with explicit expectations.
- The `--auto` mode of the `handoff` hook (the PreCompact snapshot, `hooks/handoff/handoff.ts`), dead since its registration went
  with the retired ledger row C-handoff. `handoff --auto` is now an unknown mode like any other: the CLI records its words as the
  note, so a stale PreCompact entry for it in a settings file would overwrite the handoff note with `--auto` (the CLI modes
  `--path`, `--status`, `--read` and `--clear` and the note mode are unchanged). `--status` still reads a note written by an older
  version whose resume point is only an `(auto-snapshot` line as no resume point. Removed with it: the `AutoSnapshotTest` tests in
  `tests/hooks/handoff.test.ts` (a test of the legacy note replaces the CLI one), the `handoff` payload families of
  `tests/hooks/hook-parity-{adversarial,json-limits,wrong-types}.ts` and `tests/hooks/wrong-types.test.ts`, the golden runs 0202 to
  0210 and 0217 with their unreferenced snapshots, the 48 `handoff` entries of the golden adversarial outcomes, and the fixtures
  `tests/hooks/fixtures/{C-handoff.bad,handoff.good}.json` (the smoke check reads a bad fixture per row in force and a good one per
  hook with such a row, and C-handoff is retired).

### Upgrading
- Codex: run `codex/bin/link --check`. When it lists `hooks.json` or the state file, the old files hold a non-ASCII
  character that Python wrote as a `\uXXXX` escape (a home or checkout path with an accented name); run
  `codex/bin/link --write` once. An ASCII-only install is already identical. Open `/hooks` in a new Codex session if the
  command line it shows changed.
- No step is needed for a live `~/.claude` whose owned settings hold no floats. If one does, the first
  `bin/link --check` after the upgrade may report `<key> changed since the last --write`; when you have not edited
  it and the dry run (`bin/link`) lists no other problem that `--force` would act on, run `bin/link --write --force` once.
- No step is needed for the evidence store: files written by earlier versions, including the ones the Python wrote, are read as
  before. `keel-tests.jsonl` lines are now compact JSON; readers that parse each line are unaffected.
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
