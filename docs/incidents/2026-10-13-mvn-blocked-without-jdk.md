# 2026-10-13: a Maven build started without the required JDK

- Rule: S-jdk.
- Event: at 18:25:42Z env-preflight denied an `mvn` call in a Spring/Maven backend ("mvn without JDK 17"); the agent pinned the JDK and the rerun passed 3 seconds later. 33 such denies were logged in 2026-10-13..30.
- Cost if unblocked: the same misleading compile failure as 2026-08-25.
- Why the rule: the deny names the fix, so the cost is one retry instead of a misdiagnosis.
