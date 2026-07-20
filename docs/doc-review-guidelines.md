# Doc-review — reviewer guidelines

The contract a nightly **cloud routine** follows to keep this repo's documentation
true to the code. This file is the routine's spec; it is **excluded from its own
review**. Edit it here on `main` — the routine reads it, never rewrites it.

## Why this exists

Docs drift; an agent that *remembers* to re-check them is a latent failure mode
(see `CLAUDE.md` → "auditor-agnostic robustness"). This routine moves that
re-check into tooling: every night, against the live codebase, with three
independent agents gating every change.

## The rubric sources: two philosophies

Every judgement in this routine measures against **two** canonical rubrics, loaded at the
start of every run:

1. **[`documentation-philosophy.md`](documentation-philosophy.md)** — the *doc-shape* rubric:
   what this repo's docs are for and how they're shaped (durable concepts not current state;
   one home per concept; status-noise forbidden; the condensation bias). Governs whether a doc
   is *well-formed as a doc*. When it and this file's mechanics ever conflict, it wins and this
   file is the thing to fix.
2. **[`project-philosophy.md`](project-philosophy.md)** — the *content-conformance* rubric: the
   project's organizing convictions, split into those that govern the product itself (Part A) and
   those that govern its development (Part B). Governs whether a doc's *claims and guidance align
   with the project's stated philosophy* — e.g. a doc that recommends hardcoding a model, forking
   planning per-language, gating LLM review behind a provider, or leaning on host discretion where
   the tool should enforce, **contradicts** a conviction. `project-philosophy.md` is itself a map
   that points at each conviction's canonical home (`CLAUDE.md` / `spec/` / memory); where the map
   and a home disagree, the **home** is ground truth (verify against it, not the map).

Doc-shape is a *factual/structural* judgement (can auto-apply narrow fixes). **Content-conformance
is always a judgement call → design-decision → escalate to the owner** (see *Philosophy-conformance
review* below); the routine never rewrites a doc's substance to fit a conviction on its own.

## Two perspectives — review the items AND the doc set

The routine reviews on **two distinct perspectives every run** (the philosophy demands both):

1. **Within a document** — do the items inside it fit the philosophy (durable concept, not
   status-noise) and are they factually true against code? This is the item-level pass below.
2. **Across the document set** — is each *document itself* in line with the philosophy, and
   **can/should the corpus be condensed**? Overlap between docs, a doc that should fold into
   another, a doc whose reason-to-exist has lapsed, a thin doc that belongs as a section
   elsewhere. This is the corpus-level pass ("Doc-set condensation review" below).

Perspective 1 can auto-apply narrow factual fixes; perspective 2 is **always a
design-decision → escalate** (never merge, retire, or split a doc autonomously).

## Trust model — three agents earn the autonomy

A single agent editing docs is itself an untrusted host. Autonomy is earned by a
three-tier gate; nothing reaches `main` without surviving all three:

1. **Reviewer** — examines every in-scope item, proposes a disposition.
2. **Adversary** — independently examines **every** item (not just the
   reviewer's surfaced ones, so it also catches false negatives — items the
   reviewer skimmed and passed). Agrees or refutes, with evidence.
3. **Judge** — runs only on **contested** items (reviewer ↔ adversary disagree).
   Decides the final disposition *and* the apply-vs-escalate call. **Defaults to
   escalate on any uncertainty.**

Every agent verifies from code/disk — never trusts doc prose as ground truth.

## The two dispositions

Every item resolves to exactly one:

- **stale-factual-fix** — a *factual* claim the code contradicts: a named file,
  symbol, command, path, or count that demonstrably no longer exists or has
  changed. Narrow and code-anchored. → **auto-applied** (except instruction
  files, below).
- **design-decision** — anything with judgment in it: a policy/convention, a
  conceptual claim, a "should we still do this", a vague backlog item, an A→B
  spec. → **escalated to the owner, never auto-applied.**

The split is the entire safety surface. The classifying rule:

