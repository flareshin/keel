# keel for Codex

The Codex adapter lives entirely in `keel/codex/`. It reads the shared charter,
core skills, guard scripts and optional private overlay; it does not change the
Claude installer, settings, workflow engine, authentication or model configuration.

## Install

Requires Python 3.11 or newer and a POSIX host (macOS/Linux). From the keel checkout:

```sh
codex/bin/link              # preview; writes nothing
codex/bin/link --write      # install instructions, hooks and skill links
codex/bin/link --check      # exit 1 on drift
codex/bin/link --unlink     # remove only unchanged files this adapter created
```

The installer uses `CODEX_HOME` (default `~/.codex`) for `AGENTS.md` and
`hooks.json`, and `~/.agents/skills/` for skills. Override the optional overlay and
evidence locations with `KEEL_OVERLAY_DIR` and `KEEL_DATA_DIR`. Defaults are
`~/git/keel-overlay` and `~/.claude`; the latter intentionally shares existing
keel evidence. `--home <temporary directory>` isolates a test installation;
unset `CODEX_HOME` when testing the default home layout.

Existing equivalent skill links are preserved and remain outside adapter
ownership. Conflicting files cause a refusal before writes. Existing
`AGENTS.md` or `hooks.json` must be reconciled manually; there is no destructive
force/adopt mode. A state file tracks created paths and their hashes; hand edits
prevent replacement and unlinking. Refresh after changing shared principles,
PERSONAL.md or the Codex runtime instructions by running `--write` again.
Shared skill ownership is recorded in `~/.agents/keel-codex-skills.json` under an exclusive installer lock. Each profile registers a reference; only the last unlink removes adapter-created links. Pre-existing and legacy links remain user-owned. Unlink uses recorded state even when sources have changed.
The installer preflights conflicts; an OS failure during writing can still leave
a partial installation. Keep its output and reconcile affected paths before retrying.

Start a new Codex session after installation. Open `/hooks` in the Codex CLI,
review the generated command and trust its exact definition. This adapter never
changes trust records or bypasses the trust check. Re-review after the hook
command changes. CLI 0.160.1 was inspected during implementation; callback
execution depends on the installed runtime and trust settings.

## Runtime behavior

| Surface | Codex implementation |
| --- | --- |
| Charter and owner preferences | Generated user `AGENTS.md`: shared PRINCIPLES.md + optional PERSONAL.md + Codex runtime guidance |
| Skills | Core, overlay and Codex skill folders linked into `~/.agents/skills` |
| Tool guards | Codex PreToolUse → `codex/hooks/pre-tool-use.py` → existing git-guard and ship-gate CLIs |
| Patch edits | Each add/update/delete/move becomes a Write-shaped guard input; added text is scanned |
| Test evidence | Existing `bin/keel test -- <command>` with explicit shared runtime paths |
| Independent review | `$keel-review` with a fresh context or supported `codex review` invocation |

The hook bridge emits Codex's explicit deny JSON when a guard refuses, input is
unsupported, or a child guard fails. It accumulates warnings into one JSON output.
The active profile and OS user's default `.codex` profile have their `sessions/`
and `archived_sessions/` trees made read-only to
matched agent edit tools and recognized shell writes, removals and moves. Reads
remain allowed; runtime-owned logging does not go through these tool callbacks.
The hook is synchronous. As with Codex hooks generally, a runtime failure before
that JSON is emitted may not stop the tool. Interactive `write_stdin`, hosted
tools, or tool paths outside the registered matcher are not enforcement coverage.

Claude's `report-gate`, `model-assign`, `handoff`, stack hooks, JS Workflow engine,
`commands/ship1.md`, `commands/xrepo.md` and scheduled tasks are not ported or
registered. Existing unrelated user skill links, including an older `ship1`, are
left alone. This is not full Claude/Codex feature parity. A native review does
not fabricate the transcript-backed review chain required by ship-gate. If the
installed core provides `evidence record-codex`, follow its
`docs/codex-review.md` version 2 protocol: one independent auditor covering the lenses (split when warranted) and finding-only verification, with snapshot deltas for fixes. Historical evidence is read-only; only the current registration flow creates new records.
Otherwise formal native evidence is unavailable. Gated shipping remains blocked
without supported evidence. Review and test claims in
Codex responses are instructions, not report-gate enforcement.

## Verify

```sh
python3 -m unittest discover -s codex/tests -v
```

Tests use temporary homes and data directories. They exercise real guard
subprocesses for force push and evidence-store edits, as well as installation,
idempotence, conflict preservation, custom profiles and ownership-aware unlink.
They do not assert that a live Codex session has trusted or invoked hooks.

Official references:
[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[skills](https://learn.chatgpt.com/docs/build-skills),
[hooks and trust](https://learn.chatgpt.com/docs/hooks).

## Reading guide

- Entry point: `codex/bin/link` → `lib/install.py:main`.
- Flow: resolve profile/overlay → build instructions/hooks/skill targets → preflight ownership/conflicts → write only requested changes.
- Changed: Codex gets its own discoverable instructions, skills and synchronous shell/patch bridge.
- Shared invariants: charter, evidence CLI and guard decisions stay in keel core; the Claude installer and runtime configuration are untouched.
- Decisions: generated instructions combine shared sources with Codex-specific tool semantics; existing equivalent skills stay outside installer ownership.
- Rejected: copying Claude settings/workflow JS into Codex would imply unsupported APIs and review provenance.
- Read first: `hooks/pre-tool-use.py:protect_adapter` and `run_guard` decide whether a tool call receives an explicit denial; trust and callback behavior still need runtime verification.

## Safe configuration updates

Shell writes to the active profile's `config.toml` are refused because their final
contents cannot be validated before execution. Prepare a complete TOML file and run:

```sh
codex/bin/config --file /absolute/path/proposed-config.toml
```

Use `--profile /absolute/profile` for another profile. The updater parses the
whole document, rejects disabled hooks and changes to the hooks table, then
atomically replaces the file while preserving its mode. Full Write and exact Edit
calls receive the same validation; partial patches are refused. Shell target
recognition is a guardrail, not a sandbox for arbitrary programs.
