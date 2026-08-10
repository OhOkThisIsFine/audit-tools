# Analyzer-sweep dedup cluster — what shipped, and the verified specs for what remains

Date: 2026-08-07 · Follows [`analysis-tools-plan-2026-08-07.md`](analysis-tools-plan-2026-08-07.md) §4,
which listed ten verified duplication/cycle findings. This document records the extractions that
landed and carries a **verified, diff-ready spec for each one that did not**, so the remaining work
is a bounded edit rather than a repeat of the analysis.

Method: each item was analyzed on the the offload router offload lane (offload-routed `claude -p`, DeepSeek V4
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
| 2 | `recordStore.ts` — `mintToken`, `readRecordMap` (pick, not guard), `writeRecordMap` | `426c2ba6` |
| 6 | `workspaceMemberEdges` (6b) + `designReviewNotesSection` / `prepareConceptualPass` (6a) | `ec494621` |
| 8 | `tests/audit/helpers/step-driver.ts` — one `walkStepsUntilTerminal` | `c791df49` |

**The cluster is complete — 10 of 10.** The adjacent `providers/index.ts` twin item 4 exposed
also landed (`9329238f`), and the T4 target the cluster kept bumping into
(`audit-code-wrapper-packets.test.ts`, the 198.5s single-file floor) was split three ways in
`8e7931e4`, dropping the floor to 40.3s.

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

## The specs, and what each turned out to be — ALL LANDED

Nothing below is outstanding. Each section is kept because the *correction* it records is the
reusable part: what the written spec claimed, versus what verification actually found. Read these
before sizing any future extraction — the pattern that repeats is a spec undercounting its family.

### ~~§4 item 2 — `claimRegistry` / `reservationLedger` store scaffolding~~ — LANDED `426c2ba6`

Kept below because the correction it forced is the reusable part.

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

### ~~§4 item 4 — `rollingAuditDispatch` / `providerNodeDispatch` shared prep head~~ — LANDED

The classification the item asked for, with each divergence typed:

| Spine step | Verdict |
|---|---|
| provider resolve — `createProvider ?? default`, `sourceByPoolId.get(slot.poolId)`, `withSourceConfig`, `resolveProvider(slot.providerName \|\| cfg.provider, cfg)` | **(c) shared core** — identical modulo `sessionConfig ?? {}` |
| `dirname(resultPath)` + the three sidecar names | **(c) shared core** |
| the worker task object | **(a) genuine INPUT** — `audit-code-worker/v1alpha1` vs `remediation-worker/v1alpha1` carry different fields |
| launch `repoRoot` (review snapshot vs node worktree), `entityLabel` | **(b) routing adapter** |

Now `src/shared/dispatch/providerDispatchPrep.ts` (`resolveDispatchProvider`,
`dispatchSidecarNames`/`Paths`/`PathsForResult`). Both dispatchers call it; remediate's
`nodeArtifacts` draws its three sidecar names from it, so there is no second implementation.
No knob was added: (a) and (b) are passed in by the caller rather than selected inside.

**Adjacent duplication this exposed, NOT in the sweep and still open:**
`src/audit/providers/index.ts` and `src/remediate/providers/index.ts` are byte-identical apart from
the descriptor constant they reference — same imports, same `buildOrchestratorProviderBindings(D)`,
same `resolveFreshSessionProviderName`, same `createFreshSessionProvider` body. Their own docblocks
say the descriptor is "the ONE home for everything that legitimately differs", which is exactly the
tell: the descriptor *is* the per-mode axis, so the factory boilerplate around it should be
`buildOrchestratorProviderModule(descriptor)` in shared. Only asymmetry is audit's extra
`ACTIVE_CLAUDE_CODE_SESSION_MESSAGE` export.

### ~~§4 item 4 — original spec, kept for the latent bug it recorded~~

**Pair.** `src/audit/cli/rollingAuditDispatch.ts` (prep spine inside
`makeAuditProviderPacketDispatcher`) against `src/remediate/steps/providerNodeDispatch.ts` (spine
inside `makeProviderNodeDispatcher`): provider-resolve → sidecar-write → launch.

**This is the "one core, two draws" item** — the largest of the cluster and the one with real design
content. Classify each divergence as (a) genuinely different INPUT, (b) terminal/result-routing
adapter, or (c) a policy knob belonging on the shared core; only (a) and (b) legitimately stay
per-mode. Note the standing rule: "it would become a config shell with several knobs" is *not* a
fork justification.

> **LANDED as its own fix — and the spec below UNDERSTATED it by 5×.** The spec said the name was
> built in TWO places. Verification found **six filenames built in TEN places across five modules**,
> with **three** independent writer/reader rebuild pairs, not one:
> `implement-<id>.result.json` was rebuilt three times (`implementPrompt.ts` plan item, its own
> `implementResultPath`, and `triage.ts` — which also re-hardcoded the `runs/<id>/implement` layout,
> so a drift there left a stale result to be read as current); `<id>.task.json` and
> `<id>.stderr.txt` twice each (writer + `marshal.ts`); plus `<id>.stdout.txt`,
> `implement-<id>.md`, and `accept-outcome-<id>.json`. `acceptNode.ts`'s docstring *asserted* the ids
> "follow the same filename-safe convention" — an invariant nothing enforced.
> All ten now derive from one owner, `src/remediate/steps/dispatch/nodeArtifacts.ts`, which sanitizes
> through `artifactNameForId` (moved to `src/shared/io/artifactName.ts` with
> `isCanonicalResultFilename`, its format recognizer, kept beside it).
> **The cross-platform face matters more than the reported one:** `writeJsonFile` runs
> `ensureParentDirectory`, so a `/` in a model-authored id does NOT throw — it silently mkdir -p's a
> subtree and hides the sidecar one level down, on every OS. The win32 `:` throw is only the visible
> third of the defect. Red-green pinned in `tests/remediate/dispatch-artifact-naming.test.ts`.
> *Lesson for the remaining items: a spec's "built in N places" is a floor, not a count — grep the
> whole filename family before sizing the edit.*

⚠ **A latent bug the comparison exposed, worth fixing regardless of whether the extraction happens —
and it is bigger than it first looks.** Audit names its sidecars through `artifactNameForId(...)`,
which sanitizes the `:` that packet ids embed (`rollingAuditDispatch.ts` documents that a raw id
throws on Windows, NTFS reading `:` as an alternate-data-stream separator). Remediate builds them
raw as `` `${block.block_id}.task.json` ``, with **no sanitizer**. `block_id` is declared
`z.string()` with no charset constraint and no validating regex anywhere, and it is model-authored,
so it is not guaranteed `:`-free.

**The trap for whoever fixes it:** the name is constructed in TWO places, with no shared helper.
`providerNodeDispatch.ts` writes `<blockId>.{task.json,stdout.txt,stderr.txt}`, and
`steps/dispatch/marshal.ts:614-616` INDEPENDENTLY rebuilds `<blockId>.task.json` /
`<blockId>.stderr.txt` to decide whether a block was ever dispatched (no task.json ⇒ it reports a
rolling-engine plan/drive inconsistency). Sanitizing only the writer makes marshal fail to find the
file and wrongly report "never dispatched" on every node. So the fix is: single-source the three
sidecar paths into one helper used by both, and sanitize there.

Supporting move: `artifactNameForId` / `safeArtifactStem` / `digestId` currently live in
`src/audit/cli/args.ts`. Remediate must not import from audit, so they belong in
`src/shared/io/artifactName.ts` with `args.ts` re-exporting for its existing consumers.

Note this changes on-disk sidecar names (`B1.task.json` → `B1_<digest>.task.json`), so the tests
asserting the literal names need updating with it —
`tests/remediate/rolling-provider-dispatch.test.ts:235`,
`tests/remediate/dispatch-merge-tolerance.test.ts:173`. These are per-run transient artifacts, not a
persisted cross-version identity, so renaming them is safe as long as writer and reader move
together. Loop-core (`src/remediate/steps/dispatch/`) — attested commit.

Also unresolved by the lane: `WorkerTask` is a per-orchestrator contract
(`audit-code-worker/v1alpha1` vs `remediation-worker/v1alpha1`), so the task-builder is genuine
per-mode INPUT; the surrounding prep is not.

**Loop-core** on both sides — attested commit.

### ~~§4 item 6 — `nextStepCommand` conceptual-dispatch near-twins, and cargo/packageJson~~ — LANDED `ec494621`

**6a was a THREE-site family, not two.** The spec named the two conceptual branches; verification
found `prepareContractDispatch` builds the same re-review + rejection-notice pair for the *contract*
pass, composing it inline instead of joining it. All three now go through one
`designReviewNotesSection(artifactsDir, bundle, pass)`; the two conceptual branches additionally
share `prepareConceptualPass`. Composition equivalence was checked per presence-combination before
collapsing the contract site — the old two-optional-entry spread and the new single joined section
emit byte-identical prompts in all four cases. A fourth site (the legacy `design_review` branch,
`nextStepCommand.ts:429`) calls the rejection notice with `["legacy"]` and NO re-review pairing, so
it is genuinely a different thing and was left alone.

Settings resolution deliberately stayed at each call site: the parallel branch feeds
`conceptualSettings.max_units` to the contract packet it writes FIRST, and both preps write into
`incoming/`, so hoisting it into the helper would have reordered writes.

**6b landed as specced**, and its stable-order warning was confirmed DISCHARGED rather than assumed
— both extractors push into `acc.references`, which `graph.ts` sorts via `uniqueSortedEdges` before
hashing, so `pathLookup` iteration order never reaches the artifact. That reasoning now lives in the
helper's docblock instead of this file, so the next reader does not re-derive it.
`workspacePatternMatchesPackage` was a single-consumer alias and went dead under the collapse; it was
deleted in the same commit rather than left for the knip gate.

### ~~§4 item 6 — original spec~~

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

### ~~§4 item 8 — step-driving harness unification~~ — LANDED `c791df49`

**A four-file family, and `run-wrapper.mjs` was not one of the drivers.** The spec named
`completion-harness.advanceToDispatchReady`, `wrapper-harness.startDispatchRun` and
`helpers/run-wrapper.mjs`. Verification found `run-wrapper.mjs` is a one-shot subprocess runner with
no walk in it at all (a near-duplicate of `wrapper-harness`'s own `runWrapper`, left alone), while
the genuine third driver was `next-step-harness.advancePastDesignReview`, which the spec never
mentioned.

The first two had **byte-identical** pause bodies differing only in transport — in-process
`cmdNextStep` vs spawned wrapper. The third was the same walk, drifted: it answered two kinds the
others threw on and hardcoded two artifact paths the others read from the step contract.

`tests/audit/helpers/step-driver.ts` now owns the walk; callers supply transport, terminal kind set,
label, and an optional observation hook. Two deliberate behaviour changes are stated in its docblock
rather than left to be discovered: the answerer covers the UNION of the three kind sets (so the
dispatch walks now answer `critical_flow_fallback` / legacy `design_review` instead of throwing —
those narrow sets were incidental, not contractual, and unknown kinds still throw), and analyzer
artifact paths now prefer the step contract with the conventional `incoming/` name as fallback.

**It also exposed a test that never called its subject.**
`"advancePastDesignReview throws on unknown pause kind"` declared a hand-copied REPLICA of the walker
inside the test body and asserted on the replica — the production helper could have been deleted and
it would have stayed green. Injectable transport made the real case testable; it now drives the real
driver, red-green validated by inverting the throw. [[test-must-reach-the-code-it-claims]]

An independent adversarial lane was run against the equivalence claim. It reached the same two
findings (the union trade-off, the changed error string) and refuted the other three — check
ordering, path resolution, and pause-budget semantics are all equivalent.
