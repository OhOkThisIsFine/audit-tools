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
> and at commit). 120 entr(y/ies) indexed.

### [`open-bugs.md`](backlog/open-bugs.md)

- `open-bugs.md:9` — Coherence components have no granularity control, so a whole audit collapses into one work block (2026-08-13, high).
- `open-bugs.md:23` — `runCommand` buffers child output unboundedly (2026-08-13, medium).
- `open-bugs.md:30` — `shell-trap-guard` misses `git stash push <pathspec>` eating uncommitted work (2026-08-12, medium).
- `open-bugs.md:36` — Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).
- `open-bugs.md:44` — Diff-based re-review loses the verdict it must diff against (2026-08-08, low).
- `open-bugs.md:50` — `free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low).
- `open-bugs.md:54` — Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low).
- `open-bugs.md:59` — Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).
- `open-bugs.md:68` — Regex-perf triage tail from the analyzer sweep (2026-08-07, low).
- `open-bugs.md:75` — Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test passes", 2026-08-06).
- `open-bugs.md:94` — Remediation pause/recovery is not durable (2026-08-03, medium).
- `open-bugs.md:102` — Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).
- `open-bugs.md:109` — Phase-boundary gate false abandonment (2026-07-30, HIGH).
- `open-bugs.md:120` — A contract change swept `tests/` and missed the PRODUCERS in `scripts/` — caught only by CI (2026-07-25, low, friction: inefficient-feeding).
- `open-bugs.md:134` — Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction).
- `open-bugs.md:144` — DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted).
- `open-bugs.md:169` — A spec row's category prefix is load-bearing enough to manufacture work — and one was false (2026-07-28, low, RESOLVED; the open half is the class).
- `open-bugs.md:180` — ⬇ LIVE (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim.
- `open-bugs.md:188` — ⬇ LIVE (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it.
- `open-bugs.md:206` — LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low).
- `open-bugs.md:211` — Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).
- `open-bugs.md:232` — A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.
- `open-bugs.md:252` — Friction walk (determinations-execution lap, 2026-07-29):
- `open-bugs.md:266` — Friction walk (duplicated-guard lap, 2026-07-25):
- `open-bugs.md:278` — Implementation workers are never given the contract they must satisfy (2026-08-09, high).
- `open-bugs.md:288` — `obligation_ledger.input.json` is listed as a required input but never written (2026-08-09, low).
- `open-bugs.md:294` — A delegated step prompt can turn its executor into a second driver (2026-07-16, tool-should-decide, medium).
- `open-bugs.md:310` — Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16, ambiguous-direction, low-medium).
- `open-bugs.md:326` — A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).
- `open-bugs.md:328` — Friction walk (niggle-fix lap, 2026-08-07):
- `open-bugs.md:344` — Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):
- `open-bugs.md:356` — Friction walk (queue-closeout + first `.ts`-conversion lap, 2026-07-28):
- `open-bugs.md:368` — Friction walk (nightly-determinations lap, 2026-07-26):
- `open-bugs.md:380` — Friction walk (contract-sweep producer lap, 2026-07-26):
- `open-bugs.md:392` — Friction walk (touched_files load-gate lap, 2026-07-25):
- `open-bugs.md:398` — Friction walk (fourth backlog-clearance lap, 2026-07-24):
- `open-bugs.md:411` — Friction walk (second backlog-clearance lap, 2026-07-24):
- `open-bugs.md:420` — Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code site).
- `open-bugs.md:446` — External shared-logic audit V1–V7 residuals
- `open-bugs.md:458` — Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured 2026-07-06).
- `open-bugs.md:464` — Selective-deepening convergence — live validation env-bound.
- `open-bugs.md:472` — `goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD 2026-07-25).
- `open-bugs.md:481` — `StepArtifactSchema` is `.strict()` but `writeStepContract` injects `agent_id`.
- `open-bugs.md:487` — systemic_challenge findings ids are adversary-invented and round-colliding.
- `open-bugs.md:494` — The systemic_challenge loop has no ceiling — its only exit is a dry signal the host may have to fabricate.
- `open-bugs.md:501` — CI trigger paths omit `.claude/
- `open-bugs.md:508` — `ensure` writes opencode.json with unstable key order.
- `open-bugs.md:513` — Two run-id notions; friction record keyed both ways.
- `open-bugs.md:519` — Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification (2026-08-06, lead, low).
- `open-bugs.md:524` — `hostInputPause.ts` says analyzer consent lives in session config; it lives in `analyzer-policy.json` (2026-08-12, nightly, low).
- `open-bugs.md:533` — `writeOpenItems` reads `subject_key` but never computes or requires it; the HANDOFF generator hard-requires it (2026-08-14, nightly, low).
- `open-bugs.md:543` — `check:memory-citations` cannot see a `[[name]]` cross-link, and 4 are already dangling (2026-08-14, nightly, low).
- `open-bugs.md:554` — Steward verification metadata is undeliverable through the host-result envelope (hit 2026-08-18).
- `open-bugs.md:564` — The report renderer emits control characters from finding prose raw (hit 2026-08-18).

### [`forward-tracks.md — Open tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:11` — Track 2.5 — keep production-orphan detection beside knip.

### [`forward-tracks.md — Forward tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:25` — A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs.
- `forward-tracks.md:50` — Generate the executor↔artifact mapping from the registries (anti-drift).
- `forward-tracks.md:57` — End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).
- `forward-tracks.md:65` — Deterministic analyzers: own-vs-acquire engine.
- `forward-tracks.md:80` — CI wall-clock: shard balance and the single-file floor.
- `forward-tracks.md:87` — Obligation-id slugs and decomposed-module names are two name spaces joined by a prefix match.
- `forward-tracks.md:99` — Wave-friendly host dispatch: run identity survives partial ingest.
- `forward-tracks.md:113` — `ensureGlobalAssets` is now production-unwired — decide whether it is duplicated or genuinely dead.

### [`deferred.md`](backlog/deferred.md)

- `deferred.md:11` — A7 multi-host validation — automated half green, manual GUI half never run.
- `deferred.md:21` — Manual real-OpenCode validation
- `deferred.md:24` — Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts stay deferred (2026-07-24, low).

### [`durable-traps.md`](backlog/durable-traps.md)

- `durable-traps.md:16` — A vitest CLI file filter resurrects same-suffixed test COPIES under stale worktree dirs (2026-08-06).
- `durable-traps.md:27` — The Workflow tool's per-agent `model` override may not take (observed 2026-08-06).
- `durable-traps.md:34` — A broad multi-file review scope kills both peer-CLI lanes, and they fail in OPPOSITE shapes (2026-08-09 and 2026-08-10, four deaths in two nights).
- `durable-traps.md:47` — A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).
- `durable-traps.md:55` — An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).
- `durable-traps.md:60` — Never delete from a backlog file by LINE NUMBER.
- `durable-traps.md:66` — A Claude lane whose isolated `CLAUDE_CONFIG_DIR` has not TRUSTED the workspace answers from nothing rather than failing (2026-08-15).
- `durable-traps.md:79` — The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model
- `durable-traps.md:106` — The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).
- `durable-traps.md:114` — Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).
- `durable-traps.md:123` — Concurrent agent sessions can share the ONE primary checkout (2026-07-23).
- `durable-traps.md:132` — The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21).
- `durable-traps.md:146` — The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium).
- `durable-traps.md:154` — An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium).
- `durable-traps.md:164` — The free offload lane is a local router — it must be RUNNING, and callers should request the `auto` alias.
- `durable-traps.md:189` — After an unattended run, `git diff` the tracked docs before committing.
- `durable-traps.md:201` — npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).
- `durable-traps.md:223` — `git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is NOT a rejection.
- `durable-traps.md:229` — The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file wall is expected, not a hang.
- `durable-traps.md:249` — One test runner: vitest
- `durable-traps.md:263` — Don't mask the test exit code with a REDIRECT.
- `durable-traps.md:278` — Global `-g` install BLOCKS `postinstall`
- `durable-traps.md:288` — A global junction to a LIVE working tree silently shadows a registry install.
- `durable-traps.md:294` — PowerShell
- `durable-traps.md:303` — Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently.
- `durable-traps.md:319` — A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY.
- `durable-traps.md:332` — Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one.
- `durable-traps.md:339` — Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.
- `durable-traps.md:344` — Do not hand-edit a wedged audit run — use `audit-code force-synthesis`.
- `durable-traps.md:349` — A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).
- `durable-traps.md:351` — A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.
- `durable-traps.md:359` — The Grep tool's content output can mangle comment markers with a BACKSLASH.
- `durable-traps.md:364` — After a "string to replace not found" on text you JUST wrote, grep for the anchor instead of re-reading the whole file (2026-07-16).
- `durable-traps.md:368` — A typecheck sweep's error count is not final until you re-run it.
- `durable-traps.md:376` — An untypechecked fixture can sit inert for months while its suite reads green.
- `durable-traps.md:397` — Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.
- `durable-traps.md:408` — A backlog entry's bold title must not contain `
- `durable-traps.md:413` — Child sessions in the shared checkout — session-registry split (2026-08-18, mechanized; supersedes the 2026-08-07/09 kill-switch advice).
- `durable-traps.md:443` — The `audit-code-completion-*` files can flake together under full-suite load, and the symptom reads exactly like a regression (2026-08-09).
- `durable-traps.md:456` — An offload recon lane reading a file you are concurrently editing reports the POST-edit tree (2026-08-07).
- `durable-traps.md:463` — Long offload recon jobs die mid-response; short ones do not (2026-08-07).
- `durable-traps.md:477` — `.audit-tools/remediation-report.md` and `-outcomes.json` are TRACKED — archiving a finished run deletes them (2026-08-09).
- `durable-traps.md:488` — A background lane piped through `tail`/`head` shows ZERO bytes until it exits (2026-08-09).
- `durable-traps.md:497` — Right after the free router restarts, its `/v1` Anthropic surface can forward a router-local key UPSTREAM — a transient 401 window, not a permanent property (2026-08-09).
- `durable-traps.md:514` — A trivial `claude.ps1 -p` prompt did not return in 5 min while the router answered in 0.4s (2026-08-09).
- `durable-traps.md:521` — A free-pool reply that returns nothing usable is usually `finish_reason: max_tokens`, not a weak model (2026-08-09).
- `durable-traps.md:532` — `.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between its markers is silently wiped (2026-07-30).
- `durable-traps.md:541` — The contract-pipeline repair prompt orders the OPPOSITE of the repair invariant (2026-08-09).
- `durable-traps.md:549` — A critique can prescribe a remedy the pipeline structurally cannot perform (2026-08-09).
- `durable-traps.md:558` — The per-project memory store has NO locking, and a concurrent session silently reverts your edits (2026-08-09).
- `durable-traps.md:565` — `MEMORY.md` has no size gate, and the harness read limit is a hard cliff (2026-08-09).
- `durable-traps.md:571` — An attestation binds to the staged tree, and a later gate-demanded regeneration used to void it (2026-08-09; ENFORCED at the attest scripts 2026-08-12, P19).
- `durable-traps.md:585` — `docs/backlog.md` is NOT a record path to `writeOpenItems`, but `docs/backlog/*` is
- `durable-traps.md:596` — Git-bash `/tmp` and node's `C: mp` are different directories (hit 2026-08-18).

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
| **Any** live audit | Selective-deepening convergence · prompt-bound result ingestion · knip `files`/`dependencies` dead-code leads |
| **Any** live remediation on a dirty checkout | Allowed-file enforcement · run-start-dirt overlap · commit/test/worktree evidence · pause/resume continuity |
| **Two cooperating hosts** | Idempotent audit ingestion · locked remediation state transitions · stale workload rejection |
| **Rust or Ruby target repo** | clippy (cargo) + rubocop (bundle) live spawn |

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a crash
while ingesting a partial workload · an analyzer that silently skipped when it should have spawned ·
a host result accepted despite a prompt/scope mismatch · knip dead-code leads that never reach the
per-file lens. (The A2 oracle corpus is now
pinned public repos, not labeled live runs — a run's findings are at most optional calibration
data; see Deferred / waiting.)

---
