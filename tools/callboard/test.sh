#!/bin/bash
# Runs every callboard suite. Self-contained: nothing outside tools/callboard.
# CALLBOARD_SKIP_MOD_TESTS=1 skips only `claude plugin test mod` (the slow part: about 2 minutes), and says so. It is for a quick
# local run; CI does not set it. Run this script without it before any PR that touches tools/callboard/mod.
set -uo pipefail
cd "$(dirname "$0")"
rc=0
step() { echo "== $1"; shift; "$@" || rc=1; }
step "core logic" node --test mod/hooks/*.spec.ts
step "sender" node --test send/callboard-send.test.mjs
step "prompt audit" node --test prompt-audit.test.mjs
step "extension" node --test extension/*.test.js
step "mod validate" claude plugin validate mod
if [ "${CALLBOARD_SKIP_MOD_TESTS:-}" = 1 ]; then
  echo "== mod tests"
  echo "SKIPPED: CALLBOARD_SKIP_MOD_TESTS=1. Not run here; run this script without it before any mod PR."
else
  step "mod tests" claude plugin test mod
fi
step "extension link" bash test-link-extension.sh
exit "$rc"
