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
      reclaim_suite_lock "$holder" || return 1
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
    older_than_the_grace "$suite_lock_dir"
  fi
}

reclaim_suite_lock() {
  local judged="$1"
  if ! mkdir "$suite_reclaim_dir" 2>/dev/null; then
    if older_than_the_grace "$suite_reclaim_dir"; then
      echo "run-all: a reclaim of the full suite lock stopped halfway; remove $suite_reclaim_dir and $suite_lock_dir if no full suite is running" >&2
      return 1
    fi
    sleep "${KEEL_SUITE_LOCK_POLL_SECONDS:-5}"
    return 0
  fi
  local removal_failure=""
  if [ "$(suite_lock_holder)" = "$judged" ] && suite_lock_is_stale "$judged"; then
    removal_failure=$(LC_ALL=C rm -rf "$suite_lock_dir" 2>&1) || removal_failure="${removal_failure:-rm failed}"
  fi
  rmdir "$suite_reclaim_dir"
  if [ -n "$removal_failure" ]; then
    echo "run-all: cannot remove the stale full suite lock $suite_lock_dir: $removal_failure" >&2
    return 1
  fi
}

older_than_the_grace() {
  node -e 'const fs = require("node:fs"); process.exit(Date.now() - fs.statSync(process.argv[1]).mtimeMs > 60_000 ? 0 : 1)' "$1" 2>/dev/null
}

release_suite_lock() {
  stop_the_suite
  if [ "$(suite_lock_holder)" = "$$" ]; then rm -rf "$suite_lock_dir"; fi
}

suite_pid=""

run_within_the_suite_limit() {
  local limit="${KEEL_SUITE_TIMEOUT_SECONDS:-1800}"
  case "$limit" in
    "" | *[!0-9]* | 0?*)
      echo "run-all: KEEL_SUITE_TIMEOUT_SECONDS must be whole seconds without leading zeros, got '$limit'" >&2
      return 2
      ;;
  esac
  local deadline=$((SECONDS + limit))
  "$@" &
  suite_pid=$!
  while kill -0 "$suite_pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      save_the_suite_stacks "$limit"
      stop_the_suite
      return 124
    fi
    sleep 1
  done
  local status=0
  wait "$suite_pid" || status=$?
  suite_pid=""
  return "$status"
}

suite_tree() {
  echo "$1"
  local child
  for child in $(pgrep -P "$1"); do suite_tree "$child"; done
}

save_the_suite_stacks() {
  local limit="$1"
  local saved_to
  saved_to="${KEEL_DATA_DIR:-$HOME/.claude}/state/keel/suite-hangs/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$saved_to" || true
  local pids
  pids=$(suite_tree "$suite_pid")
  ps -o pid=,ppid=,etime=,command= -p "$(echo $pids | tr ' ' ',')" > "$saved_to/processes.txt" 2>&1 || true
  local samplers="" pid
  for pid in $pids; do
    sample "$pid" 1 -file "$saved_to/$pid.txt" > /dev/null 2>&1 &
    samplers="$samplers $!"
  done
  for pid in $samplers; do wait "$pid" || true; done
  local total=0 saved=0
  for pid in $pids; do
    total=$((total + 1))
    if [ -s "$saved_to/$pid.txt" ]; then saved=$((saved + 1)); fi
  done
  echo "run-all: the full suite ran past $limit seconds; saved $saved of $total process stacks to $saved_to and stopped it" >&2
}

stop_the_suite() {
  [ -n "$suite_pid" ] || return 0
  local frozen="" found
  found=$(suite_tree "$suite_pid")
  while [ "$found" != "$frozen" ]; do
    frozen="$found"
    kill -STOP $frozen 2>/dev/null || true
    found=$(suite_tree "$suite_pid")
  done
  kill -KILL $frozen 2>/dev/null || true
  suite_pid=""
}
