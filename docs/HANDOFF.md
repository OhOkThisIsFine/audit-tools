# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- **Current version = `package.json`** (authoritative). Per-lap shipped detail is NOT narrated here
  (changelog creep — see `git log` + project memory [[live-status]]); this section is current-state +
  open-work roadmap only.
- **The maximal-coverage validation run's dispatch/quota fix cluster, unified-routing collapse, and
  proxy-contract swap all shipped.** The remaining open work is ▶ IMMEDIATE NEXT below (the live-run
  confirmation with the new contract live) + the bounded forward remainder; authoritative per-track status
  is in the Track status section (the older T1–T6 quota-cluster numbering, all closed — not a claim about
  the open dogfood gap, which ▶ IMMEDIATE NEXT owns).
- **Env cruft (harmless):** two empty git-deregistered worktree dirs (`.claude/worktrees/beautiful-euclid-1514e9`,
  and in repair-proxy `repair-proxy-tool-calls-7e075d`) are held by a stale Windows handle — gitignored,
  inert, clear on reboot. Also: `INV-shared-core-14` fails in this shell but identically on `main`
  (pre-existing + env-sensitive; re-proved on a stashed clean HEAD during the G3 A″ lap) — never a branch's doing.
- **Local env note:** the box runs npm 12.0.0 — it blocks dependency install scripts by default and can
  emit object-shaped `npm pack --json`; smokes are fixed, but see `docs/backlog.md` → Durable traps
  before any manual `npm install -g` / packaged-install work.
- **⚠️ Stale-worktree trap:** ALWAYS `git fetch audit-tools main && git log HEAD..audit-tools/main` before
  starting a lap — a worktree can branch behind main and must fast-forward + re-read HANDOFF/backlog first.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial contract pipeline only
  for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
  gate → ship). **Tool-enforced**, not a host workaround: the lean path is taken automatically when the
  effective risk tier is `low` via the risk-tier → Dial A/B continuum fold (`findingRiskEvidence` in
  `src/remediate/riskSignal.ts`); accepted residue in `docs/backlog.md`.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog + `open_observations`.
  **Mechanically backstopped**: step-boundary capture + an in-run blocking per-category close-out gate +
  a session-end Stop-hook (`.claude/hooks/friction-stop-gate.mjs`); accepted residue (hand-fix laps that
  never invoke an orchestrator) in `docs/backlog.md`.
