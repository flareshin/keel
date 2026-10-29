# Readable Code

Implements K5 (change only what the request needs, minimally, in code a person can follow). AI writes the code; a person must still follow its flow, understand it and own it. People do not read every line, so the code has to make sense from the **entry point and the flow alone**.

Good code = code that someone else (or the next AI session) can **understand quickly** and change correctly and safely. Before/after examples: `references/examples.md`. Signal-only regex checks over a diff: `scripts/rule-checks.ts` (each signal is a candidate the reviewer judges, never a verdict). FE performance while writing (data loading, large lists or grids, heavy components, Next.js server side): `references/react-perf.md`, the 70 Vercel `react-best-practices` rules distilled; a writing reference, not a K5 rule, so a review blocks on it only where a project lens says so. Spring backend writing reference (transactions, JPA and MyBatis data access, async and scheduling, external calls, boundary, configuration, tests): `references/spring-practices.md`, distilled from the official Spring, Hibernate and MyBatis docs with the section cited per bullet; a writing reference, not a K5 rule, so a review blocks on it only where a project lens says so.

## Reader-cost model

Every rule exists to cut at least one of these costs:

| Cost | What the reader pays |
|---|---|
| **Flow break** | the top-down story is interrupted by detail or another concern |
| **Memory load** | holding values, open branches and state changes in mind (≈4 items max) |
| **Jump** | leaving to a definition, another file or hidden framework behavior |
| **Surprise** | the name predicted one thing and the body does another |

## Rules

### Scope
- [K5] Rules apply to **new and changed lines**. Do not rewrite untouched legacy code; legacy cleanup is its own tidy diff. Existing-comment cleanup is a separate requested task; do not enlarge a behavior change to clean untouched lines.
- [K5] Every rule has a **check** a reviewer can answer yes or no. Anything not checkable is taste and is not a rule.
- [K5] Breaking a rule is allowed with the reason in the reading guide's `Decisions`. This does not waive K5.14: its two comment exceptions are exhaustive.
- [K5] A domain name comes from the team's glossary when one exists; a missing concept is added there first.
- [K5] A coding-agent brief tells the agent to load this skill, or inlines the rules the task touches.
- [K5] The author does not judge their own diff against these rules (K1). Apply them while writing; a separate reviewer judges.

### Flow
- [K5.1] **Entry method reads as a story.** A public method (FE: component body, event handler) lists steps at **one abstraction level**. Retry loops, transaction setup and string parsing go behind named methods. *Check:* can you state what it does, in order, in one sentence from the entry method alone? *Exception:* ~15-line linear methods.
- [K5.2] **Stepdown order.** BE: callers above callees, in call order; public before private. FE file: `imports → types → pure helpers outside the component → component`. Inside the component: `props → hooks/state → derived values → handlers → effects → JSX`. *Check:* the call path can be followed by scrolling down only.
- [K5.3] **Guards first, happy path flat.** Validation and early returns go at the top. **Nesting ≤ 2.** Fallback chains ("take from A, else B, else C") go into a named `resolve…` method. *Check:* nesting depth ≥ 3, or Cognitive Complexity > 15 per method.

### Names
- [K5.4] **One concept, one name.** Use the glossary's standard name. Different concepts get different names (customer ≠ account, listPrice ≠ salePrice). FE: convert API snake_case to camelCase **once, at the API-layer boundary**. *Check:* a new domain name not in the glossary, or the same predicate written a different way. *Exception:* DTOs that mirror an external system's fields; use the standard names inside the boundary.
- [K5.5] **Names state behavior and side effects.** Verb contract: `find…` may be absent · `get…` must exist, else throw, never writes · `build…/to…` no persistence · `create/save/update/delete…` DB write · `push/publish/send/sync…` leaves the process · `resolve…` picks among sources · `is/has/can/should…` boolean. Doing two things → `…And…` (or split). Banned when used alone: `process, handle, do, execute, data, info, result, temp, list, obj, flag, util, manager, helper`. *Check:* from the name and signature alone, state the role in one sentence, then compare with the body. *Exception:* short lambda params, loop indices.
- [K5.6] **No magic values or sentinels.** Meaningful literals (`1/2`, `"Y"/"N"`, a status code, an id prefix) become enums or named constants **defined once**. Never load `null` with a special meaning ("all", "default tenant"). *Check:* a literal other than 0, 1, -1 or "" used in a comparison or branch, or null used as a signal. *Exception:* test fixtures, a single mapping from an external spec.

