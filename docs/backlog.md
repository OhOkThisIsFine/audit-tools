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

## Deferred fixes (product bugs)

- **Extraction can silently drop findings — no coverage accounting.** The
  `extract_findings` step (and the host driving it) can consolidate a large
  source finding set into far fewer remediation items and drop the remainder
  with no record. On the self-audit run, 391 audit findings became 15
  remediation items; all 15 were resolved, but the tail of medium/low findings
  was neither fixed nor explicitly deferred. The default expectation is to
  address *all* findings unless the user says otherwise. Fix: the extraction
  step should either carry every distinct finding through (dedup, don't drop),
  or emit an explicit coverage ledger marking each source finding as
  planned / folded-into-a-bulk-item / deferred-with-rationale — so dropped
  findings are auditable rather than silent.
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

### remediate-code host-dispatch gaps (surfaced by the 2026-06-03 MCP-removal dogfood run)

- **Preview "skip Tier 3 finding" is documented but not wired.** The
  `preview_implement` prompt invites the user to *"name the IDs to exclude (they will
  be marked `deemed_inappropriate`)"*, but the ack consumer in `src/steps/nextStep.ts`
  only checks that `impl_preview_acknowledged.json` *exists* — it never parses a skip
  list. To actually skip a finding the host has to hand-edit `state.json` and set the
  item's `status` to `deemed_inappropriate`. Worse, the skipped finding still renders
  in its block's implement prompt (`buildImplementDispatchItem` includes every block
  item regardless of status), and `mergeImplementResults` sets status from the
  worker's `item_results` — so a worker that reports the skipped finding `resolved`
  silently *un-skips* it. (Hit on FINDING-016 this run; had to mark state by hand and
  instruct the worker to omit it from its result.) Fix: parse a skip-ID list from the
  ack, exclude those findings from `buildImplementDispatchItem`, and make merge refuse
  to resurrect a `deemed_inappropriate` item.
- **Block `dependencies` are not enforced during host-dispatch implement.**
  `prepareImplementDispatch` emits every block with documented work regardless of its
  `dependencies`, and `mergeImplementResults` marks any planned block with no result
  file as `blocked`. So when worktrees aren't used (next entry) and workers edit the
  main tree, the *host* must manually serialize blocks that share a file (e.g. the
  several blocks all editing `CLAUDE.md` / `shared/src/types/sessionConfig.ts`) across
  separate waves+merges, or parallel workers clobber each other. The dependency DAG is
  computed but nothing acts on it in this path. Fix: honor block `dependencies` when
  selecting the dispatch wave, and don't pre-mark un-dispatched blocks `blocked`.
- **Worktree isolation is half-wired in host-dispatch mode.** The implement plan
  assigns a `worktree_path` per block, but the worker prompts use repo-root-relative
  paths with no instruction to edit the worktree, so host-dispatched workers edit the
  MAIN tree and `mergeWorktree` then no-ops on the empty branches — worktrees are
  created but never used. They also collide: `git worktree add` fails when the
  `remediate-<block>` branch already exists, and stale test-fixture worktrees under
  `packages/remediate-code/tests/.test-dispatch-*/…/worktrees/` held `remediate-B-001`
  / `-B-002`, forcing the shared-repo fallback. Fix: either make host-dispatch workers
  edit (and really merge) their worktree, or stop creating worktrees in this mode; and
  namespace/clean branch names so fixtures can't collide with a live run.
- **`--input` against a non-empty `.remediation-artifacts/` silently resumes the old
  run.** The input is read only during intake/planning; if a run already exists past
  `pending`, a new `--input` is ignored and the OLD plan resumes with no warning (this
  session surfaced a 3-day-old plan instead of the new brief; the workaround was to
  stash the artifacts dir). Fix: when `--input` is given but state is past intake, warn
  loudly and/or require an explicit new-vs-resume choice.
- **Block access is derived from the pre-document `affected_files`, so it goes stale
  when the document phase corrects the file set.** FINDING-015's document worker
  correctly moved the change into `packages/shared/src/providers/` + `providerFactory.ts`,
  but the block's `access.write_paths` were frozen from the original finding's
  `affected_files` (`audit-code/src/providers/…`), so the files actually needed weren't
  in the declared write set; it only worked because that block ran alone and merge
  doesn't validate access. (Compounds the "fix spans multiple blocks" entry above.)
  Fix: recompute block access from the documented `item_spec`, not the pre-document
  finding.
- **Tests that assert a removed surface aren't pulled into the removing block →
  orphaned breakage needing a central mop-up.** Deleting the claude-desktop host
  descriptor (FINDING-006, `audit-code-wrapper-lib.mjs`) broke
  `tests/host-bootstrap-descriptors.test.mjs`, but that file was in no block's access,
  so no worker fixed it — it needed a separate central pass (11 failing tests). Fix:
  pull test files that reference a finding's touched/removed symbols into that block's
  access (derive via a grep of the symbols), or add a "reconcile tests for removed
  surfaces" closing step.
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
