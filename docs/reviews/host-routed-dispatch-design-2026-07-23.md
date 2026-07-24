# Design of record — dynamic 9router-backed routing for audit-tools

Status: design + right-sized plan (not yet built). Converged with owner 2026-07-23. Promote durable
parts to `spec/` when the roster+quota read lands. Companion notes:
[`proactive-dispatch-via-9router-2026-07-23.md`](proactive-dispatch-via-9router-2026-07-23.md),
[`litellm-vs-cli-dispatch-investigation-2026-07-23.md`](litellm-vs-cli-dispatch-investigation-2026-07-23.md).
Memory: `routing-is-separate-from-categorization`, `9router-functionality-wanted-tos-reversed`,
`proactive-dispatch-is-naming-the-target`.

## Goal

audit-tools categorizes each work packet by its *requirements*; its existing deterministic router —
re-pointed to read 9router's **live** roster + quota — picks a current target per policy; 9router
transports, tracks quota, and reactive-falls-back. Result: **dynamic** (new models adopted with zero
edits), **agnostic** (runtime-discovered, nothing baked in), **never-pay** (free sorts first, paid
pruned), **capability-floored** — with no LLM in the hot loop and no new router built.

## What changed from the earlier framing (owner, 2026-07-23) — this right-sizes the work

Two corrections dissolve the false "LLM-per-dispatch vs build-a-huge-router" choice:

1. **Routing is DETERMINISTIC, not host-LLM-per-dispatch.** Ranking a roster by capability ∧ cost ∧
   quota is mechanical. An LLM in front of every dispatch is latency/cost the problem doesn't need.
   (Reserve LLM judgment for genuinely ambiguous cases only — "right tool, not deterministic dogma"
   — never the per-packet default.)
2. **"Everything-agnostic" means runtime-discovered / contract-abstracted, NOT a separate process**
   (CLAUDE.md's own definition). A router that reads the live roster/quota with zero hardcoded model
   ids *is* agnostic whether it lives in its own binary or inside audit-tools. So the router does
   **not** need to be extracted into a standalone tool. Physical extraction is optional purity,
   deferred indefinitely.

**The deterministic router largely already exists in audit-tools** — capability floor, cost rank,
quota-aware admission control are built and working. This is a **re-point + two small adapters**, not a
from-scratch build.

## Three-role contract

| Role | Owner | Produces / owns | Must NOT own |
|---|---|---|---|
| **Categorize** | audit-tools | per-packet *requirements*: est. tokens, complexity, importance, min-capability floor, cost-class | which model; provider transport |
| **Route** | audit-tools' deterministic router (runtime-discovered) | rank the **live** 9router roster by capability ∧ cost ∧ quota under the policy → a current model id | baked-in model ids; LLM-per-dispatch |
| **Transport + track** | 9router | upstream call, format translation, quota/usage state, reactive fallback | task semantics; capability floor |

Categorization never names a model; the router picks from 9router's live `/v1/models`; **nothing pins**.

## Enforcement stays mechanical (the robustness invariant, trivially)

Because the router *is* the tool, capability floor / quota headroom / never-strand are enforced in
code, not host discretion — the `enforce-robustness-in-tooling-not-host-discretion` invariant holds by
construction. **Policy** (daily = quality-first Claude→Codex/AGY→free; audit = free-first
capability-floored) is a declared **input** to the router, not a fork — one router, two policies.

## Never-pay + free-first fall out of the existing cost rank

9router's roster carries each model's provider; free tiers price at cost 0 → they sort first in the
router's existing cost rank, so **free-first is automatic**. Paid lanes (DeepSeek / Mistral /
Perplexity — the only truly billable connections) are excluded by **pruning** (don't connect, or mark
excluded), so "never pay" is guaranteed by the roster the router *sees*, not by hoping routing avoids
them. (Live free quota is large — AGY ~10 models×1000/5h incl. free Claude, Gemini-CLI 8×1000/day,
Kiro 50/wk — so free-first is genuinely viable, not a fallback.)

## Honest accounting — book against the SERVED target

Named target = a request; served target = a fact. 9router returns the served model in the
response/usage; reconcile against it (reuse `extractReportedCostUsd` / cost-drift seam), or a silent
reactive fallback corrupts the ledger.

## Right-sized change list (the actual work)

1. **Re-point `proxyCatalog` at 9router** — declare `:20128/v1` as the openai-compatible source;
   `proxyCatalog.ts` already reads `/v1/models` into the uniform roster (built for the LiteLLM work).
   *Mostly config; the read seam exists.*
2. **`NineRouterQuotaSource` adapter** — read `/api/usage` + the quota tracker → normalized per-target
   headroom; fold into `cross-provider-quota-matrix`. *One small HTTP adapter.*
3. **Capability-rank mapping (the one real gap)** — the floor needs ranks for 9router's namespaced ids
   (`ag/`, `cx/`, `kr/`…), which won't key-match the models.dev snapshot. Prefix-normalize
   (`ag/claude-sonnet-4-6` → `claude-sonnet-4-6`) to match where possible; operator-declared ranks for
   the rest; unmatched degrade to the floor default. *Bounded — a normalize + fallback.*
4. **Dispatch target** — the openai-compatible worker POSTs to 9router with the chosen id.
   *Existing provider, re-pointed.*
5. **Served-target readback** — parse 9router's served model from the response → reconcile. *Small.*

**Not doing** (optional later purity, not required for any outcome above): extracting a standalone
router process; dissolving audit-tools' own transport layer.

## Open questions

- **Capability ranks for niche 9router models** — many aren't in models.dev; prefix-normalize +
  operator-declared fallback; unmatched degrade to floor. This is the item most likely to need a pass.
- **Worker class** — whether the single-shot openai-compatible lane suffices, or audit workers that
  touch files need the agentic `claude-worker`-via-9router path (a proxy-backed agentic lane).
- **Policy set** — start with the two policies above; refine the audit task-class taxonomy on evidence.
