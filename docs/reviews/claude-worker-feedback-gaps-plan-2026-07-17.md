# Claude-worker feedback gaps — fix plan (2026-07-17)

Closes the three gaps from [`claude-worker-lane-dogfood-2026-07-16.md`](claude-worker-lane-dogfood-2026-07-16.md)
(backlog: "claude-worker lane dogfood feedback gaps", HIGH). Loop-core — full pipeline + attestation.

## Verified ground truth (this lap, against HEAD + the live run corpus)

The 06:17 run dir (`.audit-tools/audit/runs/20260717T061733049Z_audit_tasks_completed_001/task-results/`,
119 workers) is the evidence base:

1. **All failure text landed on STDOUT, none on stderr** (0×"429" on stderr; stdout: 29×429,
   61×"Request too large", 28×"may not exist"). Exact strings:
   - `API Error: Request rejected (429) · openai backend HTTP 429: {...}` — matches TIER-1 `/\b429\b/i`.
   - `Request too large (max 32MB). Try with a smaller file.` — the CLI's misleading render of groq's 413.
   - `There's an issue with the selected model (nim/moonshotai/kimi-k2.6). It may not exist or you may
     not have access to it.` — the 404 class. Matches NO current pattern.
2. **No worker wrote a result file** (task-results holds only task.json/prompt/stdout/stderr).
3. **The ledger recorded during the run but never as rate-limited**: all four pool entries
   (`~/.audit-code/quota-state.json`) show `updated_at` inside the run window with
   `cooldown_until:null, consecutive_429_count:0`.
4. **Root cause of (2)+(3): the not-accepted short-circuit.** `spawnLoggedCommand.ts:189` sets
   `accepted = closeCode === 0 && signal === null`; the Claude CLI exits nonzero on API error;
   `finalizeProviderLaunchResult` (`providerLaunchFinalize.ts:62-69`) returns `outcome:"error"` on
   `!launch.accepted` **before any channel scan**. The whole three-tier classifier (TIER-1 credit/rate,
   TIER-2 quota-suspicious, stdout fallback) is unreachable for a worker that exits nonzero — the
   COMMON failure shape for agentic CLI workers. `recordWaveOutcome` then records `error`, which by
   design leaves streak/cooldown alone (`rollingDispatch.ts:916-946`).
5. Claude-worker packets DO route through the rolling engine (`IN_PROCESS_AUDIT_PROVIDERS`,
   `hybridDispatch.ts:40-49` → `makeAuditProviderPacketDispatcher` → finalize at
   `rollingAuditDispatch.ts:335`) — the engine wiring is sound; only the classification entry is dead.
6. Packet sizing uses ONLY the host window: `dispatch.ts:372-380` passes
   `dispatchPool.contextBudgetTokens`; the only re-fit is host-tier (`fitPacketsToTierBudgets`,
   `dispatch.ts:381-393`). `DispatchableSource.quota` (`QuotaModelLimits`: `context_tokens`,
   `max_concurrent`, …) exists in the contract but is never consumed for sizing/fit.
7. Populate (`proxyCatalog.ts:248-293`) trusts the registry's `reachable:true`/`has_key:true` verdicts;
   kimi-k2.6 passed both and 404s live — registry rows are leads, not reach
   ([[external-audit-catalogs-are-leads]]). The expansion also discards any context-window data the
   registry carries.

## Fix design — three bounded units

### U1 — classify the not-accepted branch (gap b core + gap c runtime half)

**Property: a worker's failure text is classified identically whether the process exited 0 or not.**

- `providerLaunchFinalize.ts`: on `!launch.accepted`, BEFORE returning `error`, run the existing
  channel scans (stderr TIER-1 credit → rate-limit; then stdout TIER-1; then TIER-2
  `detectQuotaSuspicious` over both) — same order and channel-isolation semantics as the accepted
  branch. Factor the shared scan into one helper so the two branches cannot drift.
