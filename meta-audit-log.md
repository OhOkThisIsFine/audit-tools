# Meta-Audit Log — `/audit-code` workflow experience

> Running journal of the host-agent experience driving the `/audit-code` skill against the `audit-tools` repo itself. Captures friction, ambiguity, and pain points from the perspective of the agent executing each step. Untracked scratch artifact.

**Run started:** 2026-05-31
**Target:** `C:\Code\audit-tools` (audit-code auditing itself)
**Host:** Claude Code (Opus 4.8), Windows / PowerShell

---

## Observations

### O1 — Loader: "auditor-lambda repository itself" naming requires a leap
The loader prompt branches on whether I'm "inside the `auditor-lambda` repository itself." But the working directory is `audit-tools` (the monorepo), and the bin/package/dir names are all different (`auditor-lambda` npm name, `audit-code` bin, `packages/audit-code` dir — the documented three-way mismatch). As a host agent I had to *infer* that "auditor-lambda repository" == "this monorepo, and I should run the entrypoint at `packages/audit-code/audit-code.mjs`." A global `audit-code` bin isn't on PATH here, so the first branch wouldn't work. Minor friction; resolved by Glob.

### O2 — Loader's relative commands assume a fixed cwd; collides with shell cwd state (HIGH friction)
The loader instructs the host to run bare `node audit-code.mjs next-step`, implicitly assuming cwd == the package dir. But to run `ensure` I had done `cd packages/audit-code && …`, which **persisted** the cwd. My next call prepended `packages/audit-code/` again → `…/packages/audit-code/packages/audit-code/audit-code.mjs` → `MODULE_NOT_FOUND`. The loader gives no guidance on which cwd its commands assume, and the bare-relative-path convention is fragile against a stateful shell. A host that uses absolute paths or that the loader anchored explicitly would avoid this. **This is the single sharpest footgun so far.**

### O3 — cwd accident silently re-scoped the audit + disabled git signals (HIGH severity)
Because `next-step` ran with cwd = `packages/audit-code`, the backend auto-resolved `repo_root` to that sub-package and emitted: *"target directory … does not appear to be a git repository. Diff-based signals will be unavailable."* Two silent consequences:
  1. The audit is scoped to **1 of 3 workspaces** — it will not see `@audit-tools/shared` or `remediate-code`, i.e. exactly the cross-package contracts CLAUDE.md flags as the high-risk surface.
  2. **Git diff signals are off** because the `.git` lives at the monorepo root, not the sub-package — degrading prioritization.
The orchestrator created `.audit-artifacts/` inside `packages/audit-code` as a side effect. Nothing in the loader flow forced me to confirm scope before artifacts were written. A confirmation/echo of resolved scope ("auditing X, N files, git: yes/no — proceed?") would catch this class of error. Pausing to reconcile scope with the user. → User chose whole-monorepo; re-scoped to root cleanly (git-aware, no warning).

### O4 — POSITIVE: deterministic work runs to completion inside one `next-step` (works well)
The very first `next-step` silently ran intake → disposition → structure → planning (manifest, units, surfaces, flows, risk, 12 structural findings incl. dependency cycles) and only *stopped* at the first step that genuinely needs an LLM: `design_review`. This is the right division of labor — the host agent isn't handed deterministic busywork. The returned prompt was self-contained (full structural context inlined), so I didn't have to go spelunking for state. Matches the intended "backend runs deterministic work" design. Credit where due.

### O5 — `design_review` step is bounded in OUTPUT but unbounded in INPUT effort (medium friction)
The step's obligation is bounded ("write findings JSON, then next-step"), but the instruction "Read the project source to understand what it does and how it works" over a 511-file / 41k-LOC repo is effectively unbounded. There's no budget, no "read at least/at most," no prioritized reading list beyond the risk table. A host could spend 5 reads or 500 here and both "satisfy" the step. The bounded-step guarantee covers the *handoff*, not the *cost of the thinking inside a step*. Some steps are cheap; this one is open-ended and the contract doesn't say so. A suggested file budget or "focus on the top-N risk units" hint would calibrate effort.

### O6 — Contract↔docs drift is discoverable only by reading code (low/medium)
CLAUDE.md documents the audit priority chain but the live `PRIORITY[]` in `nextStep.ts` has three extra obligations (`graph_enrichment_current`, `design_assessment_current`, `design_review_completed`). As the host I'd have been mildly misled about what step comes next if I trusted the docs. Not blocking — the loader tells me to follow only the returned prompt — but it's a smell that becomes a real finding (see DR-007).

