# Dirty-tree + nightly-answer reconciliation — 2026-07-28

State assessment after a quota-exhausted sprint was continued in Codex/AGY, and after the nightly
maintenance routine's questions were answered by the owner.

## Verdict

**The tree is not confused — it is coherent, green, and incomplete.** Nothing needs recovery or
reverting. The single real problem is a *lost-work* hazard in the nightly ledger, not in the code.

- Branch `main` is level with `audit-tools/main` at `97f26766`. No strand, no divergence, no
  half-landed commit.
- The 15 modified + 3 untracked files form **two self-contained clusters**, both complete.
- Full gate sweep passes on the dirty tree: `build`, `check`, `check:deadcode`,
  `check:doc-manifest`, `check:nightly-routine-prompt`, `check:handoff-roadmap`,
  `check:backlog-index`, `check:backlog-budget`, `check:backlog-status`,
  `check:memory-citations`, `check:constitutional-doc-paths`, and the four touched suites
  (60 tests).

## What is in the working tree

### Cluster 1 — the nightly scheduler prompt becomes generated

`docs/nightly-routine-prompt.md` was a hand-maintained operational summary of
`docs/nightly-routine.md` + `docs/doc-review-guidelines.md`, kept honest by a precedence rule
("conflicts resolve in the sources' favor"). It had drifted into banning the shared helper its own
sources require — the second-copy failure this project bans.

It is now WHOLE-FILE generated:

- `scripts/check-nightly-routine-prompt.mjs` (new, 140 lines) — generator + `--write`.
- `check:nightly-routine-prompt` wired into `verify:checks` (`package.json`).
- Pre-commit gate section `2b-i` fires on either source, the target, the generator, or
  `package.json` — so drift is refused at commit, not first in release CI.
- `scripts/doc-manifest-data.mjs` / `docs/doc-review-guidelines.md` move the file out of
  *meta-tooling* into a new **generated scheduler prompt** row, `autoApply: No — generator-owned`.
- `tests/shared/nightly-routine-prompt-gate.test.mjs` (new, 307 lines) + doc-manifest gate tests.

Also in this cluster: the doc-manifest pre-commit trigger widened to fire on
`scripts/doc-manifest-data.mjs` itself (a trigger narrower than its check plants violations the
gate never runs on).

### Cluster 2 — `reviewSnapshot.ts` worktree lifecycle

Two independent defects fixed in `src/shared/providers/reviewSnapshot.ts`:

1. **Ancestor-repo escape.** `createReviewSnapshot` only asserted `--is-inside-work-tree`, which
   succeeds when `root` is a *subdirectory* of a repo — the worktree then lands in the ancestor.
   Now compares `--show-toplevel` against `root` through a `canonicalPathKey` (realpath +
   Windows case-fold) and refuses with a reason.
2. **Global `git worktree prune` clobbered siblings.** A concurrent node between deleting and
   recreating its own directory had its live registration silently dropped. Replaced with a
   retried path-scoped `worktree remove --force`; the vanished-directory case now also clears its
   registration instead of stranding it (which made the next `worktree add` at that path fail).
   A `runGit` parameter is a narrow test seam.

Covered by `tests/shared/review-snapshot.test.mjs` (+105 lines).

### Doc/backlog updates (consistent with both clusters)

- `docs/audit-pkg/release.md` — corrects a false claim: linked-install smoke IS in `verify:release`.
- `docs/backlog/open-bugs.md` — deletes the shipped stale-worktree-prune entry; rewrites the
  branch-strand entry from a warning into a **landing-worktree plan** with a red-first contract;
  adds this lap's five-item friction walk; adds the OWNER CALL below.
- `docs/HANDOFF.md` — regenerated roadmap (102 → 103), drops the two now-closed trap warnings.

## The one thing that needs a decision

