# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.42.1 (the tag, not a sha — a sha here restales on every commit). Everything
  below `main`'s tip is pushed; there are unreleased commits, so a publish is available whenever
  the owner wants one.
- The zero-adapter retirement is live; audit-tools emits complete provider-neutral host workloads
  and ingests bound results. Host submissions ride tool-computed sha256-bound paths under the
  artifacts directory's submissions tree.
- `remediate-code recover-ingest` is new: the sanctioned repair when a workload's trusted baseline
  has been orphaned. It is true-orphanhood gated, ledger-marked, and runs every required test
  before taking the state lock. See the durable trap about amending a landed wave commit.

## Next: resume the remediation run — six items remain

The run is LIVE and mid-wave; resume it, never restart it. `remediate-code next-step` picks it up
against a fresh binding at the current HEAD.

**Resolved: 21 of 27.** Remaining: **CP-NODE-6** (blocked, see below), then **CP-NODE-3, 5, 15, 24,
26** down the dependency spine, then the close phase.

### 1. CP-NODE-6 is reviewed and BLOCKED — this is deliberate, not an unfinished edit

The host-handoff ingestion substrate work is preserved on branch **`wip/cp-node-6-blocked`**
(commit `cdbdd05e`), deliberately **not** on `main`. Its loop-core attestation records a `concerns`
verdict rather than a clearance. `main` is clean; do not merge that branch as-is.

Two blocking defects, each with a stated fix and each needing a test that reds today — both are
spelled out in the WIP commit message, and the entry in
[`open-bugs.md`](backlog/open-bugs.md) carries the same property statements:

- **Security** — the block-contract command scanner treats single-quoted shell metacharacters as
  inert, but `cmd.exe` does not treat `'` as a quote, so an admitted command can execute a second
  process at ingest and write outside every declared write scope.
- **Wedge** — a non-empty block-issue list early-returns before any work item is examined, so one
  malformed non-level-0 block means no landed result is ever accepted and `next-step` re-emits the
  same items forever.

Everything else in that branch reviewed clean, including the verified-intact recovery work, so the
fix is two functions plus two tests, not a rewrite.

### 2. The protocol that works — keep using it

- **One item in flight at a time** (the tree is shared). Give the implementer its module's
  finalized contract and test specs as the binding spec; require red-green by inversion (never
  `git checkout --`), real exit codes, and a STOP-and-report on any out-of-scope need.
- **Every item gets an independent adversarial review before it lands**, and a second delta pass
  after the fixes. This is not ceremony: every single item this wave had at least one real defect
  found that way, several of them mechanism-level.
- **Scope widening is the routing fix, and it was needed nine times.** When an item genuinely
  needs a file outside `allowed_files`, verify the file is owned by no other module, add it to the
  plan block's `touched_files`, delete `state.host_handoff`, and re-run `next-step` to re-prepare.
  A permanent test home earns the same treatment — that is how a red-green transcript becomes a
  durable test instead of a commit-message artifact.
- **Land the item, then write its result JSON** at the work item's `result_path` bound to the
  workload's own `baseline_commit` (not the git parent), then `next-step` to ingest.
- **A new `INV-*` id must not appear in `src/` comments** unless `docs/glossary-ids.md` is in the
  item's scope — the glossary gate scans `src/`, and the pre-commit gate does not run that test, so
  the red lands silently and the next item's worker finds it. It happened twice this wave.

### 3. The close phase is blocked on a contract gap — design-check it before starting

Every module's coverage-join invariant demands a per-finding evidence triple (file + line +
mechanism) recorded on its remediation item, but **the host-result envelope has no channel for
dispositions or evidence**, and no remaining node's contract owns adding one. Every landed item's
triples currently live only in commit messages and the workers' summaries. Before the close phase:
run `/design-check` on extending the result contract with an optional per-finding disposition block
validated at ingestion (versus a separate recording verb), then backfill the resolved items'
triples. The tracked entry is the steward-metadata item in [`open-bugs.md`](backlog/open-bugs.md).

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

### 4. Three owner decisions were taken at hand-back — they are recorded, not pending

Do not re-ask these; the ledger and the backlog hold them, and each is work rather than a question:

- **Write-scope routing is approved for the mechanical fix.** The node write-scope resolver should
  read the finalized module contracts and union the owning module's declared write targets — both
  `outputs` and `side_effects` — into the node's scope, replacing the early return of node-declared
  files. That retires the manual widening step described above; the built patch is in the routine's
  proposals directory.
- **`CLAUDE.md` gets the analyzer-veto clause.** The own-vs-acquire bullet should state that a
  recorded operator decline (or a `skip` setting) refuses the spawn even for a curated default-set
  tool. The full admission ladder stays single-homed in code — do not restate it in prose.
- **`intentOrdering` is to be WIRED, not deleted.** Call it where the plan's findings and blocks are
  finalized, reading the interpreted intent already persisted at the checkpoint; that closes a
  write-only data flow. It lands with CP-NODE-15, whose scope owns the file.

## Immediate next

1. **Unblock CP-NODE-6**: fix the two defects on `wip/cp-node-6-blocked`, re-review, re-attest
   against the final staged tree, then land on `main` and ingest. Its workload binding is already
   prepared at the current HEAD.
2. **Then CP-NODE-3 → 5 → 15 → 24 → 26** in dependency order (`next-step` derives the frontier;
   CP-NODE-26 and 5 unlock together after 6).
3. **Before the close phase**, resolve the evidence-triple envelope gap above.
4. **A consolidated pass is queued** in the backlog: the wave's deferred durable tests, the
   owner-decided registry deletion, the emission-scaffold type lift, and the per-node review
   residuals — all seven entries are at the top of [`open-bugs.md`](backlog/open-bugs.md).
5. **The three decisions in section 4 are settled and waiting to be built** — the write-scope
   resolver fix retires the manual widening step, so it is worth doing early.

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 0 pinned item(s).

### ▶ Next up — pinned in the backlog

*(nothing pinned — no immediate next step is set. Every open item is in [`docs/backlog/`](backlog/).)*

<!-- END GENERATED ROADMAP -->
