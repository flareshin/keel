# Installing keel

The README's [Install](../README.md#install) covers the common path. This page has the details: what `bin/link` reports and how to resolve it, running without an overlay, the link-only install, and upgrades. Run every command here from a terminal outside Claude Code: git-guard denies an agent `bin/link --write`, `--unlink` and every `claude plugin` command that changes the installed plugins.

## The dedicated checkout

`bin/link` and the plugin both read `~/git/keel` in place, so that checkout moves only by merge. Do not edit in it: once keel is installed, git-guard denies Claude Code writes there and asks for a worktree (`C-isolation`), and `bin/link --write` refuses to link from a linked worktree unless `--allow-worktree` is given.

To update it:

```bash
git -C ~/git/keel pull --ff-only
~/git/keel/bin/link --check
```

If `--check` reports drift, run `~/git/keel/bin/link --write` and check again. Start new Claude Code sessions after each update.

## What `bin/link` does

keel never generates all of `settings.json`. It owns exactly the `hooks`, `permissions` and `env` keys; other keys, such as `model`, stay as they are. Settings fragments use `{{KEEL}}`, `{{OVERLAY}}` and `{{DATA}}` placeholders, which `bin/link` expands.

```bash
bin/link            # dry run: what would change; lists items a first --write --adopt would drop
bin/link --check    # report drift (exit 1 on any problem)
bin/link --write    # apply links, owned settings keys and, in link mode, the generated CLAUDE.md
bin/link --unlink   # remove keel's links and restore the backed-up settings
```

The dry run prints JSON: `actions` (what `--write` would do), `problems` and `dropped`. A refused `--write` writes nothing and prints the exact command to run after `link: or, once each one is reviewed, run:`. Every settings write is backed up first. `--write` also sets `core.hooksPath githooks` in the keel checkout, so the boundary scan runs on commit and push.

`--plugin` and `--full` pick the mode and are recorded; `--check` reads the recorded mode. Plugin mode leaves the hooks, skills, agents, workflows and principles to the plugin and refuses (`plugin-not-enabled`) until `enabledPlugins` has `"keel@keel": true`.

### Resolving problems

With an existing `~/.claude` setup, one or both of two problems block `--write`:

- `settings-unadopted`: keel takes over the `hooks`, `permissions` and `env` keys of `settings.json`, and `dropped` lists every existing item it would remove. To keep an item, declare it in an overlay settings fragment, such as `~/git/keel-overlay/settings/mine.json`, with the same key and value as in your `settings.json`. A plain `--write` refuses, writes nothing and prints each item on stderr as `link: adopt drops: <item>`. Copy each item you accept losing into a file, one per line, exactly as those lines print it (the JSON in `dropped` escapes quotes and backslashes), then run the command the refusal prints: `bin/link --write --plugin --adopt --accept-drops <file>` in plugin mode, or the same without `--plugin` for the link-only install.
- `target-occupied` on `CLAUDE.md` (link mode only): the file is yours, not generated. `--force` moves it to `~/.claude/state/keel/link-backup/<time>/CLAUDE.md`. To keep its rules, move them into the overlay's `PERSONAL.md`; `bin/link` appends that file to the generated `CLAUDE.md`. The generated file is capped at 4608 bytes and `PRINCIPLES.md` uses about half, so `PERSONAL.md` has about 2.3 KB; no flag lifts the cap, and the dry run's `claude_md_bytes` shows the size. Plugin mode removes only a generated `CLAUDE.md` and leaves yours in place.

With both problems in link mode, the command is `bin/link --write --adopt --force --accept-drops <file>`.

`bin/link --unlink` restores the backed-up `settings.json` and `CLAUDE.md`.

### Environment variables

Specified in DESIGN.md (i):

| Variable | Default | Meaning |
|---|---|---|
| `KEEL_HOME` | repo root of the running script | keel checkout |
| `KEEL_OVERLAY_DIR` | `~/git/keel-overlay` | overlay checkout; missing means no overlay data |
| `KEEL_DATA_DIR` | `~/.claude` | logs, state, evidence, link targets, settings |

## Without an overlay

The overlay (`~/git/keel-overlay`, or `KEEL_OVERLAY_DIR`) holds your own rules and data. Every file in it is optional, so you can start without one. Until you add one:

- No repo is gated. ship-gate warns once per session and lets pushes and merges through, except one it cannot attribute to one repo and branch, such as `git subtree push` or a `GIT_DIR` override, which it still denies.
- `git-guard`, `report-gate` and `model-assign` still run in every repo. For example, `model-assign` assigns a model and an effort to an agent dispatch that names none, and denies a Workflow script whose `agent()` calls name none.
- Each session loads `PRINCIPLES.md` only, with no `PERSONAL.md` after it.
- `measure/smoke` fails until the overlay has `boundary/lexicon.txt`, and while any installed Claude Code mod is missing from the overlay's `reviewed-mods.txt`.

Create and edit overlay files from your own terminal: git-guard treats the overlay like the keel checkout and denies Claude Code writes in it. [`examples/`](../examples) shows sample data for the main overlay files, grouped by component, with invented values. DESIGN.md (a) lists every overlay file, and (h) specifies `gated-repos.tsv` and `risk-rules.tsv`.

## The link-only install

Before the plugin, keel was installed by `bin/link` alone, and that install still works. In link mode `bin/link` also links the hooks, skills, agents and workflows into `~/.claude` and writes a generated `CLAUDE.md` from `PRINCIPLES.md` and `PERSONAL.md`. Skills and workflows then carry no `keel:` prefix, for example `/lens-review`.

```bash
cd ~/git/keel
bin/link
bin/link --write --full
bin/link --check
```

To move from the plugin back to the link install:

```bash
claude plugin disable keel@keel
cd ~/git/keel && bin/link --write --full
bin/link --check
```

## Upgrading from a release with Python hooks

1. Fast-forward the dedicated keel checkout (`~/git/keel`) to the 1.0.0 commit.
2. At once, from a terminal outside Claude Code and Codex, run `bin/link --write` and then `codex/bin/link --write` in that checkout. Both rewrite the hook registrations in the settings from `python3 .../<name>.py` to `node .../<name>.ts`.
3. Start a new Codex session, open `/hooks` and trust the regenerated `pre-tool-use.ts` command (see [`codex/README.md`](../codex/README.md)).
4. Run `bin/link --check` and `codex/bin/link --check`. Both must report no drift.

Until step 2 is done, every keel hook blocks: the old settings still point at the `.py` files this release deletes, so `python3` fails on each hook call. Run the two `link --write` commands from a terminal outside Claude Code and Codex, whose blocked hooks would stop them.
