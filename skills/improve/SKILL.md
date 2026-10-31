---
name: improve
description: Finding and making one behavior-preserving structural improvement or a specified refactoring in existing code — shallow modules, pass-through layers, dead code, seams nothing varies across. Trigger; "improve this module", "where is this codebase hard to change", "refactor candidates", "refactor this module", "simplify this structure without changing behavior", "architecture review of <area>", a requested legacy cleanup. Do NOT use for code the current diff already changes (readable-code covers it), a behavior bug (fix it with a red test), a recurring review finding a machine can decide (descend), or an unrequested repo-wide sweep.
---

# Improve

K5 keeps unrelated legacy cleanup out of feature diffs and makes it a separate requested task; this skill is that task's procedure. Candidate discovery leaves an HTML report of ranked candidates. A selected improvement or specified refactoring leaves one behavior-preserving diff that goes through the normal review and ship-gate.

The vocabulary and the deletion test are adapted from Matt Pocock's `improve-codebase-architecture` and `codebase-design` skills (github.com/mattpocock/skills at 49dd158, MIT); the ordering rules from pstack's subtract-before-you-add and migrate-callers principles (github.com/cursor/plugins at 6b78e9f, MIT).

## Choose the entry point

- **Find an improvement.** The user names an area but has not chosen a structural
  change: follow steps 1–4, report candidates and let the user choose one.
- **Make a specified refactoring.** The request or prior conversation already
  names the structural change and its scope: read the affected flow and the reasons
  for the current shape, enter step 4 with that choice, and follow step 5. Do not
  repeat candidate discovery or require another selection. A file name alone does
  not settle an unclear structural goal; use `prompt-refine` for decisions that
  change the work.

Before implementing either path, read [Refactoring](references/refactoring.md).
It defines the behavior pin, equivalence proof and reader-load comparison. Load
`readable-code` for the changed code. This skill adds no model panel or permission
for commits, activation, PRs or other delivery actions.

## Vocabulary

Use these words in the report and the brief so candidates compare on one scale.

| Word | Meaning |
|---|---|
| Module | Anything with an interface and an implementation: a function, class, package or slice |
| Interface | Everything a caller has to know: signature, invariants, ordering, error modes, configuration |
| Depth | Behavior a caller gets per unit of interface it learns. Deep: small interface, much behavior. Shallow: the interface is nearly as large as the implementation |
| Seam | The place a module's interface lives, where behavior can change without editing callers |
| Adapter | A concrete thing that fills a seam (the production client, the in-memory fake) |

Three tests decide most candidates:

- **Deletion test.** Imagine deleting the module and inlining it into its callers. If complexity vanishes, it was a pass-through. If the same complexity reappears in N callers, it earns its place.
- **One adapter is a hypothetical seam; two adapters make a real one.** An interface, port or factory with a single implementation and no test double is indirection, not a seam.
- **The interface is the test surface.** If the tests have to reach past the interface (private methods, internal helpers, the database behind a repository) to check behavior, the module has the wrong shape.

## How it works

1. **Scope before scanning.** Take the area the user named. Without one, find the hot spots: files that keep changing are where depth pays back.

   ```bash
   git log --since=90.days --name-only --format= -- . | sort | uniq -c | sort -rn | head -20
   ```

   Read what the project keeps on its domain and past decisions (the notes directory named in `PERSONAL.md`, `docs/adr/`, a glossary) and the candidates earlier runs recorded as rejected; do not re-propose a rejected one without new evidence.

2. **Explore with a read-only subagent.** Brief it with the scope, the vocabulary above and these friction questions; it names a model and an effort (C-dispatch) and edits nothing:
   - Where does understanding one concept mean bouncing between many small modules?
   - Which modules fail the deletion test, or are seams with one adapter?
   - Where were pure functions extracted for testing while the bugs live in how they are called?
   - Where does a caller have to know a module's internal rules to use it, or import a module's internals instead of its public entry?
   - Where is one format or rule known by several modules split by execution step (fetch, transform, save)?
   - Which hand-maintained lists must change together, and which concept has its decision split across files?
   - What is dead: unreferenced code, flags fixed to one value, a second way to do something the codebase already does one way?
   - What is hard to test through its current interface, or untested?

   Each finding comes back with `file:line` evidence and its deletion-test result. Dead code is a candidate of its own and ranks first: subtract before adding.