- **Release:** `npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump.
  Run `npm run verify:release` locally before tagging (local pre-tag gate is only `check`).
  CI gate is split for speed: `verify:release` = `verify:checks` (cheap deterministic chain) + vitest;
  `ci.yml` runs the cheap chain only, `audit-code-test-suite.yml` owns the vitest suite once per Node line
  (20 + 22, each sharded 4 ways) with a release-bump skip guard, and `publish-package.yml` runs the
  authoritative release-time gate (`verify:checks` + a 4-way sharded vitest matrix). vitest was ~93% of the
  old serial gate → sharding is the only lever that moved release latency. No open per-push redundancy.
- **Branch-strand trap (bit twice already):** a remediation run leaves you checked out on its
  worktree branch — commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit
  strands off main.
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code
  implement node** — the tool's dispatch plan already names the correct worktree; a second isolation
  worktree strands the subagent's edits where `accept-node` can't see them. See backlog → durable traps.

---

## ▶ IMMEDIATE NEXT (a) — account-metering: ROUND 2 REFUSED 3/3, one owner call before any code

**On `wip/capability-evidence` at `e500672f`, NOT on main. Round 2 was REFUSED by all three independent
lenses (2026-07-19) — round 4 of refusals on this defect.** The underlying bug is real (N models on one
credential metered as N budgets/caps/cooldowns ⇒ ~N× over-admission); the fix is not correct.
Full record: [`account-metering-round2-independent-review-2026-07-19.md`](reviews/account-metering-round2-independent-review-2026-07-19.md).
Defect statement + author's own account: [`nim-dispatch-single-pool-2026-07-19.md`](reviews/nim-dispatch-single-pool-2026-07-19.md).

**⛔ OWNER CALL, gates all further code — the budget axis.** The lease key moved to account scope
(`resourceKey: pool.account_key`) but the budget operand did not (`budget: pool.remaining_token_budget`)
— `admissionLoop.ts:239-241`, `rollingDispatch.ts:1005-1011`, `unifiedRolling.ts:99`. Executed at
`e500672f`: two pools on one account (budgets 1000/200), 20 packets → **10 granted, all on the big pool,
the small pool starved to 0.** The effective ceiling becomes the MAX sibling budget, and drops to
unenforced entirely when any sibling is uncalibrated (null → `+Infinity`). **This is not a partial fix,
it is a new starvation bug.** Either the budget becomes account-scoped (needs an account-level
`tokens_per_pct`; today it is per-pool and explicitly excluded from the fold, `accountId.ts:104-107`) or
the lease key returns to pool scope. Decide before touching code.

⚠ The reviewers noted this is **the author's own rejection argument, verbatim** — `admissionLoop.ts:624-628`
rejects a per-account cap because it would make the ceiling "the MAX cap across an account's pools
rather than any real limit, permanently starving its lowest-cap pool." That is why the cap change was
reverted; the identical flaw shipped on the budget axis.

**Also blocking:** the motivating `nim-nano`/`nim-super` case is **still unfixed** for the inline
`api_key` shape (`accountId.ts:37` requires `api_key_env`; `api_key` is a supported field
`openAiCompatibleSource` copies) — third consecutive round where this case was claimed fixed and was
not. And the `concurrency_cap` revert rests on a TRUE contract claim but a non-sequitur conclusion:
enforcement keys on `poolId`, so two models declaring `max_concurrent: 2` on one endpoint admit 4.

⚠ **The pinning gate is not admissible as evidence yet.** `assert-sites-pinned.mjs` measures "the suite
went red", not "a test asserting THIS behavior went red" — renaming an export so importers crash yields
`71 failed` and it reports `PINNED`. Its spec is also a hand-written subset (7 declared, ≥11 substantive
hunks), and the two hunks that are the fix's core claim (`capacity.ts:725`, `apiPool.ts:276`) sit outside
it and survive reversion with `tsc` clean and the suite byte-identical. Bind it to expected-failing test
NAMES and derive the spec from the diff before citing it again.

**The attestation on `e500672f` is `verdict=concerns` with an explicit override — a preservation record,
never a sign-off.** ⚠ Its "sole failure" claim was **wrong**: a clean-worktree run measured TWO
pre-existing failures (`linux-cycle-regression.test.mjs` unmentioned alongside `INV-shared-core-14`).
Env-sensitive, but the claim was made by stopping at the first explanation that fit — resolve "N failed"
to N names, not one.

Same lap, no code change needed: the capability ranker's PRODUCER now exists (NIM roster joined to
OpenRouter `agentic_index` → LiteLLM `model_info.capability_rank` → the seam `proxyCatalog.ts:159`
already ingests), and codex/agy quota is reachable as CLI-agentic declared sources. **LiteLLM cannot
front codex/agy** (CLI agents are their own harnesses — no endpoint to proxy), and Codex-subscription-
off-CLI stays ruled out on ToS per the owner's standing 2026-07-14 decision.

**Still not done:** the audit wave through the proxy. Configuration is now correct for it.

## ▶ IMMEDIATE NEXT (b) — implement the capability-evidence obligation (plan ready, ONE owner call open)

**IN FLIGHT, REVIEW-BLOCKED after THREE review rounds — on branch `wip/capability-evidence` (pushed,
HEAD `e500672f`), NOT on main.** The tree is green (build + check + `check:deadcode`;
`tests/audit`+`tests/shared` 4651 passed, the single failure resolved by name to `INV-shared-core-14`
and proven pre-existing on clean HEAD).
**Green is not the blocker and never was.** Round 3 ran three INDEPENDENT adversarial lenses and all
three refused sign-off; five of their six defects are now closed. Do not land it, and do not
re-implement it from the plan — read the implementation review first:
[`docs/reviews/capability-evidence-implementation-review-2026-07-18.md`](reviews/capability-evidence-implementation-review-2026-07-18.md).
It records what is confirmed correct, every round's defects, the owner decisions, and the durable
lesson — which round 3 proved twice over: fixing the named instance is not fixing the defect class.
Round 3's critical find was that **the change did not achieve its own purpose in the default
configuration** (the rank join walked three arrays while the evidence obligation walked two, so the
conversation-first host pool was unranked, never asked about, and failing open forever). The
round-3 fixes therefore SINGLE-SOURCE their walks instead of adding a third correct copy.

**Three things block landing, in order:** (a) **R3-3** — route the headless promotion through an LLM
ranker (owner decision 2026-07-19); until it lands the obligation never converges on the headless
path. (b) a test for **`marshal.ts`'s rank stamping** — the live fail-open this whole sprint exists
to close, currently invisible to the suite (reverting one line breaks nothing). (c) **producer-seam
tests** for `admissionPoolsFromSummaries`/`parseCooldownMs` and `cmdNextStep`'s anchor wiring, then a
**fourth independent review**. Detail: backlog entry, properties (5)–(7).

**Owner decisions (settled, do not re-litigate):** injection at the `apiPool.ts` CapacityPool
constructors, not `admissionLoop`; the host pool is not a special case; headless unrankable models go
to an **LLM ranker** (not a recorded fail-open) with LLM provenance kept out of the operator's raw
`capability_order`; an active cooldown grants **one**, matching `scheduler.ts`.

Plan, written and adversarially reviewed:
[`docs/reviews/capability-evidence-obligation-plan-2026-07-18.md`](reviews/capability-evidence-obligation-plan-2026-07-18.md)
(v2 + owner clarification — the review REFUTED three v1 claims; read it, not a summary).

**The scope question that briefly blocked this is WITHDRAWN (owner, 2026-07-18):** because the gate
FORCES every pool to be pinned, there is no unranked pool at dispatch time, so the fail-open branch stops
being the operative path. With all pools scored, `FLOOR_MAX_BAND.standard = 1` excludes the bottom tercile
from `standard` as well as `deep` — a weak pool is pushed down to `small` work by ELIGIBILITY, no ordering
change needed. Most of what v2 called out-of-scope arrives as a consequence of this plan.

**Deferred residue, NOT forgotten:** banding is **relative** — `band <= Math.max(FLOOR_MAX_BAND[tier],
bestAvailableBand)` admits the best available pool however bad it is. If every pool is weak, `deep` work
still goes to the least-weak one. Forcing rankings guarantees the ORDERING, not that anyone is good
enough. Whether an ABSOLUTE floor is wanted needs live data from a ranked run first.

**Owner decisions taken 2026-07-18** (these are settled, do not re-litigate): (1) fix the composition
BEFORE re-dogfooding; (2) a pool with no capability evidence must be **pinned down** by LLM judgment or by
asking the operator — never silently routed around; (3) build a ranker via **OpenRouter**.

**Loop-core** (`src/shared/dispatch/`) → green + independent review + attestation required. The v2 plan
deliberately keeps `bandOf`/banding logic byte-identical to shrink that surface to data plumbing.

**Then, in order:** (2) the ranker — OpenRouter `/api/v1/models` runtime-fetch →
LiteLLM `model_info`, which `proxyCatalog.ts:159` already ingests, so **zero audit-tools code change**
(survey: [`docs/model-capability-ranking-sources.md`](model-capability-ranking-sources.md); the scores are
Artificial Analysis data and AA forbids redistribution, so runtime-fetch is the pattern, NOT a vendored
snapshot — and the sign inverts, `agentic_index` is higher-better while `capability_rank` is lower-better);
(3) re-dogfood a conversation-first self-audit through the live proxy — validates both of the above plus
Track 1's leftovers (dispatch under a real wave, quota at the proxy); (4) Track 3 Gate-0 priority-order UX
(two named owner calls — see backlog).

---

### Prior context — the three-track forward (Track 1 now closed)

**The unified-routing collapse + repair-proxy retirement are COMPLETE (2026-07-18).** v0.33.7 shipped with the brand-neutral proxy contract (`proxyCatalog.ts` adapter for discovery + liveness probe; generic `proxy` block replaces legacy `repair_proxy`; CI green, published).

**Track 1 — Deploy LiteLLM, validate the proxy swap live — ✅ DONE 2026-07-18.**
LiteLLM 1.91.1 stood up on `127.0.0.1:4000` fronting NVIDIA NIM (9 aliases across tiers); all five
deliverables (roster discovery, `/model/info` enrichment + its degrade path, liveness, auth threading,
verbatim `--model` routing) validated against the live proxy. One defect found and fixed: the proxy lane
accepted an `api_key_env` but never reach-verified it, so an unset key surfaced as a misleading
"run the populate" instead of naming the variable. Record:
[`docs/reviews/litellm-proxy-live-validation-2026-07-18.md`](reviews/litellm-proxy-live-validation-2026-07-18.md).
Config at `~/.audit-code/litellm-config.yaml`; the machine declaration was migrated off the retired
`repair_proxy` key. **Remaining on this track:** dispatch through the proxy under a real audit wave, and
quota behavior at the proxy — both belong to the re-dogfood below, which this now unblocks.

**Track 2 — Ranker contract (separate project, not audit-tools code):**
Design the contract: what a model ranker PRODUCES and where audit-tools READS it. Natural home: alongside `~/.audit-code/sources-declared.json`, a machine-level file keyed by pool identity `backend_provider[#account]/model` with `rank` and `tier` optional per model. audit-tools consumes it if present (none of its routing code changes if the ranker isn't running). Property to hold: audit-tools stays agnostic — swapping the ranker, or having no ranker, changes zero audit-tools code.

**Track 3 — Ranking-absent fallback: Gate-0 operator-confirmed priority order (Gate-0 UX enhancement):**
Gate-0 already persists a `cost_order` from operator input + has all dispatch wiring to honor it. What's missing: when NO EXTERNAL RANKS exist, Gate-0 should surface a **fallback priority order** (default: tier-based: frontier > capable > fast > unknown) and explicitly show the operator that `cost_order` is their **DISPATCH PRIORITY** (not inclusion; that's `exclude[]`/`include[]`). Operator can accept the suggested order, reorder it manually, or exclude pools — all persist to the shared confirmation. Make dispatch routing explicit about the ordering-vs-exclusion distinction, and name any design question as an owner call rather than deciding it yourself.

