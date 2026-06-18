#!/bin/bash
#
# SessionStart hook for Claude Code on the web.
#
# The remote container starts from a fresh clone with an empty node_modules,
# so `npm run check` / `npm test` fail until dependencies are installed and
# the package is built. This hook makes the workspace immediately usable.
# Local checkouts manage their own toolchain, so it is a no-op off the remote
# environment.
#
# Synchronous (no async marker): the session waits for this to finish, which
# guarantees deps are ready before the agent runs anything. Cached after first
# success, so subsequent sessions are fast.
set -euo pipefail

# Only run in the remote (Claude Code on the web) environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install dependencies. `install` (not `ci`) so the warm container cache is
# reused on later runs and the step stays idempotent.
npm install

# Single package: one `tsc` build emits dist/{shared,audit,remediate}/...
npm run build
