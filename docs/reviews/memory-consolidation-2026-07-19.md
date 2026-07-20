# Memory consolidation pass — 2026-07-19

A disambiguate-backlog-style pass over the project memory store
(`~/.claude/projects/C--Code-audit-tools/memory/`, 149 files + index). Every verdict was validated
against HEAD (`e9be0ba0`) rather than against the memory's own prose.

**Backup before mutation:** `…/scratchpad/memory-backup-e9be0ba0/` (150 files). The memory dir is not
a git repo — deletions there are otherwise irreversible.

**Result:** 149 → 136 files. 14 deleted, 1 added, 28 corrected or compressed, index rebuilt to zero dangling
entries and zero unindexed files.

## The headline finding: a structural refactor silently invalidated 17 memories

The single-package collapse (monorepo `packages/*` + `auditor-lambda`/`remediator-lambda` →
one `audit-tools` package, bins at repo root, `audit-tools/shared` subpath) left **17 memory files
citing paths and package names that no longer exist**.

This mattered more than ordinary staleness because the affected files were disproportionately the
**trap and recovery memories** — the ones a session consults precisely when it is confused and least
able to detect bad instructions. Their recovery procedures were *runnable and wrong*:

| Memory | What it told a future session to run |
|---|---|
| `audit-tools-worktree-traps` | `npm run build -w @audit-tools/shared && npm run build -w packages/audit-code` |
| `audit-code-global-bin-traps` | `npm rm --global auditor-lambda`, `npm approve-scripts auditor-lambda` |
| `remediate-code-dogfooding-trap` | dev wrapper at `packages/remediate-code/remediate-code.mjs` |
| `remediate-code-entrypoint-and-ensure-eperm` | asserted repo-root invocation FAILS — the inverse of current truth |
| `submit-packet-json-array-trap`, `audit-worker-submit-packet-shell` | `node packages/audit-code/audit-code.mjs submit-packet …` |
| `end-of-sprint-cleanup-standing-step` | run remediate vitest FROM `packages/remediate-code` |

All corrected in place, except `remediate-code-entrypoint-and-ensure-eperm` (deleted — its entrypoint
half was inverted, its EPERM half already lives in `remediate-code-dogfooding-trap`).

**Generalizable rule:** a structural refactor needs a memory sweep the same way it needs a code sweep.
Grep the store for the retired path/package/symbol names as part of the refactor, not a year later.
This is `fix-the-defect-class-not-the-named-instance` applied to memory.

## Superseded-direction memories — the most dangerous class

Three memories described a direction that was later **reverted or falsified**, while still reading as
the current goal:

- `parallel-dispatch-overlapping-files-is-goal` — the superseding memory
  (`parallel-dispatch-optimistic-not-anchors`) says outright that the semantic-anchor design was
  falsified as infeasible and that this file is superseded. Deleted.
- `multi-ide-concurrent-runs` — described per-run **isolation** namespaces as the target. The design
  memory records that isolation was "a first draft that solved the OPPOSITE and was reverted"; the
  real goal is cooperative joining. Deleted.
- `auditor-remediator-mirroring-is-common-logic` cited CLAUDE.md's *"Keep orchestrators in parity"* —
  a rule since **inverted** (current text: "NOT two forks kept 'in parity'"). Corrected in place.

A superseded-direction memory is worse than a stale one: staleness merely wastes a check, but a
reverted direction actively steers work the wrong way.

## Deleted (14)

Changelog-only or superseded: `a12-single-package-collapse-done`, `remaining-specs-quickwins-remediation`,
`resume-list-dogfood-fixes-progress`, `rolling-implement-windows-and-writescope-findings`,
`rolling-implement-writescope-verify-seam-defects`, `remediate-verify-runner-mjs-vitest-bug`,
`remediate-verify-spawn-no-shell-windows`, `stale-remediation-report-complete-redelivery-trap`,
`ambiguity-step-deemed-inappropriate-drops-finding`, `audit-code-feature-roadmap`,
`remediate-code-entrypoint-and-ensure-eperm`, `parallel-dispatch-overlapping-files-is-goal`,
`multi-ide-concurrent-runs`, `live-status`.

`live-status` was an owner call: it duplicated HANDOFF's *Live state* and had to be hand-updated every
release to stay true. Its 8 inbound `[[live-status]]` links were retargeted to `docs/HANDOFF.md`.

## Factual corrections found by verification

Two Codex read-only verification passes (33 claims, file:line evidence) against HEAD:

- **`a3-a4-engine-unification`** stated the cycle-detection key as `artifact-sig|obligation|executor`.
  Actual order is `artifact-sig|executor|obligation` (`src/audit/cli/nextStepHelpers.ts:1195`), and
  audit does not pass `stateSignature` into shared `advance` at all (`:1153`). Corrected.
