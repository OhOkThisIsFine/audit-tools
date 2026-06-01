# Remediation Launch Brief

**Source type:** documents (single input)
**Input:** `meta-audit-log.md` — a host-agent journal from running `/audit-code` against the `audit-tools` repo itself, plus a four-part root-cause investigation.
**Status:** `ready: true` — both blocking scope questions resolved by user clarification. Remaining uncertainties (per-backend quota-API feasibility, exact fallback ordering) are engineering investigations the user delegated via "if possible" + "cascading fallbacks", not user decisions.

## Clarification outcome

- **Q-001 (scope breadth) → FULL.** Fix the concrete code/doc defects **and** take on the workflow/UX redesigns. Expect work that touches the `/audit-code` skill loader / host assets in addition to package source.
- **Q-002 (quota depth) → MAXIMAL.** Implement **real remaining-quota querying** for claude-code, claude-desktop, codex, vscode, opencode, and antigravity, *"if possible"*, with **cascading fallbacks** (model-based, provider-based, …). Best-effort per backend: where no programmatic signal exists, cascade down gracefully — never fabricate or fail.

## Source summary

The log contains (1) a confirmed, user-flagged defect — dispatch wave size always
falls back to `wave_size:3` / `source:"default"` and never reflects the active
backend's remaining quota — traced to four producer-side causes (provider pinned
to `local-subprocess`; the canonical `prepareDispatchArtifacts` path never acquires
quota; no provider implements `queryLimits`; the only dynamic signal is reactive
and empty on first contact); and (2) a set of workflow/UX observations (loader cwd
footgun, no scope-confirmation echo, unbounded `design_review` effort, a 106-packet
fan-out with no canary / sampling / human-in-the-loop gate, prose-only findings
schema). Two smaller concrete items: a Windows path-join bug
(`Codeauditor-lambda.audit-artifacts`) and CLAUDE.md priority-chain drift.

Verified in code during intake: Cause 1 (`providers/index.ts:46-50`), Cause 2
(`prepareDispatchArtifacts` reads only cached/static inputs), Cause 3 (`queryLimits`
appears only in the interface + legacy caller, zero provider impls).

## Goals

**Workstream A — Quota adaptation (headline defect), maximal depth**
- **A1 (Cause 1):** Replace the forced `local-subprocess` default with active-backend detection (claude-code, claude-desktop, codex, vscode, opencode, antigravity) instead of env-sniffing only when provider is `"auto"`.
- **A2 (Cause 2, central):** Make `prepareDispatchArtifacts`/`cmdPrepareDispatch` acquire live quota (QuotaSource + discovered limits + real host model + snapshot to `scheduleWave`), mirroring the legacy path so the scheduler's remaining-quota logic becomes reachable.
- **A3 (Cause 3):** Implement **real** best-effort `queryLimits` (or per-backend QuotaSources) for each named backend.
- **A4 (cascade):** First-class fallback chain — provider `queryLimits` → discovered/cached → reactive learned → model-based default → conservative provider/local default.
- **A5 (new providers):** Add `codex` and `antigravity` providers (and a distinct `claude-desktop` classification if it differs from `claude-code`) conforming to `FreshSessionProvider`. Minimum = provider resolution + best-effort quota; full worker-dispatch parity is a per-backend planning decision.

**Workstream B — Other concrete defects**
- **B1:** Locate & fix the Windows path-join bug (`"C:\Code"` + `"auditor-lambda"` without a separator) in artifacts-dir/repo-root resolution; add a Windows path test.
- **B2:** Reconcile CLAUDE.md's priority chain with the live `PRIORITY[]` in `nextStep.ts` (add the three missing obligations), ideally enforced by a test.

**Workstream C — Workflow/UX redesigns (now in scope)**
- **C1 (canary):** Single-worker canary verifying one packet's submit round-trip before the full fan-out.
- **C2 (sampling):** Top-K (by risk) packet mode producing an honest **partial** report, vs. all-or-loop-back.
- **C3 (HITL gate):** "This will launch N agents across M waves — continue?" confirmation before large fan-out.
- **C4 (loader cwd):** Anchor loader commands to an explicit cwd (absolute paths/anchor); mirror for `/remediate-code`.
- **C5 (scope echo):** Echo resolved scope ("auditing X, N files, git: yes/no — proceed?") before writing `.audit-artifacts`.
- **C6 (effort budget):** Bounded reading budget / "top-N risk units" hint for `design_review`.
- **C7 (schema):** Point findings/AuditResult output at a machine-validatable JSON Schema for pre-submit self-validation.

## Non-goals

