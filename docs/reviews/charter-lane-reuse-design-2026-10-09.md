# Charter-lane reuse — design-check record, 9 October 2026

<!-- review-routing: backlog-forward -->

Third half of the frozen-snapshot track ([`forward-tracks.md`](../backlog/forward-tracks.md):
"each register lane records the digest of the packet it was written from, and a later run re-runs
only a lane whose fresh digest differs"). Builds on the kept artifacts dir
([`artifacts-dir-rollover-plan-2026-10-08.md`](artifacts-dir-rollover-plan-2026-10-08.md)). Dated
record, not a spec.

## Property

When the charter register goes stale, the next extraction asks the host only for the lanes whose
evidence packet changed; every other lane is carried from the previous register unchanged.

## Today (verified recon)

- A lane's evidence is its packet: `materializeCharterPacket` (`src/audit/orchestrator/charterPackets.ts`);
  its digest `charterExtractionInputRevision` is bound at emit and re-checked at ingest, but never
  stored. `stated` reads docs plus member comments, `structural` the member tree, sizes, edges and
  declarations, `revealed` the stripped member bodies — so a comment-only edit changes `stated`
  alone.
- One `charterReadFileSlice` (`src/audit/orchestrator/dependencySlices.ts`) stales the whole
  register; `emitCharterExtraction` (`src/audit/cli/nextStepCommand.ts`) then asks for every lane,
  and `handleCharterExtractionBranch` (`src/audit/cli/nextStepHelpers.ts`) merges only when every
  kind arrived; `runCharterExtractionExecutor` rebuilds the register.

## As built

1. **Record.** `CharterLaneGraphSchema` (`src/shared/types/charter.ts`) gains an optional
   `packet_sha256`, the digest of the packet the lane was written from. Optional, so no schema bump:
   a register written before digests were recorded is simply never carried and re-extracts in full
   once. The merge stamps the digest on each authored lane (`CharterAuthoredLaneSchema`, like `kind`);
   the executor copies it onto the assembled lane.
2. **One rule.** `carriedCharterLane(bundle, kind, freshDigest)` (`charterPackets.ts`): the previous
   register's lane of that kind when its recorded digest equals the fresh one.
3. **One asset writer.** `writeCharterLaneAssets` (`nextStepHelpers.ts`) writes a kind's packet and
   coverage manifest and returns its digest. The emitter and the merge both call it for every kind,
   so the executor finds every kind's coverage even when no emission ran (all kinds carried).
4. **Emit.** A carried kind gets no lane prompt; the step names the carried kinds.
5. **Merge.** Carried kinds are not waited for; `CharterExtractionMerged.carried` hands the previous
   lanes to the executor, which re-assembles them like authored ones against the CURRENT repo
   universe and re-checks their citations against the fresh (byte-identical) packet.
6. **Comparison and fidelity re-run** after any re-extraction (`comparison_pending`), as before.

## Refutation (AGY gemini-3.8-flash-high, report-only; each verdict checked against source)

- **Holds — nothing retired returns.** The lanes stay blind and unmerged; the digest is tool-stamped
  (no lane self-attestation).
- **Accepted — a carried lane must be re-grounded.** Its packet is unchanged, but a file outside the
  packet may have been deleted or renamed; carried lanes are re-assembled against the current
  universe (item 5).
- **Accepted — with every kind carried no emission runs**, so no coverage manifest was on disk; the
  merge now writes every kind's assets itself (item 3).
- **Already handled by the build — K-of-N and shortfall:** a carried kind is neither waited for nor
  emitted as an expected lane.
- **Rejected — the schema bump.** The digest is optional, so nothing is discarded.
- **Rejected — classify an all-carried extraction as DETERMINISTIC in the plan draw.** The plan
  draw's deterministic arm for this obligation is the omit executor, which writes an EMPTY register;
  halting at the host boundary (unchanged) is the safe answer. The fold is unaffected: it calls the
  merge directly.
- **Deferred — keep the comparison and fidelity results when every lane is carried.** The fidelity
  pass reads evidence beyond the packets, so reusing it needs its own input digest; recorded below.

## Review (Opus, report-only, on the staged diff; each finding checked against source)

- **Fixed — the all-carried path had no test.** It is the common case: a new non-member file stales
  the register while every packet stays byte-identical. The emitter does not run, so only the merge's
  asset write keeps the coverage manifests. A new test reaches the comparison with no extraction step
  and asserts three coverage kinds and the delivered-quote check; it is red when the merge drops the
  manifests.
- **Fixed — a carried lane's digest was optional in the merged submission.** `carried` now requires
  it, as `lanes` does.
- **Fixed — the plan draw's halt reason claimed a host turn is owed.** The halt stays (see the
  rejected DETERMINISTIC classification above); the reason now says the next-step fold extracts.
- **Residuals below:** findings on stray submissions, lost assembly issues and packet rebuild cost.

## Residuals

- With every lane carried, the comparison and fidelity passes still re-run.
- A submission written to a carried kind's lane path is neither consumed nor quarantined, and the plan
  draw reports it as pending until the rollover removes it.
- A carried lane is re-assembled from its already-clean graph, so the assembly issues from when it was
  authored (a dropped scope file, a refused edge) are not repeated in the new register.
- A fold call can build a kind's packet up to three times (merge, binding check, emitter).
- A lane-prompt change between tool versions does not move a packet digest, so a carried lane may
  predate the current prompt.
- The structural packet carries `size_bytes`, so even a comment edit re-runs `structural` when it
  changes a member's length.
