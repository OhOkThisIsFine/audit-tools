# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of what is open. Durable
> how-to is in `CLAUDE.md`; per-item detail in the split backlog [`docs/backlog/`](backlog/); durable design in
> `spec/`. This is the *sequencing* view — every open item appears once, in suggested order, with a
> pointer to its detail. The roadmap list is **generated** from the backlog
> (`scripts/shared/generate-handoff-roadmap.mjs`), so an item's text has exactly one home and the two
> cannot drift. **Shipped detail is `git log`, never this doc.**

## Live state

- **▶ NEXT: work the actionable backlog queue.** Start from the triage
  ([`backlog-triage-2026-07-25.md`](reviews/backlog-triage-2026-07-25.md)) — every open entry classified,
  regenerate with `node scripts/shared/triage-backlog.mjs`. Then use the SEEK INDEX in
  [`backlog.md`](backlog.md): each entry carries a `file:line` anchor, so read the index once and jump
  with an offset read instead of paging the file blind.
  ⚠ **The triage's verdicts are ADVISORY.** The lane over-flags `owner_decision_needed` (its hedge is
  "schedule a discussion"), and it cannot check HEAD — the 2026-07-25 lap opened three entries whose
  premise was already fixed. Verify a premise before working it
  ([[backlog-prose-decays-verify-against-head]]).

- **⚠ Every owner call in the backlog is ANSWERED, recorded in the entry that owns it — do not re-ask.**
  Nightly-queue determinations live in `.claude/nightly-decisions.json`, settled by SUBJECT so they are
  never re-raised; `node scripts/nightly/answer.mjs --list` shows what is genuinely still open.
  Two remain owner-OWNED and no lap can close them: the **A7 GUI host checklist** (a human at
  Antigravity / OpenCode / VS Code) and the **dogfood run** below.
  ⚠ Two decision traps to read before building: the per-site pinning gate's diff-derived site list does
  NOT solve its second property (expected-failing test names are still author-supplied, so a naive build
  relocates the claim instead of removing it); and contract-pipeline (b) narrows the
  whole-artifact-rewrite invariant, so it must be scoped to rejections naming specific fields.

- **The dogfood self-audit is the OWNER's, in a separate conversation, after the code fixes land.**
  ~22 `⬇ LIVE-run watch` entries are blocked only on evidence from it. A lap lands what it can WITHOUT
  the run and must not start one: a commit mid-run re-stales the planning chain and regresses it to
  `charter_extraction`. Recipe is in the collapsed section below.

- **⚠ `reviewed_clean` is a hard contract on every zero-finding `AuditResult`.** An empty `findings`
  array is REFUSED unless the result also sets `reviewed_clean: true`, and the flag is refused ALONGSIDE
  findings. A worker or fixture written against the older contract fails validation — that is the gate,
  not a regression. A contract sweep must therefore grep the TYPE across the whole repo: the
  `reviewed_clean` sweep globbed `tests/**`, went green four ways locally, and failed release CI on two
  producers in `scripts/`.

- **⚠ The per-node token estimate is WIRED and has NO live evidence yet.** It is the first change that
  makes the `no_capable_pool` resumable pause reachable in real use. On the next real frontier an
  unplaceable node must reach a RESUMABLE pause naming the real cause — never `empty_pool`, never a
  terminal strand. A large node that now refuses everywhere is the honest estimate working; check the
  pool's declared `context_tokens` before calling it a regression.

- **⚠ Regenerating the price snapshot INVERTS host tier cost order — still live.** `npm run update-models`
  rewrites the flat table, whose entry for a colliding id is the CHEAPEST across providers by
  construction, so `claude-opus-4-8` ranks below haiku and cost-first routing at λ=0 sends every packet
  to Opus. The service→vendor-id mapping is a PREREQUISITE, not a follow-up. Do NOT "fix" it by editing
  `cost-rank.test.mjs`'s expectations — they encode real list prices and are what caught it.

- **A2 oracle corpus is UNPARKED** (superseding the earlier park) — funded as the mechanical answer to
  per-lane result quality. Corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs.
  SPEC in [`deferred.md`](backlog/deferred.md).