- **`conversation-first-subagent-dispatch-first-class`** listed 4 open items; 3 are done —
  audit's symmetric wiring exists and uses the SHARED engine
  (`src/audit/cli/rollingAuditDispatch.ts`), INV-QD-14 spill is implemented
  (`src/shared/dispatch/rollingDispatch.ts:23`), `rate_limited` is handled
  (`src/shared/dispatch/providerLaunchFinalize.ts`). Rewritten as "since closed".
- **`account-metering-step2-multiconstraint-ledger`** warned the N× over-admission was "STILL LIVE".
  The budget axis closed in v0.33.10; the **cooldown axis** is the live remainder. Corrected so it
  points at the actual open work.

### Incidental finding — CLAUDE.md overstates a gate

CLAUDE.md's *Own-vs-acquire analyzer engine* says every acquired-tool spawn "routes through the single
`admitSpawn` chokepoint and requires the per-run `ExternalAcquisitionConfig.consent_token`."
Verification found `defaultRun` **bypasses** the token requirement — only non-default tools require it
(`src/audit/extractors/analyzers/acquisitionEngine.ts:216-224`). Logged to backlog; not fixed here.

## Compression pass — 29 drafted, 20 applied, 7 rejected as lossy

The dominant defect across surviving memories was a durable kernel buried in dated shipment narrative
("SHIPPED v0.32.x", commit hashes, "Phase A/B/C DONE") — the changelog creep
`docs/documentation-philosophy.md` forbids. The offload lane drafted 29 compressions keeping
decisions/invariants/traps/refuted premises and dropping shipment stamps.

Two files grew slightly; both were quality improvements rather than padding — e.g.
`artifact-token-ordering-derivation` had an `UPDATE` section contradicting its own opening premise, and
the rewrite marks the superseded premise inline instead.

### Aggressive compression is lossy — gate it mechanically, not by eye

The most aggressive draft (`meta-audit-friction-must-be-tool-enforced`, 46% of original) silently
dropped **7 symbol names and a wikilink** — `captureFrictionEvent`, `buildFrictionTriageBlock`,
`free_form_notes`, `validate-artifact`, `[[concurrent-nextstep-staleness-cascade-wipe]]` — despite the
prompt explicitly instructing that symbol names and file paths be kept. Compression ratio turned out to
be a good proxy for content loss, but eyeballing 29 diffs is exactly the host-discretion check that
`enforce-robustness-in-tooling-not-host-discretion` says to replace with a mechanism.

**The gate used:** diff the set of backticked symbol tokens (excluding commit hashes) and the set of
`[[wikilinks]]` between original and draft; reject any draft that drops a member of either set. That
split 29 drafts cleanly into 20 lossless (applied) and 7 lossy (rejected, originals kept uncompressed).
Verbosity is a cosmetic problem; a missing symbol pointer is a broken memory — so the gate fails toward
keeping the original.

Reusable for any future memory/doc compression pass.

**Caveat carried forward:** compression preserves the *content* faithfully, including its staleness.
The `conversation-first-subagent-dispatch-first-class` open-items list was faithfully preserved and was
stale (3 of 4 items long done). Other compressed files may carry similar stale "open" claims not covered
by the 33 verified claims. Treat any "open item" in a memory as a lead requiring a HEAD check
(`backlog-prose-decays-verify-against-head` applies to memory too).

## Verdicts rejected

The offload lane's triage was advisory and ~3 of its 7 obsolete calls were wrong. Rejected:

- `git-remote-and-default-branch` → "self-evident from `git remote -v`". It is precisely the
  non-obvious fact (remote is `audit-tools`, not `origin`) that saves a wrong push. **Verified true**,
  kept.
- `audit-no-redundant-reextraction-verified` → "closed investigation, no action needed". Refutation of
  a plausible hypothesis is durable negative knowledge that prevents re-investigation. Kept.
- `friction-loop-dogfood-cli-traps` → "fixed traps". The CLI contract facts (`--run-id` required,
  merge-validation recovery) are still live. Kept.
- Several proposed merges targeted the wrong file (narrower principle as the merge target, or a
  status file as the home for durable traps). Rejected.

This is `offload-lane-failures-are-usually-the-caller` from the other side: the lane produced
review-grade analysis, but its conclusions still need verification before they mutate anything.

## Method

- Deterministic first: orphan/dangling-link detection, retired-name sweep. Found the 16 orphans and
  17-file refactor class before any LLM ran.
- Offload lane (LiteLLM → NIM) for triage + compression, ~10 batches across 5 models.
- Codex `exec --sandbox read-only` for the two HEAD-verification rounds.
- Main context spent on judgment, not file reading.
