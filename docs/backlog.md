# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Live-validation guide — READ FIRST if you're running a live audit/remediate

Most open items below are **code-complete and only await a real run to confirm**. Each such item
carries a **⬇ Live-run watch** line: exactly what to observe during the run to confirm it validated —
or to catch it failing. Pick a run config from this matrix; watch the items it lights up.

| Run config | Items it exercises (watch their ⬇ lines) |
|---|---|
| **Any** live audit, any provider | Selective-deepening convergence · knip `files`/`dependencies` dead-code leads |
| **Metered provider + LARGE target** — this is what exercises the wall (`AUDIT_TOOLS_LIVE_QUOTA=1` only enables the live-credential test probe in `tests/audit/inv2.test.mjs`, it does not force a production wall) | Quota-aware dispatch · M-QUOTA friction escalation · pre-wall pacing · retryable resume |
| **Codex backend** (`--provider codex`; Codex CLI is a nested-agent host) | Y-dispatcher driver selection · cross-provider quota (Codex live endpoint) |
| **openai-compatible / NIM backend** (`RUN_NIM_E2E=1` for the gated e2e) | openai-compatible dispatch pool · CE-004 emit-time-constraint build opportunity |
| **Rust or Ruby target repo** | clippy (cargo) + rubocop (bundle) live spawn |

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a *crash*
(not a graceful pause) when a rate limit is hit · an analyzer that silently skipped when it should have
spawned · knip dead-code leads that never reach the per-file lens. After a run, its findings are the
corpus to hand-label for the A2 oracle (see Deferred / waiting).

---

## Open bugs / frictions — fix in tooling (never "host remembers")