- **Current version = `package.json`** (authoritative): v0.34.32, live on npm; main is released to HEAD
  with nothing pending.

**Per-release shipped detail is `git log` and the `docs/reviews/` records — deliberately not restated
here.** This section had twice grown into version-by-version narration, which is the changelog creep this
doc's own header forbids. Durable traps belong in
[`durable-traps.md`](backlog/durable-traps.md), durable design in project memory, durable how-to in
`CLAUDE.md` — if a bullet here is none of those three and is not the immediate next step, delete it.

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
  laps while every lap reported "green": the pre-commit hook gates `npm run check` (plus
  `test:doc-contract` / `check:doc-manifest` when the staged set touches docs), and laps
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
- **G-series — closed as a sequence.** Do not reopen G4/G5/G6 as laps. Two slivers survive on their
  own merits and are backlog-tracked (the G6 read-path unification and G5's lies-reachably
  quarantine); they appear in the roadmap below like any other entry. Records:
  [`dispatch-fork-assessment-2026-07-16.md`](reviews/dispatch-fork-assessment-2026-07-16.md) ·
  [`g4-g5-g6-premise-check-2026-07-16.md`](reviews/g4-g5-g6-premise-check-2026-07-16.md).
- **Backlog budget: the FILE total is a shrink-only ratchet; per-entry is a plain budget.** The
  per-entry ratchet was retired — it taxed correctness, refusing a verified factual fix for costing 14
  bytes. An entry may now grow provided its file shrinks. `node scripts/check-backlog-budget.mjs` has
  the live figures (UTF-8 BYTES — agrees with `wc -c`); never hand-carry a size into a doc. Run
  `--update-baseline` only at the END of a lap, and only after entries were CLOSED. ⚠ Never run it to
  make a GROWN file pass — that raises the ceiling, which is the one thing the gate exists to prevent.
  Pay for a new entry by condensing another.

---

## ▶ Roadmap — every open item, in order

**Owner redirect 2026-07-23: stabilize audit-tools before A2.** The active track is
**runtime-loop defects**, not the A2 oracle corpus — A2 is PARKED under *Deferred / waiting* below,
its SPEC intact.

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> **Order = the entry's position in its backlog file.** Re-prioritise by MOVING the entry, never
> by re-wording this list; prefix a title with `▶` in the backlog to pin it to *Next up*.
> [`durable-traps.md`](backlog/durable-traps.md) is excluded on purpose — standing reference, not work.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 104 open item(s).

### ▶ Next up — pinned in the backlog

- ▶ ⬇ LIVE-run watch ONLY — the per-node token estimate is WIRED (2026-07-25, loop-core). · [`open-bugs.md`](backlog/open-bugs.md)

### Open bugs & frictions — the working queue

