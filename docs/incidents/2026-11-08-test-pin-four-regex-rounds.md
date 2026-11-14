# 2026-11-08: a test pin took four rounds of wider regexes before it parsed the code

- Rule: C-descending-findings.
- Event: a low review finding on a test pin in a private overlay repo, which kept a hand-kept list in sync with the code, took four rounds of progressively wider regexes (annotated, unspaced, chained, commented declarations), each with a new bypass. Parsing the file with the `typescript` devDependency closed the class in two rounds, whose findings were about which declaration kinds count, not about spellings.
- Cost: six review rounds on one change, four of them spent on spellings.
- Why the rule: a recurring finding becomes a check that decides it structurally the first time a second spelling appears; this was the second occurrence of the lesson recorded the day before.
