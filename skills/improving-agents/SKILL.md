---
name: improving-agents
description: Improving an agent definition or a reusable brief from evidence — diagnose the runs that went wrong, change one component, compare base and candidate on the same task, adopt only what helped. Trigger; "the worker keeps doing X", "improve this agent", the owner correcting the same agent mistake twice, a subagent failing the same way in two runs. Do NOT use for a one-off bad result (fix the brief and rerun), a recurring review finding a machine can decide (descending-findings), or writing a new agent (authoring-agents).
---

# Improving agents

An agent edit that sounds right can still change nothing, or make another run worse. This skill changes an agent only where a run shows the failure, tests the change against the unchanged agent on the same task, and keeps it only when the comparison says it helped. The diagnosis split, the verdict labels and the cue/lesson/evidence entry are adapted from Harness² (github.com/google-research/harness2 at 1cfe254, Apache-2.0, `harness2/core/prompts.py`); the owner approves adoption, which Harness² does not have.

## How it works

1. **Collect the failing runs.** Gather at least two runs with the same failure: the brief, the agent's reply and, where kept, its transcript. For each, name the moment the behavior went wrong (the call, the line of output). A failure seen once is noise; fix that brief and rerun instead.

2. **Diagnose the dimension.** Find the earliest divergence, then sort it:
   - **Procedure**: how the agent worked — a tool error it misread, a step repeated by hand, a check it skipped, a deliverable it did not reopen.
   - **Knowledge**: what a practitioner knows that the agent lacked — a source to read, a structure the result needs, a domain rule.

3. **Pick the lever.** Use the form order in `authoring-agents`: a brief line, the definition body, a skill with a trigger, a script, a hook, always-on text last. Procedure that is skipped despite clear text twice goes to a script or a hook, not more prose. Knowledge with a trigger goes to a skill. A rule the runs ignored although its text was clear gets a worked example beside it, not more rule text: a finished instance to copy, or a bad and a good version that differ in that one rule. Agents copy an example they skip as a rule; Stageshow's author found that in A/B runs and ships examples to copy for that reason (github.com/benjitaylor/skills at 299140f, MIT, `stageshow`).

4. **Make one candidate.** Change one component per candidate, on a branch. Leave the deliverable's shape alone: the agent changes how it works, not what it returns. If the evidence argues for no change, stop and say keep-base; that is a result.

5. **Compare base and candidate.** Run both on the reproducing task, three times each, in fresh contexts: the base with the current definition or brief, the candidate with the edited one (pass a definition's body as the brief to a `general-purpose` agent when the linked file cannot be swapped). Grade each run with a deterministic check where one exists (the expected file, a test, an exact field); a run passes a condition at two of three. When grading needs judgment, give a separate agent the outputs labelled A and B in shuffled order, not which one is the candidate. For a change to a skill or other instruction text, offer the owner `abdiff` through `AskUserQuestion` in place of this step; it runs only on their yes.

6. **Label the change.** One row per changed component: what changed, what the runs showed, and a verdict — `helped`, `hurt`, `no observed effect` or `confounded`. Use `confounded` when the candidate changed several components or one run is all that separates them. A run that produced nothing marks the edit unsafe unless the other runs outweigh it, stated in the row.

7. **Adopt or drop.** Only a `helped` change goes forward, through the normal path for its repository (tests, review, owner approval). Anything else is reverted, and the row is kept in the reading guide or the report.

8. **Record the lesson.** Write at most one entry to the module's vault `Learnings/`: `cue` (the shape of situation it applies to, not this task's facts), `lesson` (the operation, naming the component) and `evidence` (the verdict rows and run ids). With no concrete contrast, write none.

## Rules
- [K1] The author of an agent edit does not label it `helped`; the label comes from the deterministic check or a separate blind judge.
- [K2] A verdict row cites the runs and the pass counts for base and candidate; a comparison with zero graded runs is not a result.
- [K5] One component per candidate, changed only where a run shows the failure; keep-base is a valid outcome.
