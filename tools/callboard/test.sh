#!/bin/bash
# Runs every callboard suite. Self-contained: nothing outside tools/callboard.
# CALLBOARD_SKIP_MOD_TESTS=1 skips only `claude plugin test mod`, and says so. CI sets it: those tests drive a fake clock
# through thousands of ticks and are timing-sensitive, so on its slower runner some hit the kit's fixed 5 s limit and one
# ('a declined nudge is not repeated within 30 minutes') is a timing race. Run this script without it, on your own
# machine, before any PR that touches tools/callboard/mod.
set -uo pipefail
cd "$(dirname "$0")"
rc=0
step() { echo "== $1"; shift; "$@" || rc=1; }
step "core logic" node --test mod/hooks/core.spec.ts
step "sender" node --test send/callboard-send.test.mjs
step "extension" node --test extension/lanes.test.js extension/spool.test.js extension/registry.test.js
step "mod validate" claude plugin validate mod
if [ "${CALLBOARD_SKIP_MOD_TESTS:-}" = 1 ]; then
  echo "== mod tests"
  echo "SKIPPED: CALLBOARD_SKIP_MOD_TESTS=1. Not run here; run this script without it before any mod PR."
else
  step "mod tests" claude plugin test mod
fi
step "extension link" bash test-link-extension.sh
exit "$rc"