- `errorParsing.ts`: add TIER-1 `detectModelUnavailableError` — patterns for the 404 class:
  `/\b404\b/`, `/model_not_found/i`, `/\bmay not exist\b/i`, `/no such model/i`,
  `/does not exist or you do not have access/i`. New outcome `model_unavailable`.
- `rollingDispatch.ts`: `model_unavailable` handling mirrors `credit_exhausted` mechanics but the
  rationale is availability: permanent-for-the-run pool exclusion (a `modelUnavailablePoolIds`
  in-memory set, NOT a timed cooldown — a 404 does not reset), non-consuming re-queue of the packet,
  ledger outcome `error` (no backoff semantics), friction event `model_unavailable` (analog of
  `declared_cost_drift`, per-pool discriminator, medium severity).
- With this, the dogfood's 429s produce `rate_limited` → exponential `cooldown_until` → the engine's
  existing INV-QD-07 re-queue + `isPoolQuotaDegraded` spill pace the pool. Per
  [[concurrency-is-declared-or-absent-never-learned]], no static concurrency default is added for
  free tiers; the reactive backoff IS the pacing mechanism. Residual (accepted): the CLI's internal
  retries still hammer the backend WITHIN one worker's lifetime — proxy-side 307×429 vs 29 surfaced;
  if a live re-run shows cooldown alone insufficient, the follow-up is declared
  `quota.max_concurrent` consumption, backlog'd not built now.

### U2 — per-pool packet fit (gap a)

**Property: a packet is admitted to a pool only if it fits THAT pool's context/request cap.**

- Pool contract: source-pool build (`hostPool.ts` / audit `quotaPool.ts` path that constructs source
  pools) carries a per-pool `contextCapTokens: number | null` — from declared
  `DispatchableSource.quota.context_tokens`, else from populate-stamped registry data (U3), else null
  (= unknown, no fit filter; status quo).
- Selection-time fit: at packet→pool binding (`selectProvider`, `rollingDispatch.ts:529-658`), a pool
  whose `contextCapTokens` < packet's estimated tokens + `CLAUDE_WORKER_HARNESS_OVERHEAD_TOKENS` is
  skipped for THAT packet (not excluded for others). If no source pool fits, the packet falls to the
  host path (which sized it and always fits). Estimation stays `estimateTokensFromBytes` — local +
  deterministic, no tokenizer.
- Harness overhead: one named constant for the agentic-CLI system-prompt/tool overhead (order
  ~15k tokens), single-sourced in shared, documented as an estimate. Worker-kind-scoped: applied for
  `worker_kind: "agentic"` sources; single-shot sources keep the existing referenced-content caps
  (`openAiCompatibleProvider` already enforces its own inline caps).
