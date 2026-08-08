# Analyzer-sweep dedup cluster — what shipped, and the verified specs for what remains

Date: 2026-08-07 · Follows [`analysis-tools-plan-2026-08-07.md`](analysis-tools-plan-2026-08-07.md) §4,
which listed ten verified duplication/cycle findings. This document records the extractions that
landed and carries a **verified, diff-ready spec for each one that did not**, so the remaining work
is a bounded edit rather than a repeat of the analysis.

Method: each item was analyzed on the llm-relay offload lane (relay-routed `claude -p`, DeepSeek V4
Flash and `pool/high`) and then **verified against source before any edit**. Where the lane's
proposal was wrong, the correction is recorded below — the lane's output is advisory, and three of
its proposals would have introduced defects.

## Landed

| §4 item | Extraction | Commit |
|---|---|---|
| 1 | `scoreShared.ts` — `ratio`, `pct`, direction-parameterized `valueRegressed` | `3a5d352c` |
| 3 | `compareGraphEdges` → beside `graphEdgeConfidence` | `c38f4511` |
| 5 | `reviewPacketShared.ts`; `acceptNode` `rollbackFailureOutcome` | `c38f4511` |
| 7 | `scripts/shared/backlog-entry-grammar.mjs`, replacing the count-parity drift test | `e5eda582` |
| 9 | All three type-only cycles broken; `no-circular` `viaOnly` exemption removed | `4082c237` |

Item 5 also dissolved a duplicated `ReviewPacketPlanningData` interface the sweep had not listed —
same defect class, same two files, and its "re-declared locally to avoid circular dep" comment was
the tell.

**Corrections the verification pass forced** (each would have been a real defect):

- **Item 1** — the sweep called the two regression predicates "drifted (direction-flipped)". They are
  direction-flipped *by design* and both are correct: hallucination rate is worse when it RISES,
  cache-hit ratio when it FALLS, and `scoreTokens`' own docstring says so. Collapsing them to one
  direction would have silently inverted a CI gate. The direction is a parameter, not a bug.
- **Item 7** — the lane proposed unifying the two title derivations. The budget gate's title is a
  **persisted identity**: `entryKey()` writes it into `docs/backlog/.size-baseline.json`, and the five
  recorded amnesty keys carry its 78-char truncation. Unifying would have invalidated every
  grandfathered key and turned the gate red on entries meant to be exempt. Only the segmentation —
  the genuinely identical part — is shared.
- **Item 9** — the lane proposed moving two remediate-internal types into `src/shared`, widening the
  public `audit-tools/shared` surface for types only one orchestrator uses. A local sibling below
  both breaks the cycle equally well.

## Remaining — verified specs

### §4 item 2 — `claimRegistry` / `reservationLedger` store scaffolding

**Pair.** `src/shared/quota/claimRegistry.ts` `mintOwnerToken` / `readClaimMap` / `writeClaimMap`
against `src/shared/quota/reservationLedger.ts` `mintLeaseId` / `readLedger` / `writeLedger`.
`mintOwnerToken`≡`mintLeaseId` and `writeClaimMap`≡`writeLedger` are byte-identical; the two readers
share the read→parse→degrade-to-`{}`→filter skeleton.

**Stays distinct.** The two guards (`isClaimRecord` vs `isLease`) and the classes themselves — a
claim (single grant, heartbeat staleness) and a lease (multi-per-key, cost summation, TTL) are
different domain objects. `withFileLock` is already single-sourced; there is no lock scaffolding to
extract.

⚠ **Correction to the lane's proposal.** It proposed a generic `readRecordMap(path, guard)` with the
lease store passing `Array.isArray(v) && v.length > 0 && v.every(isLease)`. That is **not**
equivalent: `readLedger` filters element-wise (`leases.filter(isLease)`) and keeps a partial array,
dropping the key only if nothing survives. An `every` guard drops the whole key when any single lease
is junk — a behavior change on exactly the corrupt-input path these readers exist to handle. The
correct generalization is a **pick** function, not a guard:

```ts
export async function readRecordMap<T>(
  path: string,
  pick: (value: unknown) => T | undefined,
): Promise<Record<string, T>>
```

with `claim: (v) => (isClaimRecord(v) ? v : undefined)` and
`lease: (v) => { if (!Array.isArray(v)) return undefined; const kept = v.filter(isLease); return kept.length > 0 ? kept : undefined; }`.

**Loop-core** (`src/shared/quota/`) — needs an attested commit. No external call site changes; the
public exports are untouched.

### §4 item 4 — `rollingAuditDispatch` / `providerNodeDispatch` shared prep head

**Pair.** `src/audit/cli/rollingAuditDispatch.ts` (prep spine inside
`makeAuditProviderPacketDispatcher`) against `src/remediate/steps/providerNodeDispatch.ts` (spine
inside `makeProviderNodeDispatcher`): provider-resolve → sidecar-write → launch.

**This is the "one core, two draws" item** — the largest of the cluster and the one with real design
content. Classify each divergence as (a) genuinely different INPUT, (b) terminal/result-routing
adapter, or (c) a policy knob belonging on the shared core; only (a) and (b) legitimately stay
per-mode. Note the standing rule: "it would become a config shell with several knobs" is *not* a
fork justification.

⚠ **A latent bug the comparison exposed, worth fixing regardless of whether the extraction happens.**
Audit names its sidecars through `artifactNameForId(...)`, which sanitizes the `:` that packet ids
embed (documented as throwing on Windows NTFS). Remediate builds them raw as
`` `${block.block_id}.task.json` ``, with **no sanitizer** — and `block_id` is model-authored
verbatim, so it is not guaranteed `:`-free. That is a latent Windows failure on the remediate side.
The shared prep should adopt the sanitizer for both.

Also unresolved by the lane: `WorkerTask` is a per-orchestrator contract
(`audit-code-worker/v1alpha1` vs `remediation-worker/v1alpha1`), so the task-builder is genuine
per-mode INPUT; the surrounding prep is not.

**Loop-core** on both sides — attested commit.

### §4 item 6 — `nextStepCommand` conceptual-dispatch near-twins, and cargo/packageJson

**6a.** `src/audit/cli/nextStepCommand.ts` — the five-statement conceptual-prep scaffold
(`resolveConceptualReviewSettings` → `buildDesignReReviewSection` → `renderDesignReviewRejectionNotice`
→ notes join → `prepareConceptualDispatch`) appears **byte-identically** in the parallel branch and
the conceptual-only branch, with identical arguments and identical results. Verdict: the scaffold's
differences are **incidental — extract it**. What must stay per-branch is the step *assembly* around
it: the parallel branch folds a contract pass into `units` / `read_paths` / `write_paths`, the
conceptual-only branch does not. That is a real load-bearing difference, not duplication.

**6b.** `src/audit/extractors/graphManifestEdges/cargo.ts` and `packageJson.ts` share the
workspace-pattern algorithm after the raw-pattern fetch (normalize → split positive/negative →
cross-product against the path lookup → negative-filter). Parameterize on the raw-pattern reader and
the is-manifest predicate. ⚠ Check the stable-order invariant while extracting: extractor arrays must
be ordered by a content-derived key (path-sort), never lookup-iteration order — an incidentally
ordered array churns the artifact content hash and cascades phantom staleness.

### §4 item 8 — step-driving harness unification (partially addressed)

The T4 split of `audit-code-completion.test.ts` gave that family its own
`tests/audit/helpers/completion-harness.ts`, so the file now has *a* harness. What item 8 actually
asks for is still open: `completion-harness`'s `advanceToDispatchReady`, `wrapper-harness.ts`'s
`startDispatchRun`, and the simpler `helpers/run-wrapper.mjs` spawn plumbing are three drivers of the
same walk. One parameterized driver would serve all three.
