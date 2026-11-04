#!/bin/sh
set -eu
claude -p "$(cat "$1")"
