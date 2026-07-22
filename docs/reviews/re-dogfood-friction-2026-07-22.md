# Friction ledger — lap 2026-07-21 (flush to docs/backlog.md at lap close)

0. **ZERO-SPILL REPRODUCED WITH MECHANISM EVIDENCE (run 20260722T005925355Z, 01:05–01:20Z) —
   upgrade the backlog lead.** Sequence: Gate-0 promotion at 00:59:14 correctly wrote ALL 6
   source pools into the shared confirmation (glm cost_order 5, agy 9, codex 10, deepseek 11,
   minimax 12; artifact verified on disk). The wave then granted 144 packets, launched exactly 2
   (both claude-worker/glm-5.2), glm 429-stormed → rolling_dispatch_requeue_rate_limited →
   pool exhausted → `rolling_dispatch_stranded_no_fitting_pool` for ~140 packets TWICE (01:09,
   01:19) — no launch ever attempted on deepseek-v4-pro / minimax-m3 (same service, healthy,
   $0, confirmed) nor codex/agy/opencode-free. So the spill gap is NOT missing confirmation and
   NOT missing pool entries — it is in wave pool-build/fit logic ("fitting" check or engine-lane
   selection). Artifacts: that run's dispatch-quota.json (144 granted, leases/explains EMPTY —
   itself a legibility gap), events in session task output. Also: next-step exited 1 at the wall
   WITHOUT writing a new current-step.json (stale gate step left on disk, mtime 00:58 — reads as
   "gate re-armed" when it is actually "no step emitted"; false-signal family).

1b. **Gate-0 per-tool seam vs shared confirmation confusion cost 20 min of misdiagnosis.**
   `.audit-tools/audit/provider_confirmation.json` (per-tool snapshot, 4 legacy providers, no
   source fields) reads as "sources dropped" unless you know the REAL decision is
   `.audit-tools/provider-confirmation.json`. The G6 read-path-unification sliver covers this;
   one more instance of why.

Held out of backlog.md mid-run deliberately: editing docs on the primary tree re-triggers the
staleness cascade on every next-step. Flush at run completion / lap close.