### O7 — Writing findings: schema is clear, results path is explicit (works well)
The step prompt inlined the exact output JSON schema, an example object, the finding-ID convention (DR-001…), the results path, AND the exact next command to run. Zero ambiguity about *what* to produce or *where*. This is the friction-free part of the loop. The only nit: the schema is restated in prose rather than pointed at a JSON Schema file, so a host can't machine-validate its own output before submitting (it's validated on ingest instead — late feedback).

### O8 — Dispatch step explodes to 106 deep-tier subagents at wave_size=3 (HIGHEST-severity workflow pain)
`next-step` returned `dispatch_review` with a 2,686-line plan of **106 packets** (5 high / 2 medium / 99 low priority; 95 "deep" tier). The quota file shows why the wave is tiny: no model/provider/quota was detected, so it fell back to `source:"default"`, `confidence:"low"`, `context_tokens:32000`, `wave_size:3`. Consequences for the host:
  - **106 subagent sessions** must be launched, in **~36 sequential waves of 3**. Each "deep" packet reads thousands of lines and emits an AuditResult. This is the dominant cost of the entire workflow by far — orders of magnitude more than every other step combined.
  - The conservative default (32k context, wave 3) is pessimistic for a capable host. There's no obvious host-side "I can run N in parallel" input surfaced in the loader; the wave size is dictated by a defaulted quota the host can't easily correct from the prompt. On a fast host this serializes work that could be far more parallel.
  - **No sampling / no coverage budget.** The stop_condition is "Dispatch *every* packet." There's no first-class "audit the top-K risk packets and synthesize a partial report" mode. For a 41k-LOC repo that means all-or-(loop-back), which is a steep on-ramp for anyone wanting a quick read.
  - **No canary.** The design dispatches all 106 workers before learning whether even one can successfully run its `submit-packet` command in this environment. Given DR-004 (a broken hardcoded submit path already exists in this very repo), a single-worker canary before the full fan-out would de-risk the most expensive step. As-is, a submit misconfiguration could waste a whole wave (or more) before detection.

### O9 — "Don't load packet prompts into orchestrator context" is good hygiene but blind-spots the host
The step correctly tells me to pass `entry.prompt_path` to each subagent without reading it myself (keeps orchestrator context lean — good). The flip side: I'm dispatching 106 workers with zero visibility into what any of them will actually do or submit. I can't sanity-check a single packet's instructions or its submit command without violating the contract. The trust boundary is reasonable, but it means the orchestrator is flying blind on worker correctness until `merge-and-ingest` reports aggregate results — again arguing for a canary or a dry-run mode.

### O10 — DECISION POINT surfaced to user
106 deep subagents is a ~15x larger spend than a high-value subset and was not anticipated by the terse "run the skill" instruction. Pausing to let the user choose full-run vs. subset vs. stop. (This pause is itself a workflow observation: the tool gives the *host* no built-in guardrail here — a human-in-the-loop "this will launch 106 agents, continue?" confirmation would belong in the loader.)

→ **User chose STOP** and flagged the real bug: *"The system is meant to recognize remaining quota and rate limits from Claude Desktop (and other providers) and adjust accordingly; apparently it isn't."* Investigation below.

---

## ROOT-CAUSE INVESTIGATION — why the wave defaulted to 3 and ignored Claude Desktop quota

**Observed:** `dispatch-quota.json` → `model:null, source:"default", confidence:"low", context_tokens:32000, wave_size:3, quota_source_snapshot:null, host_concurrency_limit:null`.

`wave_size:3` is exactly `quota.first_contact_concurrency ?? 3` in [scheduler.ts:161](packages/audit-code/src/quota/scheduler.ts:161). That branch fires only when: provider classified **local** + **no learned quota history** + **no RPM/TPM limits from any source**. Tracing each input proved the user's diagnosis correct. Four layered causes, producer-side, in order of impact:

