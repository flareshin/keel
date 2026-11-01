---
name: agent-authoring
description: Choosing the form for delegated work and writing a subagent definition or an agent brief. Trigger; "make an agent for X", "write a brief for the worker", a task about to be handed to a subagent that needs more than a one-line prompt, a new `agents/*.md` file. Do NOT use for a quick lookup you can do in a few tool calls, fixing an agent that keeps failing (agent-improve), or a review dispatch (lens-review and no-comments own their briefs).
---

# Agent authoring

Delegated work fails in two places: the wrong form (a new agent where a brief would do, always-on text where a skill would do) and a brief that leaves the agent guessing. This skill picks the cheapest form that works and writes the definition and the brief so the agent can finish without the conversation it never saw. The form order and the "large input, small answer" test are adapted from Harness² (github.com/google-research/harness2 at 1cfe254, Apache-2.0, `harness2/core/prompts.py`).

## Pick the form

Take the first form that can hold the work. Each later one costs more to keep.

| Form | Use it when | Cost |
|---|---|---|
| A brief to an existing agent (`general-purpose`, `worker-low`, `worker-high`, `Explore`) | one task, not recurring | nothing kept |
| A skill | a recurring situation with a recognisable trigger | its description is always loaded |
| A script | a deterministic step agents hand-rolled and got wrong or slow | code and tests to keep |
| A new agent definition | a bounded sub-task whose input is large and whose answer is small, or one that needs a fixed tool set, model or effort | a file to keep; it sees only its file and the brief |
| A hook | a mechanical rule an agent must not be able to skip | runs on every matching call |
| Always-on text (CLAUDE.md, ledger prose) | a short rule that applies to every run | paid on every turn; cut something to add it |

A new agent is a bad trade when its output is as large as its input: the parent reads it all again. Pick `worker-low` for fully specified mechanical work and `worker-high` for hard, well-scoped implementation before writing a new definition.

## Write the definition

An agent file is `agents/<name>.md` (keel-wide, linked through `settings/links.tsv`), `~/git/keel-overlay/agents/` (personal or company), or `.claude/agents/` in one repository.

- **Frontmatter.** `name:` equals the file name; `description:` says when to dispatch it and when not, in one or two sentences; `tools:` lists only what the role needs (without it the agent inherits every tool, and keel's agent test requires it for keel agents); `effort:` or `model:` only when the role needs a pin. A reviewer or verifier leaves `model:` out so the model hook can raise it.
- **Body.** Who it is, what it receives, what it returns and in what shape, and what it does not do. It never sees the main conversation, so state the working directory rule (absolute paths; cwd resets between Bash calls) and where its output goes.
- **Output.** A fixed first line or schema the caller can check (a `VERDICT`, a count, a JSON shape). A read-only role says it never edits.

## Write the brief

The brief is all the agent knows. Include:

- **Goal and why**, in one or two sentences.
- **Target**: absolute paths, the branch or commit, the files worth reading first.
- **Already ruled out**: what you checked and what it showed, so the agent does not redo it.
- **Scope**: what is in, what is out, and that it does not commit, push or widen the change unless told.
- **Done when**: the check that proves it and the evidence to quote — a runner summary, an exit code, a count.
- **Return shape**: the format and length of the reply.
- **On failure**: one bounded fallback and a stop condition; a tool error is reported with its output, not retried blindly.

Leave out your hypothesis as a fact, your verdict on the work and any "this looks correct" language: an agent handed a conclusion tends to return it confirmed. A coding brief tells the agent to load `readable-code` or inlines the rules the task touches.

## Check it

- A new definition: link it (`bin/link`), confirm `~/.claude/agents/<name>.md` resolves, and dispatch it once on a small real task; the first reply shows whether the return shape holds.
- A brief: read it as the agent would, with no other context. Every path it names exists, and "done" is something the agent can run.

## Rules
- [K5] Pick the first form in the table that holds the work; a new agent definition or always-on text needs a reason the earlier forms cannot carry it.
- [K1] A brief for a reviewer or verifier carries the material, not the author's verdict.
- [K2] Every brief names its done check and the evidence the agent returns.