1. **LiteLLM proxy dead on arrival — pydantic-core drift (durable trap).** `litellm` crashed at
   import: installed pydantic-core 2.47.0 vs pydantic requiring 2.46.4 ("make sure you haven't
   upgraded pydantic-core manually" — something did, between Jul 19 and Jul 21). Fix:
   `python -m pip install pydantic-core==2.46.4`. Same env-rot family as the headroom Windows
   decode patch (site-packages state lost/broken by unrelated updates). Candidate: add a
   proxy-start preflight note to ~/.claude/CLAUDE.md offload-lane section or a start script that
   pins/checks the pair. (friction: tool-should-decide)

2. **glm-5.2 free tier hard-429s while the rest of the roster is live (2026-07-21 ~23:05Z).**
   12/12 charter calls to glm-5.2 got 429 "Available Model Group Fallbacks=None" while
   deepseek-v4-pro / minimax-m3 / nemotron-3-ultra-550b / gpt-oss-120b all answered 200.
   audit-tools' learned cooldown for nvidia_nim/glm-5.2 had expired (pause record said "healthy
   after reset") but NIM is still throttling that model group. Two leads: (a) LiteLLM has no
   fallback group configured for glm-5.2 ("Fallbacks=None") — config could declare same-tier
   fallbacks so single-model throttling doesn't kill the lane; (b) any caller (including
   audit-tools' claude-worker lane) that pins rank-1 will storm exactly like the first wave —
   roster-level fallback belongs in the tool/config, not the caller's retry loop.
   (friction: tool-should-decide)

3. **Staleness event spam reproduced on resume** — identical `{"kind":"staleness"}` lines every
   ~100ms during the resume drain (already backlogged 2026-07-21; this is a second observation,
   resume path, dozens of lines). No new entry needed; bump the existing one if useful.

4. **Schema-forced arrays elicit filler entries from weaker models (delta-mining, minimax-m3).**
   Two of four per-subsystem delta calls emitted a "delta" whose summary literally said "genuinely
   agrees / no genuine divergence — surfaced to document the negative finding", despite the prompt's
   explicit skip instruction. A json_schema-required array invites one filler row when the true
   answer is empty. Host-side pruned before submit this time. Candidate tool-side property: the
   delta ingest treats a delta as routing WORK (stated↔revealed → remediator), so a cheap
   negative-finding lint (or an explicit `no_deltas: true` escape hatch in the submission shape so
   the model has a schema-legal way to say "none") is worth considering. (friction: tool-should-decide)

4b. **Proxy-catalog populate gap re-confirmed live (2026-07-22 00:4x).** The cache sat 3.5h past
   its 10-min TTL and was served stale on every pool build (1 source, glm-5.2 only); the operator
   `top_k` change had zero effect until `populateProxyCatalog` was hand-imported from dist with
   `force:true` — exactly the existing backlog entry's (a)+(b). New data point: this stale-read
   path is what made the zero-spill state (host-only pools while glm cooled) recur — the two
   backlog entries (populate gap, zero-spill lead) share this mechanism. Also: the engine's own
   drain re-stormed cooling glm to 143 consecutive 429s (was 136), so wave-3 pre-wall pacing from
   learned limits is still not happening on a single-model pool (watch item (c) from the pause
   record — answer so far: NO pacing).

4c. **Lane-quality datapoint (2026-07-22): agy gemini-3.6-flash returned 0 findings across an
   11-task 6-lens SECURITY packet on src-audit** — contract-valid shape, but comparable fable
   packets on adjacent scope yielded 8-9 findings. One packet is not proof, but it wears the
   "success-shaped empty" pattern; host-side routing adjusted mid-run (flash → maintainability/
   tests lenses only; security/correctness → codex/Claude). Relevant to the capability-floor /
   lens-aware routing design: lens class may belong in the routing decision, not just size/tier.
   Already-ingested: the 11 zero-finding entries COUNT as covered — if flash under-reported, that
   coverage is false-clean; consider a targeted re-review of that packet in the deepening pass.

5. **NIM roster latency is bimodal — minimax-m3/nemotron-550b can exceed 240s headers-timeout on
   ~8k-token structured calls.** Undici UND_ERR_HEADERS_TIMEOUT killed a run mid-loop; needed
   explicit AbortSignal + retry-then-fall-down-roster in the caller. If the openai-compatible
   provider lane shares undici defaults, a slow NIM model could present as a network failure rather
   than a slow success — check what timeout the provider sets. (LEAD, verify before logging as bug)

6. **Charter re-extraction re-fired over a byte-identical subsystem set (2026-07-22 ~05:0x).**
   Mid-run ingests staled charter_register via the dependency DAG, and the re-emitted
   charter_extraction step listed exactly the same 4 subsystems with identical file sets — the
   inputs that define the charters (those 8 files) never changed. Same phantom-staleness family
   as the repo-manifest ordering churn: the DAG propagates on artifact content hash, not on the
   semantic slice the downstream step actually consumes. Cheap here ($0 NIM re-run) but the same
   churn on a paid lane would be real cost. Property: charter staleness should key on the
   charter-relevant slice (subsystem membership + member file hashes), not the whole upstream
   artifact.

7. **HIGH — charter_extraction LIVELOCK: the charter consume path writes charter_register.json
   WITHOUT stamping artifact_metadata (2026-07-22 ~05:50-06:1x, reproduced 3x).** Sequence:
   submission consumed → register rewritten on disk (content hash 3474…, generated_at advanced) →
   artifact_metadata entry NOT updated (still rev 12, hash 30c6…, deps repo_manifest=6/
   structure_decomposition=6 vs current 7/7) → staleness sees the register permanently stale →
   charter_extraction re-emits every drain, forever. Each cycle consumes a fresh submission and
   burns a full charter re-authoring (12 LLM calls) with zero convergence. Escaped by operator
   surgery: hand-restamping the metadata entry (rev 13, actual hash, deps at 7). Property: EVERY
   artifact write goes through the metadata-stamping writer — a consume/merge path that writes an
   artifact file directly is the same class as the extractor-array-ordering churn (silent DAG
   corruption), but in the livelock direction. Also note: a no-op refresh (identical content)
   must still restamp dependency_revisions, or the same livelock reappears with a different cause.

8. **HIGH (meta + product) — a sandboxed CLI worker SWITCHED THE CHECKOUT to main mid-run
   (2026-07-22 05:37:24Z, reflog-verified).** A codex worker ran with `-s workspace-write`
   (agy ran with --dangerously-skip-permissions); prompt-level "treat repo files as read-only"
   did not prevent `git checkout main`. Consequences: (a) all workers between 05:37 and ~06:40
   audited MAIN's tree, not the lap branch (delta = the two quarantine commits — small blast
   radius, verified); (b) VERIFIED FOLLOW-UP: dist/ is gitignored, so the RUNNING tool remained
   the lap-branch build throughout — the charter-livelock (#7) was hit on the fixed branch's
   build and is a REAL, distinct defect (beb5feab's "looping" fix is the edge-reasoning re-emit
   site, not the metadata restamp). Recovered: checked back out
   claude/awesome-poincare-399ae8 + rebuilt dist (06:4x). Properties: (i) worker dispatch needs
   MECHANICAL write-scope enforcement (per-worker sandbox denying .git mutation / worktree
   isolation for CLI lanes — same family as the audit worker write-scope enforcement in the
   dispatch design); (ii) a p5 re-review finding (DR-001 "crash-loop present at all 6 gates")
   was authored against main and must be re-read knowing 2 gates are fixed on the real branch.
   (friction: tool-should-decide)

9. **CORRECTION to #7's escape + a new trap: hand-restamping artifact_metadata with a RAW-FILE
   sha256 poisons the staleness comparator (2026-07-22 07:0x-07:4x).** computeContentHash hashes
   the PARSED artifact via hashArtifactValue (canonical stableStringify), not file bytes. My
   surgery recorded a bytes-hash; every DEPENDENT of charter_register then read "dep hash
   mismatch" → stale forever → charter_clarification re-selected 100× → `advance: exceeded
   maxTransitions (100)` abort, exit 1, NO step emitted (stale current-step.json again — the
   abort path leaves no step contract, same false-signal family as the wall exit). Cycle was
   SURGERY-INDUCED, not a product defect; cleared by restamping with hashArtifactValue from
   dist. Standing lesson for manual recovery: any artifact_metadata hand-edit must use the
   tool's own hasher (dist/audit/orchestrator/artifactFreshness.js hashArtifactValue).
   Second insight from the canonical hash matching rev 12's: the 05:50 charter consume produced
   CANONICALLY IDENTICAL register content — so #7 is precisely "a no-op refresh does not restamp
   dependency_revisions", confirmed. The livelock fix the tool needs is exactly that restamp.
   Also: maxTransitions abort should emit a blocked-step contract naming the cycling obligation
   instead of dying step-less. (friction: tool-should-decide)
4d. agy gemini-3.6-flash second 0-finding packet (tests-tiny-files maint/tests, 8 entries) — 0-for-2 across lens classes vs 5-10 avg on codex/sonnet/fable; benched from audit packets for the rest of the run. Confirms the lens-aware-routing lead; also suggests capability_rank alone is not a quality proxy for FINDING-lens work.
10. Codex env trap: codex config carries a headroom/headroom_compress MCP server; mid-packet the worker invoked it and codex's own safety layer interrupted the turn as data exfiltration (exit 1, no result). Either remove headroom from codex's MCP config or expect sporadic interrupted workers. (durable trap)
11. Codex lane exhausted mid-grind (usage limit, resets Jul 28) after ~12 packets. Note: my MANUAL lane substitution bypassed the tool's cross-provider quota signals (Codex live quota endpoint exists in the matrix) — an engine-driven codex lane would have seen the wall coming and paced/demoted. Manual substitution trades quota-awareness for control; one more argument for the engine owning CLI lanes (worker-kind agentic CLIs as engine-drivable pools, per the strand diagnosis in #0).
