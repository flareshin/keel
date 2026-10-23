---
name: descend
description: Moving a recurring review finding down to the strongest layer that can decide it (a type, lint rule, architecture test or CI test in the target repo). Trigger; "descend this rule", "make this a lint rule", "this finding keeps coming back", the owner correcting the same agent mistake twice, the monthly descend pick after a review cycle, a ledger row whose why_not_stronger no longer holds. Do NOT use for a one-off finding (fix it in place), a rule that needs judgment (it stays a skill or lens), or editing keel's own hooks.
---

# Descend

The enforcement ladder is `repo` > `hook` > `skill` > `prose`. A finding reviewers keep raising by hand costs review time on every diff; once a machine can decide it, it belongs in the target repo, where CI enforces it for every author, human or AI. This skill is the procedure; it leaves the target repo with a red-then-green rule and the ledger with a `layer=repo` row.

## How it works

1. **Pick the finding from review history.** Collect the last 30–60 days of findings for one repo:
   - reviewer reports (`/lens-review` final reports in subagent transcripts under `$KEEL_DATA_DIR/projects/`), grep for the lens or rule id;
   - `rule-checks.ts` signals the rule-checks lens confirmed;
   - PR review comments (`gh pr view <n> --comments`);
   - `keel-fires.jsonl` deny lines for hook rules;
   - owner corrections in session transcripts: the same mistake corrected twice is a finding even when no reviewer raised it.

   Count by finding kind and pick the most frequent one that passes all three tests:
   - **recurring:** at least 2 independent occurrences (the rule of two); each becomes an `incidents` ref;
   - **decidable:** a regex, AST match, import graph or test can say yes or no with no judgment, and a false positive has a clean fix;
   - **owned:** one target repo (or one stack) owns the code it governs.

   One or two descents a month is the pace; pick, finish, then pick again.

2. **Choose the repo form**, using tooling the target repo already has (a new dependency needs the user's approval first). Take the first row that fits:

   | Form | Fits | Example |
   |---|---|---|
   | Remove the wrong way | the mistake exists because a second way to do the task is still reachable | delete the old helper the next author would copy; narrow an internal module's visibility; replace a hand-synced list with one source of truth. Each ships with a guard a fixture can make fail: a `no-restricted-imports` entry or CI test on the removed symbol, a compile check that a fixture import outside the module fails, a CI test that fails when a second hand-maintained copy reappears. That guard is the rule path for steps 3 and 6 |
   | Make it unrepresentable | a type or data structure can make the wrong state impossible to write | an enum instead of a status string, a value type whose constructor validates, a required constructor argument instead of a nullable setter |
   | Lint rule | a syntax pattern in one file | ESLint `no-restricted-syntax` / `no-restricted-imports`, Checkstyle or PMD rule, ruff rule selection |
   | Architecture test | a dependency or layering rule across files | an ArchUnit test (`noClasses().that().resideInAPackage("..web..").should().dependOnClassesThat().resideInAPackage("..persistence..")`) |
   | CI test | anything else a test can decide | a test in the repo's suite that scans `git ls-files` output for the forbidden pattern, with an allowlist file |

   When the author of the rule writes its failure message (a lint rule, an architecture test, a CI test, a deprecation annotation), the message names the file, type or function to use instead, so an author who never read the rule can fix the violation from the message alone. A compiler visibility or missing-symbol error cannot carry that message; the module's public entry point names the replacement instead.

3. **Red first.** Before the rule is green, reproduce the original finding:
   - add a fixture (or point the rule at the commit that held the finding) and run it: it fails and names the violation;
   - quote that failing output; it is the proof the rule catches the real case.

4. **Then green.** Existing violations are either fixed in a separate commit (structure and behavior never mix) or frozen in an explicit allowlist that the test only lets shrink. Every allowlist entry carries a reason, an expiry date and the repo owner's approval; the test fails on an entry past its expiry. Run the repo's test command through `keel test -- <cmd>` and quote the runner summary.

5. **Ship it through the repo's normal flow**: a separate reviewer, ship-gate, the user's approval. The rule counts only once it is on the repo's base branch.

6. **Update the ledger row.** In the ledger that owns the scope (keel `ledger.tsv` for core or stack rules, the overlay `ledger.tsv` for private repos):
   - `layer=repo`, `enforced_at=repo:<owner/repo>:<path of the rule or test>`;
   - `metric=exists:<local repo path>:origin/<base>:<path>`;
   - `why_not_stronger=-` (repo is the top of the ladder);
   - `incidents` keeps the refs from step 1; `review_by` = today + 60 days.

   A K5.n sub-check of `/readable-code` is not a ledger row: descending it for one repo adds a new row for that repo; the K5.n text stays, because it still serves every other repo. Format example: `examples/skills/descended-row.tsv`.

7. **Retire keel's text for it.** Delete the rule's text wherever keel stated it only for that repo (a lens line, a skill bullet, a `PERSONAL.md` line, a hook branch). Text that also serves other repos stays. Then run `measure/smoke` and `measure/run <id>` and quote both results.

## Rules

- [K3] The repo rule is written red first: a quoted failing run on the reproduced finding, then a quoted green run.
- [K2] "Descended" is claimed only with evidence: the rule's path on `origin/<base>` (`git show origin/<base>:<path>` succeeds), the CI or `keel test` summary, and the `measure/run <id>` output.
- [K1] The repo rule ships through a separate reviewer like any other diff; the author of the rule does not approve it.
- [K5] Descend one finding per diff; the rule, its fixture and any allowlist are the whole change.

## Output

Report to the user:

```
Descended : <finding> → <form> at <owner/repo>:<path>
Red       : <quoted failing line on the reproduced finding>
Green     : <runner summary> (exit 0)
Ledger    : <id> layer=repo enforced_at=<…> metric=<…>
Retired   : <keel paths whose text was deleted, or "none: still serves <scopes>">
Smoke     : <measure/smoke ok/count line>
```

## Troubleshooting

- **The rule fires on many legacy lines.** Freeze them in an allowlist that may only shrink, each entry with its reason, expiry and owner approval; do not weaken the pattern to pass.
- **No form fits without judgment.** The finding is not decidable: leave it at the skill or lens layer and record why in `why_not_stronger`.
- **`measure/run <id>` FAILs after the change.** The existence check reads `origin/<base>`: fetch, and confirm the rule's commit is merged (`git branch -r --contains <sha>`).
