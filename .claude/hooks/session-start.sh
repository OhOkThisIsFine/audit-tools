#!/bin/bash
#
# SessionStart hook for Claude Code on the web.
#
# The remote container starts from a fresh clone with an empty node_modules,
# so `npm run check` / `npm test` fail until dependencies are installed and
# @audit-tools/shared is built. This hook makes the workspace immediately
# usable. Local checkouts manage their own toolchain, so it is a no-op off the
# remote environment.
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

# Install + symlink all three workspaces. `install` (not `ci`) so the warm
# container cache is reused on later runs and the step stays idempotent.
npm install

# @audit-tools/shared is the foundation both orchestrators compile and import
# against (their `tsc -p` resolves types from shared/dist). Root `npm run build`
# runs `tsc` per workspace but does NOT topologically sort, so build shared
# first and then the rest — exactly what CI does on a clean tree.
npm run build -w @audit-tools/shared
npm run build
