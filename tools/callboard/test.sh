#!/bin/bash
# Runs every callboard suite. Self-contained: nothing outside tools/callboard.
set -uo pipefail
cd "$(dirname "$0")"
rc=0
step() { echo "== $1"; shift; "$@" || rc=1; }
step "core logic" node --test mod/hooks/core.spec.ts
step "sender" node --test send/callboard-send.test.mjs
step "extension" node --test extension/lanes.test.js extension/spool.test.js extension/registry.test.js
step "mod validate" claude plugin validate mod
step "mod tests" claude plugin test mod
step "extension link" bash test-link-extension.sh
exit "$rc"
