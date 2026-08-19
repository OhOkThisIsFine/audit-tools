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
> and at commit). 121 entr(y/ies) indexed.

### [`open-bugs.md`](backlog/open-bugs.md)

- `open-bugs.md:9` — The nightly inbox wipes doc-citation-exempt markers on every render, so its stale-path citation reds recur (2026-08-19, low, owner decision pending).
- `open-bugs.md:17` — `HOST_GATE_DESCRIPTORS` / `HOST_GATE_KINDS` is a write-only registry — completed by P25, read by nothing in production (2026-08-19, low, owner decision pending).
- `open-bugs.md:25` — Coherence components have no granularity control, so a whole audit collapses into one work block (2026-08-13, high).
- `open-bugs.md:39` — The HANDOFF empty-queue projection contract is full-suite-only, so the commit gates pass a red against it (2026-08-18, low, friction).
- `open-bugs.md:47` — `runCommand` buffers child output unboundedly (2026-08-13, medium).
- `open-bugs.md:54` — `shell-trap-guard` misses `git stash push <pathspec>` eating uncommitted work (2026-08-12, medium).
- `open-bugs.md:60` — Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).
- `open-bugs.md:68` — Diff-based re-review loses the verdict it must diff against (2026-08-08, low).
- `open-bugs.md:74` — `free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low).
- `open-bugs.md:78` — Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low).
- `open-bugs.md:83` — Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).
- `open-bugs.md:92` — Regex-perf triage tail from the analyzer sweep (2026-08-07, low).
- `open-bugs.md:99` — Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test passes", 2026-08-06).
- `open-bugs.md:118` — Remediation pause/recovery is not durable (2026-08-03, medium).
- `open-bugs.md:126` — Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).
- `open-bugs.md:133` — Phase-boundary gate false abandonment (2026-07-30, HIGH).
- `open-bugs.md:144` — Contract-type coverage is derived from where TESTS live, not from the contract (2026-07-25, low, friction: inefficient-feeding).
- `open-bugs.md:153` — Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction).
- `open-bugs.md:163` — DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted).
- `open-bugs.md:188` — A spec row's category prefix is load-bearing enough to manufacture work — and one was false (2026-07-28, low, RESOLVED; the open half is the class).
- `open-bugs.md:199` — ⬇ Live-run watch (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim.
- `open-bugs.md:207` — ⬇ Live-run watch (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it.
- `open-bugs.md:225` — LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low).
- `open-bugs.md:230` — Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).
- `open-bugs.md:251` — A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.
- `open-bugs.md:271` — Friction walk (determinations-execution lap, 2026-07-29):
- `open-bugs.md:285` — Friction walk (duplicated-guard lap, 2026-07-25):
- `open-bugs.md:297` — Implementation workers are never given the contract they must satisfy (2026-08-09, high).
- `open-bugs.md:307` — A delegated step prompt can turn its executor into a second driver (2026-07-16, tool-should-decide, medium).
- `open-bugs.md:323` — Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16, ambiguous-direction, low-medium).
- `open-bugs.md:339` — A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).
- `open-bugs.md:341` — Friction walk (niggle-fix lap, 2026-08-07):
- `open-bugs.md:357` — Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):
- `open-bugs.md:369` — Friction walk (queue-closeout + first `.ts`-conversion lap, 2026-07-28):
- `open-bugs.md:384` — Friction walk (nightly-determinations lap, 2026-07-26):
- `open-bugs.md:396` — Friction walk (contract-sweep producer lap, 2026-07-26):
- `open-bugs.md:408` — Friction walk (touched_files load-gate lap, 2026-07-25):
- `open-bugs.md:414` — Friction walk (fourth backlog-clearance lap, 2026-07-24):
- `open-bugs.md:427` — Friction walk (second backlog-clearance lap, 2026-07-24):
- `open-bugs.md:436` — Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code site).
- `open-bugs.md:462` — External shared-logic audit V1–V7 residuals
- `open-bugs.md:474` — Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured 2026-07-06).
- `open-bugs.md:480` — Selective-deepening convergence — live validation env-bound.
- `open-bugs.md:488` — `goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD 2026-07-25).
- `open-bugs.md:497` — `StepArtifactSchema` is `.strict()` but `writeStepContract` injects `agent_id`.
- `open-bugs.md:503` — systemic_challenge findings ids are adversary-invented and round-colliding.
- `open-bugs.md:510` — The systemic_challenge loop has no ceiling — its only exit is a dry signal the host may have to fabricate.
- `open-bugs.md:517` — `ensure` writes opencode.json with unstable key order.
- `open-bugs.md:522` — Two run-id notions; friction record keyed both ways.
- `open-bugs.md:528` — Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification (2026-08-06, lead, low).
- `open-bugs.md:533` — `hostInputPause.ts` says analyzer consent lives in session config; it lives in `.audit-tools/audit/analyzer-policy.json` (2026-08-12, nightly, low).
- `open-bugs.md:542` — `writeOpenItems` reads `subject_key` but never computes or requires it; the HANDOFF generator hard-requires it (2026-08-14, nightly, low).
- `open-bugs.md:552` — `check:memory-citations` cannot see a `[[name]]` cross-link, and 4 are already dangling (2026-08-14, nightly, low).
- `open-bugs.md:563` — Steward verification metadata is undeliverable through the host-result envelope (hit 2026-08-18).
- `open-bugs.md:573` — The report renderer emits control characters from finding prose raw (hit 2026-08-18).

