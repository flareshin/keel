#!/bin/bash

suite_lock_dir="${KEEL_DATA_DIR:-$HOME/.claude}/state/keel/full-suite.lock"

hold_suite_lock() {
  mkdir -p "$(dirname "$suite_lock_dir")"
  local announced=""
  until mkdir "$suite_lock_dir" 2>/dev/null; do
    local holder
    holder=$(cat "$suite_lock_dir/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      mv "$suite_lock_dir" "$suite_lock_dir.stale.$$" 2>/dev/null && rm -rf "$suite_lock_dir.stale.$$"
      continue
    fi
    if [ "$announced" != "$holder" ]; then
      echo "run-all: waiting for the full suite run by pid ${holder:-unknown} to finish ($suite_lock_dir)" >&2
      announced="$holder"
    fi
    sleep "${KEEL_SUITE_LOCK_POLL_SECONDS:-5}"
  done
  echo $$ > "$suite_lock_dir/pid"
  trap release_suite_lock EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
}

release_suite_lock() {
  if [ "$(cat "$suite_lock_dir/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$suite_lock_dir"; fi
}
