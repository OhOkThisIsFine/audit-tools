# Backlog — index

> Open work, durable traps and future directions, split so each file is ONE bounded read.
> The single file grew past 1,700 lines, which meant every pass navigated it blind — and that is
> how ~21% of entries silently went stale between classification passes.
>
> A living to-do list, not a status log. Remove an entry once it ships; record durable contracts
> and rationale in project memory or `CLAUDE.md`, never "where the code is today".

| File | What lives there |
|---|---|
| [`backlog/open-bugs.md`](backlog/open-bugs.md) | Fixable defects and friction — the working queue |
| [`backlog/forward-tracks.md`](backlog/forward-tracks.md) | Open tracks + design-level directions |
| [`backlog/deferred.md`](backlog/deferred.md) | Blocked on data, a live run, creds or a toolchain |
| [`backlog/durable-traps.md`](backlog/durable-traps.md) | Standing environment reference + doc-set hygiene |

<!-- BEGIN GENERATED SEEK INDEX — scripts/shared/generate-backlog-index.mjs — DO NOT EDIT BY HAND -->

> **Seek index — GENERATED from [`docs/backlog/`](backlog/); do not hand-edit it.**
> `open-bugs.md` is past what one read call returns. Read THIS list once, then jump straight to
> an entry with an offset read at its `file:line` anchor — that is what makes the open-work
> record navigable in bounded reads without splitting it.
> Titles are each entry's own bold lead-in, verbatim, so this index restates nothing and cannot
> drift. **Line numbers move under every edit** — regenerate rather than hand-patching them:
> `node scripts/shared/generate-backlog-index.mjs` (`--check` gates it in `verify:checks`
> and at commit). 171 entr(y/ies) indexed.

### [`open-bugs.md`](backlog/open-bugs.md)

