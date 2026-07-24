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
| **Metered provider + LARGE target** — this is what exercises the wall (`AUDIT_TOOLS_LIVE_QUOTA=1` only enables the live-credential test probe in `tests/audit/inv2.test.mjs`, it does not force a production wall) | Quota-aware dispatch · M-QUOTA friction escalation · pre-wall pacing · retryable resume |
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


