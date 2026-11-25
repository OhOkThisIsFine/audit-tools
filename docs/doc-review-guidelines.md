# Doc-review — routing table

The routing table for every tracked doc: its type, the check that applies to it, and whether a
reviewer may apply a fix alone or must escalate it to the owner. The nightly doc-review routine
that once applied a longer rubric here is retired (owner, 2026-11-16); this table stays because
`check:doc-manifest` reconciles it against the tree, and because it still routes any manual doc
review. This file is **excluded from its own review**.

[`documentation-philosophy.md`](documentation-philosophy.md) is the doc-shape rubric and
[`project-philosophy.md`](project-philosophy.md) is the content-conformance rubric. When this table
and either philosophy conflict, the philosophy wins and this table is the thing to fix.

## Constitutional docs

Some docs are **normative**: they state what this project IS, not what its code currently does.
A goals doc (`spec/audit/audit-goals.md`, `spec/remediate/remediation-goals.md`) enumerates the
obligations, phases and executors its area must satisfy, so a registry entry the doc omits, or a
doc entry the registry no longer has, is a **design decision → escalate**. A goals doc is never
silently rewritten to match code.

Saying "never silently rewritten" did not stop it: commit `6fc2e453`, a routine doc-review sweep,
rewrote `spec/remediate/remediation-goals.md` along with eight other files. A label is not a
refusal. The normative set is therefore enumerated in **`src/shared/constitutionalDocPaths.ts`**
(generated for the hooks into `scripts/shared/constitutional-doc-paths.generated.mjs`,
parity-checked by `npm run check:constitutional-doc-paths`), and
`.claude/hooks/commit-gate.mjs` (git's own `pre-commit` hook, via the tracked `.githooks/`) **blocks
any commit whose staged set touches one of those paths** unless a fresh, staged-tree-bound override
record exists:

```
node scripts/attest-constitutional-doc-change.mjs --reviewed-by <id> \
  --attester-class agent|human --owner-decision "<the owner's call, and where it was escalated>"
```

The override is modelled on the loop-core review attestation: bound to the exact staged tree (any
restage invalidates it), required to name who issued it, and recorded as an attributable artifact.
It records that an owner decision was taken; it cannot verify one — that is the honest limit, and
it is why the list stays narrow. Which docs are constitutional is **derived from this manifest's
own normative rows**, never guessed; the derivation is written out in the module header.

## Scope — every doc, routed by type

All `*.md` under the repo, **recursively**, except the exclusions. Each doc gets
the check for its type:

<!-- BEGIN doc-manifest table — generated from scripts/doc-manifest-data.mjs -->

| Type | Files | Check | Auto-apply? |
|---|---|---|---|
| **design / concept** | `docs/documentation-philosophy.md`, `docs/project-philosophy.md`, `docs/glossary-ids.md`, `docs/end-of-sprint-report-template.md` | Claims vs code (drift); flag current-state / changelog creep (docs are timeless concepts, not status). `project-philosophy.md` is an orienting **map** (product-vs-development split) that points at each conviction's canonical home — verify its one-line restatements still match those homes; it deliberately references, never re-owns, so a home change makes its pointer stale, not the home. | factual-stale → yes |
| **instruction / policy** | `CLAUDE.md`, `AGENTS.md` | Factual claims only (file/command/path staleness). Policy & conventions untouchable. | **No — escalate-only.** Highest blast radius: a wrong edit deletes a guardrail governing all agents. |
| **ops / usage** | `README.md` | Do the documented commands / paths still resolve and run. | factual-stale → yes |
| **package docs (audit)** | `docs/audit-pkg/product.md`, `docs/audit-pkg/contracts.md`, `docs/audit-pkg/development.md`, `docs/audit-pkg/operator-guide.md`, `docs/audit-pkg/release.md` | Claims vs code/spec (these page the normative `spec/audit/*`); flag current-state / changelog creep. | factual-stale → yes |
| **backlog** | `docs/backlog.md`, `docs/backlog/open-bugs.md`, `docs/backlog/minor-bugs.md`, `docs/backlog/forward-tracks.md`, `docs/backlog/deferred.md`, `docs/backlog/durable-traps.md` | Shipped-detection (a fully-shipped entry is **deleted outright**, never kept as a `SHIPPED`/`FIXED`/`DONE` marker; a partial entry is **trimmed to its open remainder**); dedup near-identical raw items. Durable-traps section is **reference** — only flag a trap proven fixed-in-tooling. | shipped-removal & dedup → yes; a new design direction → escalate |
| **handoff (sequencing view)** | `docs/HANDOFF.md` | Current published state + immediate next only (sanctioned per the philosophy's HANDOFF row). The roadmap block is generated from `▶`-pinned backlog entries. Never hand-edit the generated block. Flag **changelog creep** and per-item specs duplicated from their authoritative backlog source; verify hand-written current state against code and clear stale state with proof. | hand-written state → yes; generated block → generator only |
| **design / concept (`spec/`)** | `spec/**/*.md` (the normative design corpus — workflow designs, contracts, goals docs; routed by pattern, so a new spec is registered the moment it lands. A `*.generated.md` sibling is NOT part of that corpus — see the check column) | Claims vs code (drift); flag current-state / changelog creep (durable design only). A `> **Status:** <type-declaration>` preamble identifying the kind of design artifact is permitted; a dated/versioned status string in it is still status-noise → escalate. The goals docs and the `spec/audit/*` contracts are **normative** — see *Constitutional docs* below and the constitutional-doc refusal in `src/shared/constitutionalDocPaths.ts`: a change to one is a design-decision → escalate. A `spec/**/*.generated.md` file is a whole-file generator render (its banner names the generator) — never hand-edit it; a stale claim there is a stale SOURCE, fixed by editing the source and re-running the generator, and its `check:` gate refuses the commit otherwise. | factual-stale → yes (except the constitutional subset — escalate-only; `*.generated.md` — generator only) |
| **excluded** | `docs/doc-review-guidelines.md` (this routing table — excluded from its own review), `docs/reviews/audit-final-refactor-plan.md` (finalized bounded refactor execution plan; qualification remains separately gated), `docs/reviews/*-<date>.md` (dated review / plan / diagnosis / dogfood records — excluded BY CONSTRUCTION. Each is a one-off record of what was decided on a day, never a timeless concept; the durable outcome lives in `spec/`, the backlog, or project memory. This pattern replaced a 21.5k-character exhaustive list that grew every lap), `.audit-tools/nightly/proposals/**/*.md` (nightly leg-3 proposal records — the full analysis behind an escalated item (recurrence evidence, proposed mechanism, false-positive surface). TRACKED so a proposal outlives the machine that produced it, but excluded BY CONSTRUCTION for the same reason as a dated review: each is a one-off record of a proposition as it stood that night, never a timeless concept. They deliberately cite paths that do not exist — a file the proposal proposes CREATING, or one deleted since — so reviewing them for staleness, or citation-checking them, would be checking a historical record against a present tree. Accepted outcomes land in code, `spec/`, the backlog or memory; the record stays as provenance), `.audit-tools/audit-report.md` (runtime run-artifact — an audit-code run output per `CLAUDE.md`'s Artifact layout; tracked but never reviewed), `.audit-tools/remediation-report.md` (runtime run-artifact — a remediate-code run output per `CLAUDE.md`'s Artifact layout; tracked but never reviewed), `tests/audit/fixtures/simple-app/README.md` (test-fixture content — a sample-app README, its own concern, not a project doc), `tests/fixtures/type-coverage-2.29.7/README.md` (test-fixture provenance and reproduction instructions for the pinned analyzer contract), `tests/remediate/fixtures/audit-guidance-real-mixed.md` (frozen guidance input for mixed audit provenance regression tests, not a project document) | — | — |
| **generated host assets** | `.agent/skills/audit-code/SKILL.md`, `.agent/skills/remediate-code/SKILL.md`, `.github/agents/auditor.agent.md`, `.github/agents/remediator.agent.md`, `.github/copilot-instructions.md`, `.github/prompts/audit-code.prompt.md`, `.github/prompts/remediate-code.prompt.md` | ONE canonical body rendered per-IDE (`CLAUDE.md` B5); **not hand-edited** — governed by renderer drift tests (`tests/audit/host-asset-renderer-drift.test.ts`, `tests/remediate/host-bootstrap-descriptors-remediate.test.ts`, `tests/remediate/install-repo-assets.test.ts`). Review the canonical source, not the generated copy; a diff = a drift-test/renderer gap, not a doc edit. | **No — renderer-owned.** |
| **canonical loader bodies** | `skills/audit-code/SKILL.md`, `skills/audit-code/audit-code.prompt.md`, `skills/remediate-code/SKILL.md`, `skills/remediate-code/remediate-code.prompt.md` | HAND-AUTHORED sources, not generated output — the arrow points OUT of `skills/`: the renderer drift tests read these as the canonical body and assert the `.agent/**` and `.github/**` copies equal a fresh render of them, and `scripts/audit/postinstall.mjs` copies one outward as its literal prompt source. Nothing writes into `skills/`. Review them like any other doc — in particular the CLI invocations and flag literals they carry, which no other reviewer checks. Run `npm test` after editing (the drift tests will fail until the generated copies are re-rendered). | Yes — with the renderer drift tests re-run. |
| **meta-tooling / dev-workflow** | `.claude/skills/design-check/SKILL.md`, `.claude/skills/disambiguate-backlog/SKILL.md`, `.claude/skills/ship/SKILL.md` | Standalone dev-workflow how-to; do the documented commands/paths still resolve. | factual-stale → yes |
| **package READMEs (non-`docs/`)** | `src/audit/README.md`, `examples/README.md` | Claims vs code; do documented commands, paths, provider-neutral host-workload contracts, and result-ingestion boundaries still resolve. These docs must not reintroduce a provider registry, execution adapter, or quota surface. | factual-stale → yes |

<!-- END doc-manifest table -->

**The table above is generated.** Its source of truth is `scripts/doc-manifest-data.mjs`
— edit the data and re-render (`node scripts/check-doc-manifest.mjs --write`); a
hand-edited table fails the gate. The manifest is held as data so that a path can only be
*registered* by being listed as a path: prose that merely names a doc — including the
rationale text inside a row — can never be mistaken for an entry, which is how
`remediation-report.md` became "registered" by a passing mention and how a row pointing at
a file deleted eight weeks earlier survived.

Every tracked `*.md` **anywhere in the repo** must match exactly one row (the `excluded`
row counts). This is mechanically reconciled by `scripts/check-doc-manifest.mjs` (run in
`verify:checks`, so it gates CI and every release): a doc no row matches **fails the
build**, an entry whose file is gone fails, a pattern that matches nothing fails, and a
hand-edited table fails. The existence check has **no per-row exemption** — the `excluded`
row used to have one, which is how a row pointing at a file deleted eight weeks earlier
survived. So a stray doc can never merge silently and the manifest can never drift from
the filesystem. A doc that exists but matches no row → **escalate** ("register here with a
reason / fold in / retire"), never silently treated as design/concept.

Rows carry **patterns**, not just paths (`*` within a segment, `**/` across segments, `?`
one character, `<date>` an ISO date with an optional lap suffix). That is what lets
`docs/reviews/*-<date>.md` state the rule — *a dated review record is excluded by
construction* — instead of enumerating them; the exhaustive list it replaced had reached
51 entries and 21.5k characters in a single table cell, and grew every lap.
