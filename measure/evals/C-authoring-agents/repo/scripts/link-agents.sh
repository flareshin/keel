#!/bin/sh
set -eu
mkdir -p "$HOME/.claude/agents"
for file in "$(dirname "$0")"/../agents/*.md; do
  ln -sf "$(cd "$(dirname "$file")" && pwd)/$(basename "$file")" "$HOME/.claude/agents/$(basename "$file")"
done