**Ordering superseded 2026-07-18** — see ▶ IMMEDIATE NEXT above, which owner decisions re-sequenced.
Track 2's "design the contract" framing is also superseded: the consuming seam already exists
(`proxyCatalog.ts:159` ingests `capability_rank` from `/model/info`, and LiteLLM permits arbitrary
`model_info` keys), so the remaining work is producing the numbers, not designing where they land.
See `docs/backlog.md` → *Open tracks* for detail.

## Prior track — the G-series (closed)

**The G-series is DONE as a sequence. G4/G5/G6 are closed or dissolved — do not open them as laps.**
The 2026-07-16 lap (`d1065655`) reframed the whole remainder by asking why dispatch was forked at all:

- **The dispatch ENGINE was already shared** (`driveRolling`, rolling engine, capacity, admission,
  scheduler, `estimateTokensFromBytes`, `buildHostModelPools`). Only the ASSEMBLY wrapper was forked, and
  it is now single-sourced in `src/shared/quota/hostPool.ts`; both local preambles are deleted.
- **G6 is HALF closed — and the open half is the one that matters for policy.** Its *descriptor* half is
  done, and its shape was wrong: "wire `--auditor` into remediate too" accepts the fork. The descriptor
  splits along a verified line — environment-class resolves in-process, host-self-class is unknowable to a
  spawned CLI — so remediate's pool came back via `ambientAuditorDescriptor()` + `loadRemediateSessionConfig`,
  no flag round-trip. **That fixed an un-released REGRESSION**: from G2 until that lap remediate dispatched
  with NO pool at all. **⚠ The READ-PATH half is still open and was deliberately NOT touched:** audit reads
  `<artifactsDir>/session-config.json`, remediate reads
  `<root>/.remediation-artifacts/session-config.json ?? <root>/session-config.json` — still **disjoint**
  (preserved verbatim behind `loadRemediateSessionConfig`'s `artifactsFirst`, since unifying them silently
  would change which config a run reads). **So policy still rides the confirmation artifact, exactly as the
  spec's phasing says** — the intent-carried endpoint remains blocked. That unification is the real G6.
