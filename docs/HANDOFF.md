# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of what is open. Durable
> how-to is in `CLAUDE.md`; per-item detail in the split backlog [`docs/backlog/`](backlog/); durable design in
> `spec/`. This is the *sequencing* view — every open item appears once, in suggested order, with a
> pointer to its detail. **Shipped detail is `git log`, never this doc.**

## Live state

- **Backlog clearance lap, 2026-07-24 (`6df9100e`, unreleased — still v0.34.27).** Whole file
  re-triaged (one NIM call per entry — batching 27 at a time died every time), then five fixes landed
  and **one reverted**. `open-bugs.md` is 108 → 95 entries, ~154KB → ~145KB, baseline ratcheted.
  ⚠ **The revert is the load-bearing finding.** Regenerating the price snapshot fixes the inert
  provider-scoped path but rewrites the flat table to the CHEAPEST price across providers, which ranks
  `claude-opus-4-8` at $0.85 blended — **below haiku** — so cost-first routing at λ=0 would send every
  packet to Opus. `cost-rank.test.mjs` caught it (11 failures, CI shard 1, both Node versions); the
  stale snapshot looked right only because the pre-collision `flatten()` happened to keep anthropic's
  prices. The backlog said to settle the service→vendor-id mismatch AFTER refreshing; that ordering was
  wrong and the entry now says the mapping is a PREREQUISITE. Do not "fix" it by editing the cost-rank
  expectations — they encode real list prices and are what caught it.
  ⚠ **Adversarial review overturned two premises of the remediate claim-leak item** — see IMMEDIATE
  NEXT item 2. Record: [`backlog-clearance-2026-07-24.md`](reviews/backlog-clearance-2026-07-24.md).

- **Prior backlog clear-out lap (`d4c8e9ea`).** All 176 entries
  re-verified against HEAD, then every close/rewrite verdict attacked by an independent adversary on
  a different model lane; that second pass **overturned 41 of 62** verdicts it examined, almost all
  "delete" → "rewrite" because half the entry was still live. Backlog is now **split by section**
  under `docs/backlog/` (index at `docs/backlog.md`) with a **shrink-only size budget**
  (`check:backlog-budget`, in `verify:checks`; ceilings in `docs/backlog/.size-baseline.json`).
  Shipped alongside: **FLW-COR-003 host half** (loop-core, attested), **fixture hermeticity**
  (per-invocation roots + build-vs-suite guard + false-RED gate), the **generated loop-core path
  list**, heavy-test timeouts, and 11 verified doc fixes.
  ⚠ **Two corrections worth carrying:** (1) FLW-COR-003's backlog-prescribed fix — "release claims
  on every path that claims" — was WRONG; the lease must span out-of-process workers
  (`dispatch.ts:129-136`), and the real leak was merge throwing before its own release. (2) The
  `analyzerDeps` "live npm install E404" entry was REFUTED: no test shells out to npm; it was a
  stub-log leak manufacturing a convincing false alarm. Both are the same class the backlog keeps
  hitting — an entry paraphrasing its own incident until the mechanism inverts.
  **Immediate next is now item 2 below** (FLW-COR-003 is done); ~74 triaged `fix_now` items remain,
  detail in `docs/backlog/open-bugs.md`.
