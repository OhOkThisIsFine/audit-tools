# Backlog — index

> Open work, durable traps and future directions, split so each file is ONE bounded read.
>
> A living to-do list, not a status log. Remove an entry once it ships; record durable contracts
> and rationale in project memory or `CLAUDE.md`, never "where the code is today".

| File | What lives there |
|---|---|
| [`backlog/open-bugs.md`](backlog/open-bugs.md) | Fixable defects and friction — the working queue |
| [`backlog/minor-bugs.md`](backlog/minor-bugs.md) | The same fixable defects at LOW severity — split off on size alone; re-tagging an entry moves it |
| [`backlog/forward-tracks.md`](backlog/forward-tracks.md) | Open tracks + design-level directions |
| [`backlog/deferred.md`](backlog/deferred.md) | Blocked on data, a live run, creds or a toolchain |
| [`backlog/durable-traps.md`](backlog/durable-traps.md) | Standing environment reference + doc-set hygiene |

**Current cross-cutting review:** [`Verified repository review and governance simplification plan — 2026-09-19`](reviews/audit-tools-governance-simplification-2026-09-19.md) is the single source for the verified repository-level recommendations and governance-reduction sequence. Existing bug/track entries remain the issue-level work records.

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

- `open-bugs.md:9` — The session-start "commits BEHIND origin/main" warning measures the main checkout, not the session's worktree (2026-10-06, medium).
- `open-bugs.md:11` — The shipped TOML parser carries two high advisories (2026-10-06, high).
- `open-bugs.md:13` — A step contract lists every pending result path (2026-10-05, medium).
- `open-bugs.md:15` — Inspection coverage claims are accepted on the host's word (2026-10-05, medium).
- `open-bugs.md:17` — Charter packets are sized by accident, not by the charter question (2026-10-05, medium).
- `open-bugs.md:19` — A commit gate reports its refusals one class at a time (2026-10-05, medium, friction: tool_should_decide).
- `open-bugs.md:21` — `SchemaVersionMismatchError` tells the operator to delete state it cannot regenerate (2026-10-06, medium).
- `open-bugs.md:23` — `check-backlog-budget --update-baseline` grandfathers new violators (2026-10-06, medium).
- `open-bugs.md:25` — The attestation gate judges an edit to itself with the edited copy (2026-10-04, medium).
- `open-bugs.md:27` — A loop-core commit needs a second full suite before it can land (2026-10-04, medium, friction: tool_should_decide).
- `open-bugs.md:29` — The constitutional-doc commit gate refuses a diff confined to a generated region (2026-10-04, low, friction: tool_should_decide).
- `open-bugs.md:31` — A code comment that states a workflow SHAPE or a prose ENUMERATION is checked by nothing (2026-08-31, medium, friction: tool_should_decide).
- `open-bugs.md:39` — The TASK draw's coherence eligibility is still disjunctive and has never been measured for collapse (2026-08-19, medium).
- `open-bugs.md:46` — Selective-deepening convergence — live validation env-bound.

### [`minor-bugs.md`](backlog/minor-bugs.md)

- `minor-bugs.md:14` — A partial withdrawal reports a complete item as rejected (2026-10-06, low).
- `minor-bugs.md:16` — Conceptual perspective lanes read only the head of the call-site map (2026-10-05, low).
- `minor-bugs.md:18` — The lock heartbeat only logs a stolen lock (2026-10-06, low).
- `minor-bugs.md:20` — `explain-task` takes the first token after the verb as the task id (2026-10-06, low).
- `minor-bugs.md:22` — A fractional positive-integer flag becomes 0 (2026-10-06, low).
- `minor-bugs.md:24` — `status` drops `not_applicable` obligations from its summary (2026-10-06, low).
- `minor-bugs.md:26` — `loopCoreClosure.mjs` drops directory imports from the importer graph (2026-10-06, low).
- `minor-bugs.md:28` — The vitest shard duration baseline is stale, so duration sharding is off (2026-10-06, low).
- `minor-bugs.md:30` — `bounded-call-single-source.test.ts` matches `advance(` in raw text (2026-10-05, low).
- `minor-bugs.md:32` — A repeated `--reviewed-by` keeps only its last value (2026-10-05, low).
- `minor-bugs.md:34` — The repo tool-input guard took a plain worktree sub-agent for an audit node (2026-10-05, low).
- `minor-bugs.md:36` — The stale-main guard reports a sync that already happened (2026-10-05, low).
- `minor-bugs.md:38` — Test-command discovery knows only npm, Go and pytest (2026-10-06, low).
- `minor-bugs.md:40` — DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted).

