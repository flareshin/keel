#!/bin/bash

suite_lock_dir="${KEEL_DATA_DIR:-$HOME/.claude}/state/keel/full-suite.lock"
suite_reclaim_dir="$suite_lock_dir.reclaim"

hold_suite_lock() {
  mkdir -p "$(dirname "$suite_lock_dir")" || return 1
  local announced="none"
  local refused
  until refused=$(LC_ALL=C mkdir "$suite_lock_dir" 2>&1); do
    if [[ "$refused" != *"File exists"* ]]; then
      echo "run-all: cannot create the full suite lock $suite_lock_dir: $refused" >&2
      return 1
    fi
    local holder
    holder=$(suite_lock_holder)
    if suite_lock_is_stale "$holder"; then
      reclaim_suite_lock "$holder"
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

suite_lock_holder() {
  cat "$suite_lock_dir/pid" 2>/dev/null || true
}

suite_lock_is_stale() {
  local holder="$1"
  if [ -n "$holder" ]; then
    ! kill -0 "$holder" 2>/dev/null
  else
    older_than_a_minute "$suite_lock_dir"
  fi
}

reclaim_suite_lock() {
  local judged="$1"
  if ! mkdir "$suite_reclaim_dir" 2>/dev/null; then
    if older_than_a_minute "$suite_reclaim_dir"; then rmdir "$suite_reclaim_dir" 2>/dev/null; fi
    sleep "${KEEL_SUITE_LOCK_POLL_SECONDS:-5}"
    return
  fi
  if [ "$(suite_lock_holder)" = "$judged" ] && suite_lock_is_stale "$judged"; then rm -rf "$suite_lock_dir"; fi
  rmdir "$suite_reclaim_dir"
}

older_than_a_minute() {
  [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]
}

release_suite_lock() {
  if [ "$(suite_lock_holder)" = "$$" ]; then rm -rf "$suite_lock_dir"; fi
}
