# 2026-11-07: nine review rounds each found a new shell spelling of one git-guard hole

- Rule: C-descending-findings.
- Event: on a git-guard branch about commit messages and PR bodies, every one of 9 review rounds from 2026-11-06 to 2026-11-07 found one more spelling (quoting, continuation, option cluster, abbreviation) of a gap already fixed once. The owner asked to cut the waste, and `b4c5b5e` replaced the per-spelling decoders with one closed-set rule that denies any message given other than as plain words or a plain file path.
- Cost: about 20 minutes of review, 230k+ tokens and an 18-minute precheck per round.
- Why the rule: a finding a machine can decide that keeps coming back moves to a check that decides the whole class, instead of another review round finding the next instance.
