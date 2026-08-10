# Dogfood self-audit 2026-07-30 — run record

Owner-authorized maximal-coverage self-audit of audit-tools by audit-code v0.34.42 (deep design
review, 60+5-packet review waves, 7-round systemic challenge). Deliverables:
`.audit-tools/audit-report.md` / `audit-findings.json` (1567 findings — 2 critical, 31 high);
friction record `.audit-tools/audit/friction/run.json` (14 observations, the per-event authority).

## Watch-item result

The pinned `no_capable_pool` watch item **PASSED its primary property**: a packet estimated at
193,360 tokens against a 136,000-token deep-tier budget reached an honest, RESUMABLE `blocked`
pause naming the real cause ("fit mismatch, NOT a quota wall") — never `empty_pool`, never a
terminal strand.

## Defect cluster observed live (details; the backlog entry is the pointer)

1. **Re-planning shrink never fires.** Three consecutive `next-step` calls on the blocked packet
   produced byte-identical `blocked` states; the pause's advertised "let re-planning shrink the
   packets" recovery has no trigger, and the one packet head-of-line blocked all 41 remaining tasks.
2. **"Declare a larger pool" is unreachable for host waves.** A declared source with
   `quota.context_tokens: 1000000` (agy) never entered `capacity_pools` — host-wave fitting consults
   only the conversation-host roster, so the remedy the blocked prompt names cannot clear a
   host-wave packet. Operator ran the packet out-of-band on the 1M agy lane
   (`gemini-3.6-flash-high`); `merge-and-ingest` recovered it by task_id.
3. **Session-limit deaths strand results and claims.** 22 host workers died at the session limit;
   8 had written result files the tool never reconciled until a manual `merge-and-ingest`; claims
   from dead workers held 6 `deepening:*` tasks "live by a peer" across many minutes and multiple
   invocations.
4. **agy pool cooled as `rate_limited` after each SUCCESSFUL packet** (observed twice; AGY quota
   ~untouched). The misclassification starved the free lane, which is what pushed 59/60 first-wave
   packets onto the priciest host tier at λ=0 and burned the owner's session limit. The underlying
   provider message is never surfaced in events, so the wording cannot be pattern-fixed until it is.
5. **`present_report` false-green promotion.** The final step returned `status: complete` with
   `final_report` naming the promoted root path while the promotion write never happened — the root
   deliverables still held the PREVIOUS audit (1480 findings, pre-run mtime); this run's render sat
   only under `.audit-tools/audit/`. Operator promoted by hand.
6. **Coverage accounting:** the final report claims "Fully audited files: 25" after a 60-packet
   full-tree wave (previous run: 1109), and carries 1102 `maintainability` findings although that
   lens was excluded at intent confirmation.
7. **Minor, same run:** 29× byte-identical staleness events in one call; `merge-and-ingest` exits
   code 2 on full success; the Gate-0 provider-confirmation delta re-fired 3× late-run with nothing
   operator-meaningful changed; the synthesis narrative silently truncated its digest to 120 of
   1567 findings (stderr log line only).

## Also proven

- Free lanes complete deep-tier review packets when driven directly: 19 packets (including the
  193k-token one) ran on agy `gemini-3.6-flash-high` via a plain spawn driver, all accepted by the
  merge gate's validation.
- `merge-and-ingest` recovery-by-task_id is a working escape hatch for any wedged packet.
- Owner directive issued mid-run: **dispatch inversion** — the offload router owns routing; audit-tools only
  estimates per-task/packet tokens (specced in `docs/backlog/forward-tracks.md`).
