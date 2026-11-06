# Iterative charter extraction — design record (2026-11-06)

<!-- review-routing: no-forward-work -->

Status: design-check done (independent AGY refutation, verdicts verified against source). No product
code yet. Supersedes the "index plus per-file slices" plan of the same day: the owner chose the
iterative direction instead.

## Defect (D9 of `docs/reviews/dogfood-audit-2026-11-06.md`)

Each blind charter lane (stated, structural, revealed) receives ONE markdown packet built by
`materializeCharterPacket` (`src/audit/orchestrator/charterPackets.ts`). On audit-tools 0.55.16 the
packets measured: stated 5 308 438 B, revealed 5 071 311 B, structural 1 445 735 B. About 1.3M tokens
per large lane. No executor can read one, and the lane may not read anything else.

## Owner direction (2026-11-06, relayed by the coordinator)

- Build each lane's charter ITERATIVELY: a seed, then one fold step per coherent FILE GROUP (never one
  step per file), then one short reconcile pass.
- Tool-assigned groups guarantee coverage: every file of the read set is in exactly one group.
- Each lane stays channel-blind.
- The charter state before reconcile is PROVISIONAL, and it is marked so in the data and in every prompt.
- A fold step must not re-read the whole charter. It receives only the part it needs.
- Dated docs stay in the read set. The seed or the group listing marks them as dated records.

## Constraints that bind (evidence)

- **No size cap, no backend window in the tool** — owner ruling 2026-09-04, commit `a682922d`. Group
  boundaries come from CONTENT, never from a token budget. Only the 512 KiB per-file read-safety bound
  stays.
- **Read set** — `charterPacketReadSet` returns `{ units, memberPaths, docPaths }`: every non-test
  member file (owner choice R5, commit `b6d3f927`) PLUS every doc-intent file (`isDocIntentFile`) that
  is not a member. The staleness slices (`dependencySlices.ts`: `charterUnitPartitionSlice`,
  `charterReadFileSlice`, `charterGraphEdgeSlice`) project the same inputs.
- **Channel purity by feeding** — design resolution 4, commit `3fb84823`: stated = doc-intent files +
  extracted comments; structural = file tree by unit + member dependency edges
  (`memberDependencyEdgeLines`) + top-level declaration lines; revealed = comment-stripped bodies.
- **Five-step layer, one goal DAG per lane** — commits `80793d83`, `be3551e5`. The structure
  decomposition is NOT the correspondence key (`spec/conceptual-design-review-design.md`);
  `proposeCorrespondences` keys on whole-DAG `file_overlap` and `cross_ref`.
- **The tool, not the lane, states step-fixed metadata** — owner review of prompt 8, 2026-09-17 (lane
  `kind` removed from the submission, `src/shared/decompose/charterExtraction.ts`).
- **One core, N draws** — `src/shared/decompose/contentCoherence.ts`, per-draw `ContentCoherencePolicy`,
  "no budget, ceiling, or size target".
- **Line provenance** — commit `830885fb`; `checkLaneCitations` (`charterExtractionExecutor.ts`)
  requires a quote for a path the packet excerpted.
- **Lane reuse by digest** — commit `cfb8f9c8`: `packet_sha256`, `carriedCharterLane`,
  `charterExtractionInputRevision` (`src/audit/cli/reviewSubmission.ts`).
- **Archive by content hash** — commit `986a2382`.
- **Rollover** — `rollOverFinishedRun` deletes the run directory and keeps core artifacts only.

## Independent refutation — verdicts (verified against source)

