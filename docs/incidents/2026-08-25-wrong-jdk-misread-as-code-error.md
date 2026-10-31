# 2026-08-25: wrong-JDK compile failures misread as code errors

- Rule: S-jdk.
- Event: a harness audit of Spring/Maven sessions found two real `TypeTag`/Lombok compile failures from building on a newer default JDK than the repo requires, and a 4-in-24 baseline rate of sessions misdiagnosing that failure as a code error.
- Cost: debugging time spent on code that was correct; the fix was the JDK, not the source.
- Why the rule: the JDK the repo requires is known before the build runs, so the check belongs before `mvn`.