> **Friction-walk entry template:** one line per friction — a bold title + the `[[memory-tag]]` for the
> durable lesson + only the still-OPEN tool sliver(s). No shipped-work narrative or changelog prose (that
> lives in git log / memory). Condense at write time, not in a later doc-review pass. The `[[memory-tag]]`
> appears only where a durable memory concept was actually captured for that item — by design, not every
> entry has one.
- **Live dogfood: BOTH dispatch paths failed to place a single review packet — free-pool in-process spill dispatched nothing AND host review walled at 56% (2026-07-15 repair-proxy dogfood, HIGH, reproduces [[relax-dispatch-source-forcing]] + [[capability-is-per-auditor-not-per-audit]]).** Config: host=claude-code, `repair_proxy` + `sources:[opencode-free]`, `dispatch.rolling_engine` unset (defaults TRUE). Result: 430 planned audit tasks, ZERO dispatched anywhere. VERIFIED facts (dispatch-quota.json + proxy access log + source): (1) **proxy received only 4 `/registry` hits and ZERO `/v1/chat/completions`** — no packet ever reached repair-proxy; (2) the in-process free-pool spill's gate PASSED (`resolveAuditRollingEngineEnabled`=TRUE default [`sessionConfig.ts:86`](src/shared/types/sessionConfig.ts); `auditSourcePools.length>0`, [`nextStepHelpers.ts:1808`](src/audit/cli/nextStepHelpers.ts)) and it DID assign the frontier to the source pools — but **every `openai-compatible` worker launch returned `fail()` BEFORE POSTing** (VERIFIED from `task-results/*.stderr.txt`, run 224009): **131 packets** = `"provider has no API key"` (repair-proxy is loopback/keyless but the provider demands a non-empty key and discovered repair-proxy sources carried none — `repairProxyRegistry.ts` (now retired) only set `api_key_env` when `cfg.api_key_env` was set) [**B1**]; **~136 packets** = `"refusing to dispatch an unroutable packet: N granted file(s) could not be inlined for a no-file-access worker"` — audit review packets bundle many files over the default inline caps (64KiB/file, 256KiB total, 24 files), the v0.32.68 [[openai-compatible-content-inlining]] residual (a) biting live [**B2**]; +2 `empty completion` (NIM). `!accepted`→`outcome:"error"` ([`providerLaunchFinalize.ts:62`](src/shared/dispatch/providerLaunchFinalize.ts)) is a TERMINAL completion, so the spill "completes" with 430 errors, 0 POSTs (proxy log confirms), 0 coverage; the host complement then walls. `active-dispatch.json` holds only `paused_state`. **These launch-layer failures are INDEPENDENT of the inventory-source architecture — the per-auditor-handshake decoupling would NOT fix dispatch.** (3) the host review path then built `capacity_pools`=host-ONLY (by design — [`tokenUsageObservation.ts:92`](src/audit/cli/dispatch/tokenUsageObservation.ts): source pools "belong to the separate in-process engine") and walled at **56% remaining, NOT exhaustion**: `empty_grant` from [`hostDispatchWall.ts:66`](src/shared/dispatch/hostDispatchWall.ts) with the misleading message "session limit is exhausted" ([`semanticReviewStep.ts:175`](src/audit/cli/semanticReviewStep.ts)); `admission.explains` was EMPTY (no per-packet reason recorded). Endpoints: (a1) **B1 — repair-proxy loopback sources need no key but the provider refuses without one**: stamp a placeholder key on repair-proxy-discovered sources (like opencode-free's `api_key:"public"`) or treat a loopback/127.0.0.1 endpoint as keyless-OK in `OpenAiCompatibleProvider` ([`:140`](src/shared/providers/openAiCompatibleProvider.ts)); (a2) **B2 — no-file-access single-shot workers can't take large multi-file audit packets**: either raise `openai_compatible.referenced_file*` caps, partition audit packets smaller for single-shot workers, or route oversized packets to a file-reading provider — a real design choice, since NIM/opencode/repair-proxy workers fundamentally have no Read tool; (b) **cold-start admission**: a host at 56% must not 0-grant → "exhausted" (the null-budget→+Infinity→probe path should still admit ≥1; capability/context-fit filter [`admissionLoop.ts:240`](src/shared/dispatch/admissionLoop.ts) or an empty-explains short-circuit is suspected — pin it); (c) **diagnostics**: `explains:[]` on a 0-grant is undebuggable, and "exhausted" is wrong at 56%. **Architectural (owner note [[capability-is-per-auditor-not-per-audit]] extension):** dispatch INVENTORY (`sources`/`repair_proxy`/provider blocks/available models) is read from the REPO-persisted `.audit-tools/audit/session-config.json` (single chokepoint `gatherDispatchableSources` [`apiPool.ts:473`](src/shared/quota/apiPool.ts)) → couples dispatch to the repo/run; it must be resolved PER-AUDITOR from the current auditor's environment at dispatch time (generalize the `--host-models` handshake channel), leaving the repo session-config to carry audit INTENT (scope/lenses/policy) only. Full writeup: scratchpad `repair-proxy-dogfood-findings.md`. **RESOLVED to a design of record ([`spec/unified-dispatch-worker-model.md`](../spec/unified-dispatch-worker-model.md), [[unified-dispatch-worker-model]]):** repair-proxy is a kind-1 tool-repair launch-transport, not a source pool — so **B1/B2 dissolve by RETIRING the source-pool wiring** (not by fixing them), inventory moves to the per-auditor handshake, and only **C** (cold-start host wall) remains a standalone fix. The old "repair-proxy dispatch integration" item + `spec/repair-proxy-dispatch-integration.md` are retired by that rework.
- **Friction walk (repair-proxy dogfood lap, 2026-07-15):** (1) **tool-should-decide / conceptual (medium):** Gate-0 organizes repair-proxy-discovered pools under the TRANSPORT namespace (`repair-proxy/nim/z-ai/glm-5.2`) as if repair-proxy were a provider — owner: "repair-proxy isn't a provider, we shouldn't organize dispatch in those terms." The real axes are (a) the actual backend model and (b) the OPERATOR's cost relationship to it (subscription-included / free-tier / metered-paid), for which repair-proxy is just one transport. Endpoint: model dispatch pools by `(backend-model, operator-cost-class)`, with transport an attribute, not the namespace. (2) **tool-should-decide (medium), overlaps [[quota-before-cost-ordering]]:** the cost ordering shows models.dev **LIST price** ($1.92 for nim/glm-5.2), but the operator pays **$0** for it (NVIDIA NIM free tier). Free-to-operator vs metered is a per-`(operator,backend)` fact the catalog can't know; discovered pools default to list price, so a genuinely-free backend sorts as if expensive and a paid one (openrouter) can hide mid-list. Today's only lever is hand-declaring `cost_per_mtok:0` / `enabled:false` per backend in `repair_proxy.providers` (done for this run) — the tool should let the operator classify a backend's cost-relationship once, not re-price every model. (3) **tool-should-decide (low):** no way to mark a whole discovered transport's sub-provider as paid→excluded at Gate-0 itself; had to edit session config + re-run next-step. (4) **tool-should-decide (medium), = [[per-model-tiering]]:** owner reinforced that capability/tier is assigned per PROVIDER, not per (provider, model, effort). Concrete: Codex (`~/.codex/config.toml` model=`gpt-5.6-sol`, effort `high`, but `-m/--model` + `-c model=` take any model per-call) renders at Gate-0 as ONE `capable`/`resolved at dispatch` row because the legacy `codex` block has a single `model` field — its multiple models at different capability tiers collapse to one. The tool's own workaround (pin `sources[]` `{provider:codex, model, parameters:{extra_args}}` per model/effort) puts the burden on the operator; the tiering should be per-(provider,model,effort) natively, sourced from models.dev / declared config. (5) **env-var trap (low):** repair-proxy `mistral` provider hardcodes `authEnv: "MISTRAL_API_KEY"`, but the operator's Mistral La Plateforme key lived in `CODESTRAL_API_KEY` (Codestral and La Plateforme share one key but the env-var name differs) → pool silently `has_key=false`/excluded until the authEnv was repointed. A reachability probe that reports "keyed but wrong-env-var" vs "no key" would cut the diagnosis.
- **Friction walk (force-synthesize→remediate dogfood lap, 2026-07-12):** (1) **inefficient-feeding (medium):** the contract pipeline requires ~15 sequential HOST-authoring turns (goal→context→decomp→16 shards→seam→critique→testplan→assessment→counterexample→judge→DAG) BEFORE any dispatch, so with host fan-out off (to save Claude quota) the quota is spent up-front on planning regardless of routing fixes to $0 NIM/Codex; and each failed next-step CONSUMES the `*.input.json` (full regen, no in-place field fix). (2) **tool-should-decide (low):** the implementation_dag citation-grounding gate grounds on lowercased path/symbol *tokens* from title+description, so a node whose scope is dotfiles with no code symbols (`.gemini/*.toml`) or whose prose cites real paths non-token-shaped is rejected — 2 grounding re-loops until a real camelCase symbol / clean lowercase path was embedded.
- **Friction walk (quota-cluster batch-ship lap, 2026-07-11):** (1) **NIM `llm read`/`write` unusable for reasoning-heavy review** — the selected `nvidia/nemotron-3-ultra-550b` won't emit valid JSON for a `read` review prompt (returned prose "Let me ana…" twice → the strict JSON contract errors out), and a ~500-line diff times out at the default 120s. The "delegate heavy loop-core review to the free NIM pool" workflow ([[three-tier-quota-error-classification]], [[free-nim-pool-first-default-worker]]) silently degrades to doing it in-Claude. Endpoint: either pin a JSON-reliable model for `llm read`/`write`, add a longer default timeout for large stdin, or teach the worker to salvage prose→structured. (inefficient-feeding, medium). (2) **`pre-commit-gate.mjs` false-positives on `git commit -C <sha>`** — the bypass-flag scan flags `-C` as `-n`/`--no-verify`, blocking a legitimate reuse-message commit; had to fall back to `-F <file>`. Tighten the flag regex to word-boundaries. (tool-should-decide, low). (3) **`rtk npm run …` → "program not found"** on this box — the rtk npm wrapper can't resolve the npm shim, so `rtk npm run build`/`check` fail; use PowerShell `npm` directly (CLAUDE.md's "always prefix rtk" doesn't hold for npm here). (durable trap, low).
- **Friction walk (repair-proxy capability-feed ship lap, 2026-07-15):** (1) **tool-should-decide (medium):** the local `verify:release` gate returned **exit 0 while reporting "3 failed"** — a false green that let a deterministic bug (the Gate-0 fold double-ranked the legacy `openai_compatible` pool → `provider-confirmation-gate` `expected 2 to be 1`) reach the release CI, which correctly caught it in shard 3/4. The local full-suite gate must fail-nonzero on ANY deterministic test failure (suspect a `--retry` masking the count, or the profiling reporter swallowing vitest's exit code); until fixed, treat "N failed" in the summary as a hard stop regardless of exit code. (2) **tool-should-decide (low):** `tests/audit/quota-command.test.mjs > nothing written to disk` asserts `repoRoot/.audit-tools/audit/session-config.json` is absent, but that path is a **gitignored run artifact** a prior local audit/dogfood leaves behind → false LOCAL failure (green on a fresh CI clone). Harden the test to sandbox the repo-root probe (or assert against a temp root), not the live checkout.
- **CI coverage gap: a docs-only commit skips the vitest suite, so a doc-lint / staleness-parity regression lands on main UNCAUGHT (2026-07-15, tool-should-decide, medium).** `audit-code-test-suite.yml`'s release-bump/docs skip guard skipped the vitest suite for commit `016d5945` (an owner-approved doc-review resolution touching `spec/audit-workflow-design.md` + `spec/audit/dependency-map.md`), so its two deterministic failures (design-docs-declarative banned-status-language at :85; staleness F1 inv-6 dep-map parity, where a producer-table row bled into the naive `.md` edge parser) sat red on main until the next CODE push re-ran the suite. Both were cheap, deterministic, doc-derived checks. Endpoint: run the doc-lint + dep-map-parity tests (design-docs-declarative, the staleness literal-parity guards) in the cheap `ci.yml` chain which does NOT skip on docs commits — a doc commit that breaks a doc-derived invariant should fail its own push, not the next unrelated code push. (Both failures fixed in `5c9edcb2`; the skip guard itself is the open item.)
- **Friction walk (openai-compatible content-inlining ship lap, 2026-07-15):** (1) **process/self (medium):** an adversarial-review HIGH-fix ADDED a field to a widely-asserted contract (`DispatchPlanEntry.file_paths`) AFTER the full-suite run; only targeted tests were re-run, so `review-packets.test.mjs`'s exact `Object.keys(plan[0]).sort()` key-set assertion (shard 1/4) was missed → caught by release CI, one forward-bump. Lesson: any post-review change to a CONTRACT SHAPE (a new field on a persisted/asserted type) forces a full-suite rerun, not a targeted one — the blast radius is every exact-shape assertion, not just the changed module. (2) **tool-should-decide (low):** exact `Object.keys().sort()` shape assertions are additive-hostile by design (leak-guard) but give a cryptic `expected 6 to deeply equal 5` with no field name; a helper that diffs and names the unexpected/missing key would cut the diagnosis loop.
- **Provider auto-detection misses NIM (openai-compatible) when `openai_compatible` config absent — needs session config to appear (2026-07-13 audit-gate review).** NIM does not auto-detect via PATH probe like CLI providers; it requires explicit `openai_compatible` or `sources[]` session config to appear in the pool. User expectation: NIM should appear even without config. [[nim-not-auto-detected]]
- **Provider cost ordering does not consult quota before suggesting order — quota-blocked providers still appear first (2026-07-13 audit-gate review).** The Gate-0 `suggestCostOrdering()` sorts purely by $/Mtok and tier; no quota headroom (remaining budget, rate-limit state, cold-start cap) is factored. A quota-saturated provider is still listed first, misleading the operator. Fix: pre-query quota state and demote/flag exhausted pools in the suggested order. [[quota-before-cost-ordering]]
- **Provider tiering is per-provider, not per-model/effort — wrong granularity for multi-model backends (2026-07-13 audit-gate review).** The `capabilityTier` is pegged to the provider type (e.g., all claude-code → frontier, all codex → capable). A provider offering both frontier and fast models (e.g., openai-compatible with multiple models) assigns all its models the same tier. Fix: tier per `(provider, model, effort)` tuple, sourced from models.dev or declared config. [[per-model-tiering]]
- **agy quota may reuse the wrong credential store (unverified, live-check).** agy is aliased into AntigravityQuotaSource (`src/shared/quota/antigravityQuotaSource.ts`, `ANTIGRAVITY_PROVIDER_NAMES`) which reads the IDE's `state.vscdb`/`ANTIGRAVITY_ACCESS_TOKEN`. Unverified whether the agy CLI shares that IDE credential store; if not, agy quota reads silently return null (degrade). ⬇ Live-run watch (agy install): confirm agy quota reads are non-null off its real endpoint.
- **Design (orchestrator-dispatch coupling): the dispatch system tries too hard to force specific assignments of nodes/packets to sources (2026-07-13, forward-track).** The current dispatch system/coordinator pre-assigns specific nodes to specific pools up-front, creating rigid bindings. Shift to the originally-intended model: decouple the `ClaimRegistry` so claims are pool-agnostic locks (simply checking out a node/task for an orchestrator, not binding it to a `poolId`), and move quota reservations to a **Just-in-Time (JIT)** model. The dispatch planner's role should be simplified to feeding the orchestrator clear, real-time metadata of each source's current quota headroom, rate limits (RPM/TPM), and capabilities, allowing the orchestrator to dynamically select and reserve quota JIT right before calling the provider. [[relax-dispatch-source-forcing]]
- **Never-dispatched anti-cascade retry (deferred, needs clean repro) [[synth-scopeless-nodes-doomed-run]].**
  A planned-but-not-driven node (no `task.json` written before launch) still terminal-blocks its whole
  downstream subtree (INV-RS-01) instead of retrying bounded-PENDING. Diagnosability (distinguishing
  never-dispatched from dispatched-but-silent) shipped in `mergeImplementResults`; the termination-safe
  retry did not — livelock risk needs a repro to validate before building it. Also still open: a
  dispatch-boundary "no scope-less dispatch" guard (refuse to dispatch a node whose synth-derived scope
  is empty, rather than relying solely on the synth-side fix that derives scope from module `file_scope`).
- **`tests/shared/rollingDispatch.test.mjs` is a genuine timing flake (2026-07-12, tool-should-decide, medium).**
  "second dispatch should start after first completes: expected 1 to be 2" — a wall-clock/ordering assertion
  that flakes under full parallel load; passes in isolation. It flaked the v0.32.62 publish CI (shard 2/4;
  the CI test suite has no `--retry`, unlike the now-hardened remediate gate) → re-run cleared it. De-flake the
  test itself (deterministic scheduling/fake timers), per test-failure-protocol "passes alone = hermeticity/
  timing bug → fix the test." Until then, a publish may need one CI re-run.
- **"Delegate the rolling loop" dispatcher pattern breaks on notification routing (2026-07-11 live run, tool-should-decide, medium).**
  The step prompt tells the host to hand the rolling loop to one dedicated dispatcher subagent, but worker
  completion notifications deliver to the MAIN session (the dispatcher idles between events), so the host
  must manually relay every completion to the dispatcher — the exact per-node tracking the delegation was
  meant to remove. Either the prompt's model is wrong for hosts with this notification topology, or the
  worker prompts should instruct workers to message the dispatcher directly.
- **NIM in-process worker: one packet failed with "empty completion (no choices[0].message.content)" (2026-07-11 live run, watch).**
  Hybrid partition (3 packets): 2 returned results inline, 1 errored empty. If it recurs on a specific
  model (ultra vs nano), demote that source or add a bounded same-packet retry on a sibling $0 pool.
- **Abandoned-wave leases saturate the cold-start cap → phantom "quota wall" (2026-07-11 live run, low — NOT a release bug; the reconcile already exists).**
  A host grant came back `granted 0`, all 14 packets `cap_reached`, `headroom_before: null` (ledger never
  consulted): `admitBatch` seeds `countByPool` from the ledger's live leases (admissionLoop.ts:307-319), the
  ledger held 4 leaked leases (2/pool, agent `24556`) with the 20-min TTL still live, and with cold-start
  effectiveCap = 2/pool the phantoms fully saturated the cap. BUT the release machinery is present and
  correct — `mergeAndIngestCommand.ts:595` reconciles a grant's leases at the top of every merge and
  `dispatch.ts:679` reconciles on the pause path. The leak's true cause was OPERATIONAL: waves I KILLED
  mid-flight this session (stopped drain, dead dispatchers, session-limit fleet deaths) never reached merge
  or pause-reconcile, so their leases freed only via the 20-min TTL. Working-as-designed backstop; cleared 4
  by hand. Only residual worth considering (deferred, low): a `next-step` startup sweep that reconciles
  leases whose owning run is demonstrably dead, so an abandoned wave doesn't false-wall a fresh one for up
  to 20 min. Not a defect in the release path itself.
- **empty_grant reset-time + progress-aware livelock — SHIPPED v0.32.67 ([[host-fanout-quota-gate]]).**
  `deriveTokenBudget` returns the binding (MIN-budget) window → `WaveSchedule.binding_window` → capacity
  summary; `detectHostDispatchWall` derives `earliestResetAt` from it + `renderHostWallExplanation` surfaces
  window/budget/cost in both pause renderers (audit + remediate parity), gated on a real `budget_exhausted`
  block (`admissionBlockedOnBudget`) so a `cap_reached` ledger-contention grant keeps best-effort null-reset.
  `advanceHostDispatchPause` gains `madeProgress` (in-process `accepted_count>0`) → resets the wall-pass
  counter, so a hybrid run whose NIM partition keeps covering ground never trips the livelock give-up.
- **openai-compatible content-inlining + unroutable guard — SHIPPED v0.32.68 ([[openai-compatible-content-inlining]]).**
  Root cause was NOT the `include_referenced_files` default (already on): the provider only ever inlined by
  SCAVENGING path tokens from rendered PROSE, and prompts are authored paths-only for tool-using hosts →
  a single-shot NIM worker (no Read tool) got no content, fabricated schema-valid-empty, was dropped —
  on BOTH review and implement paths. Fix: `LaunchFreshSessionInput.referencedFiles` (authoritative
  repo-relative granted read set) inlined deterministically (granted-first; prose-scavenge kept as
  best-effort supplement that never gates a dispatch) + a refuse-to-dispatch guard (`accepted:false` →
  triage/re-dispatch) when a granted file EXISTS but can't be inlined (over per-file/total/count cap or
  path escape); an ENOENT granted file is a to-be-created `touched_files` output, skipped not failed.
  Audit feeds a new repo-relative `DispatchPlanEntry.file_paths` (adversarial-review-caught HIGH: the
  absolute `access.read_paths` host-grant would self-inline the prompt + false-refuse on an out-of-repo
  `--artifacts-dir`); remediate feeds `access.read_paths` (repo-relative). Residuals (each accepted,
  low): (a) **large-packet hard-refuse** — a review packet whose `file_paths` exceed the default caps
  (64KiB/file, 256KiB total, 24 files) now REFUSES on a single-shot worker rather than silently
  half-reviewing (intended: loud > fabricated coverage; operator raises `openai_compatible.referenced_*`
  caps or routes to a file-reading provider). (b) The stat-error branch refuses on a non-ENOENT error
  (EACCES/ELOOP) for an existing granted file — correct, but untested (hard to simulate portably).
  **The `include_referenced_files:true` live workaround is now obsolete** — NIM/opencode are usable for
  review + implement (env-bound live confirmation still wanted on a real run).
