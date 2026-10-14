---
name: prompt-refine
description: Load first, before any lookup, when a request is ambiguous — turn it into an approved brief (goal, target, deliverable, scope, done-when) and ask only questions that change the work. Trigger; two or more plausible readings, no target or deliverable, a vague verb with no object ("clean it up", "improve this", "just handle it"). Do NOT use for a single-reading request, a step of an agreed plan, or a pure question.
---

# Prompt Refine

Implements K4 (ask when ambiguous; act when clear): an unclear request becomes a brief the user has approved, and work starts only after that.

## How it works

1. **Look it up first.** Fill every slot below you can before asking.
   - Pull 1–3 topic keywords from the request (module, screen, ticket id, feature noun).
   - Notes the user keeps (a notes directory named in `PERSONAL.md`, the repo's `docs/`): `grep -rlci '<keyword>'`, read only the 3 best hits' headings and summary lines.
   - Memory: the current project's index is already in context; other projects' memory only by grep. Then the repo (`git log --oneline -20`, the obvious file).
   - Each slot a source fills goes into Assumptions with that source (`<file>:<line>`, a note name), so the user can veto it.

2. **Find the gaps that change the work.** A slot is a gap only when its two plausible answers lead to different files, a different deliverable or a different risk. A gap that changes nothing gets a stated assumption instead of a question.

   | Slot | Question it answers |
   |---|---|
   | Goal | What outcome, for whom, and why now |
   | Target | Which repo, path, screen, ticket or data |
   | Deliverable | Code diff, report, ticket, answer, config |
   | Scope / Not doing | What is in, what is explicitly out |
   | Depth | Analysis, report or diagnosis only: which source (raw or digested) and which method the work rests on |
   | Done when | The check that proves it: tests, command output, a screen |
   | Constraints | Environment (dev or prod), deadline, approval gates |

3. **No gaps → do not interrupt.** Say the one-line restatement and proceed.
4. **Gaps → one message:** the refined brief, then `AskUserQuestion` with 1–4 questions. Each question offers the concrete readings as options, the recommended one first with "(Recommended)".

   ```
   ## Refined request
   Goal        : …
   Target      : …
   Deliverable : …
   Scope       : …   Not doing: …
   Depth       : … (source → method; analysis, report or diagnosis only)
   Done when   : …
   Assumptions : … (each one the user can veto)
   ```

5. **Wait.** Fold the answers into the brief. If an answer opens a new gap, ask again; repeat until clear. When nothing is open, state the final brief in one block; start right away only if the answers just picked among the options shown, otherwise start on the user's OK.

## Rules

- [K4] Never ask the user something a lookup answers.
- [K4] Questions are about decisions, not permission: never "Shall I proceed?". Approval of irreversible actions stays with the floor rule `F-irreversible`, not here.
- [K4] Talk to the user in their language; the brief headings stay as above.
- [K4] Push back in the brief when a simpler reading reaches the same goal.
- [K4] A creative or feature request with diverging directions gets 2–3 short drafts as the options instead of abstract questions.
- [K4] Fill Depth only for an analysis, report or diagnosis deliverable, from lookup first; ask only when two sources or methods lead to different work. A code-diff deliverable never gets a Depth slot.
