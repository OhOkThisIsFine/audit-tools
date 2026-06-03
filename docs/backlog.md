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

- **Conversation hosts default to serial single-item dispatch (effective
  `wave_size` = 1).** `resolveHostDispatchCapability` returns false unless a
  provider is explicitly configured, so `/remediate-code` (and the analogous
  audit-code path) document/implement one item per `next-step` instead of parallel
  waves. A Claude Code conversation *can* dispatch subagents but isn't
  auto-detected; today it needs a manual
  `.remediation-artifacts/session-config.json` (`host_can_dispatch_subagents: true`,
  plus `quota.host_active_subagent_limit` for wave width). Fix: auto-detect host
  dispatch capability (a needed manual flag is a bug signal) — sibling to the
  audit-code `wave_size` issue.
- **Implement blocks can't create new files or span block boundaries.** A block's
  `access.write_paths` lists only the *existing* source files a finding touches —
  not the *new* files a fix must create (extracted modules, new test files). So
  every "extract into a new module" or "add a new test file" finding blocks in the
  sandbox unless the host relaxes access. Separately, a finding whose fix spans
  files owned by *different* blocks (e.g. breaking the `OrchestratorOptions` import
  cycle, which touches all six remediate-code phase files split across blocks)
  cannot be completed by any single block. Fix: include spec-named new files
  (same package) in `write_paths`, and group findings whose fix-set spans blocks
  into one block.
- **File-integrity check treats the run's own implement edits as a stale plan.**
  After the implement phase modifies source files, the integrity check
  (affected-file hashes vs `hash_at_plan_time`) fires on those very edits and
  forces `next-step --force-replan` before it will triage/retry any remaining
  blocked findings. With blocked findings present this risks a
  replan → retry → re-block → integrity-fail loop, and a replan rebuilds work from
  the audit findings (which don't know about already-applied fixes). Fix: exclude
  files the run itself modified during implement (or re-snapshot hashes
  post-implement) so a run with applied fixes plus a few deferred findings can
  reach `closing` without a destabilizing replan.
- **Implement worker-result schema rejects `resolved_no_change`.** The
  `worker_result.schema.json` implement variant enums `status` to
  `["resolved","blocked"]`, but `resolved_no_change` is a valid state-machine
  terminal status and the natural status for a verified-no-op finding — agents
  emit it and `merge-implement-results` would reject it. Fix: add
  `resolved_no_change` (and the other terminal statuses) to the worker-result
  status enum.
- **Plan phase hard-crashes on a single malformed finding.** One finding with
  empty `evidence` makes `runPlanPhase` throw
  (`remediation_plan.findings[N].evidence: Expected a non-empty array`) and aborts
  the whole run — even though findings are advisory. A pre-existing
  `audit-findings.json` carrying one such finding can't be remediated at all. Fix:
  skip-and-warn on malformed/empty-evidence findings (or coerce) instead of
  throwing, so one bad finding doesn't block the entire report.
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