### [`forward-tracks.md — Open tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:17` — Track 2.5 — keep production-orphan detection beside knip.

### [`forward-tracks.md — Forward tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:32` — Deterministic analyzers: own-vs-acquire engine.
- `forward-tracks.md:47` — CI wall-clock: shard balance and the single-file floor.
- `forward-tracks.md:56` — Shared orchestration retains deliberate consumer policies.
- `forward-tracks.md:59` — The ship pipeline stops before the steps that finish it, and the remainder is agent prose (2026-08-27, from the philosophy audit).

### [`deferred.md`](backlog/deferred.md)

- `deferred.md:11` — The P1–P8 hardening contract waits for an isolated, platform-qualified execution environment (2026-10-07, medium).
- `deferred.md:21` — A7 multi-host validation — automated half green, manual GUI half never run.
- `deferred.md:31` — Manual real-OpenCode validation
- `deferred.md:34` — Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts stay deferred (2026-07-24, low).

### [`durable-traps.md`](backlog/durable-traps.md)

- `durable-traps.md:16` — Never run `npm test` concurrently with any other `npm run check:*` in the same worktree (2026-09-15).
- `durable-traps.md:26` — A checkout under a deep directory fails on Windows: "Filename too long" (2026-10-01).
- `durable-traps.md:31` — A background PowerShell task can fail with NO output (2026-09-18).
- `durable-traps.md:36` — An entry that reinterprets an incident must quote or link the primary record's own words for the mechanism, not restate them.
- `durable-traps.md:40` — A guard that fires AS DESIGNED is not friction and is never re-filed as a defect (owner decision 2026-09-05, nightly item bl-1).
- `durable-traps.md:50` — A delegated `codex exec` lane runs the sprint ceremony and CONSUMES the session's lap record (2026-08-29, ENFORCED IN PART).
- `durable-traps.md:65` — `gh run list --commit <short-sha>` silently returns an EMPTY set — the flag matches the FULL 40-character sha only (2026-08-29).
- `durable-traps.md:71` — Parallel deep `codex exec` lanes exhaust the ChatGPT quota in well under an hour, and a lane dies mid-answer with NO verdict (2026-08-28).
- `durable-traps.md:83` — Mechanical-analyzer acquisitions decided against — do not re-propose without new evidence (folded here 2026-08-27 from the retired mechanical-analyzer layer spec, now deleted).
- `durable-traps.md:98` — `git add -A` in a SHARED checkout commits a CONCURRENT session's files under your message (2026-08-26).
- `durable-traps.md:107` — Generating code through a Bash heredoc loses ONE level of backslash escaping (2026-08-26).
- `durable-traps.md:116` — Two pushes landing close together can leave the NEWER commit with no CI signal (2026-08-26).
- `durable-traps.md:123` — A session rooted ABOVE the repo loads NONE of its Claude Code hooks (measured 2026-08-26) — the COMMIT gate no longer depends on that, the shell traps still do.
- `durable-traps.md:135` — A tracked generated doc that links to an UNTRACKED file blocks every docs-touching commit (2026-08-20).
- `durable-traps.md:145` — `git commit` after `git add <paths>` commits the whole INDEX, not your paths (2026-08-20).
- `durable-traps.md:151` — A vitest CLI file filter resurrects same-suffixed test COPIES under stale worktree dirs (2026-08-06).
- `durable-traps.md:162` — The Workflow tool's per-agent `model` override may not take (observed 2026-08-06).
- `durable-traps.md:169` — A spend-limit death returns a workflow as `completed` with a success-shaped empty result (2026-08-25).
- `durable-traps.md:179` — A broad multi-file review scope kills both peer-CLI lanes, and they fail in OPPOSITE shapes (2026-08-09 and 2026-08-10, four deaths in two nights).
- `durable-traps.md:206` — A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).
- `durable-traps.md:214` — An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).
- `durable-traps.md:219` — Never delete from a backlog file by LINE NUMBER.
- `durable-traps.md:225` — A long multi-line prompt passed INLINE to a peer-CLI lane arrives truncated, and the lane then offers to work from whatever file it can find (2026-08-23).
- `durable-traps.md:238` — A lane that lost its tools FABRICATES a confident answer instead of failing — but workspace trust is NOT what takes them away (2026-08-15, premise corrected by measurement 2026-08-29).
- `durable-traps.md:261` — The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model
- `durable-traps.md:289` — The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).
- `durable-traps.md:302` — Empty repo-root files named from code or prose are cmd.exe REDIRECT artifacts, and since 2026-08-30 NOTHING in this repo watches for them (relanded here as its guard was deleted).
- `durable-traps.md:319` — Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).
- `durable-traps.md:333` — Concurrent agent sessions can share the ONE primary checkout (2026-07-23).
- `durable-traps.md:351` — The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21).
- `durable-traps.md:365` — The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium).
- `durable-traps.md:373` — An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium).
- `durable-traps.md:383` — After an unattended run, `git diff` the tracked docs before committing.
- `durable-traps.md:395` — npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).
- `durable-traps.md:417` — A direct push to `main` is refused since 2026-10-04 (`enforce_admins` on).
- `durable-traps.md:422` — The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file wall is expected, not a hang.
- `durable-traps.md:442` — A full vitest run can print `[vitest-worker]: Timeout calling "onTaskUpdate"` and exit 1 with 0 failed — read it through the gate, never raw.
- `durable-traps.md:453` — One test runner: vitest
- `durable-traps.md:467` — Don't mask the test exit code with a REDIRECT.
- `durable-traps.md:485` — Global `-g` install BLOCKS `postinstall`
- `durable-traps.md:495` — A global junction to a LIVE working tree silently shadows a registry install.
- `durable-traps.md:501` — PowerShell
- `durable-traps.md:510` — Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently.
- `durable-traps.md:527` — Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one.
- `durable-traps.md:534` — Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.
- `durable-traps.md:539` — Do not hand-edit a wedged audit run — use `audit-code force-synthesis`.
- `durable-traps.md:544` — A scratch file written into the repository root is tree dirt for the nightly clean-tree rule (2026-08-22, low).
- `durable-traps.md:551` — A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).
- `durable-traps.md:553` — A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.
- `durable-traps.md:561` — The Grep tool's content output can mangle comment markers with a BACKSLASH.
- `durable-traps.md:566` — After a "string to replace not found" on text you JUST wrote, grep for the anchor instead of re-reading the whole file (2026-07-16).
- `durable-traps.md:570` — A `check:*` typecheck leg can exit non-zero with NO error text when it races the async PostToolUse typecheck hook (2026-08-27).
- `durable-traps.md:578` — A typecheck sweep's error count is not final until you re-run it.
- `durable-traps.md:586` — An untypechecked fixture can sit inert for months while its suite reads green.
- `durable-traps.md:607` — Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.
- `durable-traps.md:618` — A backlog entry's bold title must not contain `
- `durable-traps.md:623` — Child sessions in the shared checkout — session-registry split (2026-08-18, mechanized; supersedes the 2026-08-07/09 kill-switch advice).
- `durable-traps.md:653` — A full-suite-only failure is classified by `runIsolatedDiagnostics` in `scripts/shared/run-vitest-gate.mjs`, never from a remembered file list.
- `durable-traps.md:662` — An offload recon lane reading a file you are concurrently editing reports the POST-edit tree (2026-08-07).
- `durable-traps.md:669` — Long offload recon jobs die mid-response; short ones do not (2026-08-07).
- `durable-traps.md:683` — `.audit-tools/remediation-report.md` and `-outcomes.json` are TRACKED — archiving a finished run deletes them (2026-08-09).
- `durable-traps.md:694` — A background lane piped through `tail`/`head` shows ZERO bytes until it exits (2026-08-09).
- `durable-traps.md:703` — An external-delegation directive and the Workflow tool are in tension — Workflow has no external lane (2026-08-27; reworded 2026-09-22 for the switch/agent-dispatch lap <!-- retired-infrastructure-exempt: llm-relay — replaced by agent-dispatch -->).
- `durable-traps.md:714` — agy lanes report no progress until they finish — `stdoutBytes` stays 0 for the whole run (2026-08-27).
- `durable-traps.md:722` — An execution override can be accepted without affecting the launched command.
- `durable-traps.md:727` — A reply that returns nothing usable can have exhausted its output budget.
- `durable-traps.md:733` — `.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between its markers is silently wiped (2026-07-30).
- `durable-traps.md:744` — The per-project memory store has NO locking, and a concurrent session silently reverts your edits (2026-08-09).
- `durable-traps.md:751` — The `~/.claude/…/memory/MEMORY.md` index has no size gate, and the harness read limit is a hard cliff (2026-08-09).
- `durable-traps.md:757` — An attestation binds to the staged tree, and a later gate-demanded regeneration used to void it (2026-08-09; ENFORCED at the attest scripts 2026-08-12, P19).
- `durable-traps.md:773` — Git-bash `/tmp` and node's `C: mp` are different directories (hit 2026-08-18).
- `durable-traps.md:778` — A commit-carries-its-record-update gate has a covered mechanical half and an uncovered semantic half (measured 2026-08-18, closed covered-by-neighbors).
- `durable-traps.md:792` — Never amend or rebase a landed wave commit after the remediation workload prepare (2026-08-19).
- `durable-traps.md:800` — A subagent's Read tool can serve STALE pre-edit content for a file another agent is concurrently editing (2026-08-20).
- `durable-traps.md:808` — A COMMENT-only edit to a graph extractor reds the graph-edge cache digest pin, and the failure text tells you to bump the cache version (2026-08-24).
- `durable-traps.md:816` — CBM graph tools can be absent while its daemon is healthy, and the fallback CLI can be cohort-locked (2026-08-26).
- `durable-traps.md:818` — Philosophy-audit challenges already answered — do not re-propose without new evidence (2026-08-27).
- `durable-traps.md:820` — A workflow killed mid-run by the monthly spend limit reports COMPLETED, and its partial results are recoverable by run id (2026-08-27).
- `durable-traps.md:832` — A long quoted heredoc in the Bash tool can die with "unexpected EOF while looking for matching quote", and the reported line is the last line that arrived (2026-08-27).
- `durable-traps.md:848` — Philosophy-audit challenges PH-04, PH-05 and PH-08 are ANSWERED — the refused halves must not come back (2026-08-27).
- `durable-traps.md:865` — A successful process exit does not establish a usable review result.
- `durable-traps.md:872` — A literal `<<'EOF'` heredoc still loses one level of backslash, because the TOOL JSON eats it before the shell ever sees it (2026-08-28).
- `durable-traps.md:883` — A quota-exhaustion message names a reset date, and that date is not a prediction (2026-08-28).
- `durable-traps.md:889` — Five accepted limits, moved from open-bugs (owner decision 2026-10-04) — none is a defect.

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
confirm the fix validated — or to catch it failing. The matrix below IS those entries.

<!-- BEGIN GENERATED LIVE-RUN WATCH — scripts/shared/generate-backlog-index.mjs — DO NOT EDIT BY HAND -->

> **Live-validation watch matrix — GENERATED from the entries that carry a `Live-run watch` line; do not hand-edit it.**
> Each row below IS an entry in this backlog, linked to where it lives, with that entry's own watch line lifted verbatim — so a row can never name an item the backlog does not hold. File an entry with a **⬇ Live-run watch** line and it appears here on the next generation.

- **Deterministic analyzers: own-vs-acquire engine.** — [forward-tracks.md](backlog/forward-tracks.md)
  Live-run watch (audit a Rust repo for clippy / a Ruby repo for rubocop, with the per-run consent token so the gate admits the non-default tool): the tool must actually spawn and normalize output into leads (cargo-clippy / bundle-rubocop), not skip.

<!-- END GENERATED LIVE-RUN WATCH -->

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a crash
while ingesting a partial workload · an analyzer that silently skipped when it should have spawned ·
a host result accepted despite a prompt/scope mismatch · knip dead-code leads that never reach the
per-file lens.

---
