# Self-scaling remediation pipeline — design

> Supersedes the earlier "give document input a separate lean fast path" framing of the
> *Make the loop cheaper* backlog item. Durable conceptual design; no dated status here.

## Problem

The `/remediate-code` contract pipeline (intake → goal_spec → context → decomposition →
contracts → seam → finalize → critique → obligation-ledger → cyclic-seam-resolution → test-plan
→ assessment → counterexample → judge(+repair) → impl-DAG → review → dispatch → triage → close)
applies the **same full ceremony to every input regardless of size or risk**. Empirically
(laps 1–3) that made a one-line log-removal cost roughly the same orchestration as a
concurrency-correctness change. A separate `leanFastPath` that *skips*
the whole design ceremony for pre-vetted structured-audit findings is the wrong shape: it is too
trusting (remediation routinely re-finds errors in audit conclusions), too narrow in scope
(document/backlog input can't reach it), and structurally-forked (a separate eligible/ineligible
gate rather than a point on the Dial A/B continuum). Per the A6 target ("self-scaling pipeline,
not forked paths"), the lowest-risk case is the lowest point of the dial, not separate code: Dial A
enforces a mandatory light-review floor rather than a zero-scrutiny skip — see Mechanisms, Dial A/B
below for the shape.

## Two distinct cost drivers (measured)

1. **Phase round-trip ceremony** — ~12 artifact writes + validates per run. The *content* already
   scales (a 1-module decomposition is short; an empty seam report is empty), but the *number of
   gated steps* is fixed regardless of complexity. Latency/ceremony cost.
2. **Mandatory independent adversarial passes** — the critique + counterexample sub-agents
   (~50–90k tokens *each*, every run) spin up full independent reviewers even for a trivial change
   that warrants none. The dominant token cost, and the most disproportionate.

## Principle — scale the process to the work, don't fork the path

**Do NOT create separate cased paths (fast vs deep).** Make the ONE pipeline self-scaling: a
straightforward change naturally produces a straightforward (cheap) traversal, a risky/complex
change naturally tightens. Two continuous dials, one shared signal.

### Dial A — adversarial depth (the token saving)
Critique / counterexample scrutiny scales with the assessed risk/complexity:
- low → an **inline lightweight self-check** (no independent sub-agent);
- high → full independent critique + counterexample + judge (as laps 1/3 used, and earned).

**Floor is *light*, never *off*.** Nothing — including pre-vetted structured-audit findings — gets
zero scrutiny, because remediation legitimately catches upstream (audit) errors. The
structured-audit lean path now runs one bounded light adversarial pass before proceeding
(`interpretLeanLightReviewVerdict` in `src/remediate/riskSignal.ts`), escalating to the full
pipeline on any concern — a mandatory light-review floor, not a zero-scrutiny fork.

### Dial B — phase granularity / round-trips (the ceremony saving)
- **Collapse in general**: phases that are one coherent act of authoring (e.g. decomposition +
  contracts + seam + finalize for a single-module change) can be ONE round-trip producing several
  artifacts. The fine split buys failure-isolation + per-phase gating — valuable only when there is
  real complexity to isolate.
- **Granularity = `f(complexity)`**: round-trip count is not a fixed 17. Trivial → a few coarse
  steps; complex multi-module → stays fine-grained (that is exactly when the isolation + per-phase
  validation gates earn their cost).
- **Degenerate phases collapse by structure** with no risk call at all (1 module ⇒ seam-reconciliation
  is a no-op ⇒ skip; no seam adjustments ⇒ finalize folds into drafting).

### Optimistic-start, escalate-on-evidence
Avoid needing a perfect upfront risk classification. **Begin coarse + light** (assume simple); if
evidence emerges that the work is harder than assumed — decomposition surfaces a cross-module seam,
the light self-check flags a real concern, a verify fails — **escalate** that work to finer
granularity + deeper (independent) review. The pipeline tightens only where evidence demands it.

## The shared risk/complexity signal

One signal drives both dials. Assessed **cheaply at intake** from data available at the routing
point — affected-files count + a deterministic, configurable **path-risk pattern set** (concurrency /
dispatch / merge / state / quota / shared-core = risky) + the run intent — and **re-assessed as the
run produces evidence** (per escalate-on-evidence). It must NOT depend on pipeline-internal outputs
(the lap-3 circularity: `changeClassification` consumes `finalized_module_contracts`/obligations that
don't exist at the routing point — a routing signal cannot be a pipeline output).

## What this dissolves

- **No separate document lean path** ⇒ no separate plan-builder ⇒ the lap-3 "document→`Finding`
  synthesis seam" problem **evaporates**: there is one flow that turns any input into the work it
  implements; document input is just a coarse, light traversal of it, not a forked path needing its
  own finding synthesis.
- **No reuse-vs-re-derive question** — with one flow there is no second path to reconcile.

## The mechanisms that realize this

Four mechanisms implement the two dials and their shared signal:

- **Degenerate-phase collapse** — pure architecture, no risk signal needed: a 1-module change makes
  seam-reconciliation a no-op and folds finalize into drafting, so those round-trips skip by structure.
- **The shared intake risk/complexity signal** (`src/remediate/riskSignal.ts`, whose design of record
  this doc is) — affected_files + configurable path-risk patterns + intent; fail-closed (uncertain ⇒
  treat as higher-risk ⇒ deeper/finer), with a re-assess hook so evidence during the run can raise it.
- **Dial A — adversarial depth** (`adversarialDepthForTier`, consumed in
  `src/remediate/steps/contractPipeline.ts`) — light inline self-check vs full independent sub-agents,
  selected by the signal; floor = light, so the pre-vetted audit path gets light review rather than a skip.
- **Dial B — granularity** (`contractPipeline.ts`) — collapse coherent phases into fewer round-trips for
  low-complexity work, keep fine-grained for high, and escalate-on-evidence.

## Invariants this must preserve

- Every change still passes the whole-repo green gate (build + check + tests) before it lands — the
  dials scale *design scrutiny + ceremony*, never the final verification.
- Nothing reaches zero adversarial scrutiny (light-floor).
- The routing/complexity signal is computed only from data available when it's needed (no
  pipeline-output circularity); unevaluable ⇒ fail toward more scrutiny, never less.
