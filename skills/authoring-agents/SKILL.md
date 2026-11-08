---
name: authoring-agents
description: Choosing the form for delegated work and writing a subagent definition or an agent brief. Trigger; "make an agent for X", "write a brief for the worker", a task about to be handed to a subagent that needs more than a one-line prompt, a new `agents/*.md` file, "should this agent fold back into the main loop", a new skill or agent added beside overlapping ones. Do NOT use for a quick lookup a few tool calls settle, fixing an agent that keeps failing (improving-agents), or a review dispatch (lens-review and removing-comments own their briefs).
---

# Authoring agents

Delegated work fails in two places: the wrong form (a new agent where a brief would do, always-on text where a skill would do) and a brief that leaves the agent guessing. This skill picks the cheapest form that works and writes the definition and the brief so the agent can finish without the conversation it never saw. The form order and the "large input, small answer" test are adapted from Harness² (github.com/google-research/harness2 at 1cfe254, Apache-2.0, `harness2/core/prompts.py`). The split, fold and prune rules are adapted from Anthropic's "Building agents: When to fold subagents into your main agent loop" (claude.com/resources/articles, 2026-10-22).

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

Split delegated work by context, not by problem type or by team. Give an agent a piece that needs little from the rest of the run and returns a compact result; one agent per kind of problem passes the same facts through several handoffs and loses detail at each.

Fold an agent back into the main loop, as a skill for its procedure and a tool or script for its calls, when it chains on another agent's output, reads the same data as one, or is often called together with one. Keep it without a comparison when it needs a fresh or parallel context, or its tools or instructions would conflict with the main loop's. Otherwise fold one agent at a time: treat the fold as the candidate in `improving-agents` steps 4–6 (it needs no failing runs) and adopt it unless the label is `hurt`, after checking that the folded run still makes every check the agent made.

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
- **Return shape**: the format and length of the reply. When the deliverable has a shape the agent must match (a report, a layout, a file format), point at a finished example to copy (or inline a short one when none exists), beside the checkable first line or schema, not in place of it.
- **On failure**: one bounded fallback and a stop condition; a tool error is reported with its output, not retried blindly.

Leave out your hypothesis as a fact, your verdict on the work and any "this looks correct" language: an agent handed a conclusion tends to return it confirmed. A coding brief tells the agent to load `writing-readable-code` or inlines the rules the task touches.

## Check it

- A new definition: link it (`bin/link`), confirm `~/.claude/agents/<name>.md` resolves, and dispatch it once on a small real task; the first reply shows whether the return shape holds.
- A brief: read it as the agent would, with no other context. Every path it names exists, and "done" is something the agent can run.

## Prune what is kept

Every kept skill and agent costs on each run, so when adding one, look at its neighbours:

- **Unused or overlapping.** A skill with zero Skill-tool loads in `~/.claude` transcripts since it shipped, an agent with zero Agent-tool dispatches in those transcripts, or one whose trigger or rule another already covers, is merged or removed through the normal review path.
- **Written for an older model.** Text that only made sense for a weaker model, such as repeated warnings or step-by-step instructions for work the model now plans itself, is removed as an `improving-agents` candidate; the removal is adopted unless the label is `hurt`. A tagged `[ID]` rule leaves through its ledger row (`measure/propose --model-upgrade`), not by deleting the text.

## Rules
- [K5] Pick the first form in the table that holds the work; a new agent definition or always-on text needs a reason the earlier forms cannot carry it.
- [K1] A brief for a reviewer or verifier carries the material, not the author's verdict.
- [K2] Every brief names its done check and the evidence the agent returns.
