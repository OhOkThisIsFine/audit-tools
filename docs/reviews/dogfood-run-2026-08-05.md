# Dogfood run 2026-08-05 — full-lens self-audit, free-lane bulk dispatch

Run id `20260805T031732854Z_audit_tasks_completed_001` on HEAD `fa06d358`. Full scope (1192 files),
every canonical lens plus custom `cross_platform`, deep (5-perspective + judge) conceptual review.
Result: **2,179 findings / 169 work blocks** (4 critical, 161 high, 1339 medium, 673 low), 1188 files
fully audited, promoted to `.audit-tools/audit-report.md` + `audit-findings.json`. Friction close-out:
19 observations on the run's friction record (`.audit-tools/audit/friction/run.json`).

## Dispatch shape (what actually ran)

- 358 packets / 703 tasks wave 1, then 50 (81 retries + 161 deepening), 5, 2, 1 — clean convergence.
- Owner directive: no primary-quota burn. Lanes: **relay pool** (tier-mapped subagent offload,
  deep→`pool/xhigh`; ~460 packets total across waves on Kimi-K3 / gemini-3.6-flash / DeepSeek /
  GLM-5.2), **codex** (40 packets, headless `codex exec` driver, prompt-on-stdin, 4-way concurrency,
  zero failures), **agy** — dead on arrival: the trap-guard's documented flag-latch derail makes it
  unusable for write-tasks; folded into pool.
- ~37M offloaded subagent tokens across the two Workflow fan-outs alone; primary quota spent only on
  orchestration, one narrative dispatch, and one rescue worker.

## What failed and how it was recovered

1. **Workflow loader truncation (host-side):** a single agent returning the 317-packet list as
   structured output silently dropped 142 entries (schema-valid, incomplete). Recovery: disk-truth
   reconcile (`.inline-result.json` census) + relaunch with ≤24-entry chunk files, each loader
   affirming `count`. Pattern to reuse: never let one LLM return an unbounded list; chunk + count.
2. **`src-shared:maintainability:part-8` double-bounce (tool-side):** two free-pool workers
   hand-wrote malformed inline-result JSON and echoed "valid"; merge classified the task
   missing/unparseable, but submit had reported success and no rejection reason was persisted
   (`failed-tasks.json` appears only when ALL results block). Recovery: delete corrupt file, one
   real-Anthropic worker following the stdin submit procedure. Defect: submit must refuse coverage
   gaps and a worker-visible "valid" must be impossible unless the tool wrote a parseable result per
   assigned task.
3. **Design-review artifact drift (tool-side gap):** 5 of 8 design-review agents missed the output
   contract (2 wrong filename, 1 wrong directory, 2 invalid JSON) — hand-repaired. The packet lane
   validates on submit; the design-review/charter/challenge lanes have no chokepoint at all.

## 2026-07-30 live-run-watch evidence (the ▶ cluster asked this run to re-test)

- **(6) report coverage counts reflect the run: PASSED** — 1188/1192 fully-audited on a genuinely
  full-tree wave; lens breakdown covers all 11+1 lenses, no excluded-lens findings.
- **(7) exit codes success-shaped only on success: PASSED this run** — `merge-and-ingest` exited 2
  exactly when rejections existed (81/…/1) and 0 on the fully-clean final merge. The 2026-07-30
  "exit 2 on full success" did not reproduce. New adjacent defect instead: the *step prompt* tells
  the host to STOP on non-zero ("if merge-and-ingest fails, stop and report"), conflating
  rejections-present with failure.
- (2) remedy-reachability and (4) cooldown attribution: **not exercised** — every wave granted all
  packets; no `no_capable_pool` pause and no rate-limit cooldown occurred. Still live-run watch.

## Friction observations (full list on the friction record; the leads)

- **tool_should_decide (10):** no submit chokepoint for design-review/charter/challenge artifacts;
  submit-packet success on uncovered/malformed results + no per-task rejection reasons at reject
  time; systemic-challenge ids not round-namespaced (SC-001 collided across rounds 3/4) and
  convergence rests on host prompt-craft; staleness event re-log spam (28× and ~15× duplicate lines
  in single next-steps); `ensure` regenerates `opencode.json` with unstable key order (perpetual
  phantom diff); deterministic observability-lens rationale factually wrong ("no logging surface");
  tier routing collapsed 354/358→deep, making the multi-rank roster dead weight; merge exit-2
  semantics vs prompt stop-on-failure language.
- **ambiguous_direction (4):** resumed runs skip the scope echo; subagent model choice unspecified
  (and with relay offload ON the handshake roster is not what serves); charter delta-miner
  independence implicit; run_id null in step envelopes while dispatch artifacts carry timestamped
  run ids — the friction record path (`friction/run.json`) and the substrate's dispatch-run-id
  keying diverge, so a substrate-keyed walk was invisible to the present_report gate.
- **inefficient_feeding (5):** ~340-line low-confidence flow-stub dump in the fallback prompt;
  auditor handshake JSON re-echoed in full every step; one silent >120s next-step derivation;
  staleness spam (also counted above); charter blindness leaks in comment-dense repos (headers ARE
  the stated intent, so stated↔revealed deltas collapse).

## Meta

- The audit's own top themes (concurrent state fragility, monolithic orchestrators, silent error
  degradation, duplication, submit/validation gaps) independently corroborate the friction log —
  the tool found its own dispatch-lane defects from source.
- Session host-side lessons: scratchpad script files beat inline `node -e` for anything with
  escapes; `.entries` on an array is a real footgun; disk truth (result-file census) beats agent
  self-reports for fan-out accounting.