### [`forward-tracks.md — Open tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:11` — Track 2.5 — keep production-orphan detection beside knip.

### [`forward-tracks.md — Forward tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:25` — A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs.
- `forward-tracks.md:51` — Generate the executor↔artifact mapping from the registries (anti-drift).
- `forward-tracks.md:58` — End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).
- `forward-tracks.md:66` — Deterministic analyzers: own-vs-acquire engine.
- `forward-tracks.md:81` — CI wall-clock: shard balance and the single-file floor.
- `forward-tracks.md:88` — Obligation-id slugs and decomposed-module names are two name spaces joined by a prefix match.
- `forward-tracks.md:100` — Wave-friendly host dispatch: run identity survives partial ingest.
- `forward-tracks.md:114` — Isolated-branch landing gap — a remediation run dispatched on its own `remediation/<runId>` branch has no closing action that lands it on the base branch.

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
- `durable-traps.md:80` — The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model
- `durable-traps.md:109` — The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).
- `durable-traps.md:117` — Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).
- `durable-traps.md:126` — Concurrent agent sessions can share the ONE primary checkout (2026-07-23).
- `durable-traps.md:135` — The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21).
- `durable-traps.md:149` — The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium).
- `durable-traps.md:157` — An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium).
- `durable-traps.md:167` — The free offload lane is a local router — it must be RUNNING, and callers should request the `auto` alias.
- `durable-traps.md:194` — After an unattended run, `git diff` the tracked docs before committing.
- `durable-traps.md:206` — npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).
- `durable-traps.md:228` — `git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is NOT a rejection.
- `durable-traps.md:234` — The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file wall is expected, not a hang.
- `durable-traps.md:254` — One test runner: vitest
- `durable-traps.md:268` — Don't mask the test exit code with a REDIRECT.
- `durable-traps.md:286` — Global `-g` install BLOCKS `postinstall`
- `durable-traps.md:296` — A global junction to a LIVE working tree silently shadows a registry install.
- `durable-traps.md:302` — PowerShell
- `durable-traps.md:311` — Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently.
- `durable-traps.md:327` — A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY.
- `durable-traps.md:340` — Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one.
- `durable-traps.md:347` — Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.
- `durable-traps.md:352` — Do not hand-edit a wedged audit run — use `audit-code force-synthesis`.
- `durable-traps.md:357` — A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).
- `durable-traps.md:359` — A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.
- `durable-traps.md:367` — The Grep tool's content output can mangle comment markers with a BACKSLASH.
- `durable-traps.md:372` — After a "string to replace not found" on text you JUST wrote, grep for the anchor instead of re-reading the whole file (2026-07-16).
- `durable-traps.md:376` — A typecheck sweep's error count is not final until you re-run it.
- `durable-traps.md:384` — An untypechecked fixture can sit inert for months while its suite reads green.
- `durable-traps.md:405` — Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.
- `durable-traps.md:416` — A backlog entry's bold title must not contain `
- `durable-traps.md:421` — Child sessions in the shared checkout — session-registry split (2026-08-18, mechanized; supersedes the 2026-08-07/09 kill-switch advice).
- `durable-traps.md:453` — The `audit-code-completion-*` files can flake together under full-suite load, and the symptom reads exactly like a regression (2026-08-09).
- `durable-traps.md:466` — An offload recon lane reading a file you are concurrently editing reports the POST-edit tree (2026-08-07).
- `durable-traps.md:473` — Long offload recon jobs die mid-response; short ones do not (2026-08-07).
- `durable-traps.md:487` — `.audit-tools/remediation-report.md` and `-outcomes.json` are TRACKED — archiving a finished run deletes them (2026-08-09).
- `durable-traps.md:498` — A background lane piped through `tail`/`head` shows ZERO bytes until it exits (2026-08-09).
- `durable-traps.md:507` — Right after the free router restarts, its `/v1` Anthropic surface can forward a router-local key UPSTREAM — a transient 401 window, not a permanent property (2026-08-09).
- `durable-traps.md:524` — A trivial `claude.ps1 -p` prompt did not return in 5 min while the router answered in 0.4s (2026-08-09).
- `durable-traps.md:531` — A free-pool reply that returns nothing usable is usually `finish_reason: max_tokens`, not a weak model (2026-08-09).
- `durable-traps.md:542` — `.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between its markers is silently wiped (2026-07-30).
- `durable-traps.md:551` — The contract-pipeline repair prompt orders the OPPOSITE of the repair invariant (2026-08-09).
- `durable-traps.md:559` — A critique can prescribe a remedy the pipeline structurally cannot perform (2026-08-09).
- `durable-traps.md:568` — The per-project memory store has NO locking, and a concurrent session silently reverts your edits (2026-08-09).
- `durable-traps.md:575` — The `~/.claude/…/memory/MEMORY.md` index has no size gate, and the harness read limit is a hard cliff (2026-08-09).
- `durable-traps.md:581` — An attestation binds to the staged tree, and a later gate-demanded regeneration used to void it (2026-08-09; ENFORCED at the attest scripts 2026-08-12, P19).
- `durable-traps.md:596` — `docs/backlog.md` is NOT a record path to `writeOpenItems`, but `docs/backlog/*` is
- `durable-traps.md:607` — Git-bash `/tmp` and node's `C: mp` are different directories (hit 2026-08-18).

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


Some open items carry a **⬇ Live-run watch** line: exactly what to observe during a real run to
confirm the fix validated — or to catch it failing. Pick a run config from this matrix; watch the
items it lights up.

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
