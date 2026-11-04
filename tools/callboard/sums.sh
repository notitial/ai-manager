#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
files() { find mod/.claude-plugin mod/hooks mod/types extension send -type f ! -name '*.test.*' ! -name '*.spec.*' ! -path 'mod/.claude-plugin/types/*' | LC_ALL=C sort; }
case "${1:-}" in
  --write) files | xargs shasum -a 256 > SHA256SUMS ;;
  --check) files | xargs shasum -a 256 | diff -u SHA256SUMS - ;;
  *) echo "usage: sums.sh --write|--check" >&2; exit 2 ;;
esac