- **G4 is CLOSED as not-implemented** — premise refuted across three passes (nothing WRITES
  `quota`/`block_quota`; `model_id` is opaque-by-design, not a peer of `host_model`). What remains is a
  judgment call, NOT a task: `block_quota.host_model` is an operator hint that persists into a run driven by
  a different auditor. **Owner call** — [`docs/reviews/g4-g5-g6-premise-check-2026-07-16.md`](reviews/g4-g5-g6-premise-check-2026-07-16.md).
- **G5 is DOWN to one clause** (the lies-reachably quarantine); the other two are shipped (G2.5) or dead
  (the auditor-id stamp is a write-only field whose premise G2.5 disproved). Backlog-tracked.

**Commit 3 SHIPPED 2026-07-16** (repair-proxy as a kind-1 launch-transport — 3a `9f4cf8f1`, 3b `dd47e8da`,
3c `860920c1`) and was dogfooded the same day; see ▶ IMMEDIATE NEXT above for current status. Design of
record: [`spec/unified-dispatch-worker-model.md`](../spec/unified-dispatch-worker-model.md) (memory
[[unified-dispatch-worker-model]]).

Also open, each on its own merits (detail in [`backlog.md`](backlog.md)): **G6 read-path unification** (the
half above — it unphases policy's home onto the intent); **G5's one surviving clause** (lies-reachably
quarantine); **commit 4** fix C (host cold-start wall, needs a clean minimal repro); **commit 5** decide kind-3's fate.


**Verify a queued item's PREMISE against HEAD before opening a lap on it** — a spec's decomposition is a
lead, not a work order ([[grep-the-writers-before-believing-inheritance]]). Records:
[`dispatch-fork-assessment-2026-07-16.md`](reviews/dispatch-fork-assessment-2026-07-16.md) ·
[`g4-g5-g6-premise-check-2026-07-16.md`](reviews/g4-g5-g6-premise-check-2026-07-16.md).

**⚠ Deliberate, still current:** autonomous auto-confirm is scoped to the DELTA case only — a first-time
confirmation (no artifact at all) still pauses for the operator even under `autonomous_mode`.

**The G-series RELEASED as v0.33.0 (2026-07-16), global bins reinstalled.** Breaking transport recap for
any stale environment: the audit CLI's `--host-*` capability flags are GONE (one `--auditor <json>`
descriptor replaces them) and a repo `session-config.json` can no longer carry `provider`/`sources`/backend
blocks (rejected at load). A pre-G1 global bin silently ignores the new handshake — reinstall before
dogfooding.