- A contract change swept `tests/` and missed the PRODUCERS in `scripts/` — caught only by CI (2026-07-25, medium, friction: inefficient-feeding). · [`open-bugs.md`](backlog/open-bugs.md)
- Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (2026-07-23, low, surfaced reviewing the shipped DEFECT-2 design-review object envelope): a `json_object` worker that adds a SIBLING key beside `findings` is quarantined, not unwrapped. · [`open-bugs.md`](backlog/open-bugs.md)
- CLI-worker write-scope — four accepted residuals of the SHIPPED review-snapshot worktree (2026-07-22, low, revisit on live evidence only). · [`open-bugs.md`](backlog/open-bugs.md)
- FLW-COR-003 claim-release livelock — SHIPPED except one low residual (2026-07-22; downgraded from HIGH after a 2026-07-24 code trace). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (2026-07-23, low, surfaced by the shipped worker-kind × pool-class rule): a `burst_limited` proxy contributes NOTHING — populate/expansion should emit single-shot lanes instead of agentic ones that all drop. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood 2026-07-22, medium, LEAD — mechanism RESTATED 2026-07-24 after a HEAD trace): a lane can return success-shaped EMPTY results and nothing in routing notices. · [`open-bugs.md`](backlog/open-bugs.md)
- RESIDUAL of the shipped DD-9 + charter slice-staleness pair (2026-07-23, low, accepted — revisit on live evidence). · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood 2026-07-22, low): a json_schema-required array elicits FILLER entries from weaker models when the true answer is empty. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it. · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (2026-07-22, low): does remediate's node-claim lifecycle share the merge-only-release defect the audit side just fixed? · [`open-bugs.md`](backlog/open-bugs.md)
- Regenerating the price snapshot INVERTS host tier cost order — the refresh is blocked on the service→vendor-id mapping, not merely followed by it (2026-07-24, medium, ATTEMPTED AND REVERTED). · [`open-bugs.md`](backlog/open-bugs.md)
- Stale agent worktrees are never pruned (2026-07-24, low, friction: tool-should-decide). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (low): NIM roster latency is bimodal — a slow model can read as a DEAD lane. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE-CONFIRMED (re-dogfood 2026-07-21): the proxy-lane drop reason names an internal function, and no populate command exists (medium, friction: tool-should-decide). · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood): token_usage stamping asks for a split real harnesses cannot supply (2026-07-21, low). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low). · [`open-bugs.md`](backlog/open-bugs.md)
- SPEC — delete inline `api_key` support; a credential must be named, never pasted. · [`open-bugs.md`](backlog/open-bugs.md)
- Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19). · [`open-bugs.md`](backlog/open-bugs.md)
- Window-scope validation at the PRODUCER boundary — designed for step 2, deferred with reason (2026-07-19). · [`open-bugs.md`](backlog/open-bugs.md)
- A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main. · [`open-bugs.md`](backlog/open-bugs.md)
- SPEC — the proxy catalog's freshness rule gates the WRITE but not the READ, and the lane has no operator-runnable refresh. · [`open-bugs.md`](backlog/open-bugs.md)
- Ranked-pool composition — live-wave watch + the absolute-floor question (mechanism shipped R3-3 `c0cf7e9b` 2026-07-21; residue only). · [`open-bugs.md`](backlog/open-bugs.md)
- H2+H4 collapse residual pins (2026-07-18, low, from review h2c3). · [`open-bugs.md`](backlog/open-bugs.md)
- Pre-existing back-compat fold survives, now against standing policy (2026-07-18, low). · [`open-bugs.md`](backlog/open-bugs.md)
- "The free model can't handle reasoning work" is a MYTH built from unset request parameters — check `finish_reason` before diagnosing a model (friction: tool-should-decide, medium-high). · [`open-bugs.md`](backlog/open-bugs.md)
- The open-work record is navigable in bounded reads via a GENERATED seek index — the remaining sliver is the skill that still says "read it in full" (2026-07-25, low). · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (smoke-dedup lap, 2026-07-25): · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (backlog triage + clearance lap, 2026-07-25): · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (backlog clear-out lap, 2026-07-24): · [`open-bugs.md`](backlog/open-bugs.md)
- Every step prompt's trailing "Then run: … next-step" makes any DELEGATED step executor a second driver (claude-worker dogfood 2026-07-16, tool-should-decide, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- The `charter_delta` step defaults its miner to the same host that merged `charter_extraction` — no mechanical author/critic split (2026-07-17 re-dogfood, tool-should-decide, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- Self-audit dogfood loop: fixing the tool mid-run invalidates the run (claude-worker dogfood 2026-07-16, ambiguous-direction, low-medium). · [`open-bugs.md`](backlog/open-bugs.md)
- A stale prior-run shared confirmation suppresses the proxy populate trigger while Gate-0 still pends (claude-worker dogfood 2026-07-16, tool-should-decide, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- `AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` is an unmeasured estimate, and the lane cannot currently measure it (low, live-gated; the rest of the 2026-07-17 feedback-gap residuals are closed — plan `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md`). · [`open-bugs.md`](backlog/open-bugs.md)
- claude-worker lane residuals — three symptoms of ONE defect: identity is decided somewhere other than where it is known (2026-07-16, low-medium, deferred deliberately). · [`open-bugs.md`](backlog/open-bugs.md)
- A doc-lint hook rewrites prose between Read and Edit, so exact-match edits fail on text the agent never wrote (2026-07-16, inefficient-feeding, low). · [`open-bugs.md`](backlog/open-bugs.md)
- Neither new test guards the WIRING — only the mechanism and the loader (2026-07-16, low). · [`open-bugs.md`](backlog/open-bugs.md)
- A post-worker LANDING stage is still misfiled as dispatch — 2,845 of 5,978 lines under `src/remediate/steps/dispatch/`, plus marshal's merge half (owner question 2026-07-16, re-verified at HEAD 2026-07-24, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- Two dispatch entry points disagree on fail-closed and on driver identity (owner question 2026-07-16, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- G4 reduces to ONE narrow bug: `block_quota.host_model` is auditor IDENTITY persisted in the repo, and it outranks the descriptor (2026-07-16, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- A declared source that verified reach and then lies at dispatch is never ejected — the reactive `lies reachably` quarantine has no catcher (found G4/G5 premise-check 2026-07-16, low). · [`open-bugs.md`](backlog/open-bugs.md)
- A ROTATING set of heavy suite tests fails only under parallel load — hermeticity, not regression (2026-07-16, tool-should-decide, low-medium). · [`open-bugs.md`](backlog/open-bugs.md)
- No read-only surface shows the built dispatch pools — an exclusion rule is unverifiable until a live dispatch (G3 A″ lap 2026-07-16, tool-should-decide, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- Gate-0 display never reflects an exclusion for a SOURCE — no status column, and the endpoint tier can't mark a provider entry (G3 A″ lap 2026-07-16, tool-should-decide, low). · [`open-bugs.md`](backlog/open-bugs.md)
- The per-tool seam artifact marks `excluded` at provider granularity only — inert today (G3 A″ lap 2026-07-16, low). · [`open-bugs.md`](backlog/open-bugs.md)
- SPEC — split the two things currently merged into one "excluded" set; then host exclusion has an obvious meaning. · [`open-bugs.md`](backlog/open-bugs.md)
- The reconciliation gate is silently disabled if the two confirmation artifacts split (G3 A′ review 2026-07-16, tool-should-decide, low). · [`open-bugs.md`](backlog/open-bugs.md)
- Loop-core gate covers `src/audit/orchestrator/` but NOT the audit cli dispatch step-emitters (2a-ii lap, tool-should-decide, low-medium) [[loop-core-enforcement-layer]]. · [`open-bugs.md`](backlog/open-bugs.md)
- Doc/lint gaps exposed by the G3 re-plan lap (2026-07-16) — three standing asks, all unbuilt at HEAD. · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (repair-proxy dogfood lap, 2026-07-15): · [`open-bugs.md`](backlog/open-bugs.md)
- Contract-pipeline planning bills HOST quota only — no route to a $0 pool (inefficient-feeding, medium, two OWNER CALLS). · [`open-bugs.md`](backlog/open-bugs.md)
- A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low). · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE-run watch only — unified routing A–G (shipped 2026-07-17, 6 attested loop-core commits). · [`open-bugs.md`](backlog/open-bugs.md)
- SPEC — probe the local OpenAI-compatible ENDPOINT, the way CLI providers are probed on PATH. · [`open-bugs.md`](backlog/open-bugs.md)
- agy quota may reuse the wrong credential store (unverified, live-check). · [`open-bugs.md`](backlog/open-bugs.md)
- Dispatch routing: JIT reservation on the HOST path + the headless/hybrid branch collapse — the remaining two thirds of the pool-agnostic-claims design (2026-07-13; concept spec 2026-07-16; re-verified against HEAD 2026-07-24). · [`open-bugs.md`](backlog/open-bugs.md)
- Accept-latch residuals (family SHIPPED 2026-07-23; two low items stay open). · [`open-bugs.md`](backlog/open-bugs.md)
- Node-worktree guard — accepted residuals only (each low, on-evidence-only; the guard itself shipped v0.34.19). · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (touched_files load-gate lap, 2026-07-25): · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (fourth backlog-clearance lap, 2026-07-24): · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (second backlog-clearance lap, 2026-07-24): · [`open-bugs.md`](backlog/open-bugs.md)
- Branch-strand trap has bitten THREE times — needs a tool-enforced fix, not a HANDOFF warning (2026-07-22, tool-should-decide, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- "Delegate the rolling loop" dispatcher pattern breaks on notification routing (2026-07-11 live run, tool-should-decide, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- NIM in-process worker: one packet failed with "empty completion (no choices[0].message.content)" (2026-07-11 live run, watch). · [`open-bugs.md`](backlog/open-bugs.md)
- Abandoned HOST-path grants hold reservation leases to the 20-min TTL, walling a fresh grant (2026-07-11 live run, low — backstop works; not a release bug). · [`open-bugs.md`](backlog/open-bugs.md)
- A2b unmatched-quota fallback — two residuals (each low, documented at the code site). · [`open-bugs.md`](backlog/open-bugs.md)
- Design (remove-waves track): dispatch should be gated ONLY by token-budget, rate, and true task-unlocks — the host merge/re-grant barrier is artificial for independent review packets (2026-07-11 live run, owner design statement, forward-track). · [`open-bugs.md`](backlog/open-bugs.md)
- Host fan-out quota gate — residual: AD-HOC host Agent spawns sit outside every ledger (re-verified 2026-07-24, low, [[host-fanout-quota-gate]]). · [`open-bugs.md`](backlog/open-bugs.md)
- Design-review independence — solo `design_review_contract` is the one pass the host judges itself (2026-07-24, low; the old "second-driver hazard" framing is REFUTED). · [`open-bugs.md`](backlog/open-bugs.md)
- Untracked-exclusion scope rule — residuals (shipped 2026-07-10; each low-severity, documented at the code site). · [`open-bugs.md`](backlog/open-bugs.md)
- Ad-hoc Agent fan-out has no per-agent ledger, so a session-limit mid-edit death is unrecoverable (low). · [`open-bugs.md`](backlog/open-bugs.md)
- External shared-logic audit V1–V7 residuals · [`open-bugs.md`](backlog/open-bugs.md)
- Top gate optimization lead — both packaged smokes REBUILD the identical package (measured 2026-07-06). · [`open-bugs.md`](backlog/open-bugs.md)
- Dispatch admission-control rework — two residuals (env-bound / architectural, not blocking). · [`open-bugs.md`](backlog/open-bugs.md)
- Quota-aware dispatch — live validation env-bound. · [`open-bugs.md`](backlog/open-bugs.md)
- SPEC — a ledger-blocked retry must back off, reusing the ONE backoff the project already owns. · [`open-bugs.md`](backlog/open-bugs.md)
- Friction detection — M-QUOTA escalation chain: remediate-side friction assertion missing; live validation env-bound. · [`open-bugs.md`](backlog/open-bugs.md)
- Selective-deepening convergence — live validation env-bound. · [`open-bugs.md`](backlog/open-bugs.md)
- The offload lane is SINGLE-CONCURRENCY and fails soft, so a fan-out reads as model incapacity (2026-07-24, medium, friction: inefficient-feeding). · [`open-bugs.md`](backlog/open-bugs.md)
- A design-review pass can auto-complete EMPTY, and nothing distinguishes that from a real review finding nothing. · [`open-bugs.md`](backlog/open-bugs.md)
- ID minting is not routed through the one registry. · [`open-bugs.md`](backlog/open-bugs.md)

### Open tracks — in flight

- Track 1 — LiteLLM → 9router migration. Infrastructure and decision are DONE; the CODE migration is 0% started, and three measured API gaps re-order the plan (re-verified 2026-07-24). · [`forward-tracks.md`](backlog/forward-tracks.md)
- Track 2 — Ranker contract. ⚠ The "design a contract" framing is SUPERSEDED — the contract already exists and is in use. · [`forward-tracks.md`](backlog/forward-tracks.md)
- Track 3 — Gate-0 operator-confirmed priority order fallback (UX enhancement when no ranks exist). · [`forward-tracks.md`](backlog/forward-tracks.md)

### Forward tracks — design-level directions

- Backend-identity axes — settle transport / service / locus once (design of record: [`spec/backend-identity-axes.md`](../spec/backend-identity-axes.md)). · [`forward-tracks.md`](backlog/forward-tracks.md)
- One repo intent, three filenames — the audit/remediate intent split is a `one core, two draws` smell (surfaced by G3 recon 2026-07-16). · [`forward-tracks.md`](backlog/forward-tracks.md)
- Generate the executor↔artifact mapping from the registries (anti-drift). · [`forward-tracks.md`](backlog/forward-tracks.md)
- End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood). · [`forward-tracks.md`](backlog/forward-tracks.md)
- Free/cheap "quota-arbitrage" dispatch tier (9router-inspired) — extra SOURCE POOLS on existing machinery, not a new provider engine. · [`forward-tracks.md`](backlog/forward-tracks.md)
- models.dev static window can over-state a specific deployment (carried from W1). · [`forward-tracks.md`](backlog/forward-tracks.md)
- Schema-enforced generation — CE-004 residual is every prompt-only backend, not just the host. · [`forward-tracks.md`](backlog/forward-tracks.md)
- Tool-enforced dispatch broker with capability-tiered driver. · [`forward-tracks.md`](backlog/forward-tracks.md)
- Deterministic analyzers: own-vs-acquire engine. · [`forward-tracks.md`](backlog/forward-tracks.md)
- Cross-provider quota — live-endpoint confirmation. · [`forward-tracks.md`](backlog/forward-tracks.md)
- Remediate's `phase:main` has no merge-time ownership re-check before persist — a correctness gap. · [`forward-tracks.md`](backlog/forward-tracks.md)
- Slice-3 — no live heartbeat on the LONG-lived execution claims (doc-review D-66/D-67/C-7; last open slice of the rolling-lifecycle unification). · [`forward-tracks.md`](backlog/forward-tracks.md)
- Context-efficiency access-memory track (items 1-3) shipped; non-blocking follow-up open: · [`forward-tracks.md`](backlog/forward-tracks.md)

### Deferred / waiting — blocked on data, a live run, credentials or a toolchain

- A2 finding-quality oracle — UNPARKED (owner 2026-07-25); corpus is SMALL, PUBLIC, PINNED git repos, not labeled self-audit runs (owner redirect 2026-07-22). · [`deferred.md`](backlog/deferred.md)
- A7 multi-host validation — automated half green, manual GUI half never run. · [`deferred.md`](backlog/deferred.md)
- Manual real-OpenCode validation · [`deferred.md`](backlog/deferred.md)
- Prose-heavy staleness narrowing — the bounded semantic gate SHIPPED for the artifact that drove it; what stays deferred is the cascade-cost measurement and the remaining prose artifacts (2026-07-24, low). · [`deferred.md`](backlog/deferred.md)

<!-- END GENERATED ROADMAP -->

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
([[autonomous-pipeline-capstone-spec]]).

Per-item detail of record is the split backlog — index: [`backlog.md`](backlog.md). The roadmap above
links every section it draws from; [`durable-traps.md`](backlog/durable-traps.md) is standing
reference, not queued work, which is why it has no roadmap group.

**Verify a queued item's PREMISE against HEAD before opening a lap on it** — a spec's decomposition is a
lead, not a work order ([[grep-the-writers-before-believing-inheritance]]). Backlog prose decays: a
2026-07-19 classification pass found ~21% of entries were already shipped, stale, or describing code
that lives only on an unmerged branch.

⚠ **Deliberate, still current:** autonomous auto-confirm is scoped to the DELTA case only — a first-time
confirmation (no artifact at all) still pauses for the operator even under `autonomous_mode`.

Each lap: pick the next item, **risk-tier it**, ship, reinstall, **full friction walk**, then
regenerate the roadmap (`node scripts/shared/generate-handoff-roadmap.mjs`) — re-prioritise by moving
the entry inside its backlog file, never by re-wording the list.
