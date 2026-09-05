# Condensation review — 2026-09-05

**Leg 1, perspective 2 (doc-set) and the entry-level pass. Every finding here is a
design-decision → escalate. Nothing was applied.**

Two of the five are raised as inbox items tonight (A2 and B1). The other three are
recorded here rather than raised, so a later pass finds them instead of
rediscovering them; they are not closed and not refuted.

## Backlog file sizes at HEAD (context only, never the reason a proposal is raised)

| File | Lines |
|---|---|
| `docs/backlog/open-bugs.md` | 1016 |
| `docs/backlog/durable-traps.md` | 978 |
| `docs/backlog/minor-bugs.md` | 522 |
| `docs/backlog/forward-tracks.md` | 224 |
| `docs/backlog/deferred.md` | 47 |

Corpus scanned: 89 tracked `*.md` under `docs/` and `spec/`, of which 49 are dated
`docs/reviews/*` records excluded by construction.

---

## RAISED TONIGHT

### A2 — the ingestion-verification check list lives in three docs and has already drifted into three different lists

- `docs/audit-pkg/contracts.md:48-56` names run id, work-item id, prompt digest,
  **result path**, assigned file coverage with current total-line counts, finding
  and lens consistency, repository containment, append-time idempotency.
- `docs/audit-pkg/operator-guide.md:45` names run id, work-item id, prompt digest,
  expected file coverage, and **strict result schema**.
- `spec/multi-ide-concurrent-runs-design.md:18` names **workload version**, run id,
  work-item id, prompt digest, and declared task or finding coverage.

Only one names `result path`, only one names the schema, only one names the
workload version. Nothing reconciles them, so a new check lands in whichever the
author happened to open. This is the predicted drift, already realized.

**Proposed:** one home keeps the enumeration; the other two state the property and
point at it.

**The routing question is genuinely open, and it is the owner's.** The obvious home
is `contracts.md`, but `spec/` is the normative corpus and `docs/audit-pkg/` is
described in the manifest as paging the normative `spec/audit/*` — so folding a
spec rule into a package doc inverts the normativity. The correct home may instead
be `spec/audit/artifact-contract.md`, which is in the constitutional set
(`src/shared/constitutionalDocPaths.ts`) and therefore an escalate-only edit.

### B1 — three friction-walk entries each carry a "guards that fired CORRECTLY" enumeration with no open property

`docs/backlog/open-bugs.md:584-590`, `:609-613` and `:628-634` each hold a
sub-item `(4)` listing guards that behaved as designed, roughly five lines each.
Five further sub-items state `ambiguous-direction: none` (`:569`, `:596`, `:619`,
`:636`, `:698`) — a record of the absence of a problem.

**Proposed:** delete sub-item `(4)` from all three walks and the bare `none`
sub-items, keeping only sub-items that state an open property or an unfiled
defect, and keeping the two live cross-references as one line each. Roughly 20
lines out of `open-bugs.md`, with no property lost.

**The argument against, stated fairly:** the enumeration's own purpose is
defensive — *"recorded so they are not mistaken for friction"* — so deleting it
removes that immunity. The counter is that the immunity is per-lap while the
guards are permanent, so the record must be rewritten every lap to keep working.
That is a mechanism made of repetition, and the confusion it guards against is
better answered once in `durable-traps.md` than three times in the defect list.

---

## RECORDED, NOT RAISED TONIGHT

### A1 — the language-analyzer policy is stated twice, near-verbatim, in two docs of the same manifest row

`docs/audit-pkg/product.md:69-110` (*Language strategy*) and
`docs/audit-pkg/development.md:60-100` (*Adding language analyzers*) state the
same three policies in different words: do not add a bespoke parser per
ecosystem; keep the fallback useful and make command-backed runners
project-config aware; keep semantic affinity low-authority so it cannot merge
packets on frequency alone.

The wordings have already diverged. product.md's test is *"concrete repository
demand or a high-value deterministic signal"*; development.md's is *"common in
expected repositories … direction or ownership that path heuristics cannot"* —
two tests for the same decision.

**Proposed:** product.md is the home; it already declares that pattern for the
installer-verb list. Replace development.md's policy prose with a pointer plus the
genuinely dev-facing residue (its *Preferred outputs* list, which product.md does
not carry).

**Argument against:** the two docs have different readers, and the person about to
write an analyzer is exactly the one who most needs the constraint in front of
them rather than one link away.

### B2 — the nightly-queue entry carries a post-mortem tail whose only durable content is one clause

`docs/backlog/open-bugs.md:228-245`. The entry states its mechanism and property
at `:228-239`, then appends the story of one lap. Proposed shorter form, keeping
the consequence that makes the severity legible:

> The predicted damage was confirmed live: a lap worked six settled items from the
> snapshot, and one answer would have reverted a completed decision. `start-lap`
> now reads `answer.mjs --list`, so the walked path is closed; the snapshot's own
> freshness gate is still the fix.

### B3 — a dissolved-premise entry carries 14 lines of refutation and 4 lines of live question

`docs/backlog/minor-bugs.md:380-397`. The title refutes the entry's own former
premise and the body is the investigation that produced the refutation. The live
remainder is a single open trade-off: the bare-name citation rule skips any token
whose extension no tracked file uses, which correctly excludes non-file tokens
(`vi.spyOn`, `claude.exe`) and at the same time hides file-shaped non-repo
mentions such as `server.log`.

**Proposed:** retitle to the open question and keep the `e38616f9` evidence, so
the refutation stays checkable rather than merely asserted.

---

## Deliberately not proposed

- The eight retired-FreeLLMAPI entries in `durable-traps.md` are stale by that
  file's own standard, but `docs/backlog/open-bugs.md:79-89` already tracks this
  with an agreed property. Re-raising it is the repetition this pass hunts.
- `spec/self-scaling-pipeline-design.md:20-27` carries retrospective narrative in
  a doc whose preamble bans dated status — but `durable-traps.md:892` records that
  PH-02 re-proposed collapsing exactly those phases and was refused, so naming the
  dead fork is doing the *a REJECTED option stays only when naming it prevents the
  proposal being raised again* job.

No finding here rests on an unverified "it shipped" claim; no deletion is proposed
on shipped grounds.