### Cause 1 — session config pins `provider: "local-subprocess"`, so env auto-detection never runs
`.audit-artifacts/session-config.json` contains exactly `{"provider":"local-subprocess"}`. In [providers/index.ts:47-48](packages/audit-code/src/providers/index.ts:47), `resolveFreshSessionProviderName` returns the requested provider verbatim unless it is the literal string `"auto"`. So the env sniffing that *could* detect Claude Code / Claude Desktop (CLAUDECODE / OPENCODE / TERM_PROGRAM) is **skipped entirely**. `classifyProvider("local-subprocess")` → `"local"` ([limits.ts:11-13](packages/shared/src/quota/limits.ts:11)), which selects the local first-contact ceiling of 3. `classifyProvider("claude-code")` is `"hosted"` (would cap at 1 via `unknown_hosted_concurrency`), so the fact we saw 3, not 1, confirms a *local* classification. Note the documented invariant "auto-resolution handles the environment" does NOT hold by default: the code default is `local-subprocess`, not `auto`.

### Cause 2 — the canonical conversation-first dispatch path doesn't acquire quota at all (the core regression)
There are **two** wave-scheduling call sites, and they are not equivalent:
  - **Legacy in-process path** [cli.ts:2030-2056](packages/audit-code/src/cli.ts:2030): calls `provider.queryLimits?.(hostModel)`, builds `new CompositeQuotaSource([new LearnedQuotaSource(...)])`, calls `quotaSource.queryCurrentUsage(...)` → `quotaSourceSnapshot`, and passes snapshot + discoveredLimits + quotaStateEntry into `scheduleWave`.
  - **Canonical `dispatch_review` path** [cli/dispatch.ts:640-660](packages/audit-code/src/cli/dispatch.ts:640) (`prepareDispatchArtifacts`, invoked by `cmdPrepareDispatch` at cli.ts:2843 — the command the `next-step` loop runs): passes `hostModel:null`, reads only the on-disk cache via `lookupDiscoveredLimits`, **never calls `provider.queryLimits`, never constructs a QuotaSource, never queries current usage, and never passes `quotaSourceSnapshot`.**

So the scheduler's real-time remaining-quota logic ([scheduler.ts:168-177](packages/audit-code/src/quota/scheduler.ts:168): `remaining_pct < 0.1 → wave 1`, `< 0.3 → halve`) is **unreachable from the conversation-first flow** — the very flow CLAUDE.md calls canonical. The quota-adaptive behavior the user expects lives only in the legacy path that the step-driven loop doesn't use. This is the central defect.

### Cause 3 — no provider actually implements `queryLimits`
`FreshSessionProvider.queryLimits` is declared optional in [shared/.../providers/types.ts:45](packages/shared/src/providers/types.ts:45) and implemented by **zero** of the five providers in **either** package (grep of `packages/*/src/providers/` finds only the interface). So even the legacy path's `provider.queryLimits?.(hostModel)` always short-circuits to `null`. There is no code anywhere that asks Claude Desktop (or any backend) for its remaining quota/limits. The intended "ask the provider" channel is a stub.

### Cause 4 — the only real quota signal is reactive and empty on first contact
With queryLimits unimplemented, the sole dynamic source is `LearnedQuotaSource`, populated *reactively* from observed 429/524 errors and response-header extraction (`recordWaveOutcome`, header extractors) **after** requests run. On a first run there is no history → empty. And `probeProvider` is explicitly `@deprecated` and returns `supported:false` for every provider except `subprocess-template`, which is itself "not yet implemented" ([probe.ts](packages/audit-code/src/quota/probe.ts)). So there is no *proactive* quota acquisition at plan time, by design-in-progress ("Phase 3A replaces this with the QuotaSource abstraction" — but that abstraction was only wired into the legacy path).

**Net:** the architecture is built to adapt (scheduler honors snapshots/discovered limits; QuotaSource/header-extractor/learned-state machinery all exist), but every *producer* of live quota data is either unwired from the canonical path (Cause 2), unimplemented (Cause 3), reactive-only/empty (Cause 4), or bypassed by config (Cause 1). Any single fix is insufficient: to make wave size reflect Claude Desktop's remaining quota you need (a) provider resolved to claude-code/auto, (b) the `prepareDispatchArtifacts` path to query a QuotaSource + provider limits + thread the model the way the legacy path does, and (c) at least one provider implementing `queryLimits` (or a Claude-Desktop-specific QuotaSource that reads remaining quota).

### Secondary observation — malformed artifacts path on disk
`find` surfaced `packages/audit-code/Codeauditor-lambda.audit-artifacts/session-config.json`. The directory name `Codeauditor-lambda` looks like a path-join bug (`"C:\Code"` + `"auditor-lambda"` concatenated without a separator). Likely a Windows path-construction defect somewhere in artifacts-dir resolution. Flagged for follow-up (low priority, but the repo's explicit mandate is "Windows-aware").

