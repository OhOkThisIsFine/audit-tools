# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.50.15 is live. HEAD is `ac3939a7` on `main`** — the gate-integrity lap: three defects in the
  enforcement layer itself. The masked-exit refusal keys on a load-bearing EXIT STATUS rather than on
  test runners, so a piped `git push`/`commit`/`merge`/`rebase`/`cherry-pick`/`tag` or `npm publish`
  is refused exactly like a suite (`a5d4a83d`). The attestation checks judge what a commit will
  CONTAIN — a cherry-pick or merge now contributes the paths its named ref INTRODUCES, closing the
  blind spot where a fresh history-moving verb staged nothing and every check read an empty set
  (`35f9b03a`, owner decision). A repo that owns its green mechanism declares it in
  `.claude/green-mechanism.json`, and the machine-wide `verify-green` ledger then DEFERS its `check`
  and REFUSES its `record`, so no second contradicting ledger can exist (`ac3939a7`, owner decision).
  One backlog entry was corrected rather than worked: the cherry-pick escape's stated mechanism was
  false, and the real one is the pre-hoc blind spot above (`3bf45786`).

## Immediate next

**Nothing is pinned.** The queue is the backlog ([`backlog.md`](backlog.md)); the standing
program direction remains *redesign before scheduled autonomy* → the autonomous
audit→remediate→PR capstone once the architecture items are worked off.

The gate-integrity lap left two of its four items unworked, both in
[`open-bugs.md`](backlog/open-bugs.md): the attest preflight judging the STAGED tree with
WORKING-TREE checks, and the added-root-entry teardown check that is not hermetic against a
concurrent session. The first touches the staged-snapshot round-trip machinery, which carries a
documented crash-safety hazard and changed in `f117ac02` — run `/design-check` before editing it.


## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` remains deliberately unbaselined:
  its parallel-load timeout passes alone and is tracked as a known flake, so rebaselining it would
  hide a real regression.
- The detached host runner is intentionally not running.
- The tracked decision-queue snapshot STILL disagrees with the ledger that settles it, and it will
  keep doing so: its writer refuses a batch that drops a record-path item on its own, so no lap can
  quietly true it up. What changed is the consumer, not the artifact — `start-lap` step 5 now asks
  the decision ledger (`answer.mjs --list`) and treats it as the authority (`0ada039a`), because
  trusting the snapshot cost a lap four questions the ledger had already recorded settled AND landed.
  **Ask the ledger. Never read the snapshot for what is open.** The artifact's own freshness gate
  remains the real fix and is stated in full in its [`open-bugs.md`](backlog/open-bugs.md) entry,
  which is its home.
- The item-6 checkJs sweep remains type-only by contract; behavioral changes are bugs, not part of
  that refactor.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

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