- `open-bugs.md:9` — Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).
- `open-bugs.md:17` — Diff-based re-review loses the verdict it must diff against (2026-08-08, low).
- `open-bugs.md:23` — `free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low).
- `open-bugs.md:27` — Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low).
- `open-bugs.md:32` — Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).
- `open-bugs.md:41` — Regex-perf triage tail from the analyzer sweep (2026-08-07, low).
- `open-bugs.md:48` — `ensureCleanWorktree` blocks a release on sibling UNTRACKED files (2026-08-07, low, friction).
- `open-bugs.md:55` — Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test passes", 2026-08-06).
- `open-bugs.md:78` — Remediation pause/recovery is not durable (2026-08-03, medium).
- `open-bugs.md:86` — Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).
- `open-bugs.md:93` — Dispatch accepts work against an incomplete source/obligation boundary (2026-08-03, medium).
- `open-bugs.md:101` — Phase-boundary gate false abandonment (2026-07-30, HIGH).
- `open-bugs.md:112` — A contract change swept `tests/` and missed the PRODUCERS in `scripts/` — caught only by CI (2026-07-25, low, friction: inefficient-feeding).
- `open-bugs.md:126` — Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction).
- `open-bugs.md:136` — LEAD (2026-07-23, low, surfaced reviewing the shipped DEFECT-2 design-review object envelope): a `json_object` worker that adds a SIBLING key beside `findings` is quarantined, not unwrapped.
- `open-bugs.md:149` — CLI-worker write-scope — four accepted residuals, revisit on live evidence only (2026-07-22, low).
- `open-bugs.md:170` — FLW-COR-003 claim-release livelock — one low residual (2026-07-22; downgraded from HIGH after a 2026-07-24 code trace).
- `open-bugs.md:185` — ⬇ LIVE (re-dogfood 2026-07-22, medium, LEAD — mechanism RESTATED 2026-07-24 after a HEAD trace): a lane can return success-shaped EMPTY results and nothing in routing notices.
- `open-bugs.md:204` — DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted).
- `open-bugs.md:229` — A spec row's category prefix is load-bearing enough to manufacture work — and one was false (2026-07-28, low, RESOLVED; the open half is the class).
- `open-bugs.md:243` — ⬇ LIVE (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim.
- `open-bugs.md:251` — ⬇ LIVE (re-dogfood 2026-07-22, low): a json_schema-required array elicits FILLER entries from weaker models when the true answer is empty.
- `open-bugs.md:267` — ⬇ LIVE (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it.
- `open-bugs.md:285` — LEAD (2026-07-22, low): does remediate's node-claim lifecycle share the merge-only-release defect the audit side just fixed?
- `open-bugs.md:295` — Regenerating the price snapshot INVERTS host tier cost order — the refresh is blocked on the service→vendor-id mapping, not merely followed by it (2026-07-24, medium, ATTEMPTED AND REVERTED).
- `open-bugs.md:321` — LEAD (low): NIM roster latency is bimodal — a slow model can read as a DEAD lane.
- `open-bugs.md:339` — ⬇ LIVE (re-dogfood): token_usage stamping asks for a split real harnesses cannot supply (2026-07-21, low).
- `open-bugs.md:345` — LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low).
- `open-bugs.md:350` — Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).
- `open-bugs.md:371` — Window-scope validation at the PRODUCER boundary — designed for step 2, deferred with reason (2026-07-19).
- `open-bugs.md:391` — A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.
- `open-bugs.md:411` — Ranked-pool composition — live-wave watch + the absolute-floor question.
- `open-bugs.md:427` — H2+H4 collapse residual pins (2026-07-18, low, from review h2c3).
- `open-bugs.md:435` — Pre-existing back-compat fold survives, now against standing policy (2026-07-18; re-verified at HEAD 2026-07-26 — NOT low).
- `open-bugs.md:437` — "The free model can't handle reasoning work" is a MYTH built from unset request parameters — check `finish_reason` before diagnosing a model (friction: tool-should-decide, medium-high).
- `open-bugs.md:462` — Friction walk (determinations-execution lap, 2026-07-29):
- `open-bugs.md:476` — Friction walk (duplicated-guard lap, 2026-07-25):
- `open-bugs.md:488` — Friction walk (backlog triage + clearance lap, 2026-07-25):
- `open-bugs.md:501` — Implementation workers are never given the contract they must satisfy (2026-08-09, high).
- `open-bugs.md:514` — `obligation_ledger.input.json` is listed as a required input but never written (2026-08-09, low).
- `open-bugs.md:520` — Friction walk (backlog clear-out lap, 2026-07-24):
- `open-bugs.md:537` — Every step prompt's trailing "Then run: … next-step" makes any DELEGATED step executor a second driver (claude-worker dogfood 2026-07-16, tool-should-decide, medium).
- `open-bugs.md:549` — The `charter_delta` step defaults its miner to the same host that merged `charter_extraction` — no mechanical author/critic split (2026-07-17 re-dogfood, tool-should-decide, medium).
- `open-bugs.md:560` — Self-audit dogfood loop: fixing the tool mid-run invalidates the run (claude-worker dogfood 2026-07-16, ambiguous-direction, low-medium).
- `open-bugs.md:572` — `AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` is an unmeasured estimate, and the lane cannot currently measure it (low, live-gated; the rest of the 2026-07-17 feedback-gap residuals are closed — plan `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md`).
- `open-bugs.md:574` — Declared-source duplicates can resolve to one pool id and silently clobber their launch source (2026-07-16, low-medium).
- `open-bugs.md:586` — A doc-lint hook rewrites prose between Read and Edit, so exact-match edits fail on text the agent never wrote (2026-07-16, inefficient-feeding, low).
- `open-bugs.md:599` — Neither new test guards the WIRING — only the mechanism and the loader (2026-07-16, low).
- `open-bugs.md:601` — A post-worker LANDING stage is still misfiled as dispatch — 2,845 of 5,978 lines under `src/remediate/steps/dispatch/`, plus marshal's merge half (owner question 2026-07-16, re-verified at HEAD 2026-07-24, medium).
- `open-bugs.md:604` — Two dispatch entry points disagree on fail-closed and on driver identity (owner question 2026-07-16, medium).
- `open-bugs.md:606` — G4 reduces to ONE narrow bug: `block_quota.host_model` is auditor IDENTITY persisted in the repo, and it outranks the descriptor (2026-07-16, medium).
- `open-bugs.md:634` — A declared source that verified reach and then lies at dispatch is never ejected — the reactive `lies reachably` quarantine has no catcher (found G4/G5 premise-check 2026-07-16, low).
- `open-bugs.md:646` — A ROTATING set of heavy suite tests fails only under parallel load — hermeticity, not regression (2026-07-16, tool-should-decide, low-medium).
- `open-bugs.md:662` — Loop-core gate covers `src/audit/orchestrator/` but NOT the audit cli dispatch step-emitters (tool-should-decide, low-medium) [[loop-core-enforcement-layer]].
- `open-bugs.md:676` — Doc/lint gaps exposed by the G3 re-plan lap (2026-07-16) — three standing asks, all unbuilt at HEAD.
- `open-bugs.md:682` — Contract-pipeline planning bills HOST quota only — no route to a $0 pool (inefficient-feeding, medium, two OWNER CALLS).
- `open-bugs.md:690` — A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).
- `open-bugs.md:692` — ⬇ LIVE-run watch only — unified routing A–G.
- `open-bugs.md:701` — SPEC — probe the local OpenAI-compatible ENDPOINT, the way CLI providers are probed on PATH.
- `open-bugs.md:714` — agy quota may reuse the wrong credential store (unverified, live-check).
- `open-bugs.md:716` — Dispatch routing: JIT reservation on the HOST path + the headless/hybrid branch collapse — the remaining two thirds of the pool-agnostic-claims design (2026-07-13; concept spec 2026-07-16; re-verified against HEAD 2026-07-24).
- `open-bugs.md:718` — Accept-latch — two low residuals stay open.
- `open-bugs.md:726` — Node-worktree guard — accepted residuals only (each low, on-evidence-only).
- `open-bugs.md:728` — Friction walk (niggle-fix lap, 2026-08-07):
- `open-bugs.md:745` — Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):
- `open-bugs.md:759` — Friction walk (queue-closeout + first `.ts`-conversion lap, 2026-07-28):
- `open-bugs.md:771` — Friction walk (nightly-determinations lap, 2026-07-26):
- `open-bugs.md:797` — Friction walk (contract-sweep producer lap, 2026-07-26):
- `open-bugs.md:814` — Friction walk (inline-api_key retirement lap, 2026-07-26):
- `open-bugs.md:826` — Friction walk (touched_files load-gate lap, 2026-07-25):
- `open-bugs.md:839` — Friction walk (fourth backlog-clearance lap, 2026-07-24):
- `open-bugs.md:859` — Friction walk (second backlog-clearance lap, 2026-07-24):
- `open-bugs.md:868` — Remediation must never switch the primary checkout off its base branch (2026-07-22, medium; product fix planned).
- `open-bugs.md:891` — "Delegate the rolling loop" dispatcher pattern breaks on notification routing (2026-07-11 live run, tool-should-decide, medium).
- `open-bugs.md:912` — NIM in-process worker: one packet failed with "empty completion (no choices[0].message.content)" (2026-07-11 live run, watch).
- `open-bugs.md:916` — Abandoned HOST-path grants hold reservation leases to the 20-min TTL, walling a fresh grant (2026-07-11 live run, low — backstop works; not a release bug).
- `open-bugs.md:938` — A2b unmatched-quota fallback — two residuals (each low, documented at the code site).
- `open-bugs.md:951` — Design (remove-waves track): dispatch should be gated ONLY by token-budget, rate, and true task-unlocks — the host merge/re-grant barrier is artificial for independent review packets (2026-07-11 live run, owner design statement, forward-track).
- `open-bugs.md:970` — Host fan-out quota gate — residual: AD-HOC host Agent spawns sit outside every ledger (re-verified 2026-07-24, low, [[host-fanout-quota-gate]]).
- `open-bugs.md:979` — Design-review independence — the solo contract branch is pinned by a shared helper, not by a test (2026-07-24, low).
- `open-bugs.md:997` — Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code site).
- `open-bugs.md:1020` — External shared-logic audit V1–V7 residuals
- `open-bugs.md:1037` — Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured 2026-07-06).
- `open-bugs.md:1043` — Dispatch admission-control rework — two residuals (env-bound / architectural, not blocking).
- `open-bugs.md:1065` — Quota-aware dispatch — live validation env-bound.
- `open-bugs.md:1080` — SPEC — a ledger-blocked retry must back off, reusing the ONE backoff the project already owns.
- `open-bugs.md:1094` — Friction detection — M-QUOTA escalation chain: remediate-side friction assertion missing; live validation env-bound.
- `open-bugs.md:1113` — Selective-deepening convergence — live validation env-bound.
- `open-bugs.md:1135` — A design-review auto-complete is now RECORDED but not yet CONSUMED — the stamped half shipped, the acting half is open.
- `open-bugs.md:1144` — `goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD 2026-07-25).
- `open-bugs.md:1153` — ▶ Dogfood/meta-review 2026-07-30 cluster — remaining live-run-watch properties.
- `open-bugs.md:1174` — Incoming design-review/charter/challenge artifacts have no submit chokepoint.
- `open-bugs.md:1183` — submit-packet can report success on a result merge later refuses.
- `open-bugs.md:1191` — systemic_challenge findings ids are adversary-invented and round-colliding.
- `open-bugs.md:1198` — The systemic_challenge loop has no ceiling — its only exit is a dry signal the host may have to fabricate.
- `open-bugs.md:1205` — A review packet's deliverable rides a tool call the worker can silently skip.
- `open-bugs.md:1211` — Dispatch children inherit the repo's `.claude` SKILLS, not just its hooks.
- `open-bugs.md:1216` — CI trigger paths omit `.claude/
- `open-bugs.md:1223` — An `openai-compatible` source's reach proves its ENDPOINT, never its declared MODEL.
- `open-bugs.md:1229` — `ensure` writes opencode.json with unstable key order.
- `open-bugs.md:1234` — Two run-id notions; friction record keyed both ways.
- `open-bugs.md:1240` — Dispatch-step prompt conflates merge rejections with failure.
- `open-bugs.md:1246` — Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification (2026-08-06, lead, low).
- `open-bugs.md:1251` — Run-closure leaves orphan node-worktree DIRECTORIES behind (2026-08-06, low).

### [`forward-tracks.md — Open tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:11` — Track 2.5 — Slim-down: ~9,400 removable lines, mapped and ranked in [`slimdown-review-2026-07-28.md`](./reviews/slimdown-review-2026-07-28.md). Nothing applied.

### [`forward-tracks.md — Forward tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:34` — A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs.
- `forward-tracks.md:61` — Backend-identity axes — settle transport / service / locus once (design of record: [`spec/backend-identity-axes.md`](../spec/backend-identity-axes.md)).
- `forward-tracks.md:74` — One repo intent, three filenames — the audit/remediate intent split is a `one core, two draws` smell.
- `forward-tracks.md:89` — Generate the executor↔artifact mapping from the registries (anti-drift).
- `forward-tracks.md:96` — End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).
- `forward-tracks.md:104` — Free/cheap "quota-arbitrage" dispatch tier — extra SOURCE POOLS on existing machinery, not a new provider engine.
- `forward-tracks.md:154` — models.dev static window can over-state a specific deployment (carried from W1).
- `forward-tracks.md:174` — Schema-enforced generation — CE-004 residual is every prompt-only backend, not just the host.
- `forward-tracks.md:186` — Tool-enforced dispatch broker with capability-tiered driver.
- `forward-tracks.md:199` — Deterministic analyzers: own-vs-acquire engine.
- `forward-tracks.md:214` — Cross-provider quota — live-endpoint confirmation.
- `forward-tracks.md:225` — Remediate's `phase:main` has no merge-time ownership re-check before persist — a correctness gap.
- `forward-tracks.md:236` — Slice-3 — no live heartbeat on the LONG-lived execution claims (doc-review D-66/D-67/C-7; last open slice of the rolling-lifecycle unification).
- `forward-tracks.md:280` — Packet `task_ids`/`lens` attribution is missing from the token-usage ledger
- `forward-tracks.md:282` — CI wall-clock: shard balance and the single-file floor.
- `forward-tracks.md:289` — Obligation-id slugs and decomposed-module names are two name spaces joined by a prefix match.
- `forward-tracks.md:301` — `ensureGlobalAssets` is now production-unwired — decide whether it is duplicated or genuinely dead.

### [`deferred.md`](backlog/deferred.md)

- `deferred.md:11` — A7 multi-host validation — automated half green, manual GUI half never run.
- `deferred.md:22` — Manual real-OpenCode validation
- `deferred.md:25` — Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts stay deferred (2026-07-24, low).

### [`durable-traps.md`](backlog/durable-traps.md)

- `durable-traps.md:16` — A vitest CLI file filter resurrects same-suffixed test COPIES under stale worktree dirs (2026-08-06).
- `durable-traps.md:27` — The Workflow tool's per-agent `model` override may not take (observed 2026-08-06).
- `durable-traps.md:34` — A local test RED can be an ambient-PATH artifact, not a regression.
- `durable-traps.md:41` — agy's headless lane is INERT until `~/.gemini/antigravity-cli/settings.json` grants tool permissions — and the grammar is `tool(target)` (verified live 2026-07-25).
- `durable-traps.md:54` — A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).
- `durable-traps.md:62` — An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).
- `durable-traps.md:68` — Never delete from a backlog file by LINE NUMBER.
- `durable-traps.md:74` — The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model
- `durable-traps.md:102` — The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).
- `durable-traps.md:110` — Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).
- `durable-traps.md:119` — Concurrent agent sessions can share the ONE primary checkout (2026-07-23).
- `durable-traps.md:128` — The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21).
- `durable-traps.md:142` — The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium).
- `durable-traps.md:150` — Global `fetch` cannot outlast a long reasoning call — undici's 300s `headersTimeout` is measured to the FIRST byte and `globalThis.fetch` cannot be told otherwise (2026-07-20, low; remedy corrected 2026-07-24).
- `durable-traps.md:166` — An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium).
- `durable-traps.md:177` — `codex exec` hangs on an open stdin — inside the product that is guaranteed by the spawn substrate, not by each spawn site.
- `durable-traps.md:192` — An unrecognized key in the machine declaration can fail as a missing lane.
- `durable-traps.md:199` — The free offload lane is the local `llm-relay` broker — it must be RUNNING, and callers should request a named pool.
- `durable-traps.md:223` — After an unattended run, `git diff` the tracked docs before committing.
- `durable-traps.md:236` — npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).
- `durable-traps.md:258` — `git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is NOT a rejection.
- `durable-traps.md:264` — The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file wall is expected, not a hang.
- `durable-traps.md:284` — Codex CLI can burn a long wall-clock on large read-heavy audit packets.
- `durable-traps.md:295` — Remediate-code worktree branches strand commits off main.
- `durable-traps.md:297` — Wall-clock peak-concurrency tests are latency-fragile.
- `durable-traps.md:312` — One test runner: vitest
- `durable-traps.md:326` — Don't mask the test exit code with a REDIRECT.
- `durable-traps.md:334` — Global `-g` install BLOCKS `postinstall`
- `durable-traps.md:344` — A global junction to a LIVE working tree silently shadows a registry install.
- `durable-traps.md:350` — PowerShell
- `durable-traps.md:360` — Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently.
- `durable-traps.md:376` — A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY.
- `durable-traps.md:391` — Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one.
- `durable-traps.md:398` — Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.
- `durable-traps.md:403` — No host-side unblock for a wedged audit run — use `audit-code force-synthesis`.
- `durable-traps.md:415` — A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).
- `durable-traps.md:417` — A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.
- `durable-traps.md:425` — The Grep tool's content output can mangle comment markers with a BACKSLASH.
- `durable-traps.md:430` — A typecheck sweep's error count is not final until you re-run it.
- `durable-traps.md:438` — An untypechecked fixture can sit inert for months while its suite reads green.
- `durable-traps.md:459` — Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.
- `durable-traps.md:470` — A backlog entry's bold title must not contain `
- `durable-traps.md:475` — A nested `claude -p` launched with this repo as its cwd is a FULL session in the SHARED checkout — it runs this repo's hooks and can mutate git state (2026-08-07).
- `durable-traps.md:486` — An offload recon lane reading a file you are concurrently editing reports the POST-edit tree (2026-08-07).
- `durable-traps.md:493` — Long relay recon jobs die mid-response; short ones do not (2026-08-07).
- `durable-traps.md:501` — `.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between its markers is silently wiped (2026-07-30).

<!-- END GENERATED SEEK INDEX -->

**Log friction the moment you hit it** — non-obvious traps, misbehaving tools, missing affordances,
shell/env quirks. One line to `backlog/open-bugs.md` (a fixable defect) or
`backlog/durable-traps.md` (a standing gotcha) before moving on.

**Verify an entry's PREMISE against HEAD before opening a lap on it.** Backlog prose decays, and it
decays in a specific way: not merely going stale, but *paraphrasing an incident until the mechanism
inverts*. Two entries did exactly that this cycle, and each cost a wrong implementation before the
primary record was re-read. An entry that reinterprets an incident must quote or link the primary
record's own words for the mechanism.

**Per-entry size budget.** Entries earn their length, but the growth driver is post-mortem narrative
accreting after the fact. `npm run check:backlog-budget` fails the build on an entry past the
budget; condense at write time, and put the narrative in `git log` or a `docs/reviews/` record.

---

## Live-validation guide — READ FIRST if you're running a live audit/remediate


Most open items below are **code-complete and only await a real run to confirm**. Each such item
carries a **⬇ Live-run watch** line: exactly what to observe during the run to confirm it validated —
or to catch it failing. Pick a run config from this matrix; watch the items it lights up.

| Run config | Items it exercises (watch their ⬇ lines) |
|---|---|
| **Any** live audit, any provider | Selective-deepening convergence · knip `files`/`dependencies` dead-code leads |
| **Metered provider + LARGE target** — this is what exercises the wall (`AUDIT_TOOLS_LIVE_QUOTA=1` only enables the live-credential test probe in `tests/audit/inv2.test.ts`, it does not force a production wall) | Quota-aware dispatch · M-QUOTA friction escalation · pre-wall pacing · retryable resume |
| **Codex backend** (`--provider codex`; Codex CLI is a nested-agent host) | Y-dispatcher driver selection · cross-provider quota (Codex live endpoint) |
| **openai-compatible / NIM backend** (`RUN_NIM_E2E=1` for the gated e2e) | openai-compatible dispatch pool · CE-004 emit-time-constraint build opportunity |
| **Rust or Ruby target repo** | clippy (cargo) + rubocop (bundle) live spawn |

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a *crash*
(not a graceful pause) when a rate limit is hit · an analyzer that silently skipped when it should have
spawned · knip dead-code leads that never reach the per-file lens. (The A2 oracle corpus is now
pinned public repos, not labeled live runs — a run's findings are at most optional calibration
data; see Deferred / waiting.)

---

