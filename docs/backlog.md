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
> and at commit). 150 entr(y/ies) indexed.

### [`open-bugs.md`](backlog/open-bugs.md)

- `open-bugs.md:10` — `render-digest.mjs --open` discards the URL of the server it starts (2026-07-29, low, friction: missing-affordance).
- `open-bugs.md:19` — A contract change swept `tests/` and missed the PRODUCERS in `scripts/` — caught only by CI (2026-07-25, low, friction: inefficient-feeding).
- `open-bugs.md:33` — Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction).
- `open-bugs.md:43` — LEAD (2026-07-23, low, surfaced reviewing the shipped DEFECT-2 design-review object envelope): a `json_object` worker that adds a SIBLING key beside `findings` is quarantined, not unwrapped.
- `open-bugs.md:56` — CLI-worker write-scope — four accepted residuals, revisit on live evidence only (2026-07-22, low).
- `open-bugs.md:77` — FLW-COR-003 claim-release livelock — one low residual (2026-07-22; downgraded from HIGH after a 2026-07-24 code trace).
- `open-bugs.md:92` — LEAD (2026-07-23, low, surfaced by the shipped worker-kind × pool-class rule): a `burst_limited` proxy contributes NOTHING — populate/expansion should emit single-shot lanes instead of agentic ones that all drop.
- `open-bugs.md:111` — ⬇ LIVE (re-dogfood 2026-07-22, medium, LEAD — mechanism RESTATED 2026-07-24 after a HEAD trace): a lane can return success-shaped EMPTY results and nothing in routing notices.
- `open-bugs.md:130` — DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted).
- `open-bugs.md:155` — A spec row's category prefix is load-bearing enough to manufacture work — and one was false (2026-07-28, low, RESOLVED; the open half is the class).
- `open-bugs.md:169` — ⬇ LIVE (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim.
- `open-bugs.md:177` — ⬇ LIVE (re-dogfood 2026-07-22, low): a json_schema-required array elicits FILLER entries from weaker models when the true answer is empty.
- `open-bugs.md:195` — ⬇ LIVE (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it.
- `open-bugs.md:213` — LEAD (2026-07-22, low): does remediate's node-claim lifecycle share the merge-only-release defect the audit side just fixed?
- `open-bugs.md:221` — Regenerating the price snapshot INVERTS host tier cost order — the refresh is blocked on the service→vendor-id mapping, not merely followed by it (2026-07-24, medium, ATTEMPTED AND REVERTED).
- `open-bugs.md:247` — LEAD (low): NIM roster latency is bimodal — a slow model can read as a DEAD lane.
- `open-bugs.md:266` — ⬇ LIVE (re-dogfood): token_usage stamping asks for a split real harnesses cannot supply (2026-07-21, low).
- `open-bugs.md:272` — LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low).
- `open-bugs.md:277` — Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).
- `open-bugs.md:298` — Window-scope validation at the PRODUCER boundary — designed for step 2, deferred with reason (2026-07-19).
- `open-bugs.md:318` — A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.
- `open-bugs.md:338` — SPEC — the proxy catalog's freshness rule gates the WRITE but not the READ, and the lane has no operator-runnable refresh.
- `open-bugs.md:365` — Ranked-pool composition — live-wave watch + the absolute-floor question.
- `open-bugs.md:383` — H2+H4 collapse residual pins (2026-07-18, low, from review h2c3).
- `open-bugs.md:391` — Pre-existing back-compat fold survives, now against standing policy (2026-07-18; re-verified at HEAD 2026-07-26 — NOT low).
- `open-bugs.md:393` — "The free model can't handle reasoning work" is a MYTH built from unset request parameters — check `finish_reason` before diagnosing a model (friction: tool-should-decide, medium-high).
- `open-bugs.md:417` — A nightly item is PRESENTED for an answer without its premise being re-checked, so settled subjects keep getting asked (2026-07-25, medium, friction: inefficient-feeding).
- `open-bugs.md:435` — Friction walk (duplicated-guard lap, 2026-07-25):
- `open-bugs.md:447` — Friction walk (backlog triage + clearance lap, 2026-07-25):
- `open-bugs.md:466` — Friction walk (backlog clear-out lap, 2026-07-24):
- `open-bugs.md:483` — Every step prompt's trailing "Then run: … next-step" makes any DELEGATED step executor a second driver (claude-worker dogfood 2026-07-16, tool-should-decide, medium).
- `open-bugs.md:495` — The `charter_delta` step defaults its miner to the same host that merged `charter_extraction` — no mechanical author/critic split (2026-07-17 re-dogfood, tool-should-decide, medium).
- `open-bugs.md:506` — Self-audit dogfood loop: fixing the tool mid-run invalidates the run (claude-worker dogfood 2026-07-16, ambiguous-direction, low-medium).
- `open-bugs.md:518` — `AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` is an unmeasured estimate, and the lane cannot currently measure it (low, live-gated; the rest of the 2026-07-17 feedback-gap residuals are closed — plan `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md`).
- `open-bugs.md:520` — claude-worker lane residuals — two symptoms of ONE defect: identity is decided somewhere other than where it is known (2026-07-16, low-medium, deferred deliberately).
- `open-bugs.md:539` — A doc-lint hook rewrites prose between Read and Edit, so exact-match edits fail on text the agent never wrote (2026-07-16, inefficient-feeding, low).
- `open-bugs.md:552` — Neither new test guards the WIRING — only the mechanism and the loader (2026-07-16, low).
- `open-bugs.md:554` — A post-worker LANDING stage is still misfiled as dispatch — 2,845 of 5,978 lines under `src/remediate/steps/dispatch/`, plus marshal's merge half (owner question 2026-07-16, re-verified at HEAD 2026-07-24, medium).
- `open-bugs.md:557` — Two dispatch entry points disagree on fail-closed and on driver identity (owner question 2026-07-16, medium).
- `open-bugs.md:559` — G4 reduces to ONE narrow bug: `block_quota.host_model` is auditor IDENTITY persisted in the repo, and it outranks the descriptor (2026-07-16, medium).
- `open-bugs.md:587` — A declared source that verified reach and then lies at dispatch is never ejected — the reactive `lies reachably` quarantine has no catcher (found G4/G5 premise-check 2026-07-16, low).
- `open-bugs.md:599` — A ROTATING set of heavy suite tests fails only under parallel load — hermeticity, not regression (2026-07-16, tool-should-decide, low-medium).
- `open-bugs.md:615` — No read-only surface shows the built dispatch pools — an exclusion rule is unverifiable until a live dispatch (G3 A″ lap 2026-07-16, tool-should-decide, medium).
- `open-bugs.md:617` — Gate-0 display never reflects an exclusion for a SOURCE — no status column, and the endpoint tier can't mark a provider entry (G3 A″ lap 2026-07-16, tool-should-decide, low).
- `open-bugs.md:619` — The per-tool seam artifact marks `excluded` at provider granularity only — inert today (G3 A″ lap 2026-07-16, low).
- `open-bugs.md:621` — SPEC — split the two things currently merged into one "excluded" set; then host exclusion has an obvious meaning.
- `open-bugs.md:643` — The reconciliation gate is silently disabled if the two confirmation artifacts split (G3 A′ review 2026-07-16, tool-should-decide, low).
- `open-bugs.md:645` — Loop-core gate covers `src/audit/orchestrator/` but NOT the audit cli dispatch step-emitters (2a-ii lap, tool-should-decide, low-medium) [[loop-core-enforcement-layer]].
- `open-bugs.md:659` — Doc/lint gaps exposed by the G3 re-plan lap (2026-07-16) — three standing asks, all unbuilt at HEAD.
- `open-bugs.md:665` — Friction walk (repair-proxy dogfood lap, 2026-07-15):
- `open-bugs.md:667` — Contract-pipeline planning bills HOST quota only — no route to a $0 pool (inefficient-feeding, medium, two OWNER CALLS).
- `open-bugs.md:675` — A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).
- `open-bugs.md:677` — ⬇ LIVE-run watch only — unified routing A–G.
- `open-bugs.md:686` — SPEC — probe the local OpenAI-compatible ENDPOINT, the way CLI providers are probed on PATH.
- `open-bugs.md:699` — agy quota may reuse the wrong credential store (unverified, live-check).
- `open-bugs.md:701` — Dispatch routing: JIT reservation on the HOST path + the headless/hybrid branch collapse — the remaining two thirds of the pool-agnostic-claims design (2026-07-13; concept spec 2026-07-16; re-verified against HEAD 2026-07-24).
- `open-bugs.md:703` — Accept-latch — two low residuals stay open.
- `open-bugs.md:711` — Node-worktree guard — accepted residuals only (each low, on-evidence-only).
- `open-bugs.md:713` — Test-tree `.mjs`→`.ts` conversion: COMPLETE at its floor (2026-07-29).
- `open-bugs.md:735` — Friction walk (buildAccountScopedQuotaSource lap, 2026-07-29):
- `open-bugs.md:747` — Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):
- `open-bugs.md:763` — Friction walk (queue-closeout + first `.ts`-conversion lap, 2026-07-28):
- `open-bugs.md:775` — Friction walk (nightly-determinations lap, 2026-07-26):
- `open-bugs.md:801` — Friction walk (contract-sweep producer lap, 2026-07-26):
- `open-bugs.md:818` — Friction walk (inline-api_key retirement lap, 2026-07-26):
- `open-bugs.md:830` — Friction walk (touched_files load-gate lap, 2026-07-25):
- `open-bugs.md:844` — Friction walk (fourth backlog-clearance lap, 2026-07-24):
- `open-bugs.md:865` — Friction walk (second backlog-clearance lap, 2026-07-24):
- `open-bugs.md:874` — ▶ ⬇ LIVE-run watch ONLY — the per-node token estimate is WIRED (2026-07-25, loop-core).
- `open-bugs.md:885` — Remediation must never switch the primary checkout off its base branch (2026-07-22, medium; product fix planned).
- `open-bugs.md:908` — "Delegate the rolling loop" dispatcher pattern breaks on notification routing (2026-07-11 live run, tool-should-decide, medium).
- `open-bugs.md:929` — NIM in-process worker: one packet failed with "empty completion (no choices[0].message.content)" (2026-07-11 live run, watch).
- `open-bugs.md:933` — Abandoned HOST-path grants hold reservation leases to the 20-min TTL, walling a fresh grant (2026-07-11 live run, low — backstop works; not a release bug).
- `open-bugs.md:955` — A2b unmatched-quota fallback — two residuals (each low, documented at the code site).
- `open-bugs.md:968` — Design (remove-waves track): dispatch should be gated ONLY by token-budget, rate, and true task-unlocks — the host merge/re-grant barrier is artificial for independent review packets (2026-07-11 live run, owner design statement, forward-track).
- `open-bugs.md:987` — Host fan-out quota gate — residual: AD-HOC host Agent spawns sit outside every ledger (re-verified 2026-07-24, low, [[host-fanout-quota-gate]]).
- `open-bugs.md:996` — Design-review independence — the solo contract branch is pinned by a shared helper, not by a test (2026-07-24, low).
- `open-bugs.md:1013` — Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code site).
- `open-bugs.md:1036` — External shared-logic audit V1–V7 residuals
- `open-bugs.md:1053` — Top gate optimization lead — both packaged smokes REBUILD the identical package (measured 2026-07-06).
- `open-bugs.md:1067` — Dispatch admission-control rework — two residuals (env-bound / architectural, not blocking).
- `open-bugs.md:1089` — Quota-aware dispatch — live validation env-bound.
- `open-bugs.md:1104` — SPEC — a ledger-blocked retry must back off, reusing the ONE backoff the project already owns.
- `open-bugs.md:1118` — Friction detection — M-QUOTA escalation chain: remediate-side friction assertion missing; live validation env-bound.
- `open-bugs.md:1137` — Selective-deepening convergence — live validation env-bound.
- `open-bugs.md:1159` — A design-review pass can auto-complete EMPTY, and nothing distinguishes that from a real review finding nothing.
- `open-bugs.md:1167` — `goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD 2026-07-25).

### [`forward-tracks.md — Open tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:12` — Track 1 — Proxy-catalog enrichment has no source. LiteLLM is RETIRED (2026-07-28); the local lane is now `llm-relay` on `127.0.0.1:8791`, and it serves NEITHER catalog endpoint.
- `forward-tracks.md:53` — Track 2 — Ranker contract. ⚠ The "design a contract" framing is SUPERSEDED — the contract already exists and is in use.
- `forward-tracks.md:69` — Track 2.5 — Slim-down: ~9,400 removable lines, mapped and ranked in [`slimdown-review-2026-07-28.md`](./reviews/slimdown-review-2026-07-28.md). Nothing applied.
- `forward-tracks.md:86` — Track 3 — Gate-0 operator-confirmed priority order fallback (UX enhancement when no ranks exist).

### [`forward-tracks.md — Forward tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:108` — A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs.
- `forward-tracks.md:135` — Backend-identity axes — settle transport / service / locus once (design of record: [`spec/backend-identity-axes.md`](../spec/backend-identity-axes.md)).
- `forward-tracks.md:148` — One repo intent, three filenames — the audit/remediate intent split is a `one core, two draws` smell (surfaced by G3 recon 2026-07-16).
- `forward-tracks.md:163` — Generate the executor↔artifact mapping from the registries (anti-drift).
- `forward-tracks.md:170` — End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).
- `forward-tracks.md:178` — Free/cheap "quota-arbitrage" dispatch tier (9router-inspired) — extra SOURCE POOLS on existing machinery, not a new provider engine.
- `forward-tracks.md:230` — models.dev static window can over-state a specific deployment (carried from W1).
- `forward-tracks.md:250` — Schema-enforced generation — CE-004 residual is every prompt-only backend, not just the host.
- `forward-tracks.md:262` — Tool-enforced dispatch broker with capability-tiered driver.
- `forward-tracks.md:275` — Deterministic analyzers: own-vs-acquire engine.
- `forward-tracks.md:290` — Cross-provider quota — live-endpoint confirmation.
- `forward-tracks.md:301` — Remediate's `phase:main` has no merge-time ownership re-check before persist — a correctness gap.
- `forward-tracks.md:312` — Slice-3 — no live heartbeat on the LONG-lived execution claims (doc-review D-66/D-67/C-7; last open slice of the rolling-lifecycle unification).
- `forward-tracks.md:356` — Packet `task_ids`/`lens` attribution is missing from the token-usage ledger

### [`deferred.md`](backlog/deferred.md)

- `deferred.md:11` — A7 multi-host validation — automated half green, manual GUI half never run.
- `deferred.md:22` — Manual real-OpenCode validation
- `deferred.md:25` — Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts stay deferred (2026-07-24, low).

### [`durable-traps.md`](backlog/durable-traps.md)

- `durable-traps.md:16` — A local test RED can be an ambient-PATH artifact, not a regression.
- `durable-traps.md:23` — agy's headless lane is INERT until `~/.gemini/antigravity-cli/settings.json` grants tool permissions — and the grammar is `tool(target)` (verified live 2026-07-25).
- `durable-traps.md:36` — A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).
- `durable-traps.md:44` — An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).
- `durable-traps.md:50` — Never delete from a backlog file by LINE NUMBER.
- `durable-traps.md:56` — The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model
- `durable-traps.md:80` — The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).
- `durable-traps.md:88` — Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).
- `durable-traps.md:97` — Concurrent agent sessions can share the ONE primary checkout (2026-07-23).
- `durable-traps.md:106` — The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21).
- `durable-traps.md:113` — The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium).
- `durable-traps.md:121` — Global `fetch` cannot outlast a long reasoning call — undici's 300s `headersTimeout` is measured to the FIRST byte and `globalThis.fetch` cannot be told otherwise (2026-07-20, low; remedy corrected 2026-07-24).
- `durable-traps.md:140` — `$TMPDIR` is UNSET in the Bash tool, so `"$TMPDIR/x"` writes to the shell's install dir (2026-07-25, low).
- `durable-traps.md:150` — An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium).
- `durable-traps.md:161` — `codex exec` hangs on an open stdin — inside the product that is guaranteed by the spawn substrate, not by each spawn site.
- `durable-traps.md:176` — A retired or unrecognized key in the machine declaration file fails as a MISSING lane (2026-07-18).
- `durable-traps.md:189` — The free offload lane is the local `llm-relay` proxy — it must be RUNNING, and the model must be NAMESPACED (LiteLLM retired 2026-07-28).
- `durable-traps.md:207` — After an unattended run, `git diff` the tracked docs before committing.
- `durable-traps.md:220` — npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).
- `durable-traps.md:242` — `git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is NOT a rejection.
- `durable-traps.md:248` — `tests/audit/audit-code-completion.test.ts` is the slowest file in the whole suite, not just in audit.
- `durable-traps.md:265` — Codex CLI can burn a long wall-clock on large read-heavy audit packets.
- `durable-traps.md:276` — Remediate-code worktree branches strand commits off main.
- `durable-traps.md:278` — Wall-clock peak-concurrency tests are latency-fragile.
- `durable-traps.md:293` — One test runner: vitest
- `durable-traps.md:307` — Don't mask the test exit code with a REDIRECT.
- `durable-traps.md:315` — Global `-g` install BLOCKS `postinstall`
- `durable-traps.md:325` — A global junction to a LIVE working tree silently shadows a registry install.
- `durable-traps.md:331` — PowerShell
- `durable-traps.md:341` — Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently.
- `durable-traps.md:357` — A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY.
- `durable-traps.md:372` — Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one.
- `durable-traps.md:379` — Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.
- `durable-traps.md:384` — No host-side unblock for a wedged audit run — use `audit-code force-synthesis`.
- `durable-traps.md:395` — `pre-commit-gate.mjs` fires only on `git commit`, so every OTHER commit-creating git subcommand lands ungated (2026-07-22, corrected 2026-07-24, low, friction: tool-should-decide).
- `durable-traps.md:397` — A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).
- `durable-traps.md:399` — A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.
- `durable-traps.md:407` — The Grep tool's content output can mangle comment markers with a BACKSLASH.
- `durable-traps.md:412` — A typecheck sweep's error count is not final until you re-run it.
- `durable-traps.md:420` — An untypechecked fixture can sit inert for months while its suite reads green.
- `durable-traps.md:432` — Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.
- `durable-traps.md:443` — A backlog entry's bold title must not contain `

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


