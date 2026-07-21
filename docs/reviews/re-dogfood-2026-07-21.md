# Re-dogfood wave observations (2026-07-21, v0.34.6) — run record


re-derive audit_tasks and orphan in-flight packets.

## Observed so far
1. Planning → rolling dispatch reached live: 154 packets, claude-worker via LiteLLM proxy →
   nvidia_nim/glm-5.2, real `claude -p` workers with 30s heartbeats. Track 1's "dispatch under a
   real wave" gap is CLOSED as an exercise.
2. THE WALL, as scripted: blind host quota (dark credential, warned loudly) → unpaced wave →
   NIM free-tier 429 storm ("Available Model Group Fallbacks=None") → every worker exit 1 →
   correctly classified rate_limited → requeued; pool marked exhausted. Classification CORRECT
   (three-tier model held). My 10-min Bash timeout killed next-step mid-wave (harness limit, not
   tool) — resumed cleanly in background, which itself validates mid-kill recovery (INV-WH class).
3. exitCode 3221226505 (0xC0000409) on 2 packets = Windows abort artifacts of the SIGTERM kill,
   not a product signal (verify absent on the resumed wave).
4. WATCH on the resumed wave: (a) does the 429 storm teach a learned RPM/TPM limit +
   cooldown-pace the pool (check ~/.audit-code/quota-state.json after); (b) does exhaustion SPILL
   to the other $0 pool (opencode-free) / codex / agy per cost-first, or does the wave tunnel on
   glm-5.2; (c) pre-wall pacing on the SECOND wave vs first (learned limits should cap width);
   (d) does any wedge require force-synthesis (fail-signal).

## Already logged to backlog pre-freeze (no action needed)
- Silent-destroy design-review ingest (HIGH) + fix agent dispatched (worktree #3).
- Proxy drop-reason names internal function; cache orphaned by identity migration.
- api_key_env accepts NAME=value silently.
- Staleness event spam (~26 duplicate lines).

## New, NOT yet logged (log at pause)
5. systemic_challenge submission crash: an ARRAY written where the schema wants an object →
   next-step exits 1 with a RAW zod dump (no file named, no quarantine, no graceful step) — the
   "crash (not graceful pause)" fail-signal class, sibling of the silent-destroy defect (one
   ingest site destroys silently, the other crashes loudly-but-uselessly; both fail the
   quarantine-loudly property).
6. Packet output-shape contracts are INCONSISTENT across step kinds: design-review packets want a
   bare JSON array; systemic-challenge wants {findings:[...]}. A host (or single-shot worker with
   json_object mode, which CANNOT emit a bare array) must special-case per packet. Property: one
   canonical submission envelope across all incoming files — or at minimum every packet's Output
   section shape must be what a json_object-constrained worker can emit (object envelope
   everywhere).
7. NIM/offload caller lessons (mine, for the offload-lane memory): batch size kills structured
   multi-entity output (8-file charter call collapsed to 1 subsystem; per-subsystem calls
   perfect); adversary rounds MUST inline the prior-round record or they emit ungrounded slop
   (7 fake findings → 0 with the record inlined).
8. The systemic-challenge loop is at round 10 on artifacts carried from PRIOR runs — loop-count
   state survives across runs by design? Verify intended (the round counter + 11 banked
   improvements predate this run).
9. WALL DATA (first wave, 21:51–21:57): glm-5.2 took 136 consecutive 429s before the pool
   exhausted → learned cooldown_until persisted 15min under the CORRECT current key
   (`nvidia_nim/glm-5.2`) — learned-limit persistence ✓. But 136 rapid-fire failures before
   backoff = no pre-wall pacing on a cold pool (expected: blind quota + cold start; the question
   is whether wave 3 paces from the learned data).
10. ZERO SPILL (lead, needs mechanism): with glm cooling, the second prepare-dispatch built
    capacity_pools = [host only] — opencode-free/codex/agy all healthy in quota-state yet ABSENT
    from the pool set, host pool present with infinite budget yet granted 0, then wall-blocked
    with "0 paused, resumable". No drop reasons in the log. Either capability-floor eligibility
    (deepseek rank 3 = bottom tercile → small-only; packets standard+) explains the sources, or
    spill (INV-QD-14) is broken on this path; and the HOST getting 0 grants while listed with
    infinite budget needs its own explanation (attended host + engine wall-check interplay).
    Diagnose from dispatch-quota.json + pool-build code AFTER the run completes.
11. D-66/67 slice-3 EVIDENCE: the SIGTERM-killed first wave left 7 task claims held; the second
    prepare-dispatch honored them as live-peer claims and deferred those tasks a round ("re-enter
    dispatch next round"). The probe window DID bite (mildly — deferral, not deadlock). This is
    the live-run data the slice-3 gate wanted.
12. token_usage stamping impedance mismatch: the dispatch prompt asks the host to stamp
    {input_tokens, output_tokens} per result, but this host's subagent tool reports only a TOTAL
    (subagent_tokens). An invented split would poison RPM/TPM calibration, so the honest host must
    skip the optional stamp and calibration stays at cold-start. Property: the contract should
    accept a total-only figure ({total_tokens}) and calibrate on it, since that is what real
    harnesses report.
13. Host-dispatch fallback engaged correctly when engine lanes were unavailable: dispatch_review
    step with granted=3 cold-start batch across the host roster's three tiers, prompt_path-based
    worker handoff, per-packet access grants. The conversation-first subagent dispatch is
    exercising as designed.

14. merge-and-ingest on a PARTIAL wave: first call ingested the granted 3 results (18 entries, progress_made:true) yet exited 2; an immediate re-run reported "All 430 assigned task result(s) were missing or invalid; blocked before ingestion" and exited 1 — a successful partial merge presents as total failure (false-red; inverse of the vitest false-green family), and two invocations minutes apart gave two different nonzero codes with success-shaped JSON in between. Property: partial-wave merge is the NORMAL rolling case and must exit 0 with a deferred-count summary; "all missing" language reserved for a run with zero results.

15. Nested subagent dispatch WORKS on this host: a dedicated dispatcher subagent successfully
    spawned per-packet worker subagents (fable + haiku) — the "delegate the rolling loop"
    instruction in the dispatch_review prompt is viable on Claude Code, keeping the host context
    clean across passes.

## Run state at pause (2026-07-21, session end)
- Run id at pause: 20260721T220659926Z_audit_tasks_completed_001 (host-dispatch rolling; pass 2 of
  the host path finishing under a dispatcher agent: 2 packets, then merge-and-ingest, NO further
  next-step). Ingested so far: first host pass (3 packets, 14 findings, 18 entries) + whatever
  pass 2 lands. ~60 packets / ~427 tasks remain undispatched — deferred, not dropped.
- glm-5.2 pool: learned cooldown from the 429 storm (persisted); healthy again after reset.
- RESUME: from the primary checkout, `audit-code next-step` with the standard --auditor roster
  handshake (see docs/HANDOFF.md) — the tool re-grants automatically. Expect a staleness
  re-extraction first (docs changed at pause, deliberately); a replan of the REMAINING tasks is
  acceptable — ingested results are content-addressed and survive.