- **A2b unmatched-quota fallback — two residuals (each low, documented at the code site).**
  - (a) **`pausedPoolResetAt` + `quotaUnclassifiedPoolIds` are not injected across sub-waves** the way
    `costDemotedPoolIds` is (`rollingDispatch.ts` state ctor + `unifiedRolling.ts`), so within a multi-sub-wave
    drive the reversible pause + the harvest-once gate reset at each sub-wave boundary — a chronically
    quota_unclassified pool is re-attempted once per sub-wave (bounded; friction dedup collapses the repeat
    harvest). Fix = thread both through the dispatcher options like `costDemotedPoolIds`. Efficiency-only.
  - (b) **The A-8 hybrid `executeInProcessPartition` (direct `Promise.all`) never invokes the rolling engine's
    hooks**, so the VERBATIM harvest (`captureQuotaUnclassifiedFriction` / `captureCreditExhaustionFriction`)
    does not fire there — a settled node surfaces only as a `quota_escalation` friction (no verbatim text).
    Affects `credit_exhausted` identically (pre-existing, not new to A2b). Fix = thread verbatim capture into
    `executeInProcessPartition`. The pool IS now settled there (no unbounded re-offer), so this is harvest-signal
    completeness, not a safety gap.
- **Design (remove-waves track): dispatch should be gated ONLY by token-budget, rate, and true task-unlocks — the host merge/re-grant barrier is artificial for independent review packets (2026-07-11 live run, owner design statement, forward-track).**
  Owner's spec: when dispatching up to quota with tokens estimated a-priori, the ONLY legitimate reasons to
  hold a packet for a later dispatch are (1) a non-parallelizable predecessor finishes and UNLOCKS the task,
  (2) the quota window refreshes, (3) the pool is RATE-limited (RPM/TPM) — not budget-limited. Any other
  hold is pure latency. Mapping onto audit-code:
  - Base review packets are embarrassingly parallel (read-only, no write conflict, no ordering) → they
    should ALL dispatch the instant they fit budget+rate; the `next-step → dispatch → merge-and-ingest →
    next-step` barrier on the host path is an artificial wave, NOT one of (1)/(2)/(3).
  - The IN-PROCESS rolling engine (codex/NIM via `driveRollingAuditDispatch`) ALREADY implements the correct
    model — continuous slot-pull, dispatch-to-capacity, refill-on-completion, pace-on-rate. The host path is
    the deviation.
  - Legitimate (1) DOES apply to ONE layer: selective-deepening tasks are derived from completed packets'
    findings (`+N deepening` per merge), so a merge must precede them — the barrier is correct for the
    deepening layer, artificial for the base frontier.
  - The calibration cap (below) is a FOURTH, illegitimate hold: it throttles on not-knowing-quota-in-tokens,
    which is neither budget, rate, nor unlock — and never resolves. Endpoint: host admission should grant the
    full budget-and-rate-fitting independent set at once (like the in-process engine), reserving merge-gated
    re-grants for the deepening layer only. Realizes [[self-scaling-pipeline-not-forked-paths]] on the host path.
- **Prescribed host fan-out quota gate — SHIPPED v0.32.66 ([[host-fanout-quota-gate]]).** The design-review
  (perspectives + judge + contract) and systemic-challenge steps now route through `gateHostFanout`
  (`src/audit/cli/dispatch/hostFanoutGate.ts`): register the host pool + lease the whole panel (budget-only
  `fanoutMode` — no cold-start clamp / concurrency cap / context-fit gate, since fan-out is host-only and
  atomic), pause resumably at the wall, and SKIP the enrichment after the livelock bound. Residual (still
  open, distinct): **ad-hoc** Agent fan-out (recon/review the host spawns outside these prescribed
  steps) still has no per-agent ledger — see the "ledger-writer / acceptNode-inert-clean lap" sliver below.
- **Design-review worker prompts — FOLLOW-UP (low, latent):** the solo `design_review_contract` branch
  still embeds the next-step advance command directly in its worker-facing prompt (`nextStepCommand.ts:391`)
  — same second-driver hazard already fixed for `design_review_parallel` (`e6b580d0`), and it has the host
  mark its own homework (vs [[delegate-adversarial-phases-to-separate-agent]]). Consider dispatching the
  contract review to an independent subagent there too.