- Populate (U3's stamp): `expandSources` copies registry context-window fields
  (`context_length`/`context_tokens`/`max_context` — tolerant extraction like score/price) into
  `quota.context_tokens` on each emitted source, so proxied pools get real caps with zero operator
  maintenance ([[model-provider-ide-agnostic]]: someone-else-maintained, synced not forked).

### U3 — populate-time model verification (gap c populate half)

**Property: a model enters the expansion only if the proxy will actually serve it — registry rows
are leads; reach is proven, mirroring G2.5's reach-proof bar.**

- After top-K ranking in `expandSources` (so probes are bounded at K×providers, not the whole
  registry), `populateProxyCatalog` probes each candidate with a minimal
  `POST <endpoint>/v1/messages` (`max_tokens:1`, model = `<backend_provider>/<model>`, dummy key —
  same namespace the launch transport uses). Classification: HTTP 404 / model-unavailable body →
  DROP the row (with a per-row `reason` in the populate result, loud not silent); 429/5xx/timeout →
  KEEP (rate-limited ≠ unavailable; a saturated pool is still real); 200 → keep.
- Probes run concurrently with a small bound and a short timeout; a probe TRANSPORT failure (proxy
  down mid-populate) keeps the row (fail-open matches the lane's existing fail-open probe posture —
  the runtime U1 demotion is the backstop).
- Populate is Gate-0-time only (never mid-resolve), so the added latency sits at the one
  operator-interactive pause. No TTL work here (existing backlog residual, unchanged).

## Adversarial-review revisions (2026-07-17, independent reviewer — findings folded in)

- **F1 (KILL, U2 layer fix):** the engine has NO host fallback — `selectProvider` returning null just
  leaves the packet pending (`rollingDispatch.ts:1275` `continue`; strand at `noPoolCanAcceptNow`).
  Therefore the U2 fit gate lives at the **hybrid partition layer** (`hybridDispatch.ts`): a packet
  that fits no in-process source pool's cap partitions to the HOST review path at partition time.
  The selection-time check remains only as a per-packet skip among source pools (a packet skips
  too-small pools but was already guaranteed ≥1 fitting pool by the partition); if that invariant
  ever breaks, the packet FAILS LOUD with an explicit `no_fitting_pool` reason — never silent-pending.
- **F4 (413 is its own class):** add TIER-1 `detectRequestTooLargeError`
  (`/request too large/i`, `/\b413\b/`, `/payload too large/i`, `/content too long/i`) → new outcome
  `packet_too_large`: NON-consuming re-queue with a per-(packet,pool) skip entry (this pool never
  retries THIS packet; other packets unaffected), ledger outcome `error` (no cooldown — a sizing
  fault must not cool a healthy pool), friction event per (pool,packet). It is the reactive backstop
  U2's partition-time fit should make rare. `detectQuotaSuspicious` confirmed NOT to match the groq
  text, so without this the 413 class dies as raw `error` — and it must be checked BEFORE the
  rate-limit tier so a combined text can't cooldown-poison the pool.
- **F2/F3 (impl contract, pinned):** `model_unavailable` handler goes beside `credit_exhausted` in
  `handleResult` (`rollingDispatch.ts` ~1107): in-memory `modelUnavailablePoolIds` exclusion +
  re-queue; `quotaOutcome` maps to `error` (the 935-940 mapping gains both new branches). Pool
  contract gains `contextCapTokens: number | null` (CapacityPool in `quota/capacity.ts` + the
  source-pool build). Every consumer switch over the outcome union (audit + remediate — the engine
  is shared) is enumerated and extended in the same commit; the remediate draw gets identical
  behavior by construction ([[auditor-remediator-mirroring-is-common-logic]]).
- **F5 (probe bounds, pinned):** `POPULATE_PROBE_TIMEOUT_MS = 3000`,
  `POPULATE_PROBE_CONCURRENCY = 4`; probes fail-open on transport error, drop only on a definite
  404/model-unavailable classification. Probes hit only the top-K candidates (bounded K×providers).

## Test plan (red-green validated, [[regression-test-must-be-red-green-validated]])

- U1: fixture a not-accepted launch (`exitCode:1`) with the run's VERBATIM stdout strings → expect
  `rate_limited` / `model_unavailable` / `credit_exhausted` respectively; prove RED by asserting
  against current HEAD behavior (`error`) first. Engine test: `model_unavailable` excludes the pool
  for the run + re-queues; ledger records no cooldown for it.
- U2: pool with `contextCapTokens` below a packet's estimate is skipped at selection; packet lands on
  host pool; unknown-cap pool unchanged. Populate stamp test: registry row with `context_length` →
  emitted source carries `quota.context_tokens`.
- U3: registry advertises model X; probe 404s X, 200s Y → expansion contains Y only, result names X
  with reason; probe 429 keeps the row; fetch-failure keeps prior cache semantics.

## Out of scope (stays backlog'd)

- Declared `quota.max_concurrent` consumption (residual above, only if re-run shows need).
- Catalog TTL / refresh command; account-axis; intra-declaration dedup (existing 3c residuals).
- The CLI-internal retry hammering (inside one worker's lifetime) — not observable from the parent.
