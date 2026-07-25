# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of what is open. Durable
> how-to is in `CLAUDE.md`; per-item detail in the split backlog [`docs/backlog/`](backlog/); durable design in
> `spec/`. This is the *sequencing* view — every open item appears once, in suggested order, with a
> pointer to its detail. The roadmap list is **generated** from the backlog
> (`scripts/shared/generate-handoff-roadmap.mjs`), so an item's text has exactly one home and the two
> cannot drift. **Shipped detail is `git log`, never this doc.**

## Live state

- **⚠ Four NEW refusals landed 2026-07-25 (`11bbb8f2`, `9732b1ed`, `df80e55b`) — all intended; a session
  that does not expect them reads each as a fault.**
  (1) **A live backtick in a Bash-tool command is DENIED.** A backtick command-substitutes inside double
  quotes too, so markdown backticks in `git commit -m "… \`npm run check\` …"` are executed, not written.
  Use single quotes, `-F <file>`, or `$(...)`; override `AUDIT_TOOLS_ALLOW_BACKTICKS=1`.
  (2) **Two Stop hooks can BLOCK a stop.** `closeout-challenge-gate` asks "was that all taken care of?"
  with mechanical evidence (max 2/session, per-tree-state); `question-philosophy-gate` fires when a
  closing message ends in a question. Both are once-ish and both have kill switches
  (`AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE`, `AUDIT_TOOLS_NO_QUESTION_PHILOSOPHY`).
  (3) **`AskUserQuestion` is gated once per session** — the philosophy brief is injected first; ask again
  and it goes through. It does not suppress asking.
  (4) **`README.md`'s Philosophy section is GENERATED** from THE BRIEF in `docs/project-philosophy.md`
  (`check:philosophy-brief`, in `verify:checks`). Never hand-edit that block; edit the brief and run
  `npm run check:philosophy-brief -- --write`.

- **Nightly-items clearance lap, 2026-07-25 — the nightly queue is worked down; four gates are new.**
  `check:version-gates`, `check:constitutional-doc-paths`, `check:memory-citations` and the rebuilt
  `check:doc-manifest` all run in `verify:checks`. The manifest is now DATA
  (`scripts/doc-manifest-data.mjs`) rendered into `doc-review-guidelines.md` and byte-compared, and it
  reaches the whole repo — the gate reports the count, don't carry one here. Constitutional docs are
  REFUSED at commit without
  `node scripts/attest-constitutional-doc-change.mjs`.
  ⚠ **Two gates now refuse commits that previously passed.** A commit touching `CLAUDE.md`,
  a normative goals doc, `docs/project-philosophy.md` or `docs/doc-review-guidelines.md` needs a
  constitutional attestation; a commit stamping a schema version into a payload read back unchecked
  fails `check:version-gates`. Both are intended.
  ⚠ **`verify:checks` runs the gates; the pre-commit hook does NOT run `verify:checks`.** A gate wired
  only into `verify:checks` still fails first in RELEASE CI. Wire anything commit-critical into
  `.claude/hooks/pre-commit-gate.mjs` as well.


- **Still live from the earlier 2026-07-24 laps.** The price-snapshot refresh INVERTS host tier cost
  order (regenerating it ranks `claude-opus-4-8` below haiku, so cost-first routing at λ=0 sends every
  packet to Opus; `cost-rank.test.mjs` caught it, and the service→vendor-id mapping is a PREREQUISITE,
  not a follow-up) — open entry in [`open-bugs.md`](backlog/open-bugs.md); do not "fix" it by editing
  the cost-rank expectations, they encode real list prices.
  ⚠ **Adding a channel is not the same as keeping one:** injecting `onDroppedSources` to feed the Gate-0
  render SUPPRESSED the resolver's stderr default — a silent loss on every path that never reaches
  Gate-0, caught only by the full suite while `check` stayed green. Emit both.
  Records: [`backlog-clearance-2026-07-24.md`](reviews/backlog-clearance-2026-07-24.md) ·
  [`backlog-clearance-2026-07-24b.md`](reviews/backlog-clearance-2026-07-24b.md).

- **⚠ Two corrections carried from the prior clear-out lap (`d4c8e9ea`) — both still live.**
  (1) FLW-COR-003's backlog-prescribed fix, "release claims on every path that claims", was WRONG: the
  lease must span out-of-process workers (`dispatch.ts:129-136`), and the real leak was merge throwing
  before its own release. (2) The `analyzerDeps` "live npm install E404" entry was REFUTED — no test
  shells out to npm; it was a stub-log leak manufacturing a convincing false alarm. Both are the class
  the backlog keeps hitting: an entry paraphrasing its own incident until the mechanism inverts. That
  lap also established the adversarial-second-pass habit, which **overturned 41 of 62** close verdicts
  it examined — and overturned two more premises this lap (see item 2).
