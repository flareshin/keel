#!/bin/bash
set -e
cd "$(dirname "$0")/.."
status=0
for d in tests/*/; do
  ls "$d"test_*.py >/dev/null 2>&1 || continue
  python3 -m unittest discover -s "$d" -t "$d" -v || status=1
done
node --test --test-reporter=tap 'tests/**/*.test.ts' 'codex/tests/*.test.ts' || status=1
node --test 'tests/workflows/*.test.mjs' || status=1
exit $status
