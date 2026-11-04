---
name: deepening-prompts
description: Load before handing a request to an agent when the owner's words have one reading but are loose, terse or shallow — rewrite them into a deeper brief (the outcome behind the task, the rawest source, the methods a top practitioner would use, an outside judge) so the agent does the expert version, not the literal one. Trigger; an imprecise one-line request about to become a subagent brief, a workflow agent prompt or a ticket task, "make this prompt deeper", "rewrite this for the agent", "deep prompt". Do NOT use for a request with two plausible readings (refining-requests asks first), a fully specified mechanical task (a rename, an exact edit list), a question answered here without delegating, or a review dispatch (lens-review and removing-comments own their briefs).
---

# Deepening prompts

The owner often states a request in a few loose words. Passed through as written, an agent does the literal, shallow version of it. This skill rewrites the request the way Felix Rieseberg's "How to be more ambitious: a tutorial for humans with models" (felixrieseberg.com) recommends: a deeper version of the task, not a bigger one. The result is an `authoring-agents` brief with four extra lines at the top.

## Pick the path

| The request | Path |
|---|---|
| One reading, loose or shallow words | Deepen it, show the rewrite, dispatch |
| Two readings that lead to different work | Stop and load `refining-requests` |
| Fully specified or mechanical | Pass it through unchanged |

Deepening can surface a fork the words hid, such as two different outcomes the work could serve. That fork is ambiguity: hand it to `refining-requests` instead of asking a second way.

## Answer four questions

Fill each from lookup first (the repo, the owner's notes, memory, the data itself), the way `refining-requests` looks up before asking.

1. **Outcome.** What the task is for: the goal behind the goal, and the decision or change the result feeds. Say what the work does as a verb, not a noun: "decide whether Friday's release is safe to ship", not "release checklist".
2. **Rawest source.** The primary material a top practitioner would open: raw tables, logs, the diff, the transcripts. Not a summary, a dashboard or a digest someone already wrote. Name the paths, tables or queries.
3. **Method.** The instruments a top practitioner uses that the owner did not name: a query over the raw table, a red reproduction test, a bisect, a statistical test, a model checked against data it was not fitted on. Include what that practitioner would do without being asked.
4. **Judge.** The outside evidence that shows the result is right: a test run, a query result, a held-out comparison, an independent reviewer. Never the agent's own verdict.

Add these when the work calls for them:

- **Test the belief.** When the owner states a cause ("it's an onboarding problem"), the brief asks the agent to reproduce that cause from the raw source before building on it.
- **Crew.** For analysis or report work that spans fields, name two to four roles by what each does: a forensic accountant reconciles every total against the ledger; a red team argues the opposite conclusion from the same data. Ask for the work the role does, never for its voice.
- **The bar.** State the standard a top practitioner would hold the result to, plainly, even when it is higher than the owner's words.

Deeper, not bigger: the scope and the deliverable stay what the owner asked for. Work worth doing beyond them goes under Not doing with one line on why it matters.

## Write the brief

Use the `authoring-agents` brief (Goal and why, Target, Already ruled out, Scope, Done when, Return shape, On failure) and put the four answers first:

```
Outcome      : …
Rawest source: …
Method       : …
Judge        : …
```

Done when names the Judge's evidence. Where the repository keeps briefs as files, write the brief there.

## Show it

Before dispatching, show the owner one block in their language: their original words quoted, then the rewritten brief. Dispatch right after it without asking for approval. A slot that lookup cannot fill and whose two answers change the work is a gap for `refining-requests`, not a guess.

## Rules
- [K4] An imprecise single-reading request handed to an agent is rewritten first, with Outcome, Rawest source, Method and Judge filled from lookup, deeper and not bigger, and the rewrite is shown to the owner before dispatch.
- [K4] A request with two plausible readings goes to `refining-requests`; deepening never opens a second question path.
- [K1] The Judge is outside evidence or an independent context, never the agent's own pass.
