# Multi-IDE concurrent runs — design of record

Everything-agnostic. Target: N IDEs / hosts driving **independent** audit AND remediate runs against
ONE repo simultaneously, without corruption. Not just atomic + resumable — *isolated*.

Supersedes the single-writer state model. Design record for the backlog forward track
"Multi-IDE concurrent runs" (Ethan, 2026-07-02) and the durable trap
[[concurrent-nextstep-staleness-cascade-wipe]].

## The problem, precisely

Two concurrency semantics are conflated today:

- **(A) Concurrent independent runs** — IDE-1 audits the repo while IDE-2 runs a *different* audit
  (different scope/lens), or two independent remediations proceed at once. They must NOT share
  findings / bundle / state. **This is the gap.**
- **(B) Concurrent workers within one run** — already solved (rolling dispatch, `node-claims.json`,
  per-node worktrees, `rolling-session.lock`, `base-branch.lock`).

Today's locks give **serialization onto shared state**, not **isolation**. Consequences:

| Layer | Today | Under two independent runs |
|---|---|---|
| audit `.audit-tools/audit/` bundle | single shared tree, no invocation-level run id (a "run" = a worker task) | two audits silently **merge into one bundle** — `artifact-tree.lock` just orders the corruption |
| remediate `state.json` | singleton, one `plan_id` | second run's `plan_id` **overwrites** the first |
| `steps/current-step.json` (both) | single slot, **no lock** | last-writer-wins → host reads the *other* run's step; step/state desync |
| audit `artifact_metadata.json` | per-file, per-repo | shared staleness → run B's edits fire staleness on run A |

Recon detail: `docs/reviews/` is not needed — the map lives in this doc's *Current layout* section
below, sourced from the 2026-07-02 recon (paths + lines cited inline).

## Core move: an invocation-level run identity, and namespace the whole mutable tree under it

Introduce an explicit **session/run id at the orchestrator-invocation level** for BOTH orchestrators
(audit has none today) and move the ENTIRE mutable state tree under `runs/<runId>/`. Locks become
**per-run** (different runs touch different subtrees → no contention → true parallelism, not
serialization). A small cross-run **registry** with its own lock handles only register/resolve/retire.

### Target on-disk layout

```
.audit-tools/
  audit/
    registry.json                 # index of runs (own lock: registry.lock)
    runs/
      <auditRunId>/
        audit_state.json
        artifact_metadata.json
        <all bundle artifacts: repo_manifest.json … audit-findings.json>
        run-ledger.json
        worker-runs/<taskRunId>/…  # the former runs/<ISO>_… worker dirs, re-parented
        steps/current-step.json + current-prompt.md
        artifact-tree.lock         # per-run, replaces the global one
    audit-report.md               # promoted "latest completed" render (repo-canonical)
    audit-findings.json           # promoted "latest completed" contract (repo-canonical)
  remediation/
    registry.json                 # own lock: registry.lock
    runs/
      <remRunId>/
        state.json                # was singleton — now per-run
        state.lock
        steps/current-step.json + current-prompt.md
        implement/…               # rolling-session.json/.lock, node-claims.json, dispatch-*.json
    remediation-report.md         # promoted latest render
    remediation-outcomes.json     # promoted latest contract
  worktrees/…                     # already per-run named (remediate-<blockId>-<runId>)
```