- **Doc-review auto-apply must reconcile against HEAD, not a stale branch snapshot (2026-07-10, tool-should-decide).**
  **Tool fix (open):** the doc-review auto-apply must not re-propose/re-apply an item whose decision is already
  recorded resolved (or already committed to the tracked tree) — it should reconcile against HEAD, not a stale
  branch snapshot. Relates [[enforce-robustness-in-tooling-not-host-discretion]]. (The durable "git diff your
  instruction files after a restart" trap this friction produced now lives under *Durable traps*.)
- **Friction-walk lesson (lease-TTL / untracked-scope laps, recurring):** the SessionStart doc-review hook's
  clear-on-apply ledger (`doc-review-resolved.json`) is local-only — a worktree branched before a resolution
  commit lands on main re-surfaces already-resolved items from stale state (hit twice). Open tool fix: the
  hook should reconcile against the fetched remote's resolved-state (or flag "worktree behind main — list may
  be stale") before surfacing.

- **Untracked-exclusion scope rule — residuals (shipped 2026-07-10; each low-severity, documented at the
  code site).** The scratch-pollution bug is FIXED in tooling: `buildFileDisposition` now runs an `untracked`
  scope rule (one batched `git ls-files -z`; still-included files absent from the index → `excluded/untracked`,
  guards mirror the gitignore rule) so untracked litter can never enter the auditable scope, plus a
  single-sourced `renderHostScratchNote`/`hostScratchDir` prompt line directing host scratch into
  `.audit-tools/<area>/scratch/<run-id>/`. The unsound bounded/aggregate exclusion representation was deleted
  outright (a missing disposition record reads as *included* downstream, so aggregation silently un-excluded
  exactly the matched files — per-file records are now mandatory, validator-enforced). Residuals:
  - (a) **Submodule / nested-repo contents are now excluded as `untracked`** (parent `ls-files` lists only the
    gitlink). Consistent with citation grounding (which also can't ground them), but a silent scope change for
    repos with first-party submodules. Ideal fix = `--recurse-submodules` in BOTH the disposition rule and the
    grounding corpora (`findingGrounding.enumerateTrackedFilePaths`, M-B3 `enumerateRepoTreePaths`) as one
    atomic change — never one side alone (re-opens the asymmetry).
  - (b) **`file_disposition` now depends on git index state, which the dependency DAG doesn't track**
    (`dependencyMap.ts` keys it to `repo_manifest.json` only). An index-only change (committing a
    previously-untracked file) won't re-stale a persisted disposition until repo_manifest churns.
    ⬇ Live-run watch: after committing files mid-run-continuity, confirm they enter scope on the next audit.
  - (c) **Scope-rule guard decisions are invisible at the intent checkpoint** — `computeScopePreDigest` reads
    only per-file entries; a skipped rule (`root_untracked`/`share_exceeded`/git-absent fallback) never
    surfaces to the operator despite the summary existing for exactly that purpose.
  - (d) **Grounding corpora still use `ls-files` without `-z`** (`findingGrounding.ts:108`,
    `contractPipelineGates.ts` ~1034): non-ASCII tracked paths arrive C-quoted (`core.quotePath`), so citations
    to such paths fail grounding while the disposition (which uses `-z`) keeps them in scope.
  - (e) The audit `renderEdgeReasoningStepPrompt` single-agent dispatch carries no scratch-dir note (params
    lack run context; one bounded agent writing one results file — lowest-risk path, add if it ever litters).
- **Friction-walk lesson (ledger-writer / acceptNode-inert-clean lap):** `[[spec-degradation-and-doc-staleness]]`
  (verify premises before building; a pause/interrupt is not a content-veto) — see memory. Open tool slivers:
  (a) NIM `llm read` going down silently degrades the "route review to free NIM" plan to paid subagents with no
  signal — a health-probe-then-route would remove the guesswork; (b) ad-hoc Agent fan-out (recon/review)
  still has no per-agent ledger for a session-limit mid-edit death, unlike remediate-code's per-node
  worktrees + claims.

- **External shared-logic audit V1–V7 residuals** (each deliberate, low-severity, documented at the code
  site):
  - **(from V3) postinstall agent-scope legacy-wildcard migration gap.** Both postinstall scripts preserve
    an EXISTING legacy agent-scope bash `'*':'allow'` in an already-deployed
    `~/.config/opencode/opencode.json` on upgrade (the wrapper/install path DOES migrate it → `'ask'`;
    pinned deliberate by remediate's COR-fc1f12a6 tests). Full closure: mirror the wrapper's
    `withoutManagedBroadBashWildcard` migration into `scripts/{audit,remediate}/postinstall.mjs`.
  - **(from V5) path-guard blind spots.** `tests/shared/audit-tools-path-guard.test.mjs` cannot see
    template-literal construction (no live occurrence today) and its allowlist honesty check is
    substring-only. Tighten if a violation ever sneaks past. Also low: `validateArtifacts`'s unused
    `root="."` default now yields an absolute (not relative) report path — no live call site hits it.
  - **(from V2) conversation-first mid-run dirt is indistinguishable.** A declared-but-unedited file the
    USER dirties during the run window can still be staged in the `merge-implement-results` flow —
    `run_start_dirty` fences only pre-run dirt; full closure needs per-edit git ground truth that flow
    lacks. Documented at `collectStagingFiles`. ⬇ Live-run watch (conversation-first run on a dirty repo):
    `leftover_files` in the report must list untouched dirt; nothing outside the run's surface committed.

- **Friction-walk lesson (D-66/67 slice-1 ownership-gate lap):** design-level adversarial review pays for
  itself before a line is written, and review depth should scale with delicacy
  (`[[delegate-adversarial-phases-to-separate-agent]]`) — see memory. Open tool sliver (low value): the
  PreToolUse commit-gate fires on the whole Bash call before a chained `attest && git commit` runs, so the
  attestation half hasn't executed when the gate checks (workaround = attest as its own call); a gate that
  recognized the attest step in the same chain would remove the trap.

- **Friction-walk lesson (shared-logic-audit validation lap):** an external audit catalog is leads, not
  verdicts — validate its rows against current code + design-of-record before remediation intake
  (`[[external-audit-catalogs-are-leads]]` / `[[spec-degradation-and-doc-staleness]]`) — see memory. Open
  tool gap: remediate's grounding phase catches phantom PATHS but not stale CLAIMS ("X is duplicated" when X
  was single-sourced) — no tool support for claim-staleness (inherently judgment; handled by subagent
  verification today).

- **Friction-walk lesson (backlog-clearance lap):** a backlog item / chosen option / design memory is a
  point-in-time proposal — verify its premises against current code AND a real measurement before building
  (`[[spec-degradation-and-doc-staleness]]`) — see memory. Open tool sliver: the pre-commit gate that
  silently failed-open in linked worktrees is FIXED (scratch index → `os.tmpdir()`), but the durable
  improvement — make a fail-open on infra fault OBSERVABLE (a one-line stderr when the staged-snapshot path
  bails) rather than silent — is not yet done.

- **Top gate optimization lead (measured 2026-07-06, was the "vitest collect" item).** First profiled
  numbers (win32, Node 26 local; CI Linux will differ but the shape holds):
  - **`verify:checks` gate = 95.8s, of which `smoke:packaged-audit-code` alone is 70.2s (73%).**
    `smoke:packaged-remediate-code` is 13.2s; everything else is ~12s combined. **→ The highest-leverage gate
    win is the packaged-audit-code smoke.** Internal breakdown (measured): `next-step ×~7 to dispatch_review`
    = 35.9s (53% — the real audit-flow round-trips, inherent coverage), `npm install from tarball` 9.3s,
    `next-step to present_report` 10.1s, `npm pack` 7.2s (incl. a prepack rebuild). The next-step round-trips
    are fresh-process pipeline runs — cutting them cuts coverage, so this needs a real design (e.g. an
    in-process multi-step driver for the smoke, or packing once and sharing the tarball across both smokes
    since they build the identical `audit-tools` package), not a quick trim.
  - **Full vitest suite = 307s wall (452 files), `collect≈211s`** (confirms the old ~186s estimate), run
    time dominated by audit integration tests that spawn real subprocesses: `audit-code-completion` 285s,
    `audit-code-wrapper` 237s, `next-step` 165s, `cli-remediation` 111s. area:audit ≈ 1905s summed across
    workers vs remediate 451s / shared 62s. `pool: 'threads'` / `isolate: false` won't help the run-time
    tail (it's subprocess wall, not isolation overhead); the real lever is the sharding already shipped +
    possibly splitting the few 100s+ integration files across more shards. Only pursue collect/pool changes
    with per-file verification (many tests mutate fs / spawn subprocesses → isolation-off risks bleed).

- **Dispatch admission-control rework — residual (env-bound / deeper, not blocking).** Shipped; see
  `docs/HANDOFF.md` → "T5 forward tracks" for what landed. Design of record
  [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md);
  [[capability-is-per-auditor-not-per-audit]] / [[dispatch-admission-control-design]].
  - (a) **live validation** of the real host+codex+NIM concurrent run — a metered multi-pool run confirming
    the demoted backend actually fans out alongside the host (folds into the quota-aware-dispatch live-run
    watch below). (b) **Deeper simultaneity:** the audit hybrid path drives the in-process (codex/NIM)
    partition to completion within a `next-step` turn, THEN hands the complement to the host — so host and
    backend alternate ACROSS turns, not simultaneously WITHIN one. True within-turn simultaneity would need
    a detached background driver spanning host turns (architectural; only pursue if wall-clock on a real
    run shows the alternation is the bottleneck).

- **Quota-aware dispatch — live validation env-bound.** Still open: live validation of the token-budget
  dispatch gate (per-`(pool,window-label)` learned tokens-per-percent slope, budget = MIN across a
  pool's windows, quota-death = retryable pause preserving worktrees) on a real rate-limited
  multi-worker run — cold-start calibration slope + the resume path especially want a live check.
  Relates to [[claude-usage-endpoint-body-shape]] / [[claude-quota-credential-resolution]] /
  [[cross-provider-quota-matrix]] / [[quota-dispatch-vision]].
  - **⬇ Live-run watch** (a metered provider + large target is the exerciser — the run itself hits the
    wall; `AUDIT_TOOLS_LIVE_QUOTA=1` only enables the live-credential test probe, it does not force a
    production wall): at the
    rate wall the run must **pause gracefully, not crash**, and leave every in-flight worktree intact; on
    resume it continues from the pause with no lost/redone work. Early on, the tokens-per-percent slope
    should *learn* (dispatch pacing adjusts after the first window reading) rather than stay at the
    cold-start default. FAIL = crash/stall at the wall, discarded worktrees, or a resume that re-does or
    drops packets.

- **Rolling-engine ledger-blocked retry spins at 50ms during a crash-orphan lease wedge (2026-07-10,
  efficiency follow-up from the lease-TTL fix; adversarial-review finding).** With `DISPATCH_LEASE_TTL_MS`
  (20 min, `src/shared/quota/reservationLedger.ts`), a crashed sibling's orphan lease can block an
  in-process run's packet for up to the TTL — correct (waits, never double-grants), but the run loop's
  pending retry tick (`rollingDispatch.ts` ~1348, 50ms) then hammers `admitAgainstLedger` →
  `withFileLock` read-modify-write per pending packet (~24k lock cycles worst case). Fix direction:
  backoff on ledger-blocked retries, or heartbeat-renewed short leases (the ClaimRegistry pattern,
  `auditStep.ts:96`) restoring ~30s crash recovery. Efficiency-only; folds naturally into D-66/67 slice-3
  (heartbeat-on-long-claims) if that opens.

- **Critical-flow LLM fallback — SHIPPED (`critical_flow_fallback_current` obligation).** Residual (accepted,
  low): the host submission (`critical-flow-fallback.json`) is a durable leaf input that never re-stales, and
  the obligation is satisfied by its PRESENCE alone — so once the host answers (even `{flows:[]}`), the pass is
  permanently suppressed even if the repo later grows and deterministic inference stays below the bar. Matches
  `intent_checkpoint` persistence semantics (a host input that persists). A future enhancement could re-prompt
  when the repo materially changes (add `repo_manifest.json` as a marker dep, or gate satisfaction on
  merged-flow freshness rather than marker presence) — deferred until a real run shows stale enrichment biting.

- **Friction detection — M-QUOTA escalation chain: live validation env-bound.** The
  `recordLimit → escalate → strand → quota_escalation friction` chain is unit-tested end-to-end on both
  drivers (`tests/shared/rollingDispatch.test.mjs`; `tests/audit/rolling-audit-dispatch.test.mjs` §5).
  **Still open:** live validation on a real rate-limited run. [[meta-audit-friction-must-be-tool-enforced]]
  - **⬇ Live-run watch** (same wall run as quota-aware dispatch): when a packet escalates across pools at
    the wall, a **`quota_escalation` friction event** must be captured at the step boundary — check the
    run's friction log / meta-audit surface after the run and confirm the event is present with the
    escalated packet id. FAIL = wall hit but no friction event recorded (the chain didn't fire live).

- **Selective-deepening convergence — live validation env-bound.** Both known convergence loops
  (packet-result `task_id` mismatch; idempotency_key collision across rounds) have shipped fixes and need
  a real deepening-capable run to confirm. Recovery until validated: quarantine orphan pending
  `deepening:*` tasks.
  - **⬇ Live-run watch** (any audit whose findings trigger deepening — i.e. low-confidence/high-risk areas
    that spawn `deepening:*` tasks): every `deepening:*` task must **converge and complete** within a bounded
    number of rounds; the run reaches synthesis on its own. FAIL = orphaned pending `deepening:*` tasks, the
    same finding re-deepened every round (idempotency collision), or the run only finishing via
    `force-synthesis`. If you hit it, quarantine the orphan `deepening:*` tasks and note the round count here.

- **`llm read` very large review-framed payloads still fail post-fix.** A ~700-line review-framed diff
  still fails after the upstream JSON-contract fix (clean error, no result) — workaround: split the
  payload; if it recurs, add a chunked-review mode in llm-worker-tools rather than host-side splitting.

## Forward tracks

- **Generate the executor↔artifact mapping from the registries (anti-drift).** `executor-catalog.md` +
  `dependency-map.md` both render the executor→artifact relation, hand-maintained over `EXECUTOR_REGISTRY`
  (`src/audit/orchestrator/executors.ts`) + `ARTIFACT_DEFINITIONS` (`src/audit/io/artifacts.ts`) — it drifted
  once. The mapping is now consolidated to one hand-maintained home (`dependency-map.md`), but the durable fix
  per "never hand-maintain a table someone else could generate" is to GENERATE the mapping from the two
  registries at doc-build/check time. Forward track.
- **End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).** The
  node:test-gate bug ([[remediate-gate-nodetest-runner-bug]], fixed v0.32.61) blocked EVERY remediate run
  yet no gate/release check caught it: the gate command only runs in a live remediate *run*, and the unit
  test asserted the broken shape as correct. Add a smoke that drives a tiny real remediation to at least one
  phase-boundary/final gate against the actual repo tree (or a fixture repo with vitest tests) so a
  tool-owned gate that can't pass on a clean tree fails the release, not a dogfood run. Sibling of the
  packaged-bin smokes but for the *gate execution path*, not just `--version`.
- **Free/cheap multi-account "quota-arbitrage" dispatch tier (9router-inspired) — exploration → build.**
  Fan dispatch across genuinely-free backends + (later) N captured subscription-OAuth accounts, rotating on
  429/cooldown to exceed any single subscription's limit. Key finding: this is **extra SOURCE POOLS on our
  existing machinery, not a new provider engine** — pool identity is already `(provider, account[, model])`,
  the admission loop (`admitBatch` cost-first + spill) already IS the rotation engine, the `ReservationLedger`
  already does per-key backoff, and Claude/Codex/Copilot arbitrage accounts get live per-account quota for free
  via `BaseHttpQuotaSource`. Worker shape ≈ `OpenAiCompatibleProvider` (thin `buildHeaders`/`buildUrl` subclass)
  except Kiro (AWS EventStream) + Cursor (protobuf). **Reuse (vendor+sync, MIT):** 9router's provider OAuth
  catalogue (`PROVIDER_OAUTH` + token-refresh endpoints/client_ids) — the someone-else-maintained table the
  corrected sourcing rule prefers; `ERROR_RULES` text classes. **Novel build:** a multi-account credential store
  + refresh-under-lock (encrypted, rotation-loss-safe) generalizing `ClaudeOAuthQuotaSource`. **Risks:**
  ToS/paid-account-ban (impersonating official CLIs — Claude/Codex/Cursor highest; opt-in, never default-on);
  token-security surface (multi-account refresh tokens; encrypted/never-logged/atomic — recall the Antigravity
  leak). **Phase 0 first slice (recommended, ~zero ban/security risk):** `opencode-free` (`Bearer public`) +
  `vertex-trial` (operator's own GCP $300 SA) as free source pools reusing `OpenAiCompatibleProvider` → priced
  ~0 by `deriveCostRank`, routed first, spill already handled. Then Phase 1 multi-account OAuth store
  (Claude/Codex/Copilot). Design of record + full phased plan in memory [[arbitrage-dispatch-tier-design]];
  a coverage diff (2026-07-07) confirmed 9router's price table adds nothing over models.dev, so skip it.
  Relates [[quota-dispatch-vision]] / [[dispatch-admission-control-design]] / [[cross-provider-quota-matrix]] /
  [[openai-compatible-provider]] / [[model-provider-ide-agnostic]].
  - **Phase-0 opencode-free — CODE-COMPLETE (A2 = declared seed + reactive verification, shipped 2026-07-08).**
    opencode-free is live-verified: base `https://opencode.ai/zen/v1`, public `/models`, free models via
    `Bearer public` returning `cost:"0"` (design premise held; docs' "API key" is the PAID tier). opencode-free
    is a pure-config `sources[]` entry (`api_key:"public"` + `cost_per_mtok:0`) — no provider code.
    - **Increment 1 — declared per-source cost seam → SHIPPED.**
      `DispatchableSource.cost_per_mtok` → `deriveCostRank` rung 2a (declared 0 = free-first). The design memory's
      "deriveCostRank prices free ~0 automatically" was FALSE (non-models.dev ids → worst band); this is the real fix.
    - **Increment 2 — reactive cost verification → SHIPPED (loop-core, full pipeline).**
      Provider extracts the endpoint-reported cost (opencode's `cost`) → `LaunchFreshSessionResult.observedCostUsd`;
      dispatcher closures relay it to `RollingDispatchResult`; the rolling engine's `handleResult` demotes a
      declared-free pool that reports cost>0 (folded into `selectProvider`'s degraded partition, once per pool) +
      fires a `declared_cost_drift` friction event. `driveRolling` shares ONE demotion set across sub-waves/levels so
      the demotion + single friction emit span the whole drive (adversarial-review catch — a per-dispatcher set
      leaked free-first back at each level boundary). Ships `examples/session-config/opencode-free.json` + README.
      Adversarially reviewed (1 MEDIUM found + fixed) + green (6063 tests). A2 (1+2) complete → arbitrage-tier
      release unblocked.
    - **vertex-trial → deferred** (needs operator's GCP $300-trial SA JSON).
    - **Remaining Phase-0 = env-bound live validations only** (no more code): a real opencode-free run confirming
      declared-free routing + a live lapsed-free demotion + the `declared_cost_drift` friction event end-to-end.
- **Cost↔speed dispatch dial + free-pool maximization.** Generalizes the cost-first router — the
  minimum-cost corner of a cost-vs-throughput Pareto frontier — into a tunable operating point ON TOP of
  the kept router (does not replace it). Shipped: 1D dial (λ ∈ [0,1], capability a hard floor),
  pool-class-aware throughput derivation (`deriveThroughputConcurrency`), and the shared
  `admissionPoolsFromSummaries` builder. Design of record
  [`spec/dispatch-cost-speed-dial.md`](../spec/dispatch-cost-speed-dial.md); extends
  [[cost-first-routing-design]].
  - **Free-pool maximization (dial-independent).** Price-0 pools are first-fill at every operating point → free
    is saturated before any paid pool automatically (`costRank` already delivers it once a source is registered).
    "Maxed" = saturated to the pool's declared sustainable ceiling (`declaredCap` + rate limits + reactive 429
    floor), NOT flooded. **Correction:** the old note said this "depends on C3-AIMD" — C3-AIMD is CLOSED; the
    ceiling is now `declaredCap` + reactive backoff, no learned ceiling. Real work = **register every free source
    as a pool** = the arbitrage-tier track [[arbitrage-dispatch-tier-design]] (Phase 0 zero-ban-risk first).
  - **OPEN (owner call):** whether QUALITY also becomes tradeable vs cost (a true 2D dial, needs a per-task
    quality-worth weighting) — default recorded = 1D cost↔speed + capability floor.

- **models.dev static window can over-state a specific deployment (carried from W1).** The snapshot lists e.g.
  `claude-opus-4-7` at 1M context; a real headless run serving a 200k variant with discovery absent would over-size
  work blocks off the static rung. Mitigated by `BLOCK_SAFETY_MARGIN` 0.7 + discovered-capability always overriding —
  watch on a real headless metered run.
- **Minor provider/dispatch cleanups (low-pri, bundle opportunistically).**
  ~~providerFactory Rule 6 (`hasClaudeCodeConfig && claudeAvailable`) is a provable strict subset of Rule 9
  (`claudeAvailable`) — delete the redundant rung~~ — **FALSIFIED 2026-07-05 (verify-before-implementing).**
  Not a no-op: the opencode/codex *config-gated* rungs sit BETWEEN Rule 6 (claude config-gated) and Rule 9
  (claude bare-availability tie-break) and resolve to *different* providers. For a dual-configured operator
  (`hasClaudeCodeConfig && claudeAvailable && hasOpenCodeConfig && opencodeAvailable`), Rule 6 makes explicit
  claude config win; deleting it lets the opencode config-gated rung fire first → resolution flips
  claude-code→opencode. Rule 6 is a predicate-subset of Rule 9 but NOT redundant in the ordered table. Leave it.
  Remaining (still valid): inline `makeProviderKeyedFactory` (19 LOC, 2 sites — but it's a cross-area generic
  with its own dedicated test `tests/shared/provider-keyed-factory.test.mjs`; inlining loses cohesion,
  marginal — low value).
  Do NOT delete working proactive quota sources (`BaseHttpQuotaSource` + one-array register is already clean);
  `copilot` is correctly broker-only.

- **Schema-enforced generation — CE-004 residual (provider-blocked only).** The openai-compatible / NIM
  guided-decoding path is **SHIPPED** — the AuditResult `outputSchema` is plumbed through and the dispatch site
  sets it, so those endpoints get emit-time constraint (`guided_json` / `response_format: json_schema`). The
  sole residual is the always-on conversation host (`claude-code`), which advertises no API-level constraint
  mechanism → on that path CE-004 reduces to the repair floor (no emit-time prevention). Genuinely
  host-blocked, not a defect; unblocks only if that host gains a constraint endpoint.
  - **⬇ Live-run watch** on an openai-compatible run: results conform on first emit (repair rounds for
    schema-shape errors drop to ~0).

- **Tool-enforced dispatch broker with capability-tiered driver.** Desired end-state: (1) a gated
  primitive set as the single dispatch chokepoint (read quota, estimate tokens locally, dispatch/await);
  (2) a capability-tiered driver — Y-dispatcher (thin agent, no judgment) where the host supports nesting,
  slot-pull where it can't; (3) classify agent hosts off the cold-start floor. The single-source
  classifier, broker primitive, `HostSessionQuotaSource`, and driver selection/prompt rendering are
  **shipped**. **Open (env-bound):** live Y-dispatcher validation (needs a nested-agent host + live run)
  + proactive pre-wall quota-aware pacing.
  - **⬇ Live-run watch** (Codex backend, which nests agents): the driver-selection step must pick the
    **Y-dispatcher** path (thin dispatcher agent, no judgment) rather than slot-pull — confirm from the
    run's driver-selection log. Separately, on a metered run, pacing should slow *before* the wall (proactive)
    rather than only reacting after a 429. FAIL = slot-pull chosen on a nesting-capable host, or pacing that
    only ever reacts post-wall.

- **Deterministic analyzers: own-vs-acquire engine.** **Open:** clippy/rubocop landed fixture-only (no
  Rust/Ruby repo → live spawn unvalidated). *(Mutation testing was
  considered and dropped 2026-07-03: it doesn't fit the acquire+scan model — Stryker must run the full
  test suite per mutant and needs a per-repo test-runner config we don't own, so it either no-ops or is
  its own subsystem. Not an analyzer-registry add. Re-file as a scoped forward track only if a lightweight
  mutation signal appears.)* **Forward constraint:** if a future LLM-proposal channel is built for analyzer ids beyond
  the static registry, it must route through the same `admitSpawn` chokepoint; and
  `ExternalAcquisitionConfig.consent_token` must be stripped/redacted before any persistence of
  `SessionConfig` to a shared artifact. [[deterministic-analyzers-own-vs-acquire]]
  - **⬇ Live-run watch** (audit a **Rust** repo for clippy / a **Ruby** repo for rubocop, with the per-run
    consent token so the gate admits the non-default tool): the tool must actually **spawn and normalize**
    output into leads (cargo-clippy / bundle-rubocop), not skip. FAIL = "skipped" status when the ecosystem
    is present + consent given, or a parse that drops all output. (No Rust/Ruby toolchain on the box →
    install `rustup` / `ruby`+`bundler` first, or point at a repo that vendors them.)

- **Cross-provider quota — live-endpoint confirmation.** Per-provider mappings validated against
  live-shaped fixtures; confirming each source against its **real** endpoint (Claude/Codex live; Copilot/
  Antigravity gated→degrade) is environment-bound. Per-provider recipes:
  [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md). Red line: self-monitoring
  own-provider only, never IDE-GUI automation.
  - **⬇ Live-run watch** (run under each provider whose IDE/CLI you have — Codex CLI is available now):
    the provider's `QuotaSource` must return **live numbers off its real endpoint**, not the fixture/degrade
    fallback — confirm the quota reads are non-empty and move as the run consumes budget. Codex + Claude are
    reachable now; Copilot/Antigravity need those IDEs running. FAIL = a source stuck on degrade when its
    real endpoint is reachable.

- **D-66/67 SLICE-1 — merge-time ownership-gate on the long-lived claims (OD3 layer 2).** Shipped;
  design-of-record + residuals below.
  - **Accepted residual:** the probe window is staleMs-wide, not instantaneous — worst case is a stale
    LAND a beat before an imminent reclaim, never a double-land (base mutations stay serialized by the
    per-node + base-branch locks). Slice-3 heartbeat machinery shrinks it if a real cooperative run
    shows it matters.
  - **Discovered asymmetry:** remediate's `phase:main` mutex has OD3 layer-1 only (`withClaimHeartbeat`
    wraps `advance()`, `nextStep.ts` ~5088), NO layer-2 re-check before persist — unlike audit's
    `auditStep.ts:216-239` template. Not mechanically mirrorable (remediate's persists are distributed
    inside `advance()`); tracked as a still-open correctness gap for slice-3 to fold in.

- **Unify the full rolling-dispatch lifecycle shell across audit + remediate (doc-review D-66/D-67/C-7).
  Slice-1 SHIPPED (entry above); slice-2 VERIFIED not worth building as a shared reducer — Layer A
  (`PartialCompletionTerminal`) is already the correct shared surface; Layer B
  (`advancePausedState`/`LIVELOCK_PAUSE_LIMIT`) is audit-only by nature and correctly forked
  ([[rolling-lifecycle-unify-full-unification-wrong]]); open = slice-3 heartbeat only.**
  Today the genuinely-shared surface is the *admission decision* only
  (`computeDispatchAdmission`, single-sourced in `audit-tools/shared`). Two lifecycle shells around it are
  NOT shared: (a) the pause lifecycle — audit owns `waiting_for_provider`/`pausedState.ts`/`filterNewProviders`;
  remediate has its own separately-implemented `quota_paused` analogue; (b) OD3's heartbeat + merge-time
  ownership-gate revocation protocol — wired only to the short-lived coordination mutexes
  (`withClaimHeartbeat` on bundle-mutation / `phase:main`), NOT the long-lived per-task/per-node execution
  claims (`task-claims.json`, remediate node-claims), which hold a long lease with no live heartbeat and
  rest on dedup-by-id at ingest as the correctness backstop alongside the now-shipped slice-1 merge-time
  gate. The full lifecycle-shell sharing + OD3-heartbeat-on-long-claims is still-intended future work
  (slice-3), not abandoned. Design-of-record specs
  ([`spec/multi-ide-concurrent-runs-design.md`](../spec/multi-ide-concurrent-runs-design.md) OD3;
  [`spec/audit-workflow-design.md`](../spec/audit-workflow-design.md);
  [`spec/remediation-workflow-design.md`](../spec/remediation-workflow-design.md)) now scope the shared
  claim to admission-math and point here for the unification. [[multi-ide-concurrent-runs-design]] /
  [[dispatch-admission-control-design]]
  - **Design-of-record (READ before building slice-3 — it changes the target).**
    The driver + packet engine are ALREADY unified (both orchestrators run `driveRolling` over
    `createRollingDispatcher`); only the pause/resume TERMINAL adapter + OD3-on-long-claims are forked.
    Precise map: audit pause = `RollingEngineLifecycleState` (`src/shared/rolling/pausedState.ts`:
    `running|waiting_for_provider|terminal`; `advancePausedState` reducer; `LIVELOCK_PAUSE_LIMIT=3`; wired in
    `rollingAuditDispatch.ts advanceRollingPause`) — INTERNAL, self-advancing, livelock-bounded, partial-coverage-OK.
    Remediate pause = a `PartialCompletionTerminal{reason:"quota_paused", earliest_reset_at}` variant
    (`src/shared/quota/capacity.ts`; `nextStep.ts` ~4636; stranded nodes stay pending) — EXTERNAL, unbounded,
    host-retries-at-reset. **CRITICAL FINDING: full unification is the WRONG endpoint.** The resume SEMANTICS
    genuinely diverge — audit may bound-and-give-up to partial-coverage synthesis (read-only, safe); remediate must
    NOT abandon half-applied edit-nodes to "partial coverage" (a correctness hazard). So the livelock-terminal-vs-
    wait-forever branch MUST stay a per-orchestrator policy injection; `earliest_reset_at`-driven external resume has
    no audit counterpart. **Shareable core for slice-3 (the actual work, bounded):** a shared
    `withExecutionClaim` = `withClaimHeartbeat` + the merge-time `registry.heartbeat(token)` ownership-gate
    (which today exists ONLY inline on the short bundle-mutation mutex, `auditStep.ts`:219), applied to the
    LONG-lived claims (`task-claims.json` 20-min lease, remediate node-claims 30s) that currently hold a
    lease with NO heartbeat. **Architectural gotcha:** the long claims are held across OUT-OF-PROCESS worker
    runs where the parent isn't looping, so there is no natural beater — adding a heartbeat needs a beating
    owner during the out-of-process span (non-trivial). This is a FOCUSED-LAP track — the most delicate
    machinery in the repo (pause/claim/quota), a genuine divergence to respect, and the owner's own
    "redesign before scheduled autonomy" caution applies; do NOT rush it as a tail-end change.

- **Per-lap cadence rules tool-enforcement (doc-review D-68/D-69) — genuine residue (accepted, not
  built):** (a) the LAP-level decision to route an item through the orchestrator vs hand-fix it is still
  host judgment — its tool-enforced end-state is "route substantive work through the self-scaling
  orchestrator" (the [[self-scaling-pipeline-not-forked-paths]] north star), not a new gate; (b) a
  hand-fix lap that never invokes an orchestrator produces no friction artifact, so it is covered only by
  the Stop-hook backstop (and only if a recent run artifact exists in its 12h window). Closing (b)
  mechanically (e.g. block session end on any commit-bearing lap lacking a friction walk) would be fragile
  and over-fire; deferred with `CLAUDE.md`'s "Redesign before scheduled autonomy" rather than force it.
  [[enforce-robustness-in-tooling-not-host-discretion]] / [[self-scaling-pipeline-not-forked-paths]]

- **Context-efficiency access-memory track (items 1-3) shipped; non-blocking follow-up open:** packet `task_ids`/`lens` attribution missing from the token-usage ledger (`DispatchPlanEntry` carries neither).

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall.
  - **⬇ To close (after any live audit):** take that run's findings, hand-label each true-positive /
    false-positive into `corpus/<run-id>.labels.json`, then run `score-audit` → precision/recall. The
    labeling is ground-truth human judgment (can't be automated); one solid labeled run unblocks the oracle.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and
  green; the provider-matrix e2e is gated behind `RUN_PROVIDER_MATRIX_E2E=1`. **Remaining:** the
  release-time manual GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for GUI-only
  hosts (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned
  subtasks. Folds into the A7 checklist.
- **`/remediate-code` GUI-host manual checklist (parity with `/audit-code`).** `spec/host-validation.md` is
  a manual GUI-host live-dispatch checklist for `/audit-code` only; `/remediate-code` has the automated
  no-drift gate (`verify:remediate-hosts`) but no equivalent manual GUI-host checklist, which the
  "keep orchestrators in parity" convention says it should have. Add a sibling `/remediate-code` checklist
  (or extend `host-validation.md`). Folds into the A7 release-time GUI checklist work.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`,
  `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — revisit if a provider gains a real proactive rate-limit endpoint.
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment.** Prose-heavy fields feed
  downstream LLM prompts; a cosmetic edit forces wasteful re-emit. The narrowing = bounded judgment on
  meaning change, fail-safe to re-derive. Efficiency-only; defer until re-emit churn is measured.

## Doc-set hygiene (enforced)

- **Canonical doc set is mechanically reconciled.** `scripts/check-doc-manifest.mjs`
  (in `verify:release`) fails the build if any tracked `docs/**/*.md` is absent from the
  routing table in [`doc-review-guidelines.md`](doc-review-guidelines.md), or a row points
  at a deleted file. A stray/dated doc can no longer accumulate silently — it must be
  registered (type + reason) or deleted. The doc-review routine adds the soft layer:
  existence-review every run + version/date/status strings are escalate-not-auto-bump
  (a doc whose only diffs are version bumps is a status doc → propose generate-or-retire).
  Durable design captures go to a canonical design doc or backlog/HANDOFF, **never** a
  dated `*-plan-of-record.md` in the tracked tree (the gate now rejects the latter).

## Durable traps (environment / tooling reference)

Standing gotchas worth keeping for any agent (strong or weak):

- **After a process restart, `git diff` your instruction files before committing.** A background
  doc-review/hook can silently re-assert a pre-decision version of an instruction doc (e.g. CLAUDE.md,
  `project-philosophy.md`), and `git reflog` won't show it (it's a direct file edit, not a git op). Caught
  once (2026-07-10) by noticing an unexpected `M` in `git status`; restored the committed owner-decided
  version. (The still-open tool fix — reconcile auto-apply against HEAD — lives under *Open bugs*.)

- **npm 12.0.0 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).**
  Any child `npm install` of a package with a postinstall (e.g. the audit-tools tarball) silently skips the
  script and warns `install scripts blocked because they are not covered by allowScripts`. The allowlist is
  SPEC-keyed per-project (`npm install-scripts approve <pkg>` writes `allowScripts` into the consumer's
  package.json); the global `.npmrc` `allow-scripts=["audit-tools"]` does NOT cover fresh temp-dir installs,
  and `--allow-scripts=<name>` on the CLI doesn't either. Working escape hatches: env
  `npm_config_dangerously_allow_all_scripts=true` (older npm silently ignores it — used by the packaged
  smokes' hermetic installs) or `npm install-scripts approve <pkg>` post-declare. Also new in npm 12:
  `npm pack --json` can emit an OBJECT keyed by tarball name instead of an array (smokes now tolerate both).
  Global `-g` reinstall of audit-tools bins: postinstall may be blocked → run `npm install-scripts approve
  audit-tools` / re-run postinstall manually and verify `~/.claude/commands/*.md` landed
  (extends [[audit-code-global-bin-traps]]).

- **Before starting ANY lap in a worktree, sync with remote main — landed work may be missing.** A worktree
  can be branched from a *stale* local main and miss commits that already landed on `audit-tools/main`. This
  session branched 4 commits behind and **re-implemented a full commit (admission-control 2a) already on
  main**, plus built 2b blind to a pinned design section it lacked — then had to `git reset --hard
  audit-tools/main` + cherry-pick + reconcile. First action of every lap:
  `rtk git fetch audit-tools main && git log --oneline HEAD..audit-tools/main` — if that lists commits,
  rebase/reset onto main BEFORE writing code. (Strengthens [[audit-tools-worktree-traps]].) **Mitigation
  (not a hard gate):** `.claude/skills/start-lap/SKILL.md` operationalizes this sync-first step as an
  agent instruction — it is agent-instruction-driven, so it reduces the risk but does not mechanically
  enforce the fast-forward the way a git gate would.

- **Background long-running command piped through `tail` hides interim progress.** Running a long command
  in the background as `cmd 2>&1 | tail -N` (e.g. `npm run release:patch:publish 2>&1 | tail -40`) makes the
  output file stay EMPTY until the command exits — `tail` buffers and only flushes its last N lines at EOF.
  To watch progress on a background job, do NOT pipe through `tail`; let the harness capture full output (it
  tails the file for you) or redirect to a file and `tail -f` that file separately. Observed 2026-07-08 during
  a release ship — polled an empty file for minutes before realizing the pipe was the cause.

- **`git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is
  NOT a rejection.** On a fast-forward push straight to `main` the remote emits that branch-protection
  message, but the ref still updates (`04a7338c..8279d0de  HEAD -> main`, no `! [remote rejected]`). Confirm
  by `git fetch audit-tools main && git rev-parse audit-tools/main` == local HEAD — don't assume the push
  failed on seeing the advisory. Observed 2026-07-08.

- **New remediate test files must import `makeState` from `tests/remediate/test-helpers.ts`, never re-declare it.**
  `INV-remediate-tests-03` (`tests/remediate/remediate-tests-invariants.test.ts`) fails loudly if any test file
  declares a standalone `makeState`. Wrap the shared helper (`makeState({ plan: {...}, items: {...} })`) instead.
  Observed 2026-07-08 (a new `access-memory.test.ts` tripped it).

- **`tests/audit/audit-code-completion.test.mjs` is the heaviest audit integration test.** It drives the
  full multi-phase audit flow in-process (not subprocess-spawned) with an explicit 300s timeout
  (`HEAVY_AUDIT_TEST_TIMEOUT_MS`) for CPU-contended runs. Confirmed: production does not redundantly
  re-extract on an unchanged repo (extractors are presence-gated, not staleness-checked) — the wall is
  legitimate one-time-per-phase extraction, not a caching bug. Remaining lever (test-side only): pre-seed
  artifacts to cut pump iterations.

- **Codex CLI is a poor executor for large read-heavy audit packets under a wall-clock budget.** Observed
  2026-07-04: 2 concurrent codex executors ran 5+ min with zero results and 8k+ lines of echoed reasoning.
  Route only small / low-line packets to the codex pool, or drop it from the audit executor pool for
  read-heavy work. (Durable routing lesson from the admission-control rework.)

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; landed work accumulates on `remediation/<runId>` and the host is left checked out there. By DEFAULT those branches are never auto-merged — the base branch is left untouched for review. Any doc or code fix applied inside a remediate run never reaches main unless explicitly merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. **Opt-in fix (B5, shipped):** select the `merge-to-base` closing action at the confirm step — the tool then `--no-ff` merges `remediation/<runId>` into your launch branch at close (aborts safely on conflict). Otherwise, after a run that touches docs/code you want on main, merge `remediation/<runId>` manually before the next nightly run.

- **`.gitignore` artifact-tree re-include structure (don't flatten it).** The managed block ignores the
  `.audit-tools/` runtime tree at the CONTENTS level (`.audit-tools/*`, `.audit-tools/*/*`) and re-includes the
  tracked deliverables + `*/agent-feedback.jsonl` — never as a blanket `.audit-tools/` dir-ignore, because git
  cannot re-include a file under an excluded directory. Private ⇒ deliverables tracked; public ⇒ blanket-ignore.
  Single-sourced in `src/shared/io/gitignoreArtifacts.ts` (`renderGitignoreBlock`), idempotent against the
  committed block. If you ever see deliverables un-trackable, it's a stray blanket `.audit-tools/` line OUTSIDE
  the managed markers — delete it, the managed block owns the tree.
- **Tool-managed ignore patterns for runtime artifact dirs MUST be anchored to `.audit-tools/`**, never a
  bare `**/<name>/` — an unanchored glob (e.g. `**/friction/`) regenerates on every `ensure`/postinstall and
  can shadow a same-named SOURCE dir (`src/shared/friction/`), which a file-level edit can't fix. (`.audit-code/`
  is fine — distinct name, no source collision.)
- **The Bash tool is POSIX sh, NOT PowerShell — a PowerShell here-string (`@'…'@`) in a `git commit -m`
  becomes literal `@` characters** top-and-bottom of the message (`@\n<body>\n@`), silently corrupting the
  subject line. Seen twice in one lap (both caught pre-push, amended). For any MULTI-LINE commit/PR body,
  write the message to a temp file and use `git commit -F <file>` (single-line messages via `-m "…"` are
  fine). Applies to every native exe called from the Bash tool, not just git.
- **Wall-clock peak-concurrency tests are latency-fragile.** The rolling-driver integration tests assert
  `peak == N` by dispatching N nodes with a short `setTimeout` and reading the max simultaneous in-flight
  count. Any change that adds per-dispatch latency on the dispatch path (e.g. the reservation-ledger's
  reserve-before-dispatch file-lock) can push admission past the delay window so peak reads `< N` on a slow
  FS (Windows), a green-on-Linux / red-on-Windows or intermittent failure. When you touch the dispatch path,
  expect these and either keep the added latency off the hot path (the finite-budget gate that keeps the
  ledger unwired on the claude-code path) or widen the test's delay well past worst-case admission latency.
  (`tests/remediate/rolling-dispatch-file-ownership-ordering.test.ts` §INV-SOO-03/05.)
- **Fresh git worktree lacks `node_modules`** → `audit-tools/shared` resolves a stale `dist/` (spurious
  "no exported member") → run `npm install` in the worktree first.
- **One test runner: vitest** (all three areas — `tests/audit`, `tests/shared`, `tests/remediate`).
  Run a single file with `npx vitest run <path>`. `node:assert/strict`
  is still permitted as an assertion lib (runs under vitest) for the control-flow assertions
  (`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` equivalent; value
  assertions are `expect`. Vitest `testTimeout` is raised to 120s in `vitest.config.ts`
  because audit integration tests spawn real subprocesses.
- **Don't mask the test exit code.** `npm test > out; echo done` reports the *trailing* command's exit, not the
  suite's — and piping through `grep`/`rm` in the same Bash call races the output file, so a real failure reads
  as "green." Capture the suite's own status: `npm test > out 2>&1 && echo PASS || echo "FAIL=$?"`.
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **A global junction to a LIVE working tree silently shadows a registry install.** If the global
  `audit-tools` is a `Junction` → the working tree (from a prior `npm link`), `npm i -g audit-tools`
  does NOT replace it, and bins run your working-tree dist; invoking a bin *through* the junction path
  can also produce odd artifacts. Fix: `npm rm -g audit-tools` FIRST, then reinstall, and verify
  `(Get-Item <globaldir>).LinkType` is empty before trusting the smoke. (See [[audit-code-global-bin-traps]].)
- **A NEW `.claude/hooks/*.mjs` needs an explicit `!.claude/hooks/<name>` re-include in `.gitignore`.**
  `.gitignore` ignores `.claude/hooks/*` then allowlists each tracked hook by name (deliberate — never ship
  arbitrary `.claude` files). Adding a hook and committing WITHOUT the `!` exception silently drops the file
  from the commit; if `.claude/settings.json` (committed) references it, main now points at an untracked hook
  = broken state. Add the `!.claude/hooks/<name>` line in the same commit as the hook + its settings.json
  registration. (Bit once 2026-07-05: `friction-stop-gate.mjs`.)

- **A `\0` in a Write-tool template literal lands as a RAW NUL byte → binary-flags the source file.** Writing
  `` `${a}\0${b}` `` (a NUL pair-key separator) via the Write tool put a literal 0x00 in the `.ts` source, so git
  treated it as **binary** (`git diff` shows `Bin`/`- -`, grep-hostile) even though tsc/vitest read it fine. Same
  for an in-comment control char. Detect with `python -c "print(open(p,'rb').read().count(0))"`; fix by using a
  text-safe escape that stays a source escape (`U+001F` unit separator) or a printable delimiter. Never embed a
  raw control byte in source — prefer a `\uXXXX` escape the compiler resolves at runtime. (Bit once 2026-07-05:
  `src/shared/decompose/consensus.ts` pairKey.)
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **Packaged/global-install drift is caught ONLY by `smoke:packaged-*` (`verify:release`), never by dev or
  vitest — so it fails the release gate loudly, not silently.** Two ways to break the tarball that pass every
  local check: (1) a production runtime `import` declared as a `devDependency` — devDeps are present in dev +
  the vitest suite, so only the packaged smoke hits `ERR_MODULE_NOT_FOUND` (when you add an `import` to any
  `src/` module that lands in `dist/` on a production path, confirm the package is under `dependencies`; bit
  once 2026-07-04 by `zod-to-json-schema` in `src/audit/contracts/workerSchemas.ts`); (2) deleting a *shipped*
  file that the smoke's `requiredPackagedPaths` list asserts (`scripts/audit/smoke-packaged-audit-code.mjs`,
  `verify-hosts.mjs`) → the gate fails on the missing tarball path. Diagnostic, not a silent trap: if
  `smoke:packaged` errors on a missing/absent module or path, this is why.
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **Prefer a dependency-injection seam over module mocking** in tests. Under vitest, `vi.spyOn`/`vi.mock`
  and fake timers (`vi.useFakeTimers({ toFake: [...] })`) are available, but the codebase's established
  pattern is injectable deps (`WorkerRunDeps`, `createWriteStream`/`spawn` seams) — keep using those.
- **Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/
  module_decomposition, not just a targeted one.** A narrow Explore before contract authoring is the top
  repair-round-churn driver — search the WHOLE repo for equivalent logic AND independently re-verify the
  target symbol's own type/shape against source at least once per contract. The cost of one broader Explore
  call or one grep is far lower than a full adversarial repair round or an implement-time revert.
  [[front-load-broad-search-before-contract-authoring]]
- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.**
  For a broad mechanical sweep over a shared file set, run it as ONE serial agent (or partition by
  NON-overlapping files), never an uncoordinated fan-out; and never hand-edit the same files while a
  background agent is live on them.
- **`rtk` compresses files you need verbatim.** When reading the `audit-code` skill body or `docs/backlog.md`
  through `rtk read`, content gets partially summarized with retrieval hashes → not exact. For any file you must
  act on verbatim, use raw `Get-Content -Raw` (or the Read tool), not `rtk read`.
- **`rtk proxy` runs executables, not PowerShell cmdlets.** `rtk proxy Get-Content` / `rtk proxy Get-ChildItem`
  fail (cmdlets aren't standalone exes). Working form: `rtk proxy powershell -NoProfile -Command "..."`.
- **`rtk proxy rg` fails with `Access is denied`** (Codex/win32). Fallback: PowerShell `Select-String` (or the
  Grep tool).
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code implement
  node.** The tool's own dispatch plan already creates and names the node's worktree; adding the Agent tool's
  OWN `isolation: "worktree"` spawns a second, unrelated git worktree and the subagent edits source files there
  instead of the tool-designated one — `accept-node`'s cherry-pick then sees no diff.
  [[no-agent-isolation-worktree-for-dispatch-nodes]]
- **No host-side unblock for a wedged audit run — use `audit-code force-synthesis`.** Host-side attempts to
  unblock a stuck audit (pending tasks that won't clear) do NOT work and actively corrupt gitignored
  run-state: marking `status:complete` in `audit_tasks.json` is ignored; writing
  `partial_completion_terminal.stranded_ids` is overwritten; appending results with unique idempotency keys
  clears the obligation but cascades stale `planning_artifacts`. The only clean recovery is the tool-owned
  affordance — `audit-code force-synthesis` stamps an `operator_forced` partial-completion terminal over the
  pending task ids (durable direct write to `active-dispatch.json`, the special-loaded artifact
  `writeCoreArtifacts` doesn't own) and drives the synthesis executor from the intact ledger on partial
  coverage, with no hand-editing of gitignored run-state. (`src/audit/cli/forceSynthesisCommand.ts`;
  `buildOperatorForcedTerminal` in shared; e2e in `tests/audit/audit-code-completion.test.mjs`.)
