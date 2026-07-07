# Glossary — opaque identifier families

> **Purpose.** Core source files carry bare identifiers — `INV-RS-01`, `CE-003`, `N-R13`,
> `SEAM-rolling-stranding`, `FND-OBS-99e3a861` — that are load-bearing in comments and obligation
> ids but defined nowhere a reader can look them up (ARC-d81a55ab). This is the canonical lookup
> table. Each entry below is a one-sentence statement of what the family means and where its
> authority lives.
>
> **Rule.** Every identifier *family* (prefix) referenced from `src/**/*.ts` MUST have an
> entry here. A guard test (`tests/shared/id-glossary.test.mjs`) scans the source tree and
> fails if a new family prefix appears in code without a glossary entry. New *individual* ids inside an
> existing family do not need their own row, but the load-bearing ones are enumerated under their
> family for quick lookup; inline the one-sentence statement at the primary definition site so the id
> becomes an optional cross-ref rather than the only handle.

The grep that backs the guard recognises these family shapes:

| Family | Shape | Meaning |
|---|---|---|
| `INV-` | `INV-<AREA>-<NN>` | **Invariant** — a named correctness property the tooling must always uphold. `<AREA>` scopes it (see below). |
| `CE-` | `CE-<NNN>` | **Counterexample** — a judge-accepted adversarial case the contract pipeline must defend against; the paired invariant must make it impossible. **Not globally unique** — this guard only scans `src/**/*.ts`; `docs/backlog-remediation-design.md` runs its own independent `CE-*`/`FC-*` id family for a different design-history purpose, and a bare `CE-NNN` can also appear as an unrelated local counter in source comments (e.g. `stepBoundaryCapture.ts`, `scheduler.ts`, `clauseInterpreter.ts`). Always resolve a `CE-*` id from its own document/file, never assume cross-document uniqueness. |
| `N-` | `N-<phase><NN>` | **Node id** in a remediation/redesign plan DAG (e.g. the redesign `N-R*`/`N-S*` nodes, the self-audit `N-X*`/`N-CE*` nodes). A node is a bounded unit of planned work. |
| `SEAM-` | `SEAM-<NAME>` | **Multi-agent seam contract** — a hand-off boundary between independently-run agents (or between dispatch and merge) whose contract both sides must honour. |
| `OBS-` / `ARC-` / `COR-` / `MNT-` / `TST-` / `REL-` / `CFG-` / `DAT-` / `SEC-` / `PRF-` / `OPR-` | `<LENS>-<hash>` | **Auditor finding id** — a finding emitted by `audit-code`, keyed by lens prefix + a short content hash (see `findingIdentitySignature`). Stable across re-audits of the same defect. |
| `FND-` | `FND-<LENS>-<hash>` | **Obligation-bound finding reference** — the same auditor finding id wrapped as a remediation obligation handle (`FND-OBS-99e3a861`); the `FND-` prefix marks it as the unit a remediation node satisfies. |

## INV-* areas (invariant namespaces)

`INV-<AREA>-<NN>` — area codes seen in the source tree, with the file that owns the invariant:

| Area | Domain | Primary owner |
|---|---|---|
| `INV-CC` | Confirm-intent / CLI guidance handshake (sole-writer, idempotent-on-target guidance file). | `src/audit/cli/nextStepCommand.ts` |
| `INV-CK` | Content-key seam — the sole definition of `identityKey` (grouping), `idempotencyKey` (signature-stable ingest anchor) and `contentKey` (signature-sensitive staleness driver); pure/deterministic key derivation with a documented relating invariant and key-split. | `src/shared/contentKey.ts` |
| `INV-CL` | Coverage ledger — source-type-aware denominator (finding-enumeration vs source-file coverage). | `src/remediate/coverage/findingLedger.ts` |
| `INV-DA` | Deterministic-analyzers — the low-in-degree `deletion_candidate` / edge-topology dead-code signal is UNSOUND for deletion and must never gate unattended auto-apply. | `src/remediate/review/autonomousGate.ts` |
| `INV-CO` | Contract obligations — paired obligations, evidence threading, reconciliation derivation in the contract pipeline. | `src/remediate/steps/contractPipeline.ts` |
| `INV-CVG` | Contract validation gates — every structural gate failure batched into ONE report; the paired-obligation coverage gate (CE-006 negative-scoping) is exposed in `validate-artifact`; decomposition `file_scope` may not point only at re-export shims. | `src/remediate/validation/contractPipelineGates.ts` |
| `INV-IR` | Incremental contract re-convergence — item-scoped fail-closed re-validation (per-item provenance; missing/wrong key → full re-validation) + empty-delta copy-forward with zero worker dispatch + load-bearing-prose-aware semantic hash. | `src/remediate/contractPipeline/derive.ts` |
| `INV-WTS` | Dispatch worktree safety — per-node worktree isolation under one total lock order, fail-loud verify on git-toplevel escape, captured-commit-OID ancestry reconcile (no bare `cat-file` false-close), `resolved_no_change` grounded in the captured OID (a captured-OID + empty branch is a clobber → re-block + quarantine, never a data-loss false-close). | `src/remediate/steps/dispatch/worktreeLifecycle.ts` |
| `INV-B3` | Source-grounded citation (M-B3) — `normalizeRepoPath` keeps dotfile-dir leading dots; a bare basename grounds only when it uniquely resolves to one tracked path; grounding widens true-positives (dotfile dirs + unique basenames) and never blanket-passes a hallucinated path. | `src/shared/validation/findingGrounding.ts` |
| `INV-DS` | Dispatch — reconciliation expectations a node must honour, write-scope, evidence. | `src/remediate/steps/dispatch.ts` |
| `INV-GND` | Grounding — a finding with no grounding verdict is treated as ungrounded (verify-before-fix). | `src/shared/validation/findingGrounding.ts` |
| `INV-ID` | Idempotent intake — content-hash keyed source registration (re-register is a no-op). | `src/remediate/intake.ts` |
| `INV-QD` | Quota-driven dispatch — quota headroom is the sole throttle; in-flight token accounting is the single authority (no external concurrency cap). | `src/shared/dispatch/rollingDispatch.ts` |
| `INV-RCI` | Reconciled OpenCode config invariants — the shared repo-root `opencode.json` top-level `permission.bash` is the deterministic **union ceiling** of every agent's bash rules (each agent's rules are a subset, top-level introduces no command no agent needs, shared denies survive). | `src/shared/opencodePermissions.ts` |
| `INV-RPS` | Remediation plan / cross-lens dedup — distinct structural-anchor identities stay distinct. | `src/remediate/dedup/crossLensDedup.ts` |
| `INV-RS` | Remediation steps / state machine — ordered-obligation, one-bounded-step, fail-closed final gate. | `src/remediate/steps/nextStep.ts` |
| `INV-RSD` | Rolling single-tree dispatch — the whole read-modify-write of `state.json` runs under one held lock. | `src/remediate/steps/dispatch.ts` |
| `INV-PHASE` | Auto-phasing barrier (T3) — a block's foundations→consumers phase ordinal (derived at promotion from the persisted phase cut) is a hard scheduler barrier: a higher-phase block never enters a dispatch level until every lower-phase block is verified-complete. | `src/remediate/steps/nextStep.ts` |
| `INV-SOO` | Scheduler ownership ordering — file-ownership-disjoint admission (one in-flight writer per canonical file) over declared∪claimed scope, enforced at admission and amendment-grant time, with deterministic tie-break, atomic triage-retry hand-off, and disposition-aware claim lifecycle. | `src/shared/dispatch/ownershipScheduler.ts`, `src/remediate/dispatch/ownershipRegistry.ts` |

### Historical single-letter INV spelling (`INV-S05`, `INV-X06`)

A handful of invariants predate the two-letter area scheme and are still cited under their original
**redesign-node numbering** — a single letter plus a two-digit number:

| Id | Meaning | Site |
|---|---|---|
| `INV-S03` | Settled dispatch-pool exclusions — a spilled-then-exhausted pool (Gate-0/Gate-1 exclusion) is never re-offered on re-discovery; the `SettledExclusionSet` only grows within a run and is never mutated. | `src/shared/rolling/pausedState.ts`, `src/shared/dispatch/settledPools.ts` |
| `INV-S04` | Free-form intent is a derived signal only — the verbatim `free_form_intent` string is never threaded into worker/dispatch prompts or output fields. | `src/shared/intent/freeFormIntentInterpreter.ts` |
| `INV-S05` | Quota headroom is the sole dispatch throttle (the modern `INV-QD-11` restates it). | `src/shared/dispatch/rollingDispatch.ts` |
| `INV-X06` | Partial-completion terminal hook — undispatchable/blocked work routes the run to close instead of looping forever. | `src/remediate/state/store.ts`, `src/remediate/steps/nextStep.ts` |
| `INV-O1` | Foundations module O1 (friction-capture) — best-effort no-op-safe `captureFrictionEvent` sink + mandatory blocking triage whose satisfaction set is auto-captured events UNION surfaced reflections. | `src/shared/friction/captureFrictionEvent.ts` (literal `INV-O1-*` tokens; `triage.ts` implements the O1 triage module but carries no `INV-O1-*` token) |
| `INV-O2` | Foundations module O2 (append-only ledger + lock) — instance-keyed idempotent append, identityKey-grouping re-association, `withFileLock` critical section, version-keyed bounded intent-checkpoint gate. | `src/audit/orchestrator/intentCheckpointGate.ts`, `src/audit/orchestrator/resultBaseline.ts` (literal `INV-O2-*` tokens; `ledger.ts` implements the O2 module but carries no `INV-O2-*` token) |
| `INV-o3` | Foundations module O3 (emit-validate-repair seam) — cheapest-first monotonic coercion→bounded-patch→re-dispatch, one canonical validator, lock-short. | `src/shared/repair/emitValidateRepair.ts` |

Treat the single-letter `INV-<letter><NN>` spelling as the redesign-node form of an invariant; new
invariants should use the two-letter area scheme above.

## CE-* counterexamples (load-bearing)

| Id | Defends against | Site |
|---|---|---|
| `CE-001` / `CE-002` | A design/assessment claim the adversarial critic falsifies; the pipeline emits a counterexample envelope. | `src/remediate/steps/contractPipelinePrompts.ts` |
| `CE-003` / `CE-205` | Indefinite stall: after `LIVELOCK_PAUSE_LIMIT` consecutive paused passes with zero net new capacity the rolling engine must terminate, not spin. | `src/shared/rolling/pausedState.ts` |
| `CE-206` | Total-encoding-failure check too coarse — a single unencodable clause must not block every other, independently-encodable clause in a compound intent. | `src/shared/intent/clauseInterpreter.ts` |

## SEAM-* seam contracts

| Id | Contract | Site |
|---|---|---|
| `SEAM-rolling-stranding` | When all quota pools are exhausted, waiting cannot help: strand the remainder and surface an `empty_pool` terminal rather than blocking forever. | `src/shared/dispatch/rollingDispatch.ts` |
| `SEAM-ACL-*` | Allowlisted-command / env seam — host-signalling env (`CLAUDECODE`, `CLAUDE_CODE_*`) is stripped by the shared owner (`src/shared/tooling/exec.ts`) before a runtime command runs. | `src/audit/orchestrator/runtimeCommand.ts` |
| `SEAM-RSD-*` | Rolling single-tree dispatch hand-off — state mutation is committed atomically under the single held lock (paired with `INV-RSD`). | `src/remediate/steps/dispatch.ts` |

## N-* plan nodes (load-bearing references in code)

These are nodes from the agreed redesign / self-audit DAGs (full DAGs live in the plan artifacts under
`docs/*-design.md` and the remediation run dirs). The ones still cross-referenced from source:

| Id | What it was |
|---|---|
| `N-R13` | Redesign: the document phase was dissolved — a pending item that already has an `item_spec` carries forward without re-running document. |
| `N-R21` / `N-R22` | Redesign: ownership-registry / write-scope dispatch nodes. |
| `N-S09` | Redesign: rolling-engine paused-state + livelock guard (the `pausedState` module). |
| `N-X06` / `N-CE301` | Self-audit plan nodes (counterexample-derived remediation units). |

> The plan-node numbering (`N-R*`, `N-S*`, `N-X*`, `N-CE*`) is historical — nodes are consumed once and
> their work folds into the durable code; the ids survive only as cross-refs in comments. They do not
> need per-id rows here, only this family entry. (See also `OBS-d81a55ab`, the finding family below,
> which is why this glossary exists.)