**`intent-equivalence-verdict.json` retirement collision.** Nightly `docs-3` approved registering it
in `ARTIFACT_DEFINITIONS`; `/design-check` then found the DD-9 design explicitly retired a persisted
verdict-pair cache, and runtime matches the retirement (staged under `incoming/`, validated,
unlinked; the executor materializes into `artifact_metadata.intent_baseline` and reports
`artifacts_written: []`). Recorded in `open-bugs.md` and pinned as HANDOFF's next item.
Choose (a) durable audit attestation — never replay authority, no staleness-DAG edge — or
(b) keep staging-only and correct `spec/audit/artifact-contract.md`.

## The lost-work hazard — answered, not executed

`node scripts/nightly/answer.mjs --list` reports **"No open nightly items."** The ledger is
answered-and-empty, so **nothing will re-surface these**. But of the 18 determinations settled
2026-07-28T17:39–17:47, only the two clusters above were executed. The following carry an owner
answer and have **no corresponding change at HEAD or in the tree**:

| Subject | Answer | Target | State |
|---|---|---|---|
| HANDOFF is the all-open roadmap, not immediate-next-only | revert generator to immediate-next-only; empty if no priority item | `scripts/shared/generate-handoff-roadmap.mjs` | not started |
| Dead relative links (5 at HEAD, 3 self-inflicted) | build the approved `check:doc-links` gate, fix together | `scripts/check-doc-links.mjs` | **file does not exist** |
| Dependency-map producer table missing a writer | investigate which of add-the-row / stop-the-second-writer fits | `spec/audit/dependency-map.md` | not started |
| Dispatch spec describes an asymmetry a shared hoist removed | rewrite the passage | `spec/audit/dispatch-admission-control.md` | not started |
| `src/adapters` → `src/audit/adapters` | fix | `spec/contract-authoring-determinism-design.md` | not started |
| Dated "fixed on <date>" fragments in timeless specs | de-status to timeless | `spec/backend-identity-axes.md` | not started |
| Per-release checklist living in `spec/` | fold into `release.md` or move to a non-spec home | `spec/host-validation.md` | not started |
| Deferred-file status noise ("No longer deferred" still in it) | fix | `docs/backlog/deferred.md` | not started |
| Two traps now test-enforced; deletion rule says "tool call" | delete them, rephrase the rule | `docs/backlog/durable-traps.md` | not started |
| Two half-closes (direct spawns, 419 untypechecked tests) | narrow the claims | `docs/backlog/durable-traps.md` | not started |
| Dropped dispatch lane is a stderr line, not a value | apply the sibling path's existing fix | `src/shared/quota/apiPool.ts` | not started |
| `--schema` only read in leading position | change it | `~/.claude/llm-call.mjs` | **still `while (argv[0] === …)`** |

Partially executed: the bare-line-number citation policy and the three code-proven-shipped deletions
landed only for `open-bugs.md`; `deferred.md` and `durable-traps.md` were not swept.

### Two answers were questions back to the owner, not decisions

- **`.mjs` → `.ts` test conversion** (`tsconfig.test.json`): "I'm tempted to say convert over time,
  but if you have objections I'd like to hear them." The gate typechecks 141 of 560 test files;
  `checkJs:false` silently excludes every `.mjs` test.
- **Offload-lane serialization** (`~/.claude/CLAUDE.md`): "The local offload proxy shouldn't need to
  be serialized. Only NIM has been giving us issues." — asks for the claim to be narrowed or
  justified.

Both are recorded as `settled` in `.claude/nightly-decisions.json`, which means the queue will
never raise them again even though neither has an executable answer.

## Root cause — and it is already logged

Friction items (1) and (2) of this lap's walk name exactly this failure:

- `.audit-tools/nightly/open-items.json` is **stale by construction** — answering writes to
  `.claude/nightly-decisions.json` and never reconciles the queue file, so the two disagree and the
  file is the one an agent finds first.
- An answered determination is **free prose with no machine-readable work shape**, so executing one
  means re-deriving its target file from the eli5 text. Answering and executing are separate acts
  with no ledger linking them — a settled item with no diff is indistinguishable from a done one.

The `settled` disposition currently means "the owner replied," not "the work landed." That is why
twelve answered items are invisible.
