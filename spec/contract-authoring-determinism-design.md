# Making contract/obligation/invariant authoring efficient, robust, and weak-model-safe

> **Status:** durable design strategy (concepts + mechanisms + plug-in points). Companion to
> `spec/remediation-workflow-design.md`.

## 0. The one idea

**Today the LLM authors entire structured artifacts and the tool only checks them afterward.
Invert it: the tool owns structure, IDs, cross-references, derivation, and validation; the LLM
authors only the irreducible *judgment* content, in small pre-scaffolded, write-validated slots.**

Determinism owns *structure*; the model owns *meaning*. Every strategy below is an application of
this inversion. It is the same principle the codebase already commits to — *use the mechanical tool
where it does the job as well as or better than the LLM, and reserve the LLM for the irreducible
judgment* (the project is **not** "100% deterministic"; see CLAUDE.md *"Right tool, not deterministic
dogma"*) — applied to the pipeline's **own** artifact authoring, which is currently the biggest
violation of it: structure/IDs/cross-refs/derivation are exactly the work a mechanical tool does
better, so the LLM should never be authoring them.

Why this is the right axis for "manageable by both weak and strong models": a model's failure
surface today is "produce a large, schema-conforming, internally-consistent JSON artifact from
scratch with correct IDs and cross-refs." That is exactly where weak models thrash and strong
models burn tokens. Shrink that surface to "write one good invariant sentence / one ruling" and
both succeed — the weak model because the structure it could break is gone, the strong model
because it stops re-emitting boilerplate.

## 1. Current reality (grounded)

- **All 13 contract artifacts are 100% LLM-authored.** The backend's role is render-prompt →
  ingest payload → validate → envelope → re-emit-on-failure. The only artifacts any code *generates*
  are the `cyclic_seam_resolution` no-cycles fast path, the post-pipeline `extracted-plan`, and the
  intake `finding-enumeration` (the lone deterministic upstream extraction). Refs:
  `steps/contractPipeline.ts` (`PHASE_TO_ARTIFACT`, `ingestContractArtifacts`),
  `steps/contractPipelinePrompts.ts` (`renderContractPipelinePrompt`).
- **The derivable artifacts are hand-authored anyway.** `obligation_ledger` (one obligation per
  invariant + per seam), `test_validator_plan` (one spec per obligation), and the
  `implementation_dag` skeleton (one node per obligation/counterexample + edges from `depends_on`)
  are pure functions of their upstream artifact — but no deriver exists; the prompt just *tells the
  model* "derive deterministically." In the 2026-06-14 run these were the largest hand-written
  artifacts (an 86-entry ledger and an 86-entry test plan, **each authored twice** because of a
  repair round).
- **The mapping rules already exist — as validators.** `validatePairedObligations`,
  `validateDesignSpecGates` (Gate 3 invariant↔obligation), `validateImplementationDAGIntegrity`
  (bidirectional coverage), `deriveNodeModelTier` already encode the exact mapping a deriver needs.
  We are *checking* a transform we could simply *apply*. (`validation/contractPipelineGates.ts`.)
- **Validation is ingest-time only; there is no write-time guard.** The worker writes a bare
  payload with only prose schema guidance and finds out it was malformed on the *next* `next-step`.
  A weak model has no fast feedback loop.
- **Repair is a full LLM rewrite of the target + a full LLM re-author of everything downstream.**
  A judge `needs_repair` → "Rewrite the complete, corrected artifact (not a diff)"; the new
  content-hash then marks all downstream artifacts stale and the loop **re-emits each downstream
  LLM phase**. The pure `repairDownstreamPhases` function that *computes* the minimal downstream
  set **exists but is not wired in**. In the run, two repair rounds re-authored ~5 downstream
  artifacts each — pure waste, since the repairs only refined invariant *text* (IDs were stable).
- **No single ID authority.** The model mints `goal_id` / module names / obligation IDs / node IDs
  ad-hoc per artifact; code adds the `CP-BLOCK-` prefix only at promotion. The bare-node-id ↔
  `CP-BLOCK-` split is the root of the recurring "Unknown finding_id" merge trap, papered over by
  the tolerant `buildBlockAliasMap`/`collapseItemResults` remap (`steps/dispatch.ts`) and
  hand-patched by the host twice in the run.
- **Schema drift already present.** `schemas/contract_pipeline.schema.json` is a real JSON Schema
  but stale/unused (still defines `DesignSpec`; missing 6 newer artifacts). The TS validators are
  the de-facto contract; the schema file is rot.

## 2. The judgment vs. mechanical line

The actionable core: for each artifact, separate what only a model can decide from what a tool can
compute. Everything in the right column should move to deterministic code.

| Artifact | Irreducible judgment (LLM) | Mechanical → tool |
|---|---|---|
| goal_spec | objective, non-goals, success criteria | id minting, schema shape |
| context_bundle | which files are relevant + why | path validation, dedup |
| module_decomposition | the module boundaries + file ownership | disjoint-scope check, id minting |
| module_contracts | the actual invariants / failure modes / neighbor needs | per-module skeleton, id minting, shape |
| seam_reconciliation | the *decision* of which side adjusts | enumerating the mismatches (output vs neighbor_need diff) |
| finalized_module_contracts | reconciliation wording | folding seam decisions into the skeleton, hashes |
| conceptual_critique | the critique itself | nothing (pure judgment) |
| **obligation_ledger** | — | **fully derivable** (invariant→obligation, seam→test, `depends_on`) |
| **test_validator_plan** | the *assertion text* per spec | **structure fully derivable** (one spec/obligation, kind by obligation-kind, pos+neg slots) |
| contract_assessment | the satisfied/violated/uncertain verdicts | obligation enumeration, coverage symmetry |
| counterexample | the counterexamples | nothing (pure judgment) |
| judge_report | the rulings + repair target | classification enumeration, schema |
| **implementation_dag** | node *descriptions* + verify commands | **node/edge skeleton derivable** (node per obligation/CE, edges from `depends_on`, tier via `deriveNodeModelTier`) |

The four pure-judgment artifacts (critique, counterexample, judge, and the *content* of
module_contracts) stay LLM. Everything else is mostly or fully mechanical.

## 3. Strategies, prioritized

Ordered by (impact × determinism-feasibility). Each names the plug-in point.

### S1 — Derive the derivable artifacts in code *(highest leverage)*
Make `obligation_ledger`, `test_validator_plan`, and the `implementation_dag` skeleton **generated
deterministically**, not authored. The mapping logic already exists as the *inverse* of
`validatePairedObligations` / `validateDesignSpecGates` Gate 3 / `validateImplementationDAGIntegrity`
/ `deriveNodeModelTier`, so the deriver and the validator share one source and cannot drift.
- **Plug-in:** in `buildNextContractPipelineStep`, gate the dispatch for these phases — instead of
  emitting an LLM phase, compute the artifact and `writeContractArtifact(...)` (mirror the
  `cyclic_seam_resolution` no-cycles write), then recurse. Deriver = pure function in a new
  `contractPipeline/derive.ts` (next to `deriveNodeModelTier`).
- **Effect:** removes the three largest hand-authored artifacts; weak *and* strong models skip
  them; they can never disagree with the validators. Where judgment remains (assertion text, node
  descriptions), emit a skeleton with only those blank (→ S3) and ask the model for just the slots.

### S2 — Patch-based repair + deterministic downstream re-derivation — ⚠️ SUPERSEDED / DROPPED
> **CORRECTION (2026-06-15, verified in code via the S2/S4 dogfood — do NOT implement S2 as
> originally written below).** The dogfood's independent conceptual critique caught, and a code
> re-read confirmed, that S2's headline mechanism is **redundant and the wrong direction**:
> - `repairDownstreamPhases` (`validation/contractPipelineGates.ts:976`) is a **linear slice** —
>   `CONTRACT_PHASE_SEQUENCE.slice(index+1)`, i.e. "every phase after this one." It does not know the
>   real dependency structure.
> - The pipeline **already** re-derives only genuinely-affected downstream artifacts via the
>   **hash-based `DEPENDENCY_MAP` staleness DAG** (`detectStaleArtifacts` → archive stale →
>   re-emit/re-derive, `steps/contractPipeline.ts:723-726`), which runs on every step and *is* the
>   "dependency DAG is truth, never ad-hoc freshness" invariant. Wiring the linear
>   `repairDownstreamPhases` would **replace a precise mechanism with a coarser, ad-hoc one** — worse,
>   and a direct invariant violation. So S2's "deterministic downstream re-derivation" is **already
>   done, better.**
> - The remaining half (patch-vs-rewrite repair shape, `renderContractRepairPrompt`) is real but
>   **high-complexity / thin-ROI**: the full-rewrite path already validates fail-closed; a patch
>   applier adds a patch schema + mutation engine + a new "valid patch, wrong target" failure surface.
>   Note the repair loop is **hot** (Ethan: `needs_repair` fires on ~every remediation run), so the
>   patch shape *would* save real repair tokens — but not enough to justify the new machinery now.
>   It is an easy lever to revisit if repair-token cost ever bites; if so, scope it to the repair
>   *shape* only and keep the staleness DAG as the downstream authority.
>
> **Decision: S2 dropped.** `repairDownstreamPhases` is dead code that should simply be **deleted**
> (it has no correct caller — the staleness DAG supersedes it), not wired. S4 (below) is unaffected
> and shipped. Original (flawed) S2 text retained below for the record:

On `needs_repair`, the LLM emits a **targeted patch** ("add INV-X to module Y", "refine INV-Z
text") — not a full rewrite. The tool applies the patch, re-derives downstream artifacts with the
S1 derivers (no re-authoring), and re-runs **only the adversarial phases** the already-existing-but-
unwired `repairDownstreamPhases` computes.
- **Plug-in:** `renderContractRepairPrompt` (switch "rewrite in full" → a patch op); wire
  `repairDownstreamPhases` into the repair loop (it is currently dead code); reuse the staleness DAG
  only for what genuinely can't be re-derived.
- **Effect:** the run's two repair rounds re-authored ~10 downstream artifacts total; this collapses
  them to "apply small patch → re-derive → re-run critic+judge." Biggest single token saving for the
  expensive adversarial phase.

### S3 — Skeleton scaffolding + write-time validation *(the weak-model enabler)*
Stop handing the model a schema to fill from scratch. Have the tool emit a **pre-filled skeleton**
built from the already-ingested upstream payloads — structure, IDs, and cross-references populated,
only judgment slots blank — and give the worker a **write-time validator** (the same
`CONTRACT_PIPELINE_VALIDATORS` the backend runs at ingest) to run before it emits.
- **Plug-in:** `renderContractPipelinePrompt` (emit a scaffold from `readContractArtifact` of each
  required input, instead of the generic `outputSchema` template); add a `validate-artifact` CLI
  subcommand wrapping the existing validator registry; reference it in the prompt's task section.
- **Effect:** the model literally cannot emit structurally-broken JSON, a wrong ID, or a dangling
  cross-ref — those fields aren't writable. A weak model fills sentences; a strong model spends zero
  tokens on boilerplate. This is the core "both weak and strong" lever.

### S4 — Single ID authority
A tool-owned registry mints `goal_id` / module / obligation / node IDs and owns the `CP-BLOCK-`
↔ bare-node-id relationship as one registered mapping.
- **Plug-in:** new `contractPipeline/idRegistry.ts`; repoint the mint sites (`goal_normalization`,
  `obligation_ledger` derivation, `promoteImplementationDagToExtractedPlan`'s `CP-BLOCK-` prefix)
  and the consumers (`buildBlockAliasMap`/`collapseItemResults`/`mergeImplementResults`).
- **Effect:** **eliminates** the tolerant-remap seam and the recurring merge trap at the root,
  instead of mitigating it. (The tolerant merge stays as defence-in-depth, but stops being load-
  bearing.)

### S5 — Move structural checks before the adversarial phases (cheap deterministic floor)
Run a fuller **structural linter** (ID integrity, dangling refs, empty required arrays, coverage
symmetry) deterministically *before* the LLM critic/judge, so the expensive adversarial loop only
ever sees structurally-sound input and spends its budget on **semantics**.
- **Plug-in:** extend the existing pre-`critic` `validateDesignSpecGates` block; pull parts of
  `validateImplementationDAGIntegrity` / `validateGoalIdConsistency` earlier.
- **Effect:** fewer repair rounds wasted on structural issues; a weak critic still benefits from the
  deterministic floor; a strong critic aims higher.

### S6 — Single-source the schema; delete the drift
Make `schemas/contract_pipeline.schema.json` (or a regenerated equivalent) **the** source consumed
by the validators, the write-time validator (S3), and the skeleton scaffolder (S3) — or delete it
if the TS validators remain canonical. Guard with a generator↔committed test (the pattern just
shipped for the auditor-contract fixture).
- **Effect:** derivers, validators, scaffolds, and docs can't drift from three places.

### S7 — Anti-hallucination by *grounding the claim*, not *attesting the read* (audit-code side)
The original audit design tried to stop hallucinated findings by forcing auditors to prove they
read the files (the `file_coverage[].total_lines == actual` check; the `orchestrator/fileAnchors.ts`
remnant). That is the wrong target: it proves *breadth attestation*, is gameable (read the count
from a listing, never open the body), and proves nothing about whether a finding is **true**. You
don't actually care whether the model read the file — you care whether each claim is true and
re-checkable. **Reframe: attach the safeguard to claims, not to reading**, and make the verdict the
tool's re-check, never the model's word. This is the same "green implies correct without trusting
the worker" spine, applied to the auditor's *inputs* — and it matters *more* for a weak auditor,
which is the whole any-strength mandate. (In-project proof it's real: the 452-audit shipped
ARC-1fa005bb / COR-3410f5f6 / DAT-d78de464 as findings that were **not real** — caught only by
deterministically re-running `madge`/grep/const-compare, never by the read-attestation check.)

Tier the grounding by claim type:
- **Defect claims → quote-and-verify (cheapest, ungameable, highest ROI).** Every finding must
  carry a verbatim span `{file, line_start, line_end, quoted_text}`. The tool re-reads that span and
  content-matches (whitespace/CRLF-normalized; match on content not line numbers so later edits
  don't false-fail). No match → finding **quarantined as ungrounded** (surfaced, never silently
  dropped). Kills "cited code/symbol/line that doesn't exist," the most common audit hallucination.
- **Behavior claims ("throws" / "test fails" / "no cycle" / "unused") → executable anchor.** The
  finding ships a command the tool runs (the grep, the failing test, `madge`); the confirmed bit is
  the **tool's run**, not the model's assertion — exactly what disproved the three flags above.
  Bounded/sandboxed/timeout. Deterministic-tool findings (semgrep/eslint/npm-audit via
  `src/adapters/`) are already grounded this way — generalize it to model-authored findings.
- **Judgment/synthesis (severity, prioritization, "is this important") → not deterministically
  checkable.** Be honest: no anchor proves a taste call. Safeguard = the adversarial cross-check
  already in the pipeline (independent refuter + judge) **plus traceability**: every synthesis claim
  must trace to grounded tier-1/2 findings, so judgment can't invent its own facts.
- **Plug-in:** require the span in `prompts/renderWorkerPrompt.ts` + `schemas/audit_result.schema.json`
  (add span fields; **demote `total_lines` to a non-gating coverage stat**); enforce quote-verify in
  `validation/auditResults.ts` and at ingest in `orchestrator/resultIngestion.ts` /
  `cli/mergeAndIngestCommand.ts` (re-read disk + match); have the worker self-check before emit via
  the **already-existing** `cli/validateResultCommand.ts` (audit-code already ships the S3 write-time
  validator affordance — wire quote-verify into it). Executable anchors reuse the runtime-validation
  path (`runtime_validation_report.json`). Generalize/replace `orchestrator/fileAnchors.ts`.
- **Effect:** a hallucinated or stale finding cannot be admitted — its anchor either re-verifies
  against disk or it's quarantined. Proportionate (anchor the claims that matter, not every read),
  ungameable, and it degrades gracefully for a weak auditor instead of producing confident-but-fake
  findings. **Proportionality caveat:** if you only ever run a strong auditor, tier-1 catches little
  day-to-day — but it costs almost nothing and is precisely the safety net for the weak-auditor case
  the project is built around. Don't over-tax; tier-3 hallucination is triangulated, never "proven."

### S8 — Fix the conceptual design review itself (restore the original design; don't constrain it)
The audit's **conceptual design review** is the lens meant to catch deep architectural mistakes — and
it caught *none* of this class in the 452-self-audit. But the fix is **not** to teach it this
project's concerns: it is a **repo-agnostic** tool that audits any codebase, so it must ask
**general** first-principles questions, never project-specific lenses. The real root cause is that
the implementation **degraded the original design** into a narrow, constrained step. Restore it:
- **Ask general first-principles questions (primary).** Today the prompt
  (`src/audit/orchestrator/designReviewPrompt.ts:246-257`) asks only "what library / pattern /
  simplification / missing capability" — a local improvement checklist. → **Fix:** ask the general
  architectural questions — *"is the fundamental approach the right one? what core assumption
  underlies this design, and is it sound? what would a clean-sheet redesign do differently? where is
  the deepest structural risk?"* Repo-agnostic by construction. **Do NOT** bake in project-specific
  lenses (determinism-vs-LLM, weak-model robustness, ground-truth anchors) — a general "is the
  approach right?" asked against our actual pipeline surfaces our issue *as a consequence*, and that
  generality is the entire point.
- **Orient, then roam (restore the original scope intent).** The implementation degraded to ~20
  highest-**risk** units, summaries only (`renderConceptualReviewPrompt:407-409`,
  `buildPrioritizedReadingList`) — which is *why* it couldn't see a cross-cutting property. → **Fix:**
  the intended design — give the reviewer a small **context package + the project docs + an
  `/init`-style codebase overview**, then **let it roam the actual files freely** (read wherever the
  code leads, not a risk-truncated summary feed). Free exploration of real code is what lets it
  perceive emergent, whole-system structure in *any* repo.
- **Make the judge judge.** The deep-path judge is a merge/dedup pass ("you are merging, not
  reviewing", `designReviewPrompt.ts:494`). → **Fix:** restore its evaluative role — assess merit /
  validity / severity, decide what is real, and flag what is *missing* — not just fold duplicates.
- **Ground the output (general; = S7 applied to the reviewer).** Conceptual findings are ingested on
  `Array.isArray()` alone (`src/audit/cli/nextStepHelpers.ts:325-332`) — no evidence, unlike
  schema-gated `AuditResult`. → **Fix:** require each finding to carry evidence (components/lines) and
  validate on ingest. (An output requirement, not a prompt lens — stays repo-agnostic.)
- **Gate it.** The obligation is a boolean (`state.ts:158-159`); `runDesignReviewAutoComplete`
  (`structureExecutors.ts:142-144`) can mark it complete with `[]` and no LLM call. → **Fix:** require
  a real (non-fallback) finding set, or block synthesis when the pass auto-completed empty — "no
  systemic review happened" must not pass silently.

**Synthesis — why S8 is the exception to S1–S7.** The conceptual review is the **one place to lean
*into* judgment, not toward determinism**. Architectural insight is irreducibly tier-3 (S7) — you
cannot make it deterministic and should not try. So the tooling's job is to **enable** the judgment
(general questions + orientation package + project docs + `/init` overview + freedom to roam) and to
**ground/gate the output** (evidence required; cannot auto-complete empty) — **never to constrain**
the judgment with checklists or project-specific lenses. Determinism for the mechanical (S1–S7);
empowered, general, well-fed judgment for the architectural (S8). The self-audit missed our issue
because the implementation did the opposite on all three axes — narrow questions, no roaming, a
non-judging judge — not because the reviewer lacked our project's vocabulary.

## 4. Why this serves all three goals

- **More efficient:** the model emits tiny judgment slots, not whole artifacts; three artifacts
  vanish entirely (S1); repair is a patch + re-derive, not a full re-author cascade (S2).
- **Less error-prone:** structure / IDs / cross-refs are tool-owned and unwritable-wrong (S3, S4);
  write-time validation gives instant feedback (S3); structural errors are caught cheaply before the
  adversarial phases (S5); one schema source (S6).
- **Weak *and* strong-model-manageable:** the model's surface shrinks to "write a correct sentence
  / make a ruling," which both can do; the deterministic scaffold + validators + derivers are the
  floor that makes a weak model *safe* and a strong model *fast*. The same pipeline run by a weaker
  worker degrades gracefully instead of producing green-but-malformed artifacts.

## 5. Sequencing

1. **S1 + S3 together** — derive the derivable artifacts and scaffold the rest with write-time
   validation. Biggest combined efficiency + robustness win; unblocks the weak-model goal.
2. **S2 + S4** — patch repair + ID authority. Removes the two biggest remaining waste/error classes
   (repair re-author cascade; merge trap).
3. **S5 + S6** — structural floor before adversarial phases; single-source schema.

S1–S6 are the remediate-code contract-authoring track. **S7 is the parallel audit-code track**
(auditor-claim grounding) — independent of S1–S6 and cheap/high-ROI, so quote-verify (tier 1) can
land early on its own; it only needs the audit-code result schema + ingest, not the contract
pipeline.

Virtuous cycle: each of these makes the *next* contract-pipeline run (including the one that
implements the rest of this list) cheaper and more weak-model-robust. This work is itself a strong
candidate to dogfood through `audit-code → remediate-code` once S1/S3 land — at which point the
pipeline pays for its own improvement.

## 6. Non-negotiables (carry the project's invariants)

- Derivers and validators share one source of truth (no parallel logic).
- Model-agnostic throughout: tiers stay relative ranks; never a model name (`deriveNodeModelTier`
  is the template).
- A deterministic deriver must be a *pure function* of its declared upstream artifact(s) (testable
  in isolation; feeds the hash/staleness DAG cleanly).
- "Green implies correct" still holds: scaffolding/derivation reduce surface area but every
  fail-closed gate stays; a skeleton the model under-fills must fail write-time validation, not pass
  vacuously.
