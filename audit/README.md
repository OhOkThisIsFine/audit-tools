# audit-tools self-audit

A self-audit of this repository, produced by running `/audit-code` on it
(2026-06-01). **This folder is the deliverable set — start here.** Findings are
advisory: verify each against current source before acting.

> **⚠ Two self-audits now exist.** This is the **2026-06-01** curated/triaged
> baseline. A newer **2026-06-09** run (raw, untriaged, **281 findings**) lives in
> [`2026-06-09/`](2026-06-09/). Substantial remediation has shipped since this
> June-1 report (later releases plus the 2026-06 remediation pass), so re-verify
> the "Remaining backlog" below against current source. The **reconciled, current
> plan** lives in [`docs/backlog.md`](../docs/backlog.md).

## Deliverables (remediate from these)

- **`audit-report.md`** — the human-facing report: **392 findings**
  (17 high / 125 medium / 235 low / 15 info) across 394 files, 3 work blocks.
- **`audit-findings.json`** — the canonical machine contract for the same
  findings. **Feed this to `/remediate-code`** — the remediator consumes the
  JSON (not the Markdown); a Markdown file would fall through its free-form LLM
  extractor instead of the deterministic parse.

## Status — what is already fixed

The run originally produced **404** findings. Substantive remediation has since
shipped (`@audit-tools/shared@0.6.0`, `auditor-lambda@0.7.0`,
`remediator-lambda@0.5.0`), and on **2026-06-02** the report was pruned of **12
findings verified fixed** in the current tree (404 → 392; high 27 → 17,
medium 127 → 125). Removed:

- **COR-001** worktree branch leak on `git worktree add` failure (`implement.ts`) — now atomic `git worktree add -b`.
- **COR-001** worktree-block commit failure swallowed (`implement.ts`) — now gated on `git diff --cached --quiet`; real failures surface + clean up.
- **COR-001** ×2 `isLens` omitted `observability` (`flowRequeue.ts`) — now imports the canonical `isLens`/`ALL_LENSES` (`lens-guard.test.mjs`).
- **REL-001** deprecated `skip_worker_command` — removed from both packages.
- **DR-005** file-type classifier mislabelled `.md`/`.yml` — override map + case-insensitive match in `fileInventory.ts`.
- **DR-006** `ensure` had no preflight — `preflightWorkspace()` now detects missing `node_modules`/stale-dist and prints the fix.
- **TST-001** `autoFixExecutor` zero coverage — `auto-fix-executor.test.mjs` added.
- **TST-002** `withinRoot` path-escape guard untested — `within-root.test.mjs` added.
- **TST-002** `worktreeIsolation.ts` zero coverage — `worktree-isolation.test.ts` added.
- **MNT-001** `reviewPackets.ts` 1848-line monolith — split to 830 (`reviewPacketGraph.ts`, `reviewPacketSizing.ts`).
- **MNT-001** `decideNextStepInner` ~740-line function — decomposed to ~270 (dispatch branches extracted).

Deliberately **kept** (still valid in current source): `cli.ts` /
`cmdRunToCompletion` length (~1739 / ~1115 lines — those refactors predate the
run); `internalExecutors.ts` god-module (still 9 executors); **DR-002** embedded
prompt markdown (prompts still inline in `nextStep.ts`); **COR-002**
`lensSetForFlow` still omits observability and `git add .` still stages
artifacts; **COR-001** retry-after `< 600` boundary; **TST-003** autoFixExecutor
positive formatter branches; worktreeIsolation error-recovery branches; and the
advisory MNT/OBS/TST/DI bulk.

Two disputed findings (false positives, never fixed) were **left in place** —
prune separately if you concur: **COR-001** "MCP tool names in opencode template"
(opencode namespaces MCP tools by the `auditor` server key, so the names are
correct) and **TST-001** "`detectHostActiveSubagentLimit` tested with wrong
argument" (the test imports the single-arg `(env)` wrapper, so the fixture is
passed correctly).

## Remaining backlog

The expensive correctness work is done; what remains is mostly advisory.