### Release gate — the durable lesson

`ci` and `audit-code-test-suite` were red for ~a dozen laps while every lap reported "green": the
pre-commit hook gates only `npm run check`, and laps verified with build + check + vitest — none of which
include `verify:checks`. **End every lap by checking CI on main** (the generic `gh run list` endpoint has
been flaky; the per-workflow endpoint `gh api "repos/…/actions/workflows/<wf>.yml/runs?per_page=3"` always
worked), and run `npm run verify:release` before any "this is shippable" claim
([[lap-green-must-match-ci-evidence]]). Corollary from the v0.33.0 lap: a local full-suite run with "N
failed" must be resolved to NAMED files before attributing it to the known-flaky baseline — one of the
"baseline" failures was a real regression CI caught in shard 4/4.

**G3+ is loop-core** (`intakeExecutors.ts`, `dispatch.ts`, `marshal.ts`, `steps/nextStep.ts`,
`costRank.ts`, **`src/shared/quota/`**) → green + independent review + attestation required.

Design of record: **[`spec/unified-dispatch-worker-model.md`](../spec/unified-dispatch-worker-model.md)**
(memory [[unified-dispatch-worker-model]]) — now a purely timeless concept doc. Its per-commit
Decomposition (pinned SHAs, `[SHIPPED]` markers, the A′/A″ narrative) was RETIRED: a build sequence with
status markers is a plan-of-record living in a concept doc, and it is what made a stale plan read as a work
order for a dozen laps. **Shipped detail is `git log`; open sequencing is THIS doc; per-item detail is
`backlog.md`.** Per-step plan docs (dated records, with their refuted drafts) remain in
`docs/reviews/g{1,2,2-5,3}-*.md` and are registered as excluded in the routing table.

