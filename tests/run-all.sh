#!/bin/bash
set -e
cd "$(dirname "$0")/.."
source tests/suite-lock.sh
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-${KEEL_DATA_DIR:-$HOME/.claude}/state/keel/node-compile-cache}"
hold_suite_lock
run_the_suites() {
  local status=0
  node --test --test-reporter=tap 'tests/**/*.test.ts' 'codex/tests/*.test.ts' || status=1
  node --test 'tests/workflows/*.test.mjs' || status=1
  return $status
}
run_within_the_suite_limit run_the_suites
