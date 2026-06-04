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
- **New default-on orchestrator behavior breaks existing fixtures.** Turning the
  dispatch canary on by default (audit-code FINDING-008) changed `prepare-dispatch`
  first-contact output and broke end-to-end fixtures that assumed a single-round,
  all-packets dispatch; the fix was seeding `dispatch.canary:false` in the test
  helper. Any new default-on behavior needs a sweep of existing fixtures (or should
  ship default-off until they catch up).
- **audit-code `node --test` needs the tsx loader.** Bare
  `node --test packages/audit-code/tests/*.test.mjs` fails with
  `ERR_MODULE_NOT_FOUND` (the `.mjs` tests import built `.ts` via `.js` specifiers).
  Use the canonical `node --import tsx/esm --test …` (as in the package's `test`
  script). A trap when running one test file by hand or telling a subagent to "run
  node --test".
- **The `Bash` and `PowerShell` tools share one working directory.** A `cd` inside
  a `Bash` call changes the directory the next `PowerShell` call runs in, so a later
  `npm run check -w packages/<pkg>` fails with *No workspaces found* (the path
  doubles). Use a subshell `(cd … && …)` in Bash, or pass absolute paths and
  `Set-Location` the repo root explicitly, rather than relying on per-tool CWD.

## Deferred fixes (product bugs)

### remediate-code host-dispatch gaps (surfaced by the 2026-06-03 MCP-removal dogfood run)

- **F016 (provider `queryLimits`) deferred — near-zero value.** The canonical dispatch
  call site already treats an absent method and a `null` return identically
  (`await provider.queryLimits?.(…).catch(() => null) ?? null`), so the null-returning
  stubs change nothing at runtime; the only durable value would be the `types.ts`
  JSDoc contract. Revisit only if a provider gains a real proactive rate-limit endpoint
  (ties into "Adaptive, multi-agent quota-aware dispatch" below).

## Features to add later

- **User-selected lenses.** Let the operator choose which audit lenses run instead
  of always running the full set.
- **Adaptive, multi-agent quota-aware dispatch.** Detect quota per model+provider,
  adapt dispatch on the fly, and eventually dispatch to multiple CLI agents
  simultaneously under different constraints (a heterogeneous fleet). Today's wave
  scheduler is effectively single-provider.