### Structure
- [K5.7] **Split by meaning, not length.** Extract only when the name lets the reader **skip the body**. No thin pass-through layers, single-use wrappers or single-use interfaces. Size is a **review signal**: method 60 lines, class 500, FE component 300, `useState` per component 10, and a diff of **400 changed lines** (excluding tests and generated files). Past a signal, split or write why not; a diff that cannot be split gets a more detailed reading guide. FE: group related state with `useReducer` or a custom hook. *Check:* a new single-caller pass-through, or a signal exceeded with no reason. *Exception:* a split that tests genuinely require; one long but linear flow (e.g., a column mapping) — still note it when past the signal; mechanical bulk renames and the K5.14 comment-only commit are exempt from the diff signal.
- [K5.8] **One concept decided in one place.** Domain rules (price math, eligibility verdicts, status transitions) are **never duplicated**; extract immediately. Other code: extract on the third repeat, counting copies repo-wide including existing code (this diff adding the third copy triggers it). A comment like "must stay in sync with X" means extract now. A deliberate duplicate needs an equivalence test. *Check:* repo-wide grep for the same computation, or a new "in sync/lockstep/same as" comment.
- [K5.9] **Make hidden behavior visible.** Side effects show in the name (K5.5). BE: a new or changed transaction boundary (`REQUIRES_NEW`, `TransactionTemplate`) goes behind a helper named for its transaction semantics; pin its propagation and rollback behavior with tests. A catch inside `@Transactional` must preserve the intended rollback-only behavior in executable code and tests. FE: `useEffect` only syncs with external systems. Compute derived values during render. Reset state on a prop change with `key`, not an effect. New AOP, listener or reflection flow needs approval. Any stack: a state-changing operation that can run twice (a retried request, a redelivered message, a rerun job, a run that stopped halfway) converges to the same end state. It reads the current state and applies only the difference, and whatever an interrupted run leaves (a lock, a claimed job, a half-written row) is recognizable as stale by the next run. A deduplication key comes from the intent (a client-supplied key, an immutable business id), never from the attempt (a fresh UUID, a timestamp); it is claimed in one atomic write (an insert under a unique constraint), not read and then written; a repeat with a different payload fails loudly; a timeout is an unknown outcome, recorded before the call, not a failure to retry blindly. *Check:* transaction or rollback behavior is hidden by names or unverified by tests, a state-changing operation has no answer to "what if it runs twice or stopped halfway", a deduplication read is followed by a separate write, a key is generated per attempt, an effect sets state computed from other state, or a disabled `react-hooks/exhaustive-deps`. *Exception:* patterns the codebase has already established.

### State and types
- [K5.10] **One meaning per variable.** `final`/`const` by default. Conditional values come from a `resolve…()` call, not repeated reassignment. Declare variables near their use. *Check:* a local assigned twice or more (accumulators excepted).
- [K5.11] **Types carry meaning.** FE: no new `any`, `as any`, `@ts-ignore` or `@ts-expect-error`; the API layer parses JSON once and returns typed data, and screens never call `JSON.parse`. BE: no entities past the controller (use DTOs); no `Map<String, Object>` hiding a shape, no `@SuppressWarnings("unchecked")`. *Check:* the diff adds any of these. *Exception:* untyped third-party boundaries, narrowed in one place.

### Failure
- [K5.12] **Never swallow errors.** Catch only where you can handle. An intentional ignore must be explicit in the handler name and pinned by a test of the resulting behavior; explain the decision in the reading guide. **Empty `catch {}` is banned.** Logs carry identifiers (orderId, userId, jobId…) and **the exception object**, not `e.getMessage()`. Classify errors by type, not message text. FE: never report a failure as success, and tell the user about failures they must know. *Check:* an empty or unexplained catch, a message-only log, message string matching, or a success value returned after a catch. *Exception:* none; a comment never justifies swallowing an error.
- [K5.13] **Validate at the boundary, trust inside.** External input (requests, uploads, external API responses, nullable columns) is validated and normalized once, where it enters. No repeated null checks inside, and no handling for impossible cases. *Check:* the same value checked twice on one path, or unvalidated external data reaching the inside. *Exception:* security code with layered trust boundaries.

