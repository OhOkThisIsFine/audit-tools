# Doc-review findings — 2026-06-27 (run 8)

Run against main HEAD `baa7362` → pushed to `f2c956a` after applying 3 commits.

---

## FYI — auto-applied this run

Three commits pushed to main (discrete and revertible):

| Commit | Summary |
|---|---|
| `280104d` | `docs/backlog.md` — delete B-1 (self-scaling pipeline ✅ COMPLETE), B-2 (fail-loud commit-refusal ✅ FIXED), B-3 (convergence-based termination ✅ SHIPPED); remove dead `.audit-tools/phase-status-investigation.md` reference (not tracked in git). `spec/contract-authoring-determinism-design.md` — fix stale companion-doc cross-reference from `docs/remediation-workflow-design.md` → `spec/remediation-workflow-design.md`. |
| `f2c956a` | `docs/backlog.md` — delete "Remediator must mechanically decompose + boundary-enforce" forward-track entry (parent + 2 sub-bullets) — the final sliver (whole-repo test-suite gate at each phase boundary) shipped in `7e60eda`; HANDOFF T3 = ✅ COMPLETE, nothing open. Durable design in `docs/backlog-remediation-design.md`. |

**All previously-open items resolved this run:**
- AF-1 — `AGENTS.remediate.md` deleted; consolidated into `AGENTS.md` — no `remediator-lambda` in current file ✓
- D-5 — `docs/HANDOFF.md` version string gone; HANDOFF restructured ✓
- D-6 — "Last landed" / "Previously shipped" changelog sections gone from HANDOFF ✓
- D-7 — `docs/documentation-philosophy.md` line 27 now correctly references `spec/` as home for design specs ✓

**Docs reviewed, no new issues beyond open items below:**
- `CLAUDE.md` — verified; policy untouched
- `AGENTS.md` — consolidated (no remediator-lambda); verified clean
- `README.md` — commands + paths verified against code
- `docs/documentation-philosophy.md` — D-7 resolved; clean concept doc
- `docs/backlog-remediation-design.md` — design spec; seam contracts + verified invariants present
- `docs/glossary-ids.md` — INV-SOO + new IDs (INV-PHASE-01, INV-RS-09) verified against source
- `docs/quota-dispatch-design.md` — cross-reference links verified
- `docs/end-of-sprint-report-template.md` — template structure only; no code anchors
- `spec/audit/` and `spec/remediate/` files — reviewed; no new staleness
- `spec/remediation-workflow-design.md` — companion ref fixed (N-1); otherwise clean
- `spec/contract-authoring-determinism-design.md` — N-1 stale cross-ref fixed; N-2 below
- `spec/cross-provider-quota-matrix.md` — external API claims; no verifiable code changes
- `spec/audit-workflow-design.md`, `spec/host-validation.md` — reviewed; clean
- `spec/self-scaling-pipeline-design.md` — new doc (pre-existed at `baa7362`; not in ledger until this run); clean durable concept doc — no dated status noise, no current-state prose; D-8 below
- `.audit-tools/remediation-report.md` — run artifact tracked in git; D-9 below
- `docs/HANDOFF.md` — D-5/D-6 resolved; D-10 below (roadmap scope)
- `docs/backlog.md` — shipped entries deleted; D-11 below (sub-bullet trim)
- Skill/prompt/agent/template `.md` files — no changes; verified clean

---

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)

_(none this run)_

### Design decisions for you

