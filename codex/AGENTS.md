## Codex runtime

This section adapts the shared keel principles above to Codex.

- Load skills as `$prompt-refine`, `$readable-code`, and `$descend`. A `/name` in shared instructions means load that skill; it does not imply a Codex slash command exists.
- `AskUserQuestion` means use Codex's available user-input tool or ask a concise question in chat. Do not wait for approval on an already clear, authorized task.
- Before editing code, load `$readable-code`. Review changed behavior in a fresh reviewer context; use `$keel-review`. Never call an author's self-review independent evidence.
- Use the absolute keel CLI path listed below for `test -- <command>` and `snapshot <repo>`. Existing evidence stays in the shared keel data directory. Set `KEEL_HOME`, `KEEL_OVERLAY_DIR`, and `KEEL_DATA_DIR` to the paths below when invoking the CLI.
- Claude's `Workflow`, JS workflow globals, `Agent` model names (`opus`, `sonnet`, `haiku`), commands directory, and scheduled tasks are not Codex APIs. Do not execute those JS files with Node or claim that they ran. Use available Codex tools and supported model defaults; do not invent model mappings.
- The Codex adapter registers only PreToolUse shell/edit guards. Claude report-gate, model-assign, handoff, and stack hooks are not registered here. Report test output and unresolved verification limits accurately; snapshot in-flight work before handoff.
- For formal native review evidence, first confirm the installed keel CLI supports `evidence record-codex --audits` and read `docs/codex-review.md` under KEEL_HOME. Follow the same per-lens audit and finding-only batch verification flow as Claude, using recorded snapshots for deltas. Register actual completed session UUIDs. Never write provenance or approval records yourself. If the command, supported session records or trusted guards are unavailable, report formal evidence as unavailable and stop gated shipping. Only the owner runs `keel approve <root_run_id>`; a chat PASS is not approval.
- Installed hooks require the user's trust in Codex `/hooks` and a new session. Until trust and actual callback behavior are verified, treat hook enforcement as unverified. Never bypass hook trust. Hooks are guardrails, not a sandbox or complete security boundary.
