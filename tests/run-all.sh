#!/bin/bash
set -e
cd "$(dirname "$0")/.."
source tests/suite-lock.sh
hold_suite_lock
status=0
node --test --test-reporter=tap 'tests/**/*.test.ts' 'codex/tests/*.test.ts' || status=1
node --test 'tests/workflows/*.test.mjs' || status=1
exit $status
