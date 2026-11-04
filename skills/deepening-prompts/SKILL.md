---
name: deepening-prompts
description: Load before handing a request to an agent when the owner's words have one reading but are loose, terse or shallow — rewrite them into a deeper brief (the outcome behind the task, the rawest source, the methods a top practitioner would use, an outside judge, and the doubt that attacks the result) so the agent does the expert version, not the literal one. Trigger; an imprecise one-line request about to become a subagent brief, a workflow agent prompt or a ticket task, any request to write or hand off a brief for an agent, "make this prompt deeper", "rewrite this for the agent", "deep prompt". Load it before judging such a request ambiguous: it sends a real fork to refining-requests itself. Do NOT use for a request that is not a brief and has two plausible readings (refining-requests asks first), a fully specified mechanical task (a rename, an exact edit list), a question answered here without delegating, or a review dispatch (lens-review and removing-comments own their briefs).
---

# Deepening prompts

The owner often states a request in a few loose words. Passed through as written, an agent does the literal, shallow version and believes its first explanation. This skill rewrites the request the way Felix Rieseberg's "How to be more ambitious: a tutorial for humans with models" (felixrieseberg.com) recommends: a deeper version of the task, not a bigger one, which the agent then tries to break before it reports.

## Pick the path

| The request | Path |
|---|---|
| One reading, loose or shallow words | Deepen it, show the rewrite, dispatch |
| Two readings that lead to different work | Stop and load `refining-requests` |
| Fully specified or mechanical | Pass it through unchanged |

Deepening can surface a fork the words hid. Readings that are layers of one outcome are not a fork: "did the migration work" means both that it ran cleanly and that it fixed what it was for, so the brief states the outcome behind both as `assumed:` and Method checks each layer. Readings that need different deliverables or a different scope are a fork: hand it to `refining-requests` instead of asking a second way.

## Answer five questions

Fill each from lookup first (the repo, the owner's notes, memory, the data itself), the way `refining-requests` looks up before asking. Write only what you found or confirmed; a guess is marked as one.

1. **Outcome.** What the task is for: the goal behind the goal, and the decision or change the result feeds. Say it as a verb, not a noun: "decide whether Friday's release is safe to ship", not "release checklist". An outcome you inferred rather than found starts with `assumed:`, and Method tells the agent to stop and report if the raw source contradicts it.
2. **Rawest source.** The primary material a top practitioner would open: raw tables, logs, the diff, the transcripts. Not a summary, a dashboard or a digest someone already wrote. Name only paths, tables or queries you opened or listed. A source that exists but cannot be reached from here is written `not reachable: <what>`, and the agent reports that gap instead of falling back to a summary.
3. **Method.** The instruments a top practitioner uses that the owner did not name: a query over the raw table, a red reproduction test, a bisect, a profiler run, a statistical test, a model checked against data it was not fitted on. Name only instruments you confirmed run here, with the exact command or tool. When none exists, the first step is to build the smallest measurement or reproduction that does.
4. **Judge.** The outside evidence that shows the result is right, and a check the agent runs during the work, not only at the end: a test run, a query result, a replay. For analysis, hold out a period or segment the explanation was not built on and score it there. When no runnable check exists, the agent marks the result `unverified` in its return. Never the agent's own verdict.
5. **Doubt.** The strongest ways the result could be wrong. For each of the at most three claims the result depends on most, the agent names the observation that would refute it, runs that check, and reports which claims survived and which did not. A claim it did not attack is reported as untested, never as a finding.

Add these when the work calls for them:

- **Test the belief.** When the owner states a cause ("it's an onboarding problem"), it becomes the first claim under Doubt: the agent reproduces that cause from the raw source before building on it.
- **Crew.** For analysis or report work that spans fields, add one Method line naming two to four roles by what each does in this one agent's work: a forensic accountant reconciles every total against the ledger; a red team argues the opposite conclusion from the same data. Ask for the work the role does, never for its voice, and never dispatch a role as a separate agent.

Deeper, not bigger: the scope and the deliverable stay what the owner asked for. Work worth doing beyond them goes under Not doing with one line on why it matters.

## Write the brief

Use the `authoring-agents` brief and fold the answers into it so no section says the same thing twice: Outcome replaces Goal and why, Rawest source opens Target, Judge and Doubt make up Done when, and the Return shape lists the claims that survived, failed or went untested. The block sits on top, one or two sentences per line:

```
Outcome      : …
Rawest source: …
Method       : …
Judge        : …
Doubt        : …
```

Where the repository keeps briefs as files, write the brief there.

## Show it

Before dispatching, show the owner one block in their language: their original words quoted, then the rewritten brief. Dispatch right after it without asking for approval. A slot that lookup cannot fill and whose two answers change the work is a gap for `refining-requests`, not a guess.

## Rules
- [K4] An imprecise single-reading request handed to an agent is rewritten first, with Outcome, Rawest source, Method, Judge and Doubt filled from lookup, deeper and not bigger, and the rewrite is shown to the owner before dispatch.
- [K4] A request with two plausible readings goes to `refining-requests`; deepening never opens a second question path.
- [K1] The Judge is outside evidence or an independent context, never the agent's own pass; Doubt makes the agent attack its own claims before that judge sees them.
- [K2] A source, instrument or check named in the brief is one that was confirmed to exist here; one that was not is marked `not reachable`, `assumed` or `unverified`, never written as if it were.