**Offload lanes (as of the G3 session):** the free `llm read` lane works (zero Claude-read cost for recon).
`llm write`/NIM completion + `ANTHROPIC_BASE_URL` subagent-fronting are UNRETESTED. Mechanical bulk offloads
cleanly to **Haiku subagents** (parent orchestrates + verifies green + independent review) — but ALWAYS
review offloaded test diffs for assertion QUALITY, not just green (a Haiku agent once weakened a test to an
incidental TypeError). Fastest full unblock: point `ANTHROPIC_BASE_URL` at the declared `proxy` block on a
free model.

## Older track — bounded quota-cluster remainder (secondary, not blocking the rework)

1. **Low residuals:** doc-review auto-apply re-asserting a resolved decision after a process restart; the
   two A2b residuals; untracked-exclusion residuals (a–e). All in `docs/backlog.md` → Open bugs.

**Confirming re-run (verification track, not blocking the remainder):** re-run the maximal-coverage audit
on a fresh Claude window to confirm the shipped fixes hold live — the earlier parked runs cannot be
resumed usefully (their capacity pools froze at creation, pre-probe-fix), so a fresh run is required —
then hand-label `corpus/<run-id>.labels.json` (the A2 oracle unblock). Recipe below.

<details><summary>Reusable launch recipe for the maximal-coverage validation run</summary>