> **Factual** = verifiable true/false against code (apply).
> **Policy / conceptual / judgment** = needs the owner (escalate).
> A policy is **not** stale because no code "uses" it — code-absence is the
> policy *working* ("never hardcode model identities" is load-bearing precisely
> when nothing violates it). Never flag a policy as obsolete by absence.

When in doubt, it is a design-decision. Escalate.

## Existence review — every doc, every run (not just intra-doc staleness)

Keeping a doc *factually true* is not the whole job: a doomed doc that is dutifully
kept accurate never gets retired. So **in addition** to the per-type check below, every
doc is asked, every run: **does this still have a reason to exist, and is this the
right home for its content?** This is always a **design-decision → escalate**, never
auto-applied. Two smells force the question (do not silently "fix" either):

- **A pinned version / date / status string in a prose doc** (e.g. "expected version
  0.30.5", "plan of record (2026-06-24)", "THIS RUN implements…") is **status-noise, not
  a factual claim to bump.** Reclassify it from stale-factual-fix to a design-decision:
  escalate *"de-status this (derive the value or drop it), or retire the doc"* — **never
  auto-bump the number.** A doc whose only diffs across runs are version/status bumps is a
  status doc masquerading as a concept doc → propose generate-or-delete.
- **A doc that is not in the canonical manifest** (below) → escalate *"register with a
  type + reason-to-exist, fold into an existing canonical doc, or delete."* Never leave it
  unrouted and silently maintained.

## Normative goals docs — re-check against the executor/phase registry on any change

A **normative goals doc** (`spec/audit/audit-goals.md`, `spec/remediate/remediation-goals.md`) enumerates
the obligations / phases / executors its area must satisfy. Whenever a new obligation, phase, or executor
ships in that area, the goals doc gets a **"does this still match the current executor/phase registry?"**
check *then* — driven by the code change, not deferred for the next doc-review pass to discover the drift.
A registry entry the doc omits, or a doc entry the registry no longer has, is a **design-decision →
escalate** (goals docs are normative — never silently rewritten to match code).

## Shipped-entry deletion — a "SHIPPED" note is itself status-noise

`backlog.md` says *"Remove an entry once it ships."* Enforce it literally — a recorded
"what shipped" is `git log`'s job, not the backlog's:

- **Fully-shipped entry → delete it outright.** When the code proves an entry's work is
  done (factual, code-anchored), **remove the whole entry**. Do **not** rewrite it into a
  `_SHIPPED …_` / `**FIXED**` / `**DONE**` note, and do **not** leave such a note standing —
  a shipped-status marker is exactly the status-noise the philosophy forbids, and these
  accumulate. A standalone `_SHIPPED_`/`_FIXED_` paragraph or a bullet whose content is only
  "this shipped" has **no open remainder → delete it** (code-proven removal is auto-apply,
  same as any shipped-removal; if the proof is incomplete, escalate rather than guess).
- **Partial entry (shipped substrate + open remainder) → trim to the remainder.** Strip the
  "what we already shipped" prose and keep only the still-open work + enough context to act
  on it. The entry stays; its status-log tail goes.
- **Durable rule worth keeping?** If a shipped fix carries a durable trap/convention (e.g.
  "anchor ignore patterns to `.audit-tools/`"), that belongs in its durable home (Durable
  traps, `CLAUDE.md`) — move it there in the same edit, then delete the backlog entry; never
  retain the entry just to host the rule.

## Philosophy-conformance review — every doc, every run

In addition to doc-shape (well-formed?) and factual accuracy (true vs code?), every doc is asked
each run: **does its content conform to the project's philosophy** ([`project-philosophy.md`](project-philosophy.md),
verified against each conviction's canonical home)? This catches a doc that is well-formed and
factually accurate yet **advocates or documents something that cuts against a stated conviction** —
the class the other two checks miss. Smells that trigger it (non-exhaustive — the convictions in
`project-philosophy.md` are the full rubric):

- Hardcoded model/provider/window/tier assumptions presented as normal (violates *everything-agnostic*, A4).
- Per-language / per-ecosystem forks of planning logic (violates *language-neutral*, A4).
- Correctness resting on the host *remembering / noticing / being careful*, or a manual flag treated as
  the fix (violates *enforce-in-tooling*, A3 — "a needed manual flag is a bug signal").
- LLM review gated behind "if a provider exists"; CLI treated as the primary product (violates
  *conversation-first* / *LLM always in the loop*, A2/A5).
- "Deterministic by default / 100% deterministic" framing (violates *right tool, not dogma*, A2).
- A separate lean/fast path proposed instead of one self-scaling pipeline (violates A6).
- Deferring the clean endpoint on effort/complexity grounds (violates *ideal-code-over-compatibility*, B1).

**Every conformance finding is a design-decision → escalate**, never auto-applied: judging "does this
contradict a conviction" is exactly the judgment the owner must make, and the fix is often to change the
*code/policy*, not the doc. Quote the offending item, name the conviction (with its `project-philosophy.md`
section + canonical home), and surface it under the escalation block's **"Design decisions for you"**.
`project-philosophy.md` and the two rubric files (`documentation-philosophy.md`, this spec) are reviewed
for their own conformance like any other doc.

## Doc-set condensation review — the corpus as a whole (perspective 2)

Once per run, after the per-doc work, step back and review the **whole document set** against
the philosophy's *condensation bias* — fewer, denser, timeless docs beat many thin or
overlapping ones. This is a corpus-level pass, not a per-item one, and every outcome is a
**design-decision → escalate** (the routine never merges, folds, retires, or splits a doc on
its own). Hunt for:

- **Overlap / duplication** — two docs stating the same concept (a fact in two homes will
  drift). Propose: pick the most-durable home, fold the other in, leave a pointer not a copy.
- **Fold candidates** — a doc whose content is really a *section* of another (e.g. a single
  provider's credential mechanics belongs in the per-provider matrix, not its own file).
- **Lapsed reason-to-exist** — the work shipped, the concept moved into code/policy, or it was
  always current-state. Propose retire.
- **Bloat** — a concept doc grown into a changelog/log; propose trim to the durable core.
- **Split** — rare; only when one doc carries two genuinely-unrelated durable concepts.

Each proposal quotes the docs involved and names the target home; the owner makes the merge/retire
call. Surface these in the findings file under a **"Doc-set condensation"** heading.

## Scope — every doc, routed by type

All `*.md` under the repo, **recursively**, except the exclusions. Each doc gets
the check for its type:

| Type | Files | Check | Auto-apply? |
|---|---|---|---|
| **design / concept** | `docs/documentation-philosophy.md`, `docs/project-philosophy.md`, `docs/backlog-remediation-design.md`, `docs/quota-dispatch-design.md`, `docs/glossary-ids.md`, `docs/end-of-sprint-report-template.md` | Claims vs code (drift); flag current-state / changelog creep (docs are timeless concepts, not status). `project-philosophy.md` is an orienting **map** (product-vs-development split) that points at each conviction's canonical home — verify its one-line restatements still match those homes; it deliberately references, never re-owns, so a home change makes its pointer stale, not the home. | factual-stale → yes |
| **instruction / policy** | `CLAUDE.md`, `AGENTS.md` | Factual claims only (file/command/path staleness). Policy & conventions untouchable. | **No — escalate-only.** Highest blast radius: a wrong edit deletes a guardrail governing all agents. |
| **ops / usage** | `README.md` | Do the documented commands / paths still resolve and run. | factual-stale → yes |
| **package docs (audit)** | `docs/audit-pkg/product.md`, `docs/audit-pkg/contracts.md`, `docs/audit-pkg/development.md`, `docs/audit-pkg/operator-guide.md`, `docs/audit-pkg/release.md` | Claims vs code/spec (these page the normative `spec/audit/*`); flag current-state / changelog creep. | factual-stale → yes |
| **backlog** | `docs/backlog.md` | Shipped-detection (see *Shipped-entry deletion* below — a fully-shipped entry is **deleted outright**, never kept as a `SHIPPED`/`FIXED`/`DONE` marker; a partial entry is **trimmed to its open remainder**); dedup near-identical raw items; A→B draft (below). Durable-traps section is **reference** — only flag a trap proven fixed-in-tooling. | shipped-removal & dedup → yes; A→B → escalate |
| **handoff (sequencing view)** | `docs/HANDOFF.md` | The ordered roadmap of everything open + current state (sanctioned per the philosophy's HANDOFF row): each open item appears once, in suggested order, with a pointer to its `backlog.md` detail. Flag **changelog creep** (narrated already-shipped work) and **per-item specs duplicated from `backlog.md`**; verify each item vs code; a done item → clear it, with proof. NOT immediate-next-only. | yes |
| **design / concept (`spec/`)** | `spec/**/*.md` (e.g. `self-scaling-pipeline-design.md`, `contract-authoring-determinism-design.md`, `host-validation.md`, `cross-provider-quota-matrix.md`) | Claims vs code (drift); flag current-state / changelog creep (durable design only). **Soft-reviewed every run but NOT part of the `docs/**/*.md` hard gate** — `check-doc-manifest.mjs` does not gate `spec/`, so this row exists to route them, not to mechanically reconcile them. A `> **Status:** <type-declaration>` preamble identifying the kind of design artifact is permitted; a dated/versioned status string in it is still status-noise → escalate. | factual-stale → yes |
| **excluded** | `docs/doc-review-guidelines.md` (this spec), `docs/doc-review-findings.md` (output), `meta-audit-log.md` (append-only log — staleness review is a category error), `.audit-tools/remediation-report.md` (runtime run-artifact — a remediate-code run output, not a durable doc; tracked but never reviewed), `.audit-tools/audit-report.md` (same rationale — an audit-code run output, structurally parallel to its `remediation-report.md` sibling per `CLAUDE.md`'s Artifact layout; tracked but never reviewed), `docs/reviews/churn-context-enforce-pass-2026-06-27.md` (dated review-pass findings artifact — durable digest lives in `docs/backlog.md` #15; the tables are a one-off reference, not a timeless concept), `docs/reviews/churn-context-enforce-pass-2026-07-02.md` (dated review-pass findings artifact — the T5-run churn/context/enforce pass; actionable items N1/N4 live in `docs/backlog.md`, the record is a one-off reference, not a timeless concept), `docs/reviews/quota-prewall-pacing-diagnosis-2026-06-30.md` (dated root-cause diagnosis artifact — durable design lives in `spec/audit/dispatch-admission-control.md`; a one-off record of the pre-wall walling incident, not a timeless concept), `docs/reviews/host-self-quota-silently-disabled-2026-07-09.md` (dated root-cause diagnosis artifact — the record of why host self-quota monitoring kept silently disappearing; durable behavior now lives in the one-track collapse in `src/shared/quota/scheduler.ts` + `src/remediate/steps/dispatch/waveScheduling.ts` and the fail-loud in `src/remediate/steps/dispatch/marshal.ts`; a one-off record, not a timeless concept), `docs/reviews/dispatch-inventory-greenfield-design-2026-07-16.md` (dated design-synthesis artifact — the design-panel record behind the INTENT/CAPABILITY split; durable design lives in `spec/unified-dispatch-worker-model.md`, this is a one-off record, not a timeless concept), `docs/reviews/g1-auditor-descriptor-plan-2026-07-16.md` (dated plan artifact — the G1 `--auditor` descriptor collapse plan; durable design lives in `spec/unified-dispatch-worker-model.md`, a one-off record, not a timeless concept), `docs/reviews/g2-repo-session-intent-plan-2026-07-16.md` (dated plan artifact — the G2 `RepoSessionIntent` type-split plan; durable design lives in `spec/unified-dispatch-worker-model.md`, a one-off record, not a timeless concept), `docs/reviews/g2-5-source-emitter-plan-2026-07-16.md` (dated plan artifact — the G2.5 source-resolution plan plus the adversarial review that reworked it; durable design lives in `spec/unified-dispatch-worker-model.md`, a one-off record, not a timeless concept), `docs/reviews/g3-dispatch-policy-plan-2026-07-16.md` (dated plan artifact — the G3 policy-vs-reach plan and its four refuted drafts; durable design lives in `spec/unified-dispatch-worker-model.md`, a one-off record, not a timeless concept), `docs/reviews/g4-g5-g6-premise-check-2026-07-16.md` (dated premise-check artifact — the record of G4/G5/G6 being verified against HEAD before opening a lap, incl. two same-day self-corrections; the durable lessons live in `docs/backlog.md` + project memory, a one-off record, not a timeless concept), `docs/reviews/dispatch-fork-assessment-2026-07-16.md` (dated assessment artifact — the record of why dispatch had no auditor/remediator separation to begin with; durable design lives in `spec/unified-dispatch-worker-model.md` and the open remainder in `docs/backlog.md`, a one-off record, not a timeless concept), `docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md` (dated plan artifact — the commit-3 claude-worker launch-transport plan incl. its adversarial-review rewrite; durable design lives in `spec/unified-dispatch-worker-model.md`, a one-off record, not a timeless concept), `docs/reviews/claude-worker-lane-dogfood-2026-07-16.md` (dated dogfood-run findings artifact — the first live claude-worker lane run's evidence tables; actionable gaps live in `docs/backlog.md` → "claude-worker lane dogfood feedback gaps", a one-off record, not a timeless concept), `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md` (dated plan artifact — the gap-fix plan incl. verified ground truth + adversarial-review revisions; the accepted residuals live in `docs/backlog.md` → "claude-worker lane feedback-gap residuals", a one-off record, not a timeless concept), `docs/reviews/repair-proxy-dispatch-diagnosis-2026-07-17.md` (dated root-cause diagnosis artifact — the record of why the claude-worker/repair-proxy lane dispatched zero (the 750ms liveness-probe cold-drop) and how it was fixed both sides; durable fix lives in `src/shared/providers/auditorSources.ts` + repair-proxy `catalog.ts` and project memory [[repair-proxy-dispatch-unblocked-probe-fix]], a one-off record, not a timeless concept), `docs/reviews/host-fanout-proxy-dispatch-design-2026-07-17.md` (dated design-assessment artifact — the pool≠transport model + host fan-out design for proxied dispatch; durable design lives in `spec/unified-dispatch-worker-model.md` and project memory, a one-off record, not a timeless concept), `docs/reviews/host-fanout-premise-refuted-2026-07-17.md` (dated premise-refutation artifact — the record of the proxy_transport trigger premise collapsing against the run's own artifacts (pools WERE folded in; null context caps + collective settle were the real chain); durable direction lives in `docs/reviews/unified-dispatch-routing-design-2026-07-17.md` and project memory, a one-off record, not a timeless concept), `docs/reviews/unified-dispatch-routing-design-2026-07-17.md` (dated design+build record — the unified ONE-routing-decision design, owner decisions, per-step review findings and the H2+H4 remainder; the durable concept belongs to `spec/dispatch-jit-claims.md` + project memory once the collapse completes, a one-off record, not a timeless concept), `docs/reviews/h2-h4-collapse-plan-2026-07-18.md` (dated plan artifact — the H2+H4 branch-pair-collapse/demote-retirement plan with its four review records, blessed semantics and deliberate routing changes; durable direction lives in project memory [[unified-dispatch-routing-direction]] and residual pins in `docs/backlog.md`, a one-off record, not a timeless concept), `docs/reviews/litellm-swap-plan-2026-07-18.md` (dated plan artifact — the proxy-transport swap plan retiring repair-proxy and adopting LiteLLM as the generic proxy contract; durable direction lives in project memory [[litellm-replaces-repair-proxy]] and backlog entry "LiteLLM replaces repair-proxy" (docs/backlog.md:52), a one-off record, not a timeless concept), `docs/reviews/litellm-proxy-live-validation-2026-07-18.md` (dated live-validation findings artifact — the record of the v0.33.7 proxy-contract swap being exercised against a live LiteLLM proxy for the first time, incl. the per-deliverable result table and the `api_key_env` reach-verification defect it surfaced; the durable fix lives in `src/shared/providers/auditorSources.ts` + its `tests/shared/proxy-lane.test.mjs` pins, remaining work in `docs/backlog.md` → Track 1 and the traps in → Durable traps, a one-off record, not a timeless concept), `docs/model-capability-ranking-sources.md` (dated market-survey artifact — the 2026-07-18 survey of someone-else-maintained capability/agentic ranking sources, run because retiring repair-proxy removed the only automated capability signal; the durable outcome is the consumption-pattern decision (runtime-fetch vs vendored) which belongs in the ranker-contract track in `docs/backlog.md` + project memory once chosen, a one-off record whose numbers go stale by design, not a timeless concept), `docs/reviews/capability-evidence-obligation-plan-2026-07-18.md` (dated plan artifact — the plan for converting the admission capability fail-open into a pin-it-down obligation, incl. the adversarial review that refuted three v1 claims and moved the edit layer; durable direction lives in `docs/backlog.md` + project memory, a one-off record, not a timeless concept), `docs/reviews/capability-evidence-implementation-review-2026-07-18.md` (dated implementation-review artifact — the per-round record of three adversarial review rounds against the capability-evidence obligation, what each refused and which owner decisions settled it; the durable direction lives in `docs/backlog.md` + project memory [[capability-evidence-is-an-obligation]], a one-off record, not a timeless concept), `docs/reviews/nim-dispatch-single-pool-2026-07-19.md` (dated defect-and-repair record — the N-models-on-one-credential metering defect, its round-1 refusal and round-2 rework; superseded as a repair direction by the design-of-record below, kept for the two "how the green tree lied" verification lessons which live durably in `docs/backlog.md` + project memory, a one-off record, not a timeless concept), `docs/reviews/account-metering-round2-independent-review-2026-07-19.md` (dated independent-review artifact — the 3-of-3 unanimous refusal of the round-2 account-metering rework, incl. the executed starvation scenario and the correction that a unanimous refusal can still carry a wrong remedy; durable lessons live in project memory [[account-scoped-metering-refused-then-reworked]], a one-off record, not a timeless concept), `docs/reviews/account-metering-design-of-record-2026-07-19.md` (dated design-of-record — the window-scoped metering partition that resolved four rounds of refused repairs, plus the step-1..4 breakdown and its residuals; **currently load-bearing** as the plan steps 2–4 execute, and belongs in `spec/` as a timeless concept once they land — dated-record status is deliberate until then), `docs/reviews/memory-consolidation-2026-07-19.md` (dated consolidation-pass record — the 149→136 memory-store pass, its verification evidence and the rejected offload-lane verdicts; the durable lesson lives in project memory [[refactor-must-sweep-memory-not-just-code]] and the actionable items in `docs/backlog.md`, a one-off record, not a timeless concept), `tests/audit/fixtures/simple-app/README.md` (test-fixture content — a sample-app README, its own concern, not a project doc) | — | — |
| **generated host assets** | `.agent/skills/audit-code/SKILL.md`, `.agent/skills/remediate-code/SKILL.md`, `.github/agents/auditor.agent.md`, `.github/agents/remediator.agent.md`, `.github/copilot-instructions.md`, `.github/prompts/audit-code.prompt.md`, `.github/prompts/remediate-code.prompt.md`, `skills/audit-code/SKILL.md`, `skills/audit-code/audit-code.prompt.md`, `skills/remediate-code/SKILL.md`, `skills/remediate-code/remediate-code.prompt.md` | ONE canonical body rendered per-IDE (`CLAUDE.md` B5); **not hand-edited** — governed by renderer drift tests (`tests/audit/host-asset-renderer-drift.test.mjs`, `tests/remediate/host-bootstrap-descriptors-remediate.test.ts`, `tests/remediate/install-repo-assets.test.ts`). Review the canonical source, not the generated copy; a diff = a drift-test/renderer gap, not a doc edit. | **No — renderer-owned.** |
| **meta-tooling / dev-workflow** | `.claude/skills/disambiguate-backlog/SKILL.md`, `.claude/skills/ship/SKILL.md`, `.claude/skills/start-lap/SKILL.md`, `docs/doc-review-routine-prompt.md` | Standalone dev-workflow how-to (no generated-asset relationship); do the documented commands/paths still resolve. `doc-review-routine-prompt.md` is THIS routine's own scheduler prompt: check its commands/paths/ports resolve (codex invocation, proxy endpoint, memory-store path) — but it is an operational summary of this spec, so any CONFLICT between it and this file is resolved in this file's favor and reported as a finding, never by editing this spec to match the prompt. | factual-stale → yes |
| **package READMEs (non-`docs/`)** | `src/audit/README.md`, `src/audit/adapters/README.md`, `examples/README.md` | Claims vs code; do documented commands/paths/providers still resolve (e.g. the provider list must match `PROVIDER_NAMES`). | factual-stale → yes |

The file list above is the **canonical manifest**: every tracked `docs/**/*.md` must
appear in exactly one row (or the `excluded` row). This is mechanically reconciled by a
release-gate check (`scripts/check-doc-manifest.mjs`, run in `verify:release`): any
`docs/*.md` not listed here **fails the build** — so a stray doc can never merge silently
and the manifest can never drift from the filesystem. The reviewer still applies the
existence-review smell above; the gate is the hard backstop. A doc that exists but matches
no row → **escalate** ("register here with a reason / fold in / retire"), never
silently treated as design/concept.

## Item keying & the ledger (incremental scope)

State lives in a **sidecar ledger** on the `doc-review` branch
(`doc-review-ledger.json`) — never inline in the prose docs (timestamps in a
timeless doc are exactly the status-noise we flag).

- Key each reviewable item by a **content hash of its normalized text**
  (collapse whitespace before hashing). Rewording an item changes its hash →
  it is treated as new and re-checked from scratch. That is correct: a reword is
  a reason to re-verify.
- Ledger maps `itemHash → { lastCheckedCommit, lastCheckedAt }`.
- **The ledger does not let you skip items.** On an active repo the code has
  moved since almost every item's last check, so every item is re-examined. Its
  value is **scoping the evidence window**: for an item last checked at commit
  `C`, read `git diff C..HEAD` to find what *could* have invalidated it, with the
  full codebase available on demand for certainty. Smaller diff to reason over,
  same rigor.
- Ledger writes are **autonomous** (you will not approve timestamp bumps). Only
  *doc content* changes go through the apply/escalate gate.
- Stamp an item only after an agent **actually examined** it this run. The
  adversary's every-item pass is what keeps a stamp honest.

## Pipeline (one nightly run)

0. Load both rubric sources — [`documentation-philosophy.md`](documentation-philosophy.md)
   (doc-shape) and [`project-philosophy.md`](project-philosophy.md) (content-conformance) —
   every disposition measures against them.
1. On the `doc-review` branch, `git fetch` `main`; check out `main`'s HEAD content
   to review against. Load the ledger.
2. **Reviewer** over every in-scope item (perspective 1, within-doc): read
   `diff lastChecked..HEAD` for scope, full code on demand. Emit per-item
   `{ disposition, edit?, question?, a2b_draft?, evidence }`. Stamp ledger for
   examined items. Also run the **per-doc existence-review**, the
   **philosophy-conformance review** (content vs `project-philosophy.md`), and the
   **doc-set condensation review** (perspective 2) — emit those as escalations.
3. **Adversary** independently over every item: `agree | refute` + evidence.
4. Agree → stands. Contested → **Judge** → final disposition + apply/escalate
   (default-escalate).
5. **Apply** (final = stale-factual-fix, and the file is *not* an instruction
   file): make the edit on `main`. Before pushing, run the **full green gate**:
   `npm run build && npm run check && npm test` — must be
   zero-error / all-pass. **The `npm test` step is non-negotiable, not just
   `build`+`check`:** several in-scope `*.md` files are the *source of truth* for
   generated host-integration assets (e.g. `skills/audit-code/audit-code.prompt.md`
   is the canonical loader body every IDE asset renders from). A "factual"
   entrypoint/path fix to such a file can leave its derived committed asset
   (`.gemini/commands/audit-code.toml`, `.github/agents/auditor.agent.md`, …)
   stale — and ONLY the test suite (host-asset drift, wrapper, contract) catches
   that drift. If the gate fails because a derived/generated asset needs
   regenerating, regenerate it in the SAME commit; if you cannot, **do not push —
   escalate**. Commit as **one discrete, revertible commit**
   (`doc-review: <summary>`), push `main`.
   - Self-correcting: an applied edit changes the item's hash → next night it
     re-stales and all three agents re-verify the edit.
6. **Escalate** (design-decisions, A→B drafts, instruction-file fixes, anything
   the judge held back): write `doc-review-findings.md` + the ledger to the
   `doc-review` branch and push. The findings file is **overwritten** each run —
   it always reflects *currently-open* items, so resolved ones drop off on their
   own.
7. **Silent on clean**: applied nothing and escalated nothing → no findings file
   churn beyond the ledger, no notification.

## A→B backlog drafts

When a raw backlog item looks ripe to become a spec:

- **Quote the raw item verbatim** so the owner sees exactly what is being
  interpreted.
- Draft a **conceptual** spec — make the desired thing clear; **no file
  citations** (files change before implementation).
- This is a **discussion seed in the findings file**, never an edit to
  `backlog.md`. Promotion raw → specced is always the owner's manual call.

## Output contract (machine-readable for the SessionStart hook)

`doc-review-findings.md` must contain a single delimited block holding **only the
items that need the owner** — proposed instruction-file edits and design decisions.
A local SessionStart hook reads this block and surfaces it at the start of every
conversation. Keep the FYI ("what I auto-applied") outside the block.

```
<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [id] CLAUDE.md — <one line> — proposed: <diff or change>
### Design decisions for you
- [id] <doc> — <the question, with verbatim quote where relevant>
### Doc-set condensation
- [id] <docs involved> — <merge / fold / retire / trim proposal + target home>
<!-- DOC-REVIEW-OPEN:END -->
```

If there is nothing open, the block is present but empty (hook stays silent).

### Clear-on-apply (between nightly runs)

The nightly is the *primary* clearing mechanism: run N+1 re-scans `main`, sees a
fixed item, and regenerates the block without it. But that leaves a window —
between a fix landing on `main` and the next nightly — where every session-start
re-surfaces the same already-resolved items (the nag observed across sessions on
AF-1/D-5/D-6/D-7).

So the surface hook also filters against a local **clear-on-apply ledger**
(`.claude/hooks/doc-review-resolved.json`, keyed by the findings.md commit SHA).
After the host applies or rejects items, it records them:

```
node .claude/hooks/doc-review-resolve.mjs <ID>...   # e.g. AF-1 D-5 D-6 D-7
node .claude/hooks/doc-review-resolve.mjs --list    # show the open ids (matches the surface digest)
```

Ids are validated against the open findings block — an id matching no known finding is
rejected, not silently recorded (a leading `-` is always a flag, never an id).

Those IDs stop surfacing immediately — no waiting for the nightly, and no push to
the `doc-review` branch (which would race the cloud routine that owns it). When
the nightly regenerates findings.md the SHA changes, the old resolutions expire
automatically, and any genuinely-new item surfaces. The ledger is committed so
the disposition is shared across machines.

## Hard invariants

- Verify from code, never from prose.
- No code anchor → it is a question for the owner, never a silent deletion.
- Instruction files (`CLAUDE.md`, `AGENTS*.md`) are **never** auto-edited.
- The **full** green gate — `npm run build && npm run check &&
  npm test` — passes before any `main` push. Never `build`+`check` alone: the
  test suite is what catches a doc edit that desyncs a generated host asset from
  its source-of-truth `.md`.
- Each auto-applied change is one discrete, revertible commit.
- Findings file & ledger live only on the `doc-review` branch; `main` only ever
  receives reviewed, green-gated doc edits.
