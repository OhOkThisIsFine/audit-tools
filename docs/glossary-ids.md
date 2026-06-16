# Glossary — opaque identifier families

> **Purpose.** Core source files carry bare identifiers — `INV-RS-01`, `CE-003`, `N-R13`,
> `SEAM-rolling-stranding`, `FND-OBS-99e3a861` — that are load-bearing in comments and obligation
> ids but defined nowhere a reader can look them up (ARC-d81a55ab). This is the canonical lookup
> table. Each entry below is a one-sentence statement of what the family means and where its
> authority lives.
>
> **Rule.** Every identifier *family* (prefix) referenced from `packages/*/src/**/*.ts` MUST have an
> entry here. A guard test (`packages/shared/tests/id-glossary.test.mjs`) scans the source tree and
> fails if a new family prefix appears in code without a glossary entry. New *individual* ids inside an
> existing family do not need their own row, but the load-bearing ones are enumerated under their
> family for quick lookup; inline the one-sentence statement at the primary definition site so the id
> becomes an optional cross-ref rather than the only handle.

The grep that backs the guard recognises these family shapes:

| Family | Shape | Meaning |
|---|---|---|
| `INV-` | `INV-<AREA>-<NN>` | **Invariant** — a named correctness property the tooling must always uphold. `<AREA>` scopes it (see below). |
| `CE-` | `CE-<NNN>` | **Counterexample** — a judge-accepted adversarial case the contract pipeline must defend against; the paired invariant must make it impossible. |
| `N-` | `N-<phase><NN>` | **Node id** in a remediation/redesign plan DAG (e.g. the redesign `N-R*`/`N-S*` nodes, the self-audit `N-X*`/`N-CE*` nodes). A node is a bounded unit of planned work. |
| `SEAM-` | `SEAM-<NAME>` | **Multi-agent seam contract** — a hand-off boundary between independently-run agents (or between dispatch and merge) whose contract both sides must honour. |
| `OBS-` / `ARC-` / `COR-` / `MNT-` / `TST-` / `REL-` / `CFG-` / `DAT-` | `<LENS>-<hash>` | **Auditor finding id** — a finding emitted by `audit-code`, keyed by lens prefix + a short content hash (see `findingIdentitySignature`). Stable across re-audits of the same defect. |
| `FND-` | `FND-<LENS>-<hash>` | **Obligation-bound finding reference** — the same auditor finding id wrapped as a remediation obligation handle (`FND-OBS-99e3a861`); the `FND-` prefix marks it as the unit a remediation node satisfies. |

## INV-* areas (invariant namespaces)

`INV-<AREA>-<NN>` — area codes seen in the source tree, with the file that owns the invariant:

| Area | Domain | Primary owner |
|---|---|---|
| `INV-CC` | Confirm-intent / CLI guidance handshake (sole-writer, idempotent-on-target guidance file). | `audit-code/src/cli/nextStepCommand.ts` |
| `INV-CL` | Coverage ledger — source-type-aware denominator (finding-enumeration vs source-file coverage). | `remediate-code/src/coverage/findingLedger.ts` |
| `INV-CO` | Contract obligations — paired obligations, evidence threading, reconciliation derivation in the contract pipeline. | `remediate-code/src/steps/contractPipeline.ts` |
| `INV-DS` | Dispatch — reconciliation expectations a node must honour, write-scope, evidence. | `remediate-code/src/steps/dispatch.ts` |
| `INV-GND` | Grounding — a finding with no grounding verdict is treated as ungrounded (verify-before-fix). | `shared/src/validation/findingGrounding.ts` |
| `INV-ID` | Idempotent intake — content-hash keyed source registration (re-register is a no-op). | `remediate-code/src/intake.ts` |
| `INV-QD` | Quota-driven dispatch — quota headroom is the sole throttle; in-flight token accounting is the single authority (no external concurrency cap). | `shared/src/dispatch/rollingDispatch.ts` |
| `INV-RPS` | Remediation plan / cross-lens dedup — distinct structural-anchor identities stay distinct. | `remediate-code/src/dedup/crossLensDedup.ts` |
| `INV-RS` | Remediation steps / state machine — ordered-obligation, one-bounded-step, fail-closed final gate. | `remediate-code/src/steps/nextStep.ts` |
| `INV-RSD` | Rolling single-tree dispatch — the whole read-modify-write of `state.json` runs under one held lock. | `remediate-code/src/steps/dispatch.ts` |

### Historical single-letter INV spelling (`INV-S05`, `INV-X06`)

A handful of invariants predate the two-letter area scheme and are still cited under their original
**redesign-node numbering** — a single letter plus a two-digit number:

| Id | Meaning | Site |
|---|---|---|
| `INV-S05` | Quota headroom is the sole dispatch throttle (the modern `INV-QD-11` restates it). | `shared/src/dispatch/rollingDispatch.ts` |
| `INV-X06` | Partial-completion terminal hook — undispatchable/blocked work routes the run to close instead of looping forever. | `remediate-code/src/state/store.ts`, `remediate-code/src/steps/nextStep.ts` |

Treat the single-letter `INV-<letter><NN>` spelling as the redesign-node form of an invariant; new
invariants should use the two-letter area scheme above.

## CE-* counterexamples (load-bearing)

| Id | Defends against | Site |
|---|---|---|
| `CE-001` / `CE-002` | A design/assessment claim the adversarial critic falsifies; the pipeline emits a counterexample envelope. | `remediate-code/src/steps/contractPipelinePrompts.ts` |
| `CE-003` / `CE-205` | Indefinite stall: after `LIVELOCK_PAUSE_LIMIT` consecutive paused passes with zero net new capacity the rolling engine must terminate, not spin. | `shared/src/rolling/pausedState.ts` |
| `CE-005` | Grounding must be a *total* function — an absent/undefined grounding verdict resolves to "ungrounded → verify", never silently passes. | `shared/src/validation/findingGrounding.ts` |
| `CE-206` | Companion livelock counterexample to `CE-205` (paused-state re-discovery must make progress or stop). | `shared/src/rolling/pausedState.ts` |

## SEAM-* seam contracts

| Id | Contract | Site |
|---|---|---|
| `SEAM-rolling-stranding` | When all quota pools are exhausted, waiting cannot help: strand the remainder and surface an `empty_pool` terminal rather than blocking forever. | `shared/src/dispatch/rollingDispatch.ts` |
| `SEAM-ACL-*` | Allowlisted-command / env seam — host-signalling env (`CLAUDECODE`, `CLAUDE_CODE_*`) is stripped by the shared owner before a runtime command runs. | `audit-code/src/orchestrator/runtimeCommand.ts` |
| `SEAM-RSD-*` | Rolling single-tree dispatch hand-off — state mutation is committed atomically under the single held lock (paired with `INV-RSD`). | `remediate-code/src/steps/dispatch.ts` |

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