**Where.** A Claude Code conversation opened at the **primary `C:\Code\audit-tools` checkout, branch
`main`, clean tree — never a lap worktree** (slash workflows run the GLOBAL bin, so worktree state is
irrelevant anyway, but scratch/artifacts must land on main's tree). Verify the global bins are current
first (`audit-code --version` == `package.json` on main; reinstall per the Durable-traps npm-12 notes if
not). Target repo: audit-tools itself is fine and has a **pending clean self-audit re-run** on record
(the charter-fix dogfood run paused before ever reaching the dispatch/quota watches); if a genuinely
LARGER metered target is available, prefer it — **size is what forces the quota wall**; a small target
never exhausts a window and validates none of the wall items. On audit-tools, compensate with a deep
ceiling so the frontier is large.

**Configure (before launch).** Source pools are declared **off-repo** now (G2 removed `sources` /
`provider` / per-backend blocks from the session config; G2.5 resolves them from a machine-level
declaration). Write `~/.audit-code/sources-declared.json` — start from
`examples/catalog/sources-declared.json`:
1. A NIM entry — operator-supplied `endpoint` / `model` / `api_key_env` (never hardcoded). Exercises the
   openai-compatible dispatch pool + CE-004 first-emit conformance.
2. The **opencode-free** entry (`cost_per_mtok: 0`, `api_key_env: OPENCODE_ZEN_API_KEY=public`).
   Exercises arbitrage Phase-0: declared-free routing + the `declared_cost_drift` demotion if the free
   tier ever bills.
3. Codex needs nothing — the CLI is auto-detected. No `--root`/provider/model flags anywhere
   (conversation-first; a needed manual flag is a bug — report it, don't work around it).

⚠ **Export the key env vars in the shell that launches the IDE.** G2.5 admits a lane only if the
audit-tools process can PROVE reach — an `api_key_env` pointing at an unset var is dropped with a reason,
by design. If a pool is missing from Gate-0, that is the mechanism working; check the env, not the config.

**Launch.** `/audit-code` in the conversation. At the interactive Gate-0 `provider_confirmation`,
confirm the priced roster shows **host + codex + NIM + opencode-free**; accept the proposed lens set;
pick a deep ceiling. Then let it run — **do not rescue it at the wall; the failure modes ARE the data.**
Resume after the quota window resets.

**Mid-run, optional but uniquely valuable:** open a **second IDE session** on the same repo mid-wave and
start a step. That is the only live check for the just-shipped lease-TTL fix ([[host-path-quota-enforcement]])
and the multi-IDE concurrent-admitter model: the second admitter must see the account's cap still held
(no double-grant) while the first wave is in flight.

**Watch:** see `docs/backlog.md` → Live-validation guide — each item's ⬇ Live-run watch line is the
authoritative pass/fail.

**Fail-signal protocol:** any wedge needing `force-synthesis`, crash at the wall, orphaned `deepening:*`
tasks, silently-skipped analyzer, or missing friction event → one line under backlog *Open bugs* before
moving on.

**After the run:** hand-label the findings into `corpus/<run-id>.labels.json` — one labeled run is the
only thing blocking the A2 finding-quality oracle (backlog → Deferred / waiting).

**What this run can NOT cover** (separate, lower priority): clippy/rubocop live spawn (needs a Rust/Ruby
repo + toolchain — none on this box); Copilot/Antigravity quota endpoints (need those IDEs running); the
gated e2es (`RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`, `AUDIT_TOOLS_LIVE_QUOTA=1` — creds + env vars,
runnable any time).

</details>

---

## Suggested ordering — everything else open, sequenced

**Agent laps — the forward remainder is the IMMEDIATE NEXT list above.** Residuals from earlier shipped
fixes (M-B3/`judge_report` self-check, audit worker scratch pollution) live under `docs/backlog.md` →
Open bugs.

**WAITING (gated, not next): D-66/67 slice-3** (heartbeat / merge-time ownership-gate CHECK on the
LONG-lived execution claims — `task-claims.json` 20-min lease, remediate node-claims; FOCUSED-LAP,
delicate, **live-run-gated** — only pursue if a real cooperative run shows the staleMs-wide probe window
from slice-1 actually bites; the second-IDE check above is exactly the run that could show it). Fold the
`phase:main` layer-2 asymmetry (slice-1 input) into its design; the lease-TTL lap's ledger-spin follow-up
(backlog → Open bugs) also folds in here. See the D-66/67 roadmap entry in `docs/backlog.md`.

**D-66/67 — only slice-3 remains open** (above); the rest is closed and should not be reopened
([[rolling-lifecycle-unify-full-unification-wrong]] governs: full unification is the WRONG endpoint).
Residuals: `docs/backlog.md` → "Unify the full rolling-dispatch lifecycle shell".

**External-audit program — only low-severity residuals remain** (`docs/backlog.md` → *Open bugs*,
"External shared-logic audit … residuals").

Rationale for the ordering: the **loop is the meta-tool**; making it cheaper, convergent, and safe has
compounding leverage on all downstream work ([[autonomous-pipeline-capstone-spec]]). With the code tracks
closed, the live-validation run above IS the current loop-improvement work — it gates "redesign before
scheduled autonomy" advancing to the scheduled audit→remediate→PR capstone.

### Track status — what is still OPEN (pointers only; detail in `docs/backlog.md`)
- **T1–T3 loop infra:** nothing open.
- **T4 host-friction inventory:** live validation only (part of the run above).
- **T5 forward tracks:** live validation of admission control (+ deeper within-turn simultaneity, only if
  the run shows alternation is the bottleneck); clippy/rubocop live spawn (needs a Rust/Ruby target). CE-004
  is provider-blocked (the claude-code host has no constraint endpoint — not a defect).
- **T6 deferred / waiting:** A2 oracle (unblocked by labeling the run above); A7 manual GUI checklists
  (Antigravity/OpenCode); provider `queryLimits`; narrow prose-staleness; Copilot/Antigravity quota
  endpoint confirmation. Full detail in `docs/backlog.md` → "Deferred / waiting".

### Forward tracks — provider/dispatch design (lower priority, backlog-tracked, not IMMEDIATE NEXT)
- **NIM (openai-compatible) auto-detection** — NIM only appears in the pool with explicit `openai_compatible`/`sources[]` config; make it auto-appear (`docs/backlog.md` → Open bugs, [[nim-not-auto-detected]]).
- **Quota-before-cost ordering** — Gate-0 `suggestCostOrdering()` sorts by $/Mtok only; demote/flag quota-saturated pools (`docs/backlog.md` → Open bugs, [[quota-before-cost-ordering]]).
- **Per-model/effort tiering** — `capabilityTier` is per-provider, wrong granularity for multi-model backends; tier per `(provider, model, effort)` (`docs/backlog.md` → Open bugs, [[per-model-tiering]]).
- **Relax dispatch source-forcing** — dispatch pre-binds nodes to pools up-front; move to pool-agnostic claims + JIT quota reservation (`docs/backlog.md` → Open bugs, [[relax-dispatch-source-forcing]]).

---

Each lap: pick the next item, **risk-tier it** (friction/ergonomic items → lean; anything touching the loop
core → full pipeline), ship, reinstall, **full friction walk**, update this ordering.
