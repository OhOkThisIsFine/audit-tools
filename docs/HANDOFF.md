# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of what is open. Durable
> how-to is in `CLAUDE.md`; per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This is the *sequencing* view — every open item appears once, in suggested order, with a
> pointer to its detail. **Shipped detail is `git log`, never this doc.**

## Live state

- **Current version = `package.json`** (authoritative). v0.34.25 (2026-07-23) shipped the
  **per-packet pause wall** — the LAST open item of the dogfood-resume defect tier. A deep-tier
  packet whose only above-floor pool is PAUSED with a future reset (not exhausted) no longer spins
  the in-process 50ms wait tick until the reset: it strands as the retryable `quota_paused`
  terminal. `packetPoolBlockReason` single-sources the 5-reason (packet,pool) refusal disjunction
  for the `neverDispatchable` strand, the new wall, and both decision records
  (`engine_stranded_packet_pause_wall` added); `wallStrandEarliestResetAtMs` captured at both wall
  sites + cleared at `run()` start closes the getTerminal pause-expiry race and cross-run leak;
  both walls strand-then-emit-then-continue so a decision-sink-reentrant enqueue is dispatched, not
  swept. Review record (codex + agy-gemini-3.6-flash + nim-deepseek-v4-pro — all analytical
  surfaces could-not-refute; codex's MEDIUM reentrancy + LOW reuse findings and NIM's
  under-assertion note all fixed in-lap; the `UND_ERR_HEADERS_TIMEOUT` storm across three NIM
  aliases was diagnosed as the CALLER's transport, not lane health, and the offload helper fixed):
  `docs/reviews/pause-wall-per-packet-strand-2026-07-23.md`.
  v0.34.24 (2026-07-23) shipped the
  **abnormal-exit blocked-step backstop** — every fatal exit of either orchestrator's next-step
  (quota wall, engine maxTransitions abort, parse crash) writes a blocked step naming the cause
  before the error propagates, so a stale current-step.json can never read as a live instruction.
  One shared core (`runWithBlockedStepBackstop` + `writeBlockedStepContract` in
  `audit-tools/shared`), two thin draws; audit's pre-existing blocked sites re-pointed onto the
  shared assembly. Review record (NIM zero refutations; AGY caught the pre-backstop dir-setup
  bypass, fixed; Codex quota-walled):
  `docs/reviews/abnormal-exit-blocked-step-backstop-2026-07-23.md`.
  v0.34.23 (2026-07-23) shipped the
  **worker-kind × pool-class compatibility rule** — operator-declared `burst_limited` on sources +
  the proxy block; ONE predicate (`laneWorkerKindConflict`) refuses agentic lanes on burst-limited
  backends per-lane with reasons (`resolveAmbientSources` + the `collectDispatchableSources`
  chokepoint); `deriveWorkerKind` fixed-kind transports are now override-proof (a `single_shot`
  label on a `claude-worker` lane no longer bypasses safety — AGY review catch); LiteLLM config
  gained same-tier `router_settings.fallbacks`; the live declaration now rides NIM single-shot
  only. Mechanism + review record (AGY caught the override bypass + one-way stamp; NIM/nemotron
  zero refutations; Codex quota-walled): `docs/reviews/worker-kind-pool-class-rule-2026-07-23.md`.
  v0.34.22 (2026-07-23) shipped the
  **dispatch-legibility mechanistic trace** — full constraint-outcome explain records on every
  host grant/refusal (constraints + binding row + attempts trail; `resource_keys[]` on leases),
  `planned` explains on plan-only grants (closes the 144-granted-empty-explains path), and the
  engine decision log (`dispatch-explains.jsonl`, per-pool strand why-nots, stderr fallback so no
  decision vanishes). Mechanism + 4-lane review record:
  `docs/reviews/dispatch-legibility-trace-2026-07-23.md`. v0.34.21 (2026-07-23) shipped the
  **DD-9 intent-equivalence gate + charter dependency-slice layer** — a provenance-only or
  judged-equivalent intent re-confirm no longer re-stales the planning cascade
  (`intent_equivalence_current` obligation; `artifact_metadata.intent_baseline` is the intent
  entry's revision authority), and charter extraction keys on the charter-relevant slice
  (consensus membership + member∪doc file hashes) instead of whole upstream artifacts — including
  blocking transitive propagation across slice-protected edges, which was the live re-fire chain.
  Mechanism record + review history (AGY caught the baseline self-overwrite; Codex refuted two
  slice premises; NIM traced the ordering): `docs/reviews/intent-gate-charter-slice-design-2026-07-23.md`.
  Residuals in backlog (*RESIDUAL of the shipped DD-9…*). ⚠ **Codex CLI is quota-walled until
  2026-07-30** — its lane errors with a usage-limit message; use NIM/AGY + host subagents for
  independent review until then. v0.34.20 (2026-07-23) shipped the
  **zero-spill capability-floor fix** — the floor's "most capable band available" now tracks LIVE
  pool availability instead of a build-time snapshot, so an exhausted best pool no longer strands
  packets while healthy confirmed siblings sit idle (mechanism record:
  `docs/reviews/zero-spill-capability-floor-2026-07-23.md`; independent review codex + NIM/deepseek;
  paused-pool wait-tick residual logged as a backlog LEAD). The same day shipped the **trap-guard
  hook layer** (shell-trap-guard / tool-input-guard / session-start-guards + shared shell-split)
  and a pre-commit-gate hardening pass: subcommand-positional commit detection on quote-collapsed
  text (a substring false-positive ran tree-rewriting round-trips on read-only commands and
  clobbered the live index), round-trip crash journaling + locking, chained-`add && commit`
  gating against the tree that actually lands, and committed-tree-membership for the
  hook-tracking check. ⚠ **Two agent sessions worked this checkout concurrently on 2026-07-23**
  — see memory [[concurrent-sessions-share-the-checkout]] before "recovering" foreign edits.
  v0.34.19 (2026-07-23) shipped the node-context clobber tier
  (`docs/reviews/node-worktree-guard-mechanisms-2026-07-23.md`); v0.34.18 the accept-latch family
  fix (`docs/reviews/accept-latch-family-mechanisms-2026-07-23.md`). v0.34.16 (2026-07-23) landed
  the COMPLETE remediate dogfood run — 8/8 nodes of the 78-finding high slice. **The full
  audit→remediate pipeline has executed end-to-end on a real 78-finding slice** (completion
  record: `docs/reviews/remediate-dogfood-completion-2026-07-23.md`).
- **R3-3 SHIPPED 2026-07-21 (`c0cf7e9b`) — the capability-evidence landing gate is MET.** Autonomous
  runs now emit a host-LLM ranking step for unevidenced pools (authorship tool-derived; submission
  sanitized to `capability_order`; reach never LLM-confirmable; provenance in
  `capability_order_llm_ranked` with operator supersession). Full mechanism + review history:
  [`capability-evidence-salvage-2026-07-20.md`](reviews/capability-evidence-salvage-2026-07-20.md).
- **Trap-guard hook layer shipped 2026-07-23.** Durable traps that are detectable at a tool call are
  now REFUSED there rather than carried as backlog prose: `shell-trap-guard.mjs` (Bash/PowerShell),
  `tool-input-guard.mjs` (Edit/Write/Agent), `session-start-guards.mjs`, plus two new checks in
  `pre-commit-gate.mjs` (`check:doc-manifest` on staged docs — the check that burned v0.33.8 /
  v0.34.4 / v0.34.17 — and a settings.json→untracked-hook block). Gated entries were DELETED from
  backlog *Durable traps*, which now states that policy at its head. Contract tests:
  `tests/shared/hook-trap-guards.test.mjs`. [[trap-guard-hook-layer]]
- **Nightly maintenance routine shipped 2026-07-23 — replaces the cloud doc-review routine.** One
  LOCAL scheduled task (`~/.claude/scheduled-tasks/nightly-maintenance/`, 02:00 daily), three legs:
  docs (leg 1, the old doc-review rubric), backlog disambiguation (mechanical cleanup autonomous,
  real disambiguation escalates), and recurring-problem solutions (memory+backlog → proposed
  mechanisms, propose-only). Surfaces via a self-contained **HTML digest**
  (`.audit-tools/nightly/latest.html`), not a per-conversation table dump. The re-ask loop is fixed
  by a durable **subject-keyed decisions ledger** (`.claude/nightly-decisions.json`, tracked): an
  answer — including "leave it as is" — settles a subject permanently. Old `doc-review-*` hooks +
  the `doc-review` branch machinery deleted. Contract: `docs/nightly-routine.md`. Tests:
  `tests/shared/nightly-routine.test.mjs`. [[nightly-maintenance-routine]] [[doc-review-nag-clear-on-apply]]
  ⚠ **The 11 previously-surfaced doc-review items are not seeded** — tonight's first run regenerates
  them (several repair-proxy-rename items may auto-resolve); DD-9 is already decided in backlog.
- **Loop-core attestation + pre-commit gate hardened 2026-07-21 (`fd7ccab2`).** `--attester-class
  agent|human` is REQUIRED and env-markers are recorded (a self-issued clearance reads as one);
  `concerns` verdicts are destination-keyed (block only on `main`); the sibling-statement
  hooksPath escape is closed. CLAUDE.md no longer claims a human step.
- **Backend-identity migration: all stages shipped** (identity axes, exclusion grammar, capacity
  guard, service-axis autonomous write) as of v0.34.5.

- **Account metering is now WHOLE-DEFECT closed (v0.34.3).** The budget-side explicit-account key was
  transport-split (v0.34.2, `760d0579`) and the COOLDOWN axis was never migrated (v0.34.3, `3dc760f5`).
  Both now key on ONE service-scoped `CapacityPool.accountKey`; `deriveLocalAccountId` is deleted.
  ⚠ The move that unified cooldown without the proxy over-merge was to service-scope
  `deriveAccountKey`'s CREDENTIAL-DERIVED branch too (not just explicit-account) — proxied lanes share
  one proxy credential and must stay split by service. [[account-metering-closed-producer-decides-partition]].
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
  `npm pack --json`. Smokes are fixed, but read `docs/backlog.md` → *Durable traps* before any manual
  `npm install -g` / packaged-install work.
- **Offload lane changed:** `llm-worker-tools` (`llm read`/`llm write`) is RETIRED. Bulk work goes direct
  to the local LiteLLM proxy — see `~/.claude/CLAUDE.md` → *Offload lane*. The proxy must be running;
  there is no standalone fallback. ⚠ **The lane handles judgment work, not just recon.** The standing
  belief that it could not was traced to unset request parameters (no `max_tokens`; a misfitting schema
  under strict decoding) — properly configured it produced review-grade analysis. Check `finish_reason`
  before concluding anything about a model ([[offload-lane-failures-are-usually-the-caller]]).
- **The backlog was fully classified and disambiguated 2026-07-19.** Every open item was verified against
  code rather than its own prose; ~21% were closable and several load-bearing claims were false. Items
  now carry an explicit **SPEC** paragraph stating the agreed mechanism. Treat an entry without one as
  still raw ([[backlog-prose-decays-verify-against-head]]).
- **Project memory was consolidated 2026-07-19** (149 → 135 files; record:
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
- **Loop-core** (`src/shared/dispatch/`, `src/shared/quota/`, `intakeExecutors.ts`, `dispatch.ts`,
  `marshal.ts`, `steps/nextStep.ts`, `costRank.ts`) → green + independent review + attestation required.

---

## ▶ IMMEDIATE NEXT

**1. Build the A2 oracle corpus from small, public, PINNED repos** (owner redirect 2026-07-22 —
full SPEC in backlog *Deferred / waiting*): pinned SHAs + someone-else-maintained defect
inventories give durable labels and measurable RECALL, and turn `score-audit` into a per-release
gate. Hand-labeling the re-dogfood run's findings is demoted to optional large-target calibration.
**The dogfood-resume defect tier is now CLOSED** — every shippable item landed as v0.34.13–v0.34.25
(the pause-wall fix, v0.34.25, was the last). What remains from that tier is not blocking code:
two LEADs (the `window_uncalibrated` out-of-repo-resolver livelock and the openai-compatible-lane
headers-timeout, the latter spun off to its own task) and the **live-validation-gated** items that
only a real metered run can confirm (see the *Live-validation guide* + the ⬇ Live-run watch lines
in backlog).

**2. Gate-0 priority-order UX** (Track 3) — decisions resolved in backlog; implementation remains.
(The doc-review queue has one open item, DD-8 — see the `doc-review` branch.)

---

## Open tracks

**Track 1 — proxy dispatch → now 9router, LiteLLM superseded.** LiteLLM was stood up 2026-07-18
(`~/.audit-code/litellm-config.yaml`). **2026-07-23: replaced by 9router** as the harness-level
multi-provider proxy (fronts Claude/Codex/AGY/Gemini/NIM/Kiro/… + quota failover), deployed and
running (`127.0.0.1:20128`, auto-start task). LiteLLM confirmed **retirable** (9router passes
`json_schema` to NIM). Routing redesign = audit-code categorizes / a re-pointed deterministic router
routes / 9router transports — **design + build plan written, not built.** Full pickup:
[`9router-routing-sprint-handoff-2026-07-23.md`](reviews/9router-routing-sprint-handoff-2026-07-23.md).
(The sprint's files are all landed on `main`, including `examples/configure-9router.mjs`.)

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

**Watch:** `docs/backlog.md` → *Live-validation guide*; each item's ⬇ Live-run watch line is the
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

Everything else open is in [`backlog.md`](backlog.md), which is the per-item detail of record:
*Open bugs / frictions* (fixable defects), *Forward tracks* (design-level directions), *Deferred /
waiting* (blocked on data or environment), *Durable traps* (standing environment reference).

**Verify a queued item's PREMISE against HEAD before opening a lap on it** — a spec's decomposition is a
lead, not a work order ([[grep-the-writers-before-believing-inheritance]]). Backlog prose decays: a
2026-07-19 classification pass found ~21% of entries were already shipped, stale, or describing code
that lives only on an unmerged branch.

⚠ **Deliberate, still current:** autonomous auto-confirm is scoped to the DELTA case only — a first-time
confirmation (no artifact at all) still pauses for the operator even under `autonomous_mode`.

Each lap: pick the next item, **risk-tier it**, ship, reinstall, **full friction walk**, update this
ordering.