### Tier A — issues found by *running* the tool (highest signal) — all addressed

These came from the meta-audit (driving the loop end-to-end), not static
inspection, so they are the highest-signal list. All six are now fixed:

| # | Issue | Outcome |
|---|---|---|
| A1 | Finalization oscillation (`runtime_validation` ↔ `synthesis`, ~700–900 advance iters, Windows EPERM crash) | Cycle guard + 3 latent persistence-consistency fixes; convergence proven in repros (`finalization-convergence.test.mjs`). |
| A2 | `wave_size=1` from failed model detection → forced serial dispatch | Agent-host providers default to parallel; host-model detection (`resolveHostModel`) engages per-model quota. (Heterogeneous multi-agent dispatch remains a future vision.) |
| A3 | Host account session-limit invisible to the quota subsystem | `detectRateLimitError` recognizes the session-limit sentinel + clock-time reset → cooldown; dispatch prompt says pause-and-resume. |
| A4 | `ensure` had no preflight; CRLF regen dirtied the tree | Preflight with actionable `npm install` message; root `.gitattributes` enforces LF. |
| A5 | `spurious_file_count` inflated across deepening rounds | Only genuinely stray files count now. |
| A6 | Workers wrote stray `*-result.json` to repo root | Packet prompt reinforced to submit-only. |

### Tier B — sharp correctness/reliability findings — mostly fixed

The concrete-bug slice (not quality opinions). The branch-leak, commit-ignored,
`isLens`, and `skip_worker_command` items were fixed and pruned (see above).
**Remaining:**

- **DR-003** provider/quota duplication: the 10 known drift bugs were fixed by
  centralizing helpers into `shared`, but the provider *classes* are still
  per-package. Residual duplication, not a live bug.
- **COR-002** `lensSetForFlow` (`flowCoverage.ts`) silently excludes the
  `observability` lens; the worktree `git add .` stages `.remediation-artifacts/`
  into a block commit.

### Tier C — advisory bulk (strategy, not per-item verdicts)

- **MNT long-file/complexity.** Several HIGH ones are the *intended* outcome of
  the refactor sprint and should be **accepted/known** (`cli.ts` is deliberately a
  thin dispatcher; `cmdRunToCompletion` length). Optional future splits if you're
  already touching the file.
- **TST coverage.** Selective. `autoFixExecutor`/`withinRoot`/`worktreeIsolation`
  are done; **"entire quota subsystem has zero test coverage" is inaccurate**
  (tests exist — `quota-scheduler`, `quota-file-lock`, `discovered-limits`,
  `header-extraction`) — verify scope before writing redundant tests.
- **OBS / OPR / DI / CD / CFG.** Mostly advisory enhancements; **defer** unless a
  specific one blocks debugging. Skim DI (data-integrity) for any real
  correctness overlap before dismissing.

### How to read the 392 findings

- **The count is inflated by repeated IDs.** A finding ID (`COR-001`, `MNT-001`,
  `TST-001`…) is re-emitted once per file/unit it touches, so 392 ≈ a few dozen
  *distinct* problems fanned across files.
- **It is advisory.** Verify each against current source before acting (at least
  one HIGH was contradicted by shipping tests — see Tier C).

### Channel: hand-fix vs `/remediate-code`

- **Tier B correctness + judgment-heavy items → hand-fix.** They need cross-file
  reasoning, not mechanical application.
- **Tier C selective coverage / OBS bulk → candidate for `/remediate-code`**
  consuming `audit-findings.json`. **Curate a subset first** — feeding all 392
  (many advisory / intentional / inaccurate) would generate low-value churn.

## Appendix — running the tool (meta-audit notes)

The run doubled as a meta-audit of the `/audit-code` experience. The friction it
surfaced is the Tier A list above (all fixed). What worked well, worth keeping:
deterministic front-loading (one `next-step` ran the whole analysis pipeline and
produced a rich design-review prompt); the packet → subagent → submit →
merge-and-ingest pipeline (100% valid submissions, 0 rejects at 10-wide); and
selective deepening + lens-steward verification (bounded, finding-driven).
