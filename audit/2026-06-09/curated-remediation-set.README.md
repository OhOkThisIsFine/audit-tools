# Curated remediation set — triaged 2026-06-09

Hand-triage of the **24 high-severity findings** in [`audit-findings.json`](audit-findings.json),
each verified against current source (at `1bf2c89`, post audit-code 0.11.1).
[`curated-remediation-set.json`](curated-remediation-set.json) wraps the 5 confirmed
high-value items below in a valid `audit-tools/audit-findings/v1` contract for `/remediate-code`.

Result: **5 curated · 3 false-positive/resolved · 11 deferred (backlog) · 6 scope-pollution (dropped) · 1 → scope checkpoint task**
(DAT-ed4f3508 and DAT-2624dff3 are the same issue → deduped to one.)

## Status — fixed 2026-06-09

The user chose to fix the curated set **directly** (not via `/remediate-code`).
**4 of the 5 landed and were verified green** (audit-code 1592/1592 · shared 270/270 ·
remediate-code 712/712): `SEC-4747c5bf`, `REL-3c247ea1`, `DAT-ed4f3508`, `DAT-c014c153`.
`CFG-4996560e` was **deferred** as a design decision (untestable OpenCode runtime;
intricate shared merge logic) — see its row below and `docs/backlog.md`.

## Curated for remediation (5)

| ID | Lens | Verdict + fix direction |
|---|---|---|
| `SEC-4747c5bf` | security | **Confirmed.** [sessionConfig.ts:179](../../packages/audit-code/src/validation/sessionConfig.ts:179) runs `execAsync(\`${lookup} ${command}\`)` through a shell → metachar injection if `command` is config-controlled. → use `execFile` (no shell) / validate the command token. |
| `DAT-ed4f3508` | data_integrity | **Confirmed (hard).** [verification_result.schema.json:10](../../packages/remediate-code/schemas/verification_result.schema.json:10) says `reason: string` + `additionalProperties:false`, but the prompt at [implement.ts:268](../../packages/remediate-code/src/phases/implement.ts:268) asks for `notes` and [close.ts:707](../../packages/remediate-code/src/phases/close.ts:707) reads `reason` as `string[]`. Verification evidence is silently dropped. → align prompt+schema+parser on one shape (`reason: string[]`, drop `notes`, add required `finding_id`). |
| `CFG-4996560e` | config_deployment | **Confirmed but DEFERRED (design decision).** [postinstall.mjs](../../packages/audit-code/scripts/postinstall.mjs:162) deploys a **global** OpenCode config with `bash: {'*':'allow'}` and `external_directory: {'*':'allow'}`. Broad-allow + denylist is the project's *intentional* autonomy model (the repo's own `opencode.json` uses it); the real fix is scoping it to the `auditor` agent vs the global top level — which hinges on untestable OpenCode runtime semantics. Fix direction tracked in `docs/backlog.md`. |
| `REL-3c247ea1` | reliability | **Confirmed.** [fileLock.ts:54-58](../../packages/shared/src/quota/fileLock.ts:54) unlinks a stale lock **without** re-checking the owner token (unlike `releaseLock`), so a concurrent fresh lock can be deleted. → capture+CAS the token before unlink, or use atomic rename. |
| `DAT-c014c153` | data_integrity (low) | **Confirmed but low.** [dispatch_plan.schema.json:24](../../packages/remediate-code/schemas/dispatch_plan.schema.json:24) requires *both* `finding_id` and `block_id`, but the contract is phase-exclusive and the runtime [`validateDispatchPlan`](../../packages/remediate-code/src/validation/artifacts.ts:160) is already phase-correct — so it does **not** fail at runtime (the finding's claim overstates impact). Stale schema file only. → make the two fields phase-conditional (`if/then`). |

## Dropped — false positive / already resolved (3)

- **`COR-49db2f4c`** — claims `ref.split("#", 1)[0]` keeps the `#` fragment. In JS that returns the path *before* `#` (`"x.json#/d".split("#",1)` → `["x.json"]`). [graphSuites.ts:67](../../packages/audit-code/src/extractors/graphSuites.ts:67) is correct.
- **`COR-d31c8ea3`** — the tsc regex *does* match standard relative-path output via backtracking; only the absolute-Windows-drive-colon edge fails, which `tsc` doesn't emit from a project root. "No errors ever parsed" is false.
- **`MNT-6c66181b`** — describes the old `MNT-001`-style reused IDs. Current output uses unique hash IDs (`COR-11b75f89`…). Resolved by the current ID scheme.

## Deferred — confirmed but low value (backlog, not this pass)

- `COR-11b75f89`, `COR-733266d1` — best-effort heuristic route-graph extraction; advisory output, imperfect by design.
- `COR-53c7a3ee` — state read-modify-write lost-update race; the single-orchestrator-per-run model + central result merge prevents it in practice (lock isn't held across load→save, but nothing else writes `state.json`).
- `ARC-23f9165e` — `cli.ts` ↔ `index.ts` import cycle; maintainability cleanup, ESM tolerates it.
- `REL-77285661`, `COR-717ec279` — Windows provider robustness (8191-char cmdline limit / shim wrapping in the manual-fallback provider); not re-verified in depth.
- `TST-9a4da7e5` (test imports `dist/`), `TST-20f6280d` (scheduler.ts coverage), `MNT-57884bf8` (duplicated test fixtures) — test debt.

## Dropped — scope pollution (not source defects)

These target `.audit-artifacts/` run artifacts or the `audit/` output itself, not shipped source. They are *symptoms* of the scope-pollution bug, and validate the **LLM scope/intent checkpoint** task (`docs/backlog.md`):

- `COR-7aa2af30`, `MNT-1a260410` (hardcoded paths in `.audit-artifacts/dispatch/`), `COR-f3c7d732` (`requeue_tasks.json` paths), `DAT-a0f81718`, `DAT-27cf4ebf` (dispatch-copy schema `$id` dups).
- `COR-281a9b14` — the scope-pollution bug *itself*; the durable fix is the scope/intent checkpoint, not a one-off remediation.
