# Backlog — known friction, deferred fixes & future features

A living log of things to fix or build later, so they aren't lost between sessions.
**Remove an entry once it ships** — this is a to-do list, not a status log (same
anti-rot rule as CLAUDE.md's *"docs capture durable concepts, not current state"*).

## Known friction (agent / dev experience)

- **Backslash escaping / arg serialization.** Inline `node -e "…\\…"` (regexes,
  Windows paths) gets mangled by shell backslash handling — write a small script
  file instead of inlining. Separately, the Workflow tool's `args` can arrive as a
  JSON *string* rather than a parsed object, so `args.foo` is `undefined`; defend
  with `const a = typeof args === 'string' ? JSON.parse(args) : args`.
- **`opentoken wrap` mangles orchestrator step JSON.** Running `remediate-code` /
  `audit-code next-step` through `opentoken wrap` compresses the step-contract JSON
  into an ambiguous, self-referential token dictionary. Read the rendered prompt
  file (`.remediation-artifacts/steps/current-prompt.md`) directly instead of
  parsing the wrapped stdout. Fix: exempt orchestrator prompt reads from wrapping.
- **Fresh git worktrees lack `node_modules`.** A newly created worktree resolves
  `@audit-tools/shared` against a stale `dist/` → spurious "no exported member"
  type errors. Run `npm install` in the worktree before `npm run check`.

## Deferred fixes (product bugs)

- **Implement findings whose fix spans multiple blocks.** A block's
  `access.write_paths` now permits spec-named new files in the same package
  (shipped in remediate-code@0.6.0), but a finding whose fix-set spans files owned
  by *different* blocks (e.g. an import cycle touching files split across blocks)
  still can't be completed by any single block. Fix: group findings whose fix-set
  spans blocks into one block.
- **Add a friction-logging instruction to CLAUDE.md.** A standing instruction
  telling agents to record any friction they hit — even something small, like
  reaching for `grep` in a non-greppable environment — into this doc so it can be
  fixed later. Not designed yet; placeholder for later implementation.

## Features to add later

- **User-selected lenses.** Let the operator choose which audit lenses run instead
  of always running the full set.
- **Choice of design-review depth levels.** Configurable depth/effort for the
  design-review pass.
- **Adaptive, multi-agent quota-aware dispatch.** Detect quota per model+provider,
  adapt dispatch on the fly, and eventually dispatch to multiple CLI agents
  simultaneously under different constraints (a heterogeneous fleet). Today's wave
  scheduler is effectively single-provider.
