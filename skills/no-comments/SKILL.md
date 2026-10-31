---
name: no-comments
description: The comment pass before formal review — a fresh read-only reviewer judges every comment in the files a diff changes against K5.14, and the author applies its kill list. Trigger; a candidate that changes a code file is about to go to `keel review prepare` or `/lens-review`, "strip the comments", "no-comments the diff", `/no-comments`. Do NOT use for a docs-only or smoke-only diff, a fix delta after NEEDS_FIXES (the root candidate already had the pass), or files the diff does not change (that cleanup is a separate requested task).
---

# No comments

An author defends its own comments, so a context that did not write them decides which ones go. git-guard C-comments stops most new comments at write time; this pass catches the writes it does not parse and clears the pre-existing comments of every file the diff changes, before the review spends a round on them. Adapted from pstack's `no-comments` skill and Comment Sicko agent in [cursor/plugins](https://github.com/cursor/plugins) (at 4dd1d05, MIT), with keel's narrower K5.14 exceptions.

## How it works

1. **Spawn the reviewer.** Dispatch a `keel-comment-reviewer` agent (in Codex, a new reviewer context given `~/.claude/agents/keel-comment-reviewer.md` as its brief) with the repository's absolute path and the review base. Do not restate its rules or pre-judge any comment in the brief.

2. **Check the list, not the verdicts.** Reject a line only when it cites a file outside the scope, a file:line that holds no comment, a `KEEP` whose tool or notice does not exist, or a `MUST KILL` / `ENCODE` that names a symbol or check that is not there. Rerun the reviewer once with the rejected lines named; a second bad list is reported open in the reading guide. Disagreeing with a `DELETE` is not a ground: the comment goes.

3. **Delete the comments.** Remove every accepted `DELETE` line and nothing else, as its own commit on the branch (`comments: remove <n> comments per the no-comments pass`). That commit is comment-only, so the K5.7 diff signal exempts it; behavior changes stay out of it.

4. **Fix each `MUST KILL`.** Rename, extract or retype the named symbol so the code says what the comment said, in the scope of the diff. That is a logic change: it ships with a test that fails without it (K3) and goes through the formal review with the rest. A reshape outside the diff's files is reported open, not done.

5. **Offer each `ENCODE`.** Ask the owner through `AskUserQuestion` whether to add the named type, test or lint rule. On yes, add it with its red-then-green test. On no, the comment stays deleted and the constraint goes open in the reading guide's Decisions with the source that backs it.

6. **Report into the reading guide.** Paste the reviewer's summary line and list the reshapes done, the encodings added or declined, and anything open, under Decisions. The review reads it there; a candidate without that line has not had the pass.

## Rules
- [K5.14] Every comment in a file the diff changes goes unless it is a legal notice or a tool-consumed directive; the reviewer's `DELETE` stands unless the line it cites is wrong.
- [K1] The comment reviewer is a separate context from the author; the author's view that a comment helps is not a ground to keep it.
- [K3] A `MUST KILL` reshape or an `ENCODE` check is changed logic and ships with a test that fails without it.
- [K5.7] Comment deletions land as a comment-only commit, apart from reshapes and the requested change.