| # | Lead | Verdict |
|---|---|---|
| R1 | The coherence core's two eligibility rules either make singletons or join every import-connected unit into one component. | **Holds.** A charter draw needs its own eligibility value: unit partition as the floor, no cross-unit join, `refineAtModularityPeak: true`. |
| R2 | "Same groups so a correspondence lines up by group" re-keys correspondences on groups (retired 2026-09-15). | **Holds.** Claim removed. `proposeCorrespondences` stays as it is. |
| R3 | A lane-stated `provisional`/`confirmed` field repeats the retired lane-stated `kind`. | **Holds in part.** The TOOL stamps the field from the step that wrote the node. The reconcile step names the nodes it cannot confirm; the tool stamps the rest `confirmed`. |
| R4 | The read set also holds `docPaths`; my recon line was incomplete. | **Holds.** Fixed above. `docPaths` are seed/fold material for `stated` only. |
| R5 | The CHARTER VIEW rule widens along import edges for every lane: structural material leaks into stated and revealed. | **Holds.** Only `structural` widens along inter-group edges. `stated` and `revealed` widen only along their own provisional DAG edges; `stated` always keeps its doc-only nodes in view. |
| R6 | `assembleLaneGraph` drops a repeated `node_id` and drops every edge on a cycle; it cannot apply a delta. | **Holds.** A new reducer applies a fold delta: it edits only nodes in that step's view, refuses a new id that collides with a hidden node, and drops only the new edges that close a cycle. |
| R7 | Packet path, manifest, archive and citation check are per kind; reconcile has no excerpts to quote. | **Holds.** Per `(kind, step)` packets and manifests; each citation is checked against the manifest of the step that wrote it; reconcile may only reuse existing provenance. |
| R8 | Reuse "from the changed group onward" conflicts with step 8: the run directory is deleted at rollover. | **Holds.** Step digests and the per-step DAG snapshots go into `charter_register.json`. |
| R9 | Review bindings, K-of-N resume and the single-packet `inputs` check assume one lane per kind. | **Holds.** Step-qualified lane ids; each landed step delta is committed on its own. |
| R10 | Parallel waves need a merge pass. | **Holds.** Folds stay serial within a lane; the three lanes run in parallel. |

## Measurement that sizes the group rule

Non-test units of this repository (bytes of member files): `src-audit` 2 405 213 (243 files),
`src-shared` 1 394 179, `src-remediate` 979 735, `scripts-shared` 666 211, the rest under 160 000.
A unit is too coarse to be the group: `src-audit` alone is about 600K tokens. Second-level directories
are smaller (largest `src/audit/orchestrator` 823 346 B). The group rule is modularity refinement of
each unit over the member import graph, data-derived, with no size target. Its group sizes must be
measured on this repository before the change lands.

## Revised plan

1. **Groups (deterministic).** A charter draw of the coherence core: unit partition as the floor, no
   cross-unit join, refined at the modularity peak. Every member file is in exactly one group. The
   group list is in stable path order.
2. **Seed step (per lane, own channel only).** Stated: the repo-root docs and every doc-intent file not
   assigned to a group, dated records marked. Structural: the file tree by group and the inter-group
   edges. Revealed: the stripped bodies of the entry-point files (bins and package exports).
3. **Fold steps (serial within a lane).** Material: the group's channel excerpts in today's `N| ` format.
   CHARTER VIEW: the root goals + the nodes the tool selects by the per-lane rule in R5. The step
   returns a delta; the reducer of R6 applies it.
4. **Reconcile step (once per lane).** Input: the whole provisional DAG, nodes and edges, no source
   bodies. It merges duplicates and fixes the hierarchy, reusing only existing provenance. It names
   the nodes it cannot confirm, with a reason.
5. **Provisional marking.** The tool stamps `standing_in_lane` on each node. Every fold and reconcile
   prompt says that provisional nodes are a working hypothesis that the step may correct.
6. **Coverage.** Guaranteed: every group has one fold step per lane. Measured, not gated: files that no
   node cites.
7. **Identity, reuse, archive.** Per-step input digest (material + view); per-step packet archive; step
   digests and post-step snapshots in `charter_register.json`. The lane is carried when every step
   digest is unchanged. Otherwise it re-runs from the first changed step.

## Minimal failing test

`tests/audit/charter-packets.test.ts`. Fixture: two units (`src/a/entry.ts`, `src/a/helper.ts`;
`src/b/service.ts`, `src/b/store.ts`), intra-unit import edges, `README.md` and `docs/design.md` as
doc-intent files. Assertions: the charter extraction plan for `revealed` is
`[seed, fold(a), fold(b), reconcile]`; each fold's excerpts hold exactly its 2 files; the union of
fold files equals `charterPacketReadSet(bundle).memberPaths`; reconcile has no excerpts; the `stated`
plan delivers `docs/design.md`. Red today: one packet holds all 4 member files.