### Comments and consistency
- [K5.14] **Remove code comments except mandatory notices and tool directives.** git-guard denies an Edit or Write that adds or rewrites any other line-start or trailing comment in a code file. Apply to production and test code in every language, including docstrings and API doc comments. Put meaning in names, types and structure; pin behavior with tests. A removed comment that explained a surprise in this codebase's own code leaves the surprise behind: the finding names the symbol to rename, extract or retype so the code says it. A comment that guards a constraint on this codebase's own code (`do not remove`, `ask X before changing`) is replaced by the cheapest check that enforces it (a type, a test or a lint rule), offered to the owner before the comment goes; a constraint nobody encodes is reported open in the reading guide, not kept as prose. Narration, history, commented-out code, banners, TODOs (even with a ticket), internal invariants and caller assumptions do not qualify: move tasks to the tracker, decisions to the reading guide, and change history, investigation and measurements to the commit body. Exceptions are exhaustive: (1) legally required notices, preserved verbatim; (2) directives consumed by a compiler, runtime, build, lint, type-check or documentation tool, only where needed for that tool to work, preserving required syntax and without bypassing another rule (a suppression still faces K5.9/K5.11); An external-system constraint that cannot be expressed in code goes to the reading guide with an accessible authoritative source or reproducible verification, and a regression test when executable; it is never a comment, and an assertion in an old comment is not verification. Read implementation, callers and tests before inferring behavior; comments are hypotheses, never evidence. A behavior bug requires a failing reproduction test, an executable root-cause fix and a passing test; changing or deleting explanatory prose cannot establish a fix. A tool-consumed directive is a behavior input: changing it requires a failing reproduction and passing verification of that tool behavior. Apply removal to new or changed comments. Clean pre-existing comments only when cleanup is requested or a comment must change with the behavior. Keep bulk cleanup separate and verify parser/tool semantics. *Check:* inspect new and changed comments, and identify the allowed exception and evidence for each retained comment; reject claims based only on comments or an explanatory-comment-only bug fix. Regex signals are partial hints, not proof that the file complies.
- [K5.15] **Same task, same pattern.** Follow the nearest existing pattern (same module and layer). A better pattern needs approval plus a migration plan; do not mix the two. *Check:* the diff re-implements a task that the same module already does differently. *Exception:* an approved migration to a new pattern.

### Tests
- [K5.16] **Tests read as a spec.** Name tests `subject_expectedBehavior_condition`. Separate setup, action and assertions with blank lines, one behavior per test; do not add given/when/then comments. Cover changed observable behavior and meaningful failure boundaries; reuse existing tests when they detect the regression. Do not add tests solely to meet a per-branch count. Assert observable behavior (return value, persisted state, emitted event), not internals. Derive each expected value from the requirement as a literal; never recompute it the way the code under test does, because that assertion passes by construction. *Check:* from the test names alone, can you say what the feature guarantees? Are relevant failure boundaries exercised and would a regression be detected? Would any assertion still pass if the computation were wrong?

### Change shape
- [K5] **Never mix structure and behavior.** Renames, extractions and moves go in their own commit (ideally their own PR), with the same test count and parity. *Check:* one commit contains both a behavior change and a rename or move.
- [K5] **Every non-trivial change ships a reading guide** in the PR description or report, written by the session that wrote the code while its context is fresh. A guide written afterwards by someone else counts as a non-author's: a reviewer who did not write it checks it against the code before it is trusted. A delegated coding agent returns the guide in its final report.

```
## Reading guide
Entry point : <Class.method (file:line)>
Flow        : a → b → c → save
Changed     : <what behaves differently, or "structure only, behavior identical">
Unchanged   : <invariants the reader can rely on>
Decisions   : <choice + why>
Rejected    : <alternative + why not>
Read first  : <the line(s) where money, transactions or contracts are decided>
```

## Human-understanding gate

A person owns the code AI writes; the depth of understanding required follows the ship-gate risk class.

[K5] Before presenting an approval command, follow the explanation contract in
[review-policy.md](../../../docs/review-policy.md#explain-before-requesting-approval):
explain the problem, concrete flow, reasons for the structure and decision order,
relevant tradeoffs, verification evidence and remaining risks in the owner's
language. Scale detail to the change; a reading guide or PASS alone is not the
explanation.

| Tier | Scope | The owner does |
|---|---|---|
| **High** (ship-gate `heavy`) | money, pricing, transaction boundaries, data consistency, schema changes, external contracts, permissions. Code merged behind an off flag keeps the tier of what it does when enabled | Before `keel approve <root_run_id>`, reads the High summary below and asks about any part that is unclear |
| **Normal** | other logic changes | Follows the reading guide's Entry point and Flow through the entry methods |
| **Trivial** | no branch logic, no module boundary crossed, compiler-checkable, reversible | Skims |

For High, the reading guide's `Read first` line is mandatory. Before the approval command, give the High summary: a plain summary in the owner's language that answers: *Where does this change, from and to? What changes the moment it is merged or deployed? What changes later (flags, follow-ups)? What must be watched or tested before it is switched on or relied on?* Include the reviewer's remaining risks. Do not ask the owner to write their own explanation. If the owner states a condition (e.g. "test before enabling"), record it as an open task.
