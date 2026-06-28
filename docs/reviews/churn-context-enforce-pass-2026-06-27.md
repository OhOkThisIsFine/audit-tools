# Codebase-wide review — churn / context / enforce-in-tooling (T5 #15)

> Dedicated pass applying the append-only-ledger + granular-staleness + enforce-in-tooling
> perspective over the whole codebase (backlog → "Codebase-wide review for churn / context /
> enforce-in-tooling", Ethan 2026-06-24). Three parallel review agents, one per category.
> **Advisory** — findings below are verification-tiered; only ✅-VERIFIED items are acted on or
> promoted to backlog. Unverified items are leads for a follow-on lap, not facts.

Date: 2026-06-27 · against `main` @ v0.30.39.

## What shipped this lap

- **✅ FIXED — auth-session heuristic O(auth × files) → O(files).** `extractHeuristicAuthSessionEdges`
  ran *inside* the per-file loop (`graph.ts`), re-scanning the entire `repoManifest.files` for every
  auth-named file. Moved into `accumulateCrossFileEdges` (the file's own named home for cross-file
  concerns) with a single index sweep collecting auth + session paths once, then pairing. Edges are
  identical (uniqueSortedEdges normalizes order); no self-edge possible (auth/session sets disjoint).
  Tests green (`graph-heuristic-edges.test.mjs`).

## Churn — recompute / re-derive more than the delta demands

| # | Finding | Status | Note |
|---|---------|--------|------|
| C1 | auth-session O(auth×files) inner scan (`graph.ts`) | ✅ FIXED this lap | see above |
| C2 | **Graph-build extraction re-reads + re-parses every file unconditionally** (`buildGraphBundleFromFs`, `buildGraphBundle`) when repo_manifest + disposition unchanged | ⏳ KNOWN RESIDUAL | This is exactly the "incremental graph-build extraction" the handoff names as the one real remaining staleness target. Precedent: `gitHistoryBaseline`. Flagged careful (pathLookup-keyed, NOT a naïve baseline mirror). → backlog T5 #12 residual. |
| C3 | `buildDesignAssessment` re-runs all ~10 detectors on any graph_bundle stale, even a single-edge delta | ⚠️ PLAUSIBLE, unverified | Content-hash gate on graph_bundle could skip when detector inputs unmoved. Lower value (design assessment is infrequent). |
| C4 | `extractPytestConftestLinks` re-materializes `[...pathLookup.values()]` + per-conftest full-list scan every build | ⚠️ PLAUSIBLE | Folds into C2 (same incremental-extraction lap). |
| C5 | `buildPathLookup` / `buildDispositionMap` rebuilt independently in multiple extractors per run | ⚠️ LOW VALUE | Pure functions, cheap; cumulative only. Not worth a dedicated lap. |
| C6 | `computeStaleArtifacts` full DAG walk on every `decideNextStep` | ⚠️ LOW VALUE | Already cheap (O(artifacts+dependents)); a signature short-circuit is gratuitous given current artifact counts. |

## Context — ship/re-ship more than needed into a prompt or step

| # | Finding | Status | Note |
|---|---------|--------|------|
| X1 | **Remediate implement prompt inlines full finding badge body per item** (`dispatch.ts` `implementPrompt`) | ⚠️ PLAUSIBLE, highest-value | Worker needs id + title + item_spec scope; badge details live in state JSON. Compounds per item × per wave. Verify worker actually relies on badge before trimming. |
| X2 | Remediate plan carries FULL `Finding[]` (evidence/grounding/all files) into `RemediationState`, re-serialized per node | ⚠️ PLAUSIBLE | A minimal `RemediationFinding` dispatch-contract subset vs the full shared `Finding`. Compounds across waves. |
| X3 | Synthesis narrative prompt inlines full per-finding summary lines (up to 120) | ⚠️ PLAUSIBLE | Could ship `[id, title]` + point at `audit-findings.json`. Moderate. |
| X4 | Audit dispatch packet prompt inlines full file list uncapped (`packetPrompt.ts`) | ⚠️ PLAUSIBLE | Full list already in packet.json; prompt could summarize count + top-N. |
| X5 | Quarantined findings rendered in full in the report markdown | ⚠️ PLAUSIBLE | Could summarize to count + pointer to JSON. |
| X6 | Review-approval prompt renders every item full across all tiers, no streaming cap | ⚠️ PLAUSIBLE | Tier-specific render (strategic full, mechanical summary). |

> Context items share a theme: **prompts re-inline content that already lives in a machine contract
> the worker can read.** A single principle fix — "dispatch packets carry the minimal implement
> contract; everything else is a pointer to the JSON sidecar" — would address X1–X6 together. Worth a
> dedicated design lap rather than six point-trims. Verify each worker path actually reads the sidecar
> before trimming (a worker that can't open files needs the inline copy).

## Enforce-in-tooling — correctness held by host/maintainer discretion

| # | Finding | Status | Note |
|---|---------|--------|------|
| E1 | **Write-scope gate is `if (params.scope)` — optional** (`dispatch.ts:1426`) | ✅ VERIFIED, real | A caller omitting `scope` skips OBL-DS-06 entirely. Currently always passed by the tool, but optionality = latent failure mode per the auditor-agnostic invariant. Fix: make `allBlockScopes` required; fail-loud if absent. → backlog. |
| E2 | Worker `item_results` count/completeness not rejected — prompt says "exactly one per node" but `validateImplementWorkerResult` only type-checks | ⚠️ PLAUSIBLE, real-shaped | Missing/duplicate finding_ids silently become "pending" on re-dispatch. Mechanical check: `item_results` covers assigned set exactly. Verify collapseItemResults doesn't already cover this downstream. |
| E3 | Null `selected_executor` (missing obligation→executor mapping) logged as "configuration gap", not hard-rejected (`nextStep.ts`) | ✅ FIXED (v0.30.43) | `assertExecutorRegistryCoversPriority()` runs at module load → throws on a missing/ambiguous PRIORITY→executor mapping; the silent null-executor dead-end is now impossible. |
| E4 | Obligation-DAG cycles / empty-repo grounding emit `severity:"warning"`, callers filter error-only → proceed (`contractPipelineGates.ts`) | ⚠️ NEEDS DESIGN CHECK | May be intentional (N-R21 host-resolution route). Confirm intent before promoting cycles to error. |
| E5 | Finding-id remap tolerance (`collapseItemResults` aliasMap) turns unknown ids into "orphan" not reject | ⚠️ LOW | Tolerance prevents data loss; tightening risks regressions. Likely keep. |

## Recommended follow-on sequencing

1. **E1 write-scope required-param** — smallest, highest-certainty enforce-in-tooling win; verified. Lean lap.
2. **C2 incremental graph-build extraction** — the one substantive churn residual already on the roadmap (T5 #12). Full pipeline lap; pathLookup-keyed, careful.
3. **X-cluster minimal-dispatch-contract** — one design lap addressing X1–X6 via "packet carries minimal contract + sidecar pointers"; verify worker sidecar-read first.
4. E2/E3 mechanical completeness checks — lean laps after verifying no downstream coverage.

Everything else (C3–C6, E4–E5) is low-value or needs a design-intent decision; not scheduled.