- Re-running the audit or acting on the original 106 packets.
- Changing the scheduler's wave-size **math** (it is correct; it is simply never fed).
- Fabricating quota for backends with no programmatic API — best-effort detection + graceful fallback only.
- Full audit-worker dispatch parity for new backends (codex, antigravity) beyond resolution + best-effort quota, unless essentially free.
- Mirroring every change into `remediate-code`'s providers (observed defect is in the audit path); parity is optional follow-up.

## Constraints

- **Windows-aware** path construction; add Windows path tests.
- **Conversation-first is canonical** — fix lands in `prepareDispatchArtifacts`, not only the legacy path; don't regress the legacy path.
- **Graceful degradation mandatory** — no signal ⇒ cascade to safe default, never throw; first contact is normal.
- **New providers** conform to `FreshSessionProvider`; quota querying must be deterministic/mockable (no live network in tests).
- **Build order** — shared builds first; changing `shared/providers/types.ts` or `shared/quota` ⇒ rebuild shared + typecheck both dependents.
- **Host-asset edits** go to the **source templates** `ensure` renders, not generated output, so they survive `ensure`.
- **One bounded step per invocation** preserved — canary/sampling/HITL/quota must not make a step long-running or recursive.
- **Tests** — audit-code uses `node --test`; `verify:release` must pass; new behavior needs deterministic coverage.
- **Sampling honesty** — partial coverage must be truthfully represented in `coverage_matrix` and synthesis.

## Affected files / discovery targets

| File | Role |
|---|---|
| `packages/audit-code/src/cli/dispatch.ts` | A2 PRIMARY (quota threading); integration point for C1 canary & C2 sampling. |
| `packages/audit-code/src/cli.ts` | A2 PRIMARY — `cmdPrepareDispatch`; legacy path (~2030-2056) is the reference impl. |
| `packages/audit-code/src/providers/index.ts` | A1 — resolution default & detection (46-50). |
| `packages/audit-code/src/providers/{claudeCode,opencode,vscodeTask}Provider.ts` | A3 — best-effort `queryLimits`. |
| `packages/audit-code/src/providers/{codex,antigravity}Provider.ts` | A5 NEW — add providers. |
| `packages/audit-code/src/providers/constants.ts` | A5 — register new provider names/detection. |
| `packages/shared/src/providers/types.ts` | A3/A4 — `queryLimits` interface / quota-signal shape (shared change). |
| `packages/shared/src/quota/{limits,quotaSource,compositeQuotaSource,learnedQuotaSource}.ts` | A1/A4 — classification, cascade home, learned rung. |
| `packages/audit-code/src/quota/{discoveredLimits,scheduler,probe}.ts` | A2/A4 — cached rung, scheduler consumer, deprecated probe. |
| `packages/audit-code/src/orchestrator/nextStep.ts` | B2 `PRIORITY[]`; C2 stop-condition; C6 budget. |
| `CLAUDE.md` | B2 — documented chain to reconcile. |
| `packages/audit-code/schemas/audit_result.schema.json` | C7 — schema for pre-submit validation. |
| **Discovery:** artifacts-dir / repo-root resolution (wrapper or `src/io`) | B1 path-join bug + A1 session-config origin. |
| **Discovery:** `/audit-code` & `/remediate-code` loader / host-asset source templates | C3/C4/C5/C6/C7 prose & gating; edit source templates, not generated output. |

## Acceptance criteria

- Canonical dispatch path resolves the active backend (not forced `local-subprocess`) and threads a quota snapshot + discovered limits + host model into the scheduler; `dispatch-quota.json` shows a non-default `source`/`confidence` when a signal exists.
- Each named backend has best-effort `queryLimits`/QuotaSource; the cascade (provider → discovered → learned → model-default → safe default) is exercised by tests, and a no-signal run still succeeds with the safe default (no throw).
- `codex` and `antigravity` participate in provider resolution; per-backend quota is queried where feasible.
- Windows path-join never yields separator-less names like `Codeauditor-lambda` (path test).
- CLAUDE.md priority chain matches `PRIORITY[]` (ideally test-enforced).
- Canary runs one packet before fan-out; sampling mode produces an honest partial report; the HITL gate prompts before large fan-out; loader commands are cwd-anchored; scope is echoed before artifacts are written; `design_review` has a bounded budget; findings validate against the JSON Schema pre-submit.
- `npm run check` + `npm test` pass; audit-code `verify:release` passes; shared rebuilt + both dependents typecheck if shared changed.

## Open questions

None blocking. Per-backend quota-API feasibility (esp. claude-desktop, codex, antigravity) and the exact fallback ordering are engineering investigations to resolve during planning/implementation, consistent with the user's "if possible" + cascading-fallback direction.