- [D-8] `spec/self-scaling-pipeline-design.md` — this doc exists on `main` and was reviewed this run (clean concept doc), but it is not registered in the canonical manifest in `doc-review-guidelines.md` (the manifest covers `docs/**/*.md` in the hard gate; `spec/` files are in soft review scope only). The existence-review smell fires: "a doc not in the canonical manifest → escalate 'register with a type + reason-to-exist, fold into an existing canonical doc, or delete.'" Should `doc-review-guidelines.md` be updated to add a `spec/` section (with type `design / concept`) to the routing table, acknowledging that `spec/` is soft-reviewed but not hard-gated? Or is the current "spec/ is implicitly in scope but not in the manifest" posture intentional? (Background: `scripts/check-doc-manifest.mjs` only gates `docs/**/*.md`, so `spec/` files that drift or accumulate can't be caught by the mechanical gate — only by this routine.)

- [D-9] `.audit-tools/remediation-report.md` — this file is a runtime run artifact (a `remediation-report.md` written on completion of a remediate-code run) that was re-included in git tracking via `.gitignore` changes in `f301acc`. It's now a tracked `*.md` file the doc-review routine picks up. The file is obviously current-state content (a run output), not a durable concept doc. Three options: (a) **exclude it** — add `.audit-tools/remediation-report.md` to the `excluded` row in the manifest, or carve out a `type: run-artifact` exclusion; (b) **treat as `handoff` type** — verify it is accurate and a "done item → clear it, with proof"; (c) **untrack it** — add to `.gitignore`. Which disposition do you want?

- [D-10] `docs/HANDOFF.md` — the doc's own header now reads: *"Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. … This handoff is the *sequencing* view — every open item appears once, in suggested order, with a pointer to its detail."* It carries a full T1–T6 roadmap covering ALL open work across all tracks. The documentation philosophy mandates HANDOFF is *"immediate-next-only; NOT a changelog; multi-step-out roadmap."* These directly conflict. Two questions: (1) Is this an intentional philosophy change — HANDOFF is now sanctioned to carry a sequenced roadmap of everything open, in addition to current state? (2) If yes, should `documentation-philosophy.md` (and the doc-review routing table) be updated to reflect the new "sequencing view" scope? If no, HANDOFF should be restructured back to immediate-next-only (each sliver, one step).

- [D-11] `docs/backlog.md` — four open parent entries have shipped sub-bullets whose bodies contain "Still open:" specifications that define the open remainder. Per shipped-entry policy these sub-bullets should be trimmed, but stripping them without preserving the "Still open" content would silently drop the open-work specification. Each case: (a) "Content-addressed, granular staleness" — sub-bullet: *"SHIPPED 2026-06-25 — O3 re-dispatch… Still open: the general DAG-model extension"*; (b) same entry — sub-bullet: *"Investigation 2026-06-25… The general DAG-model extension is a SEPARATE, larger track… also needs an incremental planning executor"*; (c) "Schema-enforced generation" — sub-bullet: *"Emit-time seam VERIFIED already-present 2026-06-26… Still open: CE-004… and CE-009"*; (d) "Tool-enforced dispatch broker" — sub-bullet: *"Single-source classifier SHIPPED 2026-06-26… Still open: the capability-tiered driver (Y-dispatcher vs slot-pull selection) and proactive pre-wall pacing."* Proposal: for each, move the "Still open" content into the parent entry body, then delete the sub-bullet. But this requires editorial judgment on what context to keep. Should I apply these trims (moving the open-remainder content up) as a stale-factual-fix in the next run, or do you want to do it manually?

- [N-2] `spec/contract-authoring-determinism-design.md` lines 2–4 — the file opens with: `> **Status:** durable design strategy (concepts + mechanisms + plug-in points). Companion to \`spec/remediation-workflow-design.md\`. Grounded in a full hand-driven contract-pipeline run (2026-06-14) + a code map of the current authoring/derivation split.` The `> **Status:** durable design strategy` prefix: is this a permitted type-declaration preamble for `spec/` files (identifying the kind of design artifact), or does it violate the status-noise rule (*"status strings — 'plan of record (2026-06-24)', 'THIS RUN implements…' — escalate not auto-bump"*)? The `durable design strategy` part is not a dated/versioned status, but the `Grounded in a full hand-driven contract-pipeline run (2026-06-14)` part is a dated origin note. Proposal: if the preamble is accepted, drop the dated-run provenance sentence as the only clearly status-noise part. But the whole preamble's acceptability is a design decision.

### Doc-set condensation

_(no new proposals this run — previously-open D-7 resolved; corpus structure otherwise stable)_
<!-- DOC-REVIEW-OPEN:END -->