- **Current version = `package.json`** (authoritative): v0.34.29. The clearance laps after it are
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
> `verify:checks` and at commit). 113 open item(s).

### ▶ Next up — pinned in the backlog

- ▶ An HONEST per-node token estimate is UNBLOCKED and still unwired (medium, loop-core). · [`open-bugs.md`](backlog/open-bugs.md)
- ▶ `open-bugs.md` is over the 120KB budget — still not one bounded read (2026-07-24, medium, friction: inefficient-feeding). · [`open-bugs.md`](backlog/open-bugs.md)

### Open bugs & frictions — the working queue

- Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (2026-07-23, low, surfaced reviewing the shipped DEFECT-2 design-review object envelope): a `json_object` worker that adds a SIBLING key beside `findings` is quarantined, not unwrapped. · [`open-bugs.md`](backlog/open-bugs.md)
- `verifySourceReach` demands `api_key_env` on every openai-compatible source, so a KEYLESS local endpoint cannot be declared honestly (2026-07-23, low, friction: tool-should-decide). · [`open-bugs.md`](backlog/open-bugs.md)
- CLI-worker write-scope — four accepted residuals of the SHIPPED review-snapshot worktree (2026-07-22, low, revisit on live evidence only). · [`open-bugs.md`](backlog/open-bugs.md)
- FLW-COR-003 claim-release livelock — the IN-PROCESS half is SHIPPED; the HOST half is what remains (2026-07-22, downgraded from HIGH to medium 2026-07-24 after a code trace). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (2026-07-23, low, surfaced by the shipped worker-kind × pool-class rule): a `burst_limited` proxy contributes NOTHING — populate/expansion should emit single-shot lanes instead of agentic ones that all drop. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood 2026-07-22, medium, LEAD — mechanism RESTATED 2026-07-24 after a HEAD trace): a lane can return success-shaped EMPTY results and nothing in routing notices. · [`open-bugs.md`](backlog/open-bugs.md)
- RESIDUAL of the shipped DD-9 + charter slice-staleness pair (2026-07-23, low, accepted — revisit on live evidence). · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood 2026-07-22, low): a json_schema-required array elicits FILLER entries from weaker models when the true answer is empty. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood 2026-07-22, low): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it. · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (2026-07-22, low): does remediate's node-claim lifecycle share the merge-only-release defect the audit side just fixed? · [`open-bugs.md`](backlog/open-bugs.md)
- Regenerating the price snapshot INVERTS host tier cost order — the refresh is blocked on the service→vendor-id mapping, not merely followed by it (2026-07-24, medium, ATTEMPTED AND REVERTED). · [`open-bugs.md`](backlog/open-bugs.md)
- Stale agent worktrees are never pruned (2026-07-24, low, friction: tool-should-decide). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (low): NIM roster latency is bimodal — a slow model can read as a DEAD lane. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE-CONFIRMED (re-dogfood 2026-07-21): the proxy-lane drop reason names an internal function, and no populate command exists (medium, friction: tool-should-decide). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (2026-07-23, low, surfaced by the pause-wall recon — out-of-repo resolvers only): `window_uncalibrated` ledger blocks are a fixed-state 50ms-poll livelock if a custom `resolvePoolConstraints` emits unpriced windows. · [`open-bugs.md`](backlog/open-bugs.md)
- RESIDUAL of the partial-wave deferral (shipped v0.34.27, 2026-07-24, low) — two accepted residuals, no open work. · [`open-bugs.md`](backlog/open-bugs.md)
- ⬇ LIVE (re-dogfood): token_usage stamping asks for a split real harnesses cannot supply (2026-07-21, low). · [`open-bugs.md`](backlog/open-bugs.md)
- LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low). · [`open-bugs.md`](backlog/open-bugs.md)
- agy's headless lane still has no `permissions.allow` rules, so `-p` auto-denies `read_file`/`command` (2026-07-23, low, friction: tool-should-decide). · [`open-bugs.md`](backlog/open-bugs.md)
- SPEC — delete inline `api_key` support; a credential must be named, never pasted. · [`open-bugs.md`](backlog/open-bugs.md)
- Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19). · [`open-bugs.md`](backlog/open-bugs.md)
- Window-scope validation at the PRODUCER boundary — designed for step 2, deferred with reason (2026-07-19). · [`open-bugs.md`](backlog/open-bugs.md)
- A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main. · [`open-bugs.md`](backlog/open-bugs.md)
- Nothing derives "collapse a shared-budget roster to its best member" (low). · [`open-bugs.md`](backlog/open-bugs.md)
- SPEC — the proxy catalog's freshness rule gates the WRITE but not the READ, and the lane has no operator-runnable refresh. · [`open-bugs.md`](backlog/open-bugs.md)
- A DEADLINE must drive λ from measured progress, never become a second operator knob — and nothing measures progress yet (blocked on an owner call, not on code). · [`open-bugs.md`](backlog/open-bugs.md)
- Ranked-pool composition — live-wave watch + the absolute-floor question (mechanism shipped R3-3 `c0cf7e9b` 2026-07-21; residue only). · [`open-bugs.md`](backlog/open-bugs.md)
- H2+H4 collapse residual pins (2026-07-18, low, from review h2c3). · [`open-bugs.md`](backlog/open-bugs.md)
- Pre-existing back-compat fold survives, now against standing policy (2026-07-18, low). · [`open-bugs.md`](backlog/open-bugs.md)
- "The free model can't handle reasoning work" is a MYTH built from unset request parameters — check `finish_reason` before diagnosing a model (friction: tool-should-decide, medium-high). · [`open-bugs.md`](backlog/open-bugs.md)
- The open-work record exceeds a single-read budget, so every pass navigates it blind (friction: inefficient-feeding, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (backlog clear-out lap, 2026-07-24): · [`open-bugs.md`](backlog/open-bugs.md)
- Friction walk (H2+H4 collapse lap, 2026-07-18): · [`open-bugs.md`](backlog/open-bugs.md)
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
- G5's premise is 2/3 DEAD — narrow the spec before laying it out (found G4 premise-check 2026-07-16, low). · [`open-bugs.md`](backlog/open-bugs.md)
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
- Gate-0's quota-demotion primitive (`CostCandidate.saturated`) is unwired — and the real question is whether Gate-0 is the right layer at all (2026-07-13 audit-gate review; re-verified against HEAD 2026-07-24). · [`open-bugs.md`](backlog/open-bugs.md)
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
- openai-compatible content-inlining — residuals (each low, documented at the code site) ([[openai-compatible-content-inlining]]). · [`open-bugs.md`](backlog/open-bugs.md)
- A2b unmatched-quota fallback — two residuals (each low, documented at the code site). · [`open-bugs.md`](backlog/open-bugs.md)
- Design (remove-waves track): dispatch should be gated ONLY by token-budget, rate, and true task-unlocks — the host merge/re-grant barrier is artificial for independent review packets (2026-07-11 live run, owner design statement, forward-track). · [`open-bugs.md`](backlog/open-bugs.md)
- Host fan-out quota gate — residual: AD-HOC host Agent spawns sit outside every ledger (re-verified 2026-07-24, low, [[host-fanout-quota-gate]]). · [`open-bugs.md`](backlog/open-bugs.md)
- Design-review independence — solo `design_review_contract` is the one pass the host judges itself (2026-07-24, low; the old "second-driver hazard" framing is REFUTED). · [`open-bugs.md`](backlog/open-bugs.md)
- Untracked-exclusion scope rule — residuals (shipped 2026-07-10; each low-severity, documented at the code site). · [`open-bugs.md`](backlog/open-bugs.md)
- Friction-walk lesson (ledger-writer / acceptNode-inert-clean lap): · [`open-bugs.md`](backlog/open-bugs.md)
- External shared-logic audit V1–V7 residuals · [`open-bugs.md`](backlog/open-bugs.md)
- Top gate optimization lead — both packaged smokes REBUILD the identical package (measured 2026-07-06). · [`open-bugs.md`](backlog/open-bugs.md)
- Dispatch admission-control rework — two residuals (env-bound / architectural, not blocking). · [`open-bugs.md`](backlog/open-bugs.md)
- Quota-aware dispatch — live validation env-bound. · [`open-bugs.md`](backlog/open-bugs.md)
- SPEC — a ledger-blocked retry must back off, reusing the ONE backoff the project already owns. · [`open-bugs.md`](backlog/open-bugs.md)
- Friction detection — M-QUOTA escalation chain: remediate-side friction assertion missing; live validation env-bound. · [`open-bugs.md`](backlog/open-bugs.md)
- Selective-deepening convergence — live validation env-bound. · [`open-bugs.md`](backlog/open-bugs.md)
- The offload lane is SINGLE-CONCURRENCY and fails soft, so a fan-out reads as model incapacity (2026-07-24, medium, friction: inefficient-feeding). · [`open-bugs.md`](backlog/open-bugs.md)
- A backlog entry overstated its own mechanism again — "blocks the rest of the run" vs. a wrong terminal CLASSIFICATION (2026-07-24, low, friction: ambiguous-direction). · [`open-bugs.md`](backlog/open-bugs.md)
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

- A2 finding-quality oracle — REDIRECTED (owner 2026-07-22): base the corpus on SMALL, PUBLIC, PINNED git repos, not on labeled self-audit runs. · [`deferred.md`](backlog/deferred.md)
- A7 multi-host validation — automated half green, manual GUI half never run. · [`deferred.md`](backlog/deferred.md)
- Manual real-OpenCode validation · [`deferred.md`](backlog/deferred.md)
- Gated live e2es — the current flag set. · [`deferred.md`](backlog/deferred.md)
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
