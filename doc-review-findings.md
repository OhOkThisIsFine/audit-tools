# Doc-review findings — 2026-06-30 (run 9)

Run against main HEAD `bfe15b9` → pushed to `752eab0` after applying 3 commits.

---

## FYI — auto-applied this run

Three commits pushed to main (discrete and revertible):

| Commit | Summary |
|---|---|
| `ed64fad` | `docs/backlog-remediation-design.md` — remove D7 shipped-entry marker (`DO_NOT_TOKEN_WRAP_NOTE` ✅ DONE 2026-06-28). Symbol confirmed absent from `src/`. Status-noise in a timeless concept doc; deleted per shipped-entry deletion rule. |
| `fb337af` | `docs/HANDOFF.md` T6 item 17 — remove "+ gated Codex e2e". Codex dispatch e2e completed in v0.30.48 and superseded by `provider-matrix-dispatch-e2e.test.mjs` (`RUN_PROVIDER_MATRIX_E2E=1`). A7 remaining = manual GUI checklist only. |
| `752eab0` | `spec/host-validation.md` — update stale Codex e2e run instruction from `RUN_CODEX_E2E=1 …a7.test.mjs` to `RUN_PROVIDER_MATRIX_E2E=1 …provider-matrix-dispatch-e2e.test.mjs`. Former gate superseded; the provider-matrix file's own header says it "supersedes the former per-provider gated tests (the a7 codex dispatch e2e…)". (Missed by reviewer; caught by adversary.) |

**Previously-open items resolved this run (closed, no longer escalated):**
- D-8 — `spec/self-scaling-pipeline-design.md` "not in manifest": the guidelines §Scope `spec/**/*.md` row explicitly covers it as a soft-reviewed scope row. No registration gap.
- D-9 — `.audit-tools/remediation-report.md` in git: the guidelines §Scope `excluded` row now explicitly lists this file as "runtime run-artifact — a remediate-code run output, not a durable doc; tracked but never reviewed." Already handled.
- D-10 — HANDOFF multi-step roadmap vs "immediate-next-only": the guidelines §Scope `handoff` row explicitly says "NOT immediate-next-only." T1–T6 roadmap is sanctioned. Not a conflict.
- D-11 — backlog "Still open:" sub-bullet forms: confirmed absent — `ec693b2` (disambiguation cleanup) trimmed all partial entries. The specific sub-bullet forms described in D-11 are gone.
- N-2 — `spec/contract-authoring-determinism-design.md` preamble dated origin note: the "Grounded in a full hand-driven contract-pipeline run (2026-06-14)" text is **absent from the current preamble**. Lines 2–4 read only `> **Status:** durable design strategy (concepts + mechanisms + plug-in points). Companion to \`spec/remediation-workflow-design.md\`.` The only "2026-06-14" occurrence (line 39) is substantive design rationale, not status-noise. Adversary REFUTED; direct check confirmed.

**Docs reviewed, no new issues beyond open items below:**
- `CLAUDE.md` — policy; verified no factual staleness
- `AGENTS.md` — verified clean
- `README.md` — commands/paths verified
- `docs/documentation-philosophy.md` — timeless concept doc; clean
- `docs/backlog-remediation-design.md` — D7 marker removed this run; remaining rows verified vs code
- `docs/glossary-ids.md` — INV-SOO, INV-PHASE-01, INV-RS-09 verified in source
- `docs/quota-dispatch-design.md` — cross-refs verified
- `docs/end-of-sprint-report-template.md` — template-only; clean
- `docs/audit-pkg/{product,contracts,development,operator-guide,release}.md` — all reviewed clean
- `spec/remediation-workflow-design.md` — durable design doc; clean
- `spec/contract-authoring-determinism-design.md` — N-2 resolved; preamble clean; line-39 date is substantive content
- `spec/cross-provider-quota-matrix.md` — external API claims; no verifiable code changes
- `spec/self-scaling-pipeline-design.md` — D-8 resolved; clean concept doc
- `spec/remediate/remediation-goals.md` — clean
- `spec/audit/{state-machine,audit-goals,dependency-map,artifact-contract,entrypoint-contract,executor-catalog,orchestration-policy}.md` — all reviewed clean
- `spec/host-validation.md` — Codex e2e instruction updated this run; checklist table structure correct
- `docs/HANDOFF.md` — "gated Codex e2e" removed this run; N-4 below
- `docs/backlog.md` — D-11 resolved; clean open-work set; no shipped entries found
- Skills/prompt/agent/template `.md` files — no changes; verified clean
- `src/audit/adapters/README.md`, `examples/README.md` — verified

---

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)

_(none this run)_

### Design decisions for you

- [N-3] `spec/audit-workflow-design.md` — two section headers embed date stamps in a timeless design doc: `## Cross-tool alignment (added 2026-06-10)` and `## Hardening decisions (adversarial review, 2026-06-10)`. Per the philosophy, durable design docs carry concepts not provenance dates. Proposal: strip the `(added 2026-06-10)` and `(adversarial review, 2026-06-10)` parentheticals from the section headers, leaving the concepts intact. This is a design-decision (editing a spec file's structure) → awaiting your call. If you approve, it's a narrow auto-apply in the next run.

- [N-4] `docs/HANDOFF.md` lines ~12–139 — contains 10+ "Prior lap (YYYY-MM-DD): …" narration blocks detailing completed work across multiple laps. These are changelog creep; the guidelines say "Flag changelog creep (narrated already-shipped work)." The entries narrate shipped sprints rather than contribute to the open-work roadmap. Proposal: trim all "Prior lap" narration entries, keeping only the T1–T6 open-work roadmap, the "Why this order" section, and the legend. This is a large structural edit to HANDOFF; awaiting your call on whether to proceed autonomously or manually.

- [MISSED-B] `src/audit/README.md` — the file reads "Implementation code will live here. Suggested early modules: ingestion, extractors, analyzers, orchestrator, coverage, reporting, schemas." This is a stale project-scaffold placeholder from before the package was implemented. `src/audit/` now contains full real implementation. Proposal: either delete the README or replace with a short accurate module index. Design decision about content → awaiting your call.

### Doc-set condensation

_(no new proposals this run — corpus structure stable; D-8/D-9/D-10 carry-forwards resolved)_
<!-- DOC-REVIEW-OPEN:END -->