- **Current version = `package.json`** (authoritative): v0.34.27. The backlog clear-out lap above is
  UNRELEASED. **Per-release shipped detail is `git log` and the `docs/reviews/` records — deliberately
  not restated here** (this section had grown to ~107 lines of version-by-version narration, which is
  the changelog creep this doc's own header forbids).
- **A2 oracle corpus stays PARKED** (owner redirect 2026-07-22) — SPEC intact in
  [`docs/backlog/deferred.md`](backlog/deferred.md), nothing lost.
- **Shipped and settled — mechanism lives in the code + its record, not here.** Capability-evidence
  landing gate (R3-3), the trap-guard hook layer, the nightly maintenance routine, loop-core
  attestation + pre-commit hardening, the backend-identity migration (all stages) and the
  account-metering whole-defect closure are all DONE. Durable design is in project memory
  ([[trap-guard-hook-layer]], [[nightly-maintenance-routine]],
  [[account-metering-closed-producer-decides-partition]]); contracts in `docs/nightly-routine.md`
  and `CLAUDE.md`; per-change detail in `git log` + `docs/reviews/`.
  ⚠ Two carry-forward cautions from that work, both still live: service-scope the CREDENTIAL-DERIVED
  account branch too, since proxied lanes share one credential and must stay split by service; and a
  self-issued attestation reads as one, which is why `--attester-class` is recorded rather than
  trusted ([[attestation-cannot-tell-reviewer-from-author]]).
- **⚠ Changing an identity means auditing every FILTER that feeds it, not just every consumer.**
  v0.33.11 service-qualified the Gate-0 key and was verified against its consumers — but the source
  fold UPSTREAM still deduped on the bare model id, so a source colliding with a host tier on another
  service was dropped from the confirmed record and could never be confirmed (a livelock, fixed in
  v0.33.12). While the key was bare-model that same collision silently matched, which was the BYPASS:
  one defect, fail-open from one side and wedged-shut from the other. The verification was thorough
  within the boundary drawn, and the boundary was the error.
- **⚠ A local test failure can be an AMBIENT-PATH artifact, not a regression.** `INV-shared-core-14`
  stubbed only two provider constructors while auto-resolution walks the real PATH — so it passed in CI
  (no CLIs on the runner) and failed on any box with `agy`/`codex` installed, reading as a product
  defect. Fixed, but the CLASS recurs: before believing a local red, check whether the test's fixture
  depends on what happens to be installed ([[lap-green-must-match-ci-evidence]] cuts BOTH ways — CI
  green over a local red is just as much a real signal as the reverse).
- **⚠ Stale-worktree trap:** ALWAYS `git fetch audit-tools main && git log HEAD..audit-tools/main`
  before starting a lap — a worktree can branch behind main and must fast-forward + re-read
  HANDOFF/backlog first.
- **Local env:** npm 12 blocks dependency install scripts by default and can emit object-shaped
  `npm pack --json`. Smokes are fixed, but read [`docs/backlog/durable-traps.md`](backlog/durable-traps.md) before any manual
  `npm install -g` / packaged-install work.
- **Offload lane changed:** `llm-worker-tools` (`llm read`/`llm write`) is RETIRED. Bulk work goes direct
  to the local LiteLLM proxy — see `~/.claude/CLAUDE.md` → *Offload lane*. The proxy must be running;
  there is no standalone fallback (it was found DEAD at the start of the 2026-07-24 lap, taking the
  whole lane down until restarted). ⚠ **LiteLLM is being RETIRED in favour of 9router** — Track 1 in
  [`forward-tracks.md`](backlog/forward-tracks.md); infrastructure is live but ZERO code migrated, so
  `:4000` is still load-bearing today. ⚠ **The lane handles judgment work, not just recon.** The standing
  belief that it could not was traced to unset request parameters (no `max_tokens`; a misfitting schema
  under strict decoding) — properly configured it produced review-grade analysis. Check `finish_reason`
  before concluding anything about a model ([[offload-lane-failures-are-usually-the-caller]]).
- **The backlog was fully classified and disambiguated 2026-07-19.** Every open item was verified against
  code rather than its own prose; ~21% were closable and several load-bearing claims were false. Items
  now carry an explicit **SPEC** paragraph stating the agreed mechanism. Treat an entry without one as
  still raw ([[backlog-prose-decays-verify-against-head]]).
- **Project memory was consolidated 2026-07-19** (149 → 136 files; record:
  [`memory-consolidation-2026-07-19.md`](reviews/memory-consolidation-2026-07-19.md)). The single-package
  collapse had left **17 memories citing dead paths**, concentrated in the trap/recovery files whose
  procedures were runnable and wrong; three more described *reverted* directions as the current goal.
  All fixed. ⚠ Carried-forward caveat: an "open item" claim inside a memory is a LEAD, not a work order —
  one listed 4 opens of which 3 were long done ([[refactor-must-sweep-memory-not-just-code]]).

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial pipeline only for
  risky/complex changes; trivial mechanical clusters run lean. Tool-enforced via the risk-tier → Dial
  A/B fold, not host discretion.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three
  categories (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog +
  `open_observations`. Mechanically backstopped by step-boundary capture, an in-run per-category gate,
  and a session-end Stop-hook.
- **Release:** `npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump. Run `npm run verify:release` locally before
  tagging — the local pre-tag gate is only `check`.
- **End every lap by checking CI on `main`.** `ci` and `audit-code-test-suite` were red for ~a dozen
  laps while every lap reported "green": the pre-commit hook gates only `npm run check`, and laps
  verified with build + check + vitest — none of which include `verify:checks`
  ([[lap-green-must-match-ci-evidence]]). A local "N failed" must be resolved to NAMED files before
  being waved at as the known-flaky baseline.
  ⚠ **Neither `gh` endpoint is dependably up — try BOTH before concluding anything.** The per-workflow
  form (`actions/workflows/<wf>.yml/runs`) was previously the reliable one and the generic form flaky;
  on 2026-07-19 that inverted — the per-workflow endpoint returned HTTP 503 repeatedly while
  `actions/runs?per_page=N` (filter by `head_sha` yourself) answered immediately. Treat a 503 from
  either as "ask the other one", never as "CI is unavailable", and never as a reason to skip the check.
  Also expect superseded runs to show `cancelled` — a newer push cancels the older run by concurrency,
  which is normal and is not a failure.
- **Branch-strand trap (bit twice):** a remediation run leaves you checked out on its worktree branch —
  commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit strands.
- **Never pass `isolation: "worktree"` to the Agent tool** when dispatching a remediate-code/audit-code
  implement node — the dispatch plan already names the correct worktree; a second one strands the
  subagent's edits where `accept-node` can't see them.
- **Loop-core** → green + independent review + attestation required. The authoritative list is the
  `LOOP_CORE_PATTERNS` array in `src/shared/loopCorePaths.ts` (16 entries), from which
  `.claude/hooks/loop-core-patterns.mjs` is generated and both gate hooks import it. **Read the
  array, never a copy** — the paraphrase that used to sit here named 7 of the 16 and included files
  that are not canonical entries, which under-states which commits need attestation.

---

## ▶ IMMEDIATE NEXT

**Owner redirect 2026-07-23: stabilize audit-tools before A2.** The active track is now
**runtime-loop defects**, not the A2 oracle corpus (A2 is PARKED in backlog *Deferred / waiting* —
its SPEC is intact, nothing lost).

**1. Work the triaged `fix_now` queue** in [`docs/backlog/open-bugs.md`](backlog/open-bugs.md). ~74
entries carry a verified fix sketch naming files, mechanism and how a test pins it red-green; ~24 are
loop-core (attestation required). Highest-value clusters: the proxy-lane populate/refresh command (a
drop reason names an internal function no operator can run), `dropped[]` reasons never rendered at
Gate-0, the `top_k` alphabetical truncation that silently drops the frontier tier, and the
remediate-side node-claim twin below. Then **Gate-0 priority-order UX** (Track 3 — decisions
resolved, implementation remains).

**2. The remediate claim-leak twin — DESIGNED, not applied; loop-core, needs attestation.** Confirmed
at HEAD: `rollingSession.ts` claims at `:442`, releases at `:601-604`, persists at `:623`, and the
stray-worktree `throw` at `:580` sits between the outcome record and the release, so that path frees
nothing and never persists — `terminal` never counts the node and `inFlight` stays ≥1, a **permanent
hang**, not a timed stall.
⚠ Adversarial review overturned two premises that were driving the design. (a) The lease is 30s
(`STALE_LOCK_MS`), not the audit side's 20 minutes. (b) The stated blocker — that releasing breaks the
`reverify-node` retry via the ownership heartbeat — is FALSE: `reverifyQuarantinedNode` passes no
`ownership` at all (`rollingSession.ts:790-792`). ⚠ And the obvious fix is also wrong: routing a stray
into `accept_failed` makes the host directive (`nextStep.ts:2264-2269`) promise a quarantine ref that a
never-committed stray does not have, turning a hard stop into a confidently-wrong `reverify-node`
instruction. The stray needs its OWN terminal class carrying its diagnostic, plus a pinned intra-block
order (record outcome → mark terminal → drop token → persist → release → throw last). Full corrected
design in the workflow journal cited by [`backlog-clearance-2026-07-24.md`](reviews/backlog-clearance-2026-07-24.md).
Also still open: FLW-COR-003's second half, "a zero-granted round pauses the drain" — a SEPARATE
property, still unverified; check it at HEAD first. Both in [`open-bugs.md`](backlog/open-bugs.md).

**3. Make `open-bugs.md` a bounded read — condensation is now EXHAUSTED, only closing entries moves it.**
143KB / 96 entries against a 120KB budget (was 154KB / 108). Measured at HEAD: total excess over the
2600-char per-entry budget is **2,989 chars across all 96** — so even condensing every oversized entry
to budget sheds ~3KB and leaves ~140KB. The remaining 23KB has to come from CLOSING entries (item 1).
Run `node scripts/check-backlog-budget.mjs --update-baseline` after each drop to ratchet the
shrink-only ceiling.

**A2 (parked):** build the oracle corpus from small, public, PINNED repos (full SPEC in
[`deferred.md`](backlog/deferred.md)) — resume once stability work is complete.

---

## Open tracks

**Track 1 — LiteLLM → 9router migration: infrastructure DONE, code migration 0% started.** 9router is
live (`127.0.0.1:20128`, `9router-autostart` Ready, 176 models) and LiteLLM is confirmed retirable,
but `git grep -il 9router -- src/` returns NOTHING — that sprint was docs + external config only, and
every live path still runs on `:4000`. Re-verified 2026-07-24, which also measured **three gaps the
design plan does not record** — chiefly that 9router serves no `/model/info` and every `/api/*` is
401, so cost and context caps have no unauthenticated equivalent, making the prefix→models.dev
mapping a PREREQUISITE for the re-point rather than a parallel task. Full detail + the other two gaps:
Track 1 in [`forward-tracks.md`](backlog/forward-tracks.md); design of record
[`host-routed-dispatch-design-2026-07-23.md`](reviews/host-routed-dispatch-design-2026-07-23.md);
sprint pickup [`9router-routing-sprint-handoff-2026-07-23.md`](reviews/9router-routing-sprint-handoff-2026-07-23.md).

**Track 2 — Ranker contract.** A separate project, not audit-tools code. The *producer* now exists and
is validated live (NIM roster joined to OpenRouter `agentic_index` → LiteLLM `model_info`), and the
consuming seam already ingests it — so this needed **zero audit-tools code change**. What remains is a
contract question, not a build: where a ranks artifact lives and how audit-tools reads it, such that
swapping, starting, or removing the ranker changes zero audit-tools source. Still hand-run, not a
refreshed pipeline.

**Track 3 — Gate-0 operator-confirmed priority order.** The machinery exists end-to-end; what is
missing is prompt clarity plus a fallback when no ranks exist. Two open owner calls: whether a
suggested fallback order lists every pool or only the capable-and-above tiers, and how an
operator-confirmed order composes with λ (the cost↔speed bias).

**G-series — closed as a sequence.** Do not reopen G4/G5/G6 as laps. Two slivers survive on their own
merits and are backlog-tracked: the **G6 read-path unification** (audit and remediate still read their
session config from disjoint paths, so policy rides the confirmation artifact rather than the intent)
and **G5's lies-reachably quarantine**. Records:
[`dispatch-fork-assessment-2026-07-16.md`](reviews/dispatch-fork-assessment-2026-07-16.md) ·
[`g4-g5-g6-premise-check-2026-07-16.md`](reviews/g4-g5-g6-premise-check-2026-07-16.md).

**WAITING (gated, not next): D-66/67 slice-3** — heartbeat / merge-time ownership gate on the
LONG-lived execution claims. Delicate, focused-lap, **live-run-gated**: only pursue if a real
cooperative run shows the probe window actually bites. Its own blocker is a real design question —
long claims are held across out-of-process worker runs with no looping parent, so who beats the
heartbeat during that span is undecided. ([[rolling-lifecycle-unify-full-unification-wrong]] governs:
full unification is the WRONG endpoint.)

---

<details><summary>Reusable launch recipe for a maximal-coverage validation run</summary>

**Where.** A Claude Code conversation at the **primary `C:\Code\audit-tools` checkout, branch `main`,
clean tree — never a lap worktree** (slash workflows run the GLOBAL bin, so worktree state is
irrelevant, but scratch/artifacts must land on main's tree). Verify the global bins are current
(`audit-code --version` == `package.json` on main). Target: audit-tools itself is fine and has a
pending clean self-audit on record; if a genuinely LARGER metered target is available, prefer it —
**size is what forces the quota wall**, and a small target validates none of the wall items. On
audit-tools, compensate with a deep ceiling so the frontier is large.

**Configure first.** Source pools are declared **off-repo** in `~/.audit-code/sources-declared.json` —
start from `examples/catalog/sources-declared.json`. Include a NIM entry (operator-supplied endpoint /
model / key env, never hardcoded) and the **opencode-free** entry, which exercises arbitrage Phase-0
declared-free routing plus the cost-drift demotion if a free tier ever bills. Codex needs nothing — the
CLI is auto-detected. No `--root`/provider/model flags anywhere; a needed manual flag is a bug — report
it, don't work around it.

⚠ **Export the key env vars in the shell that launches the IDE.** A lane is admitted only if the process
can PROVE reach — a key env var pointing at an unset variable is dropped with a reason, by design. If a
pool is missing from Gate-0, that is the mechanism working; check the env, not the config.

**Launch.** `/audit-code`. At the interactive Gate-0, confirm the priced roster shows host + codex +
NIM + opencode-free; accept the proposed lens set; pick a deep ceiling. Then let it run — **do not
rescue it at the wall; the failure modes ARE the data.** Resume after the quota window resets.

**Mid-run, uniquely valuable:** open a **second IDE session** on the same repo mid-wave and start a
step. That is the only live check for the lease-TTL fix ([[host-path-quota-enforcement]]) and the
multi-IDE concurrent-admitter model — the second admitter must see the account's cap still held while
the first wave is in flight. It is also the run that would show whether D-66/67 slice-3 is worth doing.

**Watch:** [`docs/backlog.md`](backlog.md) → *Live-validation guide*; each item's ⬇ Live-run watch line is the
authoritative pass/fail.

**Fail-signal protocol:** any wedge needing `force-synthesis`, a crash at the wall, orphaned
`deepening:*` tasks, a silently-skipped analyzer, or a missing friction event → one line under backlog
*Open bugs* before moving on.

**After the run:** findings may optionally be hand-labeled as large-target calibration data — the
A2 oracle corpus itself is pinned public repos (see backlog *Deferred / waiting*), not labeled runs.

**What this run canNOT cover:** clippy/rubocop live spawn (needs a Rust/Ruby repo + toolchain — none on
this box); Copilot/Antigravity quota endpoints (need those IDEs running); the gated e2es (creds + env
vars, runnable any time).

</details>

---

## Suggested ordering — rationale

The **loop is the meta-tool**; making it cheaper, convergent, and safe compounds on all downstream work
([[autonomous-pipeline-capstone-spec]]). With the code tracks closed, the live-validation run IS the
current loop-improvement work — it gates "redesign before scheduled autonomy" advancing to the
scheduled audit→remediate→PR capstone.

Everything else open is in the split backlog, which is the per-item detail of record — one file per
section so each is a bounded read: [`open-bugs.md`](backlog/open-bugs.md) (fixable defects),
[`forward-tracks.md`](backlog/forward-tracks.md) (design directions),
[`deferred.md`](backlog/deferred.md) (blocked on data or environment),
[`durable-traps.md`](backlog/durable-traps.md) (standing reference). Index: [`backlog.md`](backlog.md).

**Verify a queued item's PREMISE against HEAD before opening a lap on it** — a spec's decomposition is a
lead, not a work order ([[grep-the-writers-before-believing-inheritance]]). Backlog prose decays: a
2026-07-19 classification pass found ~21% of entries were already shipped, stale, or describing code
that lives only on an unmerged branch.

⚠ **Deliberate, still current:** autonomous auto-confirm is scoped to the DELTA case only — a first-time
confirmation (no artifact at all) still pauses for the operator even under `autonomous_mode`.

Each lap: pick the next item, **risk-tier it**, ship, reinstall, **full friction walk**, update this
ordering.