3. **Write the candidate report.** One self-contained HTML file (the owner's document-deliverable rule decides the path; without one, `$TMPDIR/improve-<timestamp>.html`), inline CSS and SVG, no CDN. One card per candidate:
   - **Files**, with `file:line`;
   - **Problem**: the friction, in the project's domain words;
   - **Change**: what moves, merges or goes, in plain words; no interface code yet;
   - **Benefit**: what callers gain (leverage), where change and bugs will concentrate (locality), how tests improve;
   - **Before / after**: a small inline SVG of the modules and arrows;
   - **Dependencies**: the category from the table in step 4 and the test strategy it implies;
   - **Strength**: `Strong`, `Worth exploring` or `Speculative`.

   End with a top recommendation and the reason. A separate agent checks the report's `file:line` claims before the user sees it (K1). Then ask the user which candidate to take.

4. **Shape the chosen candidate.** Settle the open decisions with the user per `prompt-refine` (only the ones that change the work). Classify each dependency of the deepened module; the class sets the test strategy:

   | Dependency | Test at the new interface with |
   |---|---|
   | In-process (pure computation, memory) | the real code; merge the modules directly |
   | Local stand-in exists (embedded database, in-memory filesystem, a container) | the stand-in, inside the test suite |
   | Remote, owned by the team | a port at the seam, an in-memory adapter in tests |
   | Remote, third party | a port at the seam, a mock adapter in tests |

   Order the change:
   - **Check the fence first.** Before deleting anything, read `git log -L` or `git blame` for it and every caller; a reason that still holds stops the deletion.
   - **Subtract, then reshape.** Dead code and redundant layers go in their own commit before the new shape lands.
   - **Migrate callers, then delete the old interface in the same change**, when every caller is in this repo. When a caller is outside (another service, a shipped client, a stored format), list each one and stage the change: add the new path, move callers, remove the old path in a later change.

   If the user rejects the candidate for a reason a later run would need, record it where step 1 reads (the notes directory or a short ADR) so it is not proposed again.

5. **Make the change.** Follow the behavior pin and equivalence procedure in
   [Refactoring](references/refactoring.md), running tests through
   `keel test -- <cmd>`. Replace tests of old shallow modules only where an
   observable-boundary test covers the same behavior; list each pair in the
   reading guide.

   A behavior bug found on the way is not fixed here; it becomes its own change with a red test (K3). Ship through `/lens-review` and ship-gate like any other diff.

## Rules

- [K4] Run only on an explicit request, scoped to one module or the hot-spot list; never as a repo-wide sweep.
- [K5] One candidate per diff, structure only: observable behavior, outputs and error modes stay the same; a behavior fix found on the way is a separate change.
- [K3] The behavior pin runs before restructuring and after it at a boundary both versions expose, with both runs quoted from `keel test`.
- [K2] Every candidate cites `file:line` and its deletion-test result; a report with zero candidates states the files and commit range it scanned.
- [K1] A separate agent checks the report's claims, and `/lens-review` judges the diff; the author approves neither.
- [K5] A deleted test is listed with the new interface test that covers its behavior; a deletion with no covering test is not made.

## Output

After the report:

```
Report     : <absolute path of the HTML>
Scanned    : <scope> (<commit range>, <N> files)
Candidates : <N> (<strong>/<worth exploring>/<speculative>)
Top        : <candidate> — <one-line reason>
```

After the change:

```
Improved   : <candidate> — <modules before> → <module after>
Pinned     : <runner summary before> / <runner summary after> (exit 0)
Equivalent : <old/new comparison or covered behavior and remaining limits>
Readability: <concrete caller-trace or decision-ownership improvement>
Deleted    : <old tests or code, each with its covering test> or "none"
Review     : <lens-review verdict line>
```

## Troubleshooting

- **No hot spots** (young or quiet repo): ask the user for the area that hurts; do not scan everything.
- **Every candidate is Speculative**: say so and stop; a weak report is a valid result.
- **The pinning tests cannot exercise both versions**: move the pin to their shared observable boundary or use an explicit old/new adapter in the equivalence harness; do not skip the before run.
- **A test fails after restructuring**: identify the mismatch, restore only this refactoring's affected changes to the last verified state, and split the step smaller. Preserve unrelated work; do not reset the checkout.