Deliverables (`audit-report.md` / `audit-findings.json` / remediation pair) stay at the canonical
`.audit-tools/` spot as the **latest-completed promotion** (force-tracked per
[[gitignore-deliverable-tracking]]); the per-run copy is retained under `runs/<runId>/`. On completion a
run promotes its pair to canonical (last-writer-wins is correct here — the human wants "the most recent
finished audit"), and the registry records which runId the canonical copy came from. A remediate run
consuming audit output resolves a **specific** audit runId (or the canonical latest) — never an
ambiguous shared file mid-flight.

## Run resolution — conversation-first, NO manual `--run-id` for the single-IDE case

"A needed manual flag is a bug signal" ([[enforce-robustness-in-tooling-not-host-discretion]]). The run
id must round-trip through the host, but **as an opaque token the tool emits and the workflow threads
back automatically** — a session cookie, not a human-typed flag. Mechanics:

1. **First next-step, no `--run-id`, no active run** → tool **mints** a runId, creates `runs/<id>/`,
   registers it, and emits `run_id` in the step contract (`current-step.json`).
2. **Subsequent next-steps** → the slash workflow (SKILL.md / wrapper) passes the emitted `--run-id`
   back **automatically** from conversation context — invisible to Ethan, exactly like today's
   resume-the-one-existing-run. This is mechanical continuity threaded by the wrapper, not host
   discretion or human memory.
3. **No `--run-id`, exactly ONE active run in registry** → resume it. Preserves today's zero-flag
   single-IDE ergonomics *exactly*.
4. **No `--run-id`, MULTIPLE existing runs** → tool **stops and surfaces the run manifest describing
   WHAT each run is working on** (runId, orchestrator, the scope/coverage it claims, its current
   obligation/phase) and asks the host/user to resume one or start a new run against the uncovered
   scope — the same "contextualize, don't guess" disambiguation pattern already shipped for remediate
   intake discovery ([[guidance-discovery-contextualizes]], `intakeResolver.ts` `allExisting` manifest).
   The point is not *who* is running each — it's *what is already claimed vs. free*.
5. **Explicit `--run-id`** → that run (errors clearly if retired/unknown).

The registry is the single source for "what runs exist and what each covers"; run resolution is a
deterministic function of (supplied run-id, registry contents) — enforced in the tool, no host
reasoning.

### Registry shape (both orchestrators, mirrored)

Tracks **work, not identity** — no host/IDE label (Ethan, 2026-07-02: "we don't care who's doing what —
we care what's already being worked on and what isn't"). No heartbeat/TTL either (Ethan: "TTL is not a
strong signal; changes to the codebase / git repo are stronger"). A run's *freshness relative to the
current tree* is judged by the **existing staleness / dependency-DAG machinery** against the run's own
artifacts (`artifact_metadata.json` hashes, git HEAD), never wall-clock.

```jsonc
// .audit-tools/{audit,remediation}/registry.json
{
  "runs": {
    "<runId>": {
      "orchestrator": "audit" | "remediate",
      "started_at": "<ISO>",
      "status": "active" | "complete",
      "coverage": "<what this run claims: audit scope/lens set, or remediate plan source + finding ids>"
    }
  }
}
```

Registry writes go through `withFileLock(registryLockPath())` — a *tiny* critical section
(register / update-coverage / retire), never held across an advance. `coverage` is what the manifest
shows so a new run can pick uncovered work. There is no time-based `abandoned` state: a run entry
persists until explicitly retired; whether its results are *stale* against the current codebase is a
staleness question answered by the DAG at resume, not a liveness question answered by a clock. Runs and
their worktrees/results are **never auto-pruned** (preserve-worktrees precedent,
`spec/dispatch-token-budget-gate.md`); an explicit `retire-run <id>` affordance handles cleanup.

## Locking after the move

- **Per-run `artifact-tree.lock` / `state.lock`** — unchanged mechanism (`src/shared/quota/fileLock.ts`,
  `withFileLock`, PID-token steal, 30s stale, 50→500ms backoff), just re-pathed under `runs/<runId>/`.
  Two runs never contend → real parallelism.
- **`steps/` gets covered by the per-run artifact/state lock** (it now lives inside `runs/<runId>/` and
  is written inside the same advance critical section) — closes the unlocked-single-slot hazard on both
  sides (`stepContractWriter.ts` currently takes no lock).
- **New `registry.lock`** — the only cross-run lock; tiny scope.
- Existing per-run remediate locks (`rolling-session.lock`, `base-branch.lock`, `node-claims.json`) are
  already correctly per-run — they slot under `runs/<runId>/implement/` unchanged.

## What this deletes (ideal-code, no back-compat — [[prefer-ideal-code-no-backcompat]])

- The flat audit paths (`.audit-tools/audit/audit_state.json`, `…/artifact_metadata.json`,
  `…/steps/…`, the top-level `…/audit/runs/<ISO>_…` worker dirs) — replaced by `runs/<runId>/…`.
  Single atomic replace per the atomic-replace-ordering invariant.
- The global `artifact-tree.lock` at `.audit-tools/audit/` — replaced by the per-run lock.
- Remediate's singleton `state.json` at `.audit-tools/remediation/state.json` — moved under
  `runs/<runId>/state.json`. `randomRunId()` already exists (`nextStep.ts:316`); it becomes the
  directory key, not just a field inside a singleton.

No migration shim for old flat layout: single user, no external consumers; a stale `.audit-tools/`
is regenerated by a fresh run.

## Implementation slices (each a green atomic commit)

Ordered so the tree is never half-migrated. Each ships new mechanism + deletion together.

1. **`runs/<runId>/` path module + registry (shared).** Add per-run path derivation to the
   `.audit-tools` path module (`src/shared/io/auditToolsPaths.ts`) — `auditRunDir(runId)`,
   `remediationRunDir(runId)`, `registryPath/registryLockPath`, per-run `artifactTreeLockPath(runId)`.
   Add `src/shared/io/runRegistry.ts` (register / resolveRun(runIdArg, registry) / heartbeat / retire,
   all `withFileLock`). Unit-test resolution truth-table (§Run resolution 1–5). No caller rewired yet
   → land behind the not-yet-used module (green, unused-export gated — wire in the same slice's tail or
   mark test-covered).
2. **Remediate onto per-run state.** Re-path `store.ts` (`stateFilePath`/`stateLockPath` take runId),
   thread runId from `nextStep.ts` resolution through every state read/write and `steps/` write. Delete
   the singleton path. Resolution: mint on first `pending`, resume via registry otherwise, manifest on
   multiple. Remediate suite (vitest) green. Smaller blast radius than audit → do first.
3. **Audit onto per-run tree.** Re-parent the whole bundle + `artifact_metadata.json` + `run-ledger.json`
   + worker `runs/` + `steps/` under `runs/<runId>/`; per-run `artifact-tree.lock`; thread runId through
   `advance.ts`, `auditStep.ts`, `nextStepHelpers.ts`, `reviewRun.ts`, `runArtifacts.ts`. Delete flat
   paths + global lock. Audit suite (node:test) green.
4. **Deliverable promotion + cross-orchestrator resolve.** On completion, promote per-run pair →
   canonical `.audit-tools/…` and record source runId in registry. Remediate intake resolves a specific
   audit runId or canonical latest (extend `intakeResolver.ts` discovery to list per-run findings).
5. **Manifest step + host wiring.** Add the multi-run disambiguation step (mirror the intake-manifest
   step shape) to both orchestrators; update both SKILL.md workflows to thread the emitted `run_id`
   automatically on subsequent next-steps. Update durable trap
   [[concurrent-nextstep-staleness-cascade-wipe]] → resolved (isolation, not "one call at a time").

## Decisions (settled, Ethan 2026-07-02)

- **D1 — RETIRE the "one sequential CLI call at a time" trap.** Per-run isolation makes concurrent
  *different-run* calls a supported feature; concurrent *same-run* next-steps just wait on the per-run
  lock. The lock is the mechanical enforcement — no host-remembered rule. Slice 5 rewrites the durable
  trap [[concurrent-nextstep-staleness-cascade-wipe]] to "resolved by per-run isolation."
- **D2 — NO TTL / heartbeat liveness.** Wall-clock is not a strong signal; codebase/git changes are.
  A registry entry persists until explicitly retired; its *staleness vs. the current tree* is answered by
  the existing dependency-DAG/`artifact_metadata` machinery at resume, not a clock. Never auto-prune;
  `retire-run <id>` is the only removal path.
- **D3 — NO `host_label`.** The registry tracks *what is being worked on*, not *who*. The manifest's
  discriminator is `coverage` (scope/lens or plan+finding-ids) so a new run can claim uncovered work.
```
