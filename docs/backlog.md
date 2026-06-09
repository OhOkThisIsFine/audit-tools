# Backlog — known friction, deferred fixes & future product directions

A living log of things to fix or build later, so they are not lost between
sessions. This is also the home for deferred product-design specs that are still
too early to encode as implementation contracts.

**Remove an entry once it ships** — this is a to-do list, not a status log. When
an item needs design detail, record durable contracts, gates, and principles
rather than "where the code is today."

> **Last reconciled 2026-06-09** against the remediation that shipped
> `@audit-tools/shared@0.10.0` / `auditor-lambda@0.11.0` /
> `remediator-lambda@0.10.0`. Items verified resolved in-tree were removed;
> friction surfaced by the June 8–9 self-audit (agents' own feedback +
> `.audit-tools/audit/audit-report.md`, 281 findings) was folded in. The
> contract-pipeline spec was trimmed to what is unbuilt — the full original spec
> is in git history before this date.

## Known friction (agent / dev experience)

- **Release CI-wait loop floods stdout.** `packages/*/scripts/release-and-publish.mjs`
  logs every 5s poll attempt while waiting on the CI publish run, so a normal
  ~9-min release writes ~5,000 lines / 100k+ tokens to the task output — naively
  `Read`-ing that file overflows context. Tail it (`Get-Content -Tail N`) instead
  of whole-reading; consider throttling the poll log to status-changes or every
  Nth attempt.
- **Global install defers `postinstall` under npm's allow-scripts policy.**
  `npm install -g auditor-lambda` installs the bin but prints
  `npm warn allow-scripts … (postinstall: node scripts/postinstall.mjs)` and skips
  it, so the host-integration deploy (OpenCode config + `/audit-code` skill/prompt)
  silently doesn't run. Finish with `npm approve-scripts auditor-lambda` or invoke
  `postinstall.mjs` manually. (This also gates the overbroad-perms deploy flagged
  by `CFG-4996560e`, so it's not purely a regression.)
- **`t.mock.module` is unusable in audit-code tests.** audit-code runs tests via
  `node --import tsx/esm --test`; `t.mock.module` needs
  `--experimental-test-module-mocks` and conflicts with the tsx/esm loader, so it
  throws `t.mock.module is not a function`. Use a dependency-injection point
  instead (e.g. `cmdWorkerRun(argv, deps)` in
  `src/cli/workerRunCommand.ts`) rather than module-graph mocking.
- **Backslash escaping / arg serialization.** Inline `node -e "…\\…"` (regexes,
  Windows paths) gets mangled by shell backslash handling — write a small script
  file instead of inlining. Separately, the Workflow tool's `args` can arrive as a
  JSON *string* rather than a parsed object, so `args.foo` is `undefined`; defend
  with `const a = typeof args === 'string' ? JSON.parse(args) : args`. (The
  orchestrator-rendered command path now routes through the shared
  `renderPromptCommand`/`toPromptPathToken`, so this is mainly a trap for
  hand-typed or inline `node -e` commands.)
- **The `Bash` tool mangles Windows backslash paths.** A plain command like
  `node C:\…\audit-code.mjs merge-and-ingest …` run through `Bash` drops the
  backslashes (`C:\a\b` → `C:ab` → MODULE_NOT_FOUND). Use the `PowerShell` tool for
  Windows-absolute-path commands, or forward slashes (Node accepts `C:/…`). The
  orchestrators now emit POSIX-slash commands for this reason (`renderCommand`), so
  the trap is mainly for hand-typed paths. The `opentoken wrap` step-JSON mangling
  friction graduated to a command-class wrap policy — control-plane commands are
  wrap-exempt, encoded in the dispatch prompts + memory
  `opentoken-wrap-mangles-orchestrator-prompts`.
- **Fresh git worktrees lack `node_modules`.** A newly created worktree resolves
  `@audit-tools/shared` against a stale `dist/` → spurious "no exported member"
  type errors. Run `npm install` in the worktree before `npm run check`.
- **New default-on orchestrator behavior breaks existing fixtures.** Turning the
  dispatch canary on by default changed `prepare-dispatch` first-contact output
  and broke end-to-end fixtures that assumed a single-round, all-packets dispatch;
  the fix was seeding `dispatch.canary:false` in the test helper. Any new
  default-on behavior needs a sweep of existing fixtures, or should ship
  default-off until they catch up.
- **audit-code `node --test` needs the tsx loader.** Bare
  `node --test packages/audit-code/tests/*.test.mjs` fails with
  `ERR_MODULE_NOT_FOUND` because the `.mjs` tests import built `.ts` via `.js`
  specifiers. Use the canonical `node --import tsx/esm --test …`, as in the
  package's `test` script, or `npm run test:single -- tests/<file>.test.mjs`. This
  is a trap when running one test file by hand or telling a subagent to "run
  node --test".
- **The `Bash` and `PowerShell` tools share one working directory.** A `cd` inside
  a `Bash` call changes the directory the next `PowerShell` call runs in, so a
  later `npm run check -w packages/<pkg>` fails with *No workspaces found* because
  the path doubles. Use a subshell `(cd … && …)` in Bash, or pass absolute paths
  and `Set-Location` the repo root explicitly, rather than relying on per-tool CWD.
- **PowerShell block output cannot be piped inline after a `foreach` statement.**
  A shape like `foreach (...) { ... } | ConvertTo-Json` throws "An empty pipe
  element is not allowed"; assign the loop output first (`$out = foreach (...) {
  ... }`) and pipe `$out`.
- **PowerShell `-Filter` is not a regex.** Patterns like
  `document-FINDING-00[1-6].result.json` can match nothing even when files exist;
  use `Where-Object { $_.Name -match '...' }` for numbered result checks.
- **PowerShell unwraps single-element arrays in `ConvertTo-Json`.** `@(@{...})`
  collapses to a bare object, so a one-result `submit-packet` payload serializes as
  an object instead of a 1-element array and is rejected. Workers had to
  string-concat the surrounding `[`/`]`. The packet and worker prompts now carry
  this guidance (bracket-wrap the output, or `Write-Output -NoEnumerate`).
  (Sibling of the `foreach`/`-Filter` PowerShell traps above.)
- **Completed remediation runs before state preservation are hard to retry.** If
  close deleted `.audit-tools/remediation/state.json`, the final report/outcomes
  may not contain enough item-spec or block context to reopen ignored findings
  deterministically.

### Friction from the June 8–9 self-audit (auditor feedback)

- **Audit scope is polluted by non-source artifacts.** The dominant friction of
  the run: the planner scanned and dispatched review packets for prior
  `.audit-artifacts/` run outputs, `-tmp/opentoken_*.json`, `.tgz` package
  tarballs, npm `_cacache` blobs, and the `audit/` deliverable folder auditing
  itself. Auditors repeatedly reported "JSON data artifacts, not code — no
  findings possible," so most agent effort was spent on data, not code. The tool's
  own synthesis confirmed it: `COR-281a9b14` (VCS-ignored / temp dirs scanned into
  the manifest), `MNT-68f7a179` (801 stale entries referencing non-existent
  `.tmp/opentoken/` paths), `COR-6464fa65` (`bun.lock` misclassified as
  pending-audit rather than generated). This is the strongest evidence for the
  scope checkpoint below. **Partly shipped 2026-06-09:** `disposition.ts` now
  excludes `.tgz`/`.tar`/`.gz` archives, npm `_cacache`/`npm-cache`, nested
  `.audit-artifacts/`, and the pipeline's own `audit-findings.json` /
  `remediation-outcomes.json` contracts. Remaining: honor `.gitignore` generally,
  and the LLM scope/intent gate below.
- **`submit-packet` rejects in-boundary `affected_files`.** `file_coverage`
  validation rejects an `affected_files` entry that crosses a packet boundary even
  when the referenced file is in the task's declared boundary list (e.g. a
  `schemas/finding.schema.json` needed to fully describe a duplicate-schema
  finding). Workers had to drop legitimate evidence files. The error also doesn't
  surface which files ARE allowed — the assigned `file_paths` are opaque to the
  agent. **Shipped 2026-06-09:** the rejection now lists the task's allowed files.
  Still open: whether to *allow* declared-boundary files as `affected_files`
  evidence (a contract decision — auditors currently may reference only assigned
  files).
- **Read tool truncates lines over ~2000 chars.** Large `file_coverage` arrays
  inside prior-result JSON exceed the per-line cap, so auditors couldn't
  reconstruct exact arrays and fell back to `Get-Content`/bash. Largely a
  downstream symptom of the scope pollution above (auditing huge JSON), but worth
  noting for any task that must read wide JSON.

## Deferred fixes (product bugs)

### audit-code + remediate-code: add a lightweight scope and intent checkpoint — *highest-signal open item*

> **Validated by the June 8–9 self-audit.** With no scope gate, the run spent the
> bulk of its agents auditing `.audit-artifacts/`, tarballs, npm cache, and its
> own `audit/` output. A single bounded confirmation would have caught all of it.
> See "Audit scope is polluted by non-source artifacts" above.

Both orchestrators should confirm scope before expensive planning or multi-agent
dispatch. After deterministic intake, each tool should propose the scope it
intends to operate on, explain suspicious inclusions and exclusions, and let the
user accept the default or provide compact overrides. The default path should be
one low-friction confirmation, not an extended interview.

The checkpoint should combine deterministic checks with bounded LLM judgment over
the deterministically discovered intake. Deterministic intake can identify
folders, packages, generated outputs, vendored dependencies, build artifacts,
existing `.audit-tools` state, candidate input documents, finding severities,
lenses, and work-block counts. The LLM layer should reason about whether that
discovered shape looks like the intended product scope: e.g. whether
`node_modules`, `dist`, vendored code, archived experiments, scratch folders,
stale audit artifacts, or adjacent packages should be included, excluded, or
called out for the user's decision.

The prompt should receive a pre-digested scope summary, not a broad repo/report
dump. For audit-code, the proposal should cover repo/folder boundaries,
ignored/generated areas, selected lenses, and operator guidance such as "focus on
API contracts" or "skip tests." For remediate-code, it should cover selected input
documents/contracts, finding filters by severity/theme/package/lens, files or
packages that must not be touched, and free-form remediation intent. Persist the
accepted scope and user intent as a durable artifact, feed it into planning and
worker prompts, and include skipped scope in the final report so omissions are
explicit.

This checkpoint also subsumes the separate "ask for user approval for intake
object(s)" idea: even when a perfectly structured and non-stale
`audit-findings.json` exists, remediate-code should still propose candidate
inputs before planning. Prefer the canonical auditor contract when present, but
also look through `docs/` and similar folders for plausible remediation inputs,
summarize the candidates, and let the user add conversational direction.

### remediate-code: structured `audit-findings.json` fast path skips intake

Default input discovery prefers `audit-findings.json` over `audit-report.md`,
which is right because JSON is the source of truth. The remaining problem is that
structured input calls planning directly and bypasses the intake summary,
briefing, clarification, and scope gate (`shouldEnterContractPipeline` returns
false for `structured_audit`; `intakeResolver.ts` routes a lone `.json` straight
to the lossless fast path). A clean "remediate everything" hand-off is fine for
small contracts, but a large contract gives the operator no chance to choose
"high severity only," filter by theme/package/lens, or exclude scratch units.

Resolve this through the shared scope and intent checkpoint above. Structured
input should stay lossless, but it should still allow selectable work blocks,
severity/theme/package filters, excluded paths, and conversational remediation
intent before `runPlanPhase`. (This is the deferred `FINDING-012` from the
2026-06 remediation pass.)

### remediate-code host-dispatch gaps

- **Provider `queryLimits` is deferred because it has near-zero value today.** The
  canonical dispatch call site already treats an absent method and a `null` return
  identically (`await provider.queryLimits?.(…).catch(() => null) ?? null`), so
  null-returning stubs change nothing at runtime. Revisit only if a provider gains
  a real proactive rate-limit endpoint. This belongs with heterogeneous,
  quota-aware dispatch.

### audit-code: scope postinstall's deployed OpenCode permissions to the auditor agent

- **`CFG-4996560e` (triaged 2026-06-09, confirmed-but-design-sensitive).**
  `packages/audit-code/scripts/postinstall.mjs` deploys, into the user's **global**
  OpenCode config, a top-level `permission.bash: {'*':'allow'}` + `external_directory:
  {'*':'allow'}` (with a denylist). Broad-allow-with-denylist is the project's
  *intentional* autonomy model (the repo's own `opencode.json` uses it), but applying it
  at the **global top level** widens permissions for *all* OpenCode usage, not just audit
  runs. Fix direction: keep the broad perms on the `auditor` agent (the `/audit-code`
  command runs as `agent: 'auditor'`) and minimize the global top-level default — drop the
  forced `external_directory: {'*':'allow'}` in `mergeOpenCodeGlobalConfig` and stop
  seeding `bash['*']='allow'` at top level so it falls back to `ask`. Intricacy: the broad
  value flows through the shared `mergeOpenCodePermissionRule`/`mergeOpenCodePermissionConfig`
  helpers (forced `managedRules` + `'*'` defaulting), feeding both scopes from one
  `renderOpenCodePermissionConfig()`; splitting them needs care. Validate against **real
  OpenCode** (agent/subtask permission inheritance can't be unit-tested) and update
  `tests/postinstall-contract.test.mjs`. Deferred from the 2026-06-09 curated-highs pass
  (the other 4 highs were fixed directly); see
  `audit/2026-06-09/curated-remediation-set.README.md`.

## Features to add later

### Contract-governed implementation pipeline — *MVP shipped 2026-06; partial*

The artifact contracts, JSON schemas, validators, artifact store + staleness DAG,
next-step prompt renderers, and the closing verification report are built and
wired into both tools (shared types in
`packages/shared/src/types/contractPipeline.ts`; remediate-code
`src/contractPipeline/`, `src/steps/contractPipeline*.ts`,
`schemas/contract_pipeline.schema.json`; audit-code contract-assessment posture in
`designReviewPrompt.ts` and `spec/artifact-contract.md`). Free-form remediation
enters the pipeline; structured `audit-findings.json` keeps the deterministic
fast path.

**What remains** (durable design, not yet executed end-to-end):

- The adversarial **critic → judge → repair** loop: generate concrete
  counterexamples against design claims, classify them (`accepted` /
  `out_of_scope` / `duplicate` / `invalid` / `residual_risk`), and repair the
  contract *before* implementation tasks are generated. The artifact types exist;
  the dispatch + bounded-execution wiring does not.
- Exercising the full `goal → context → candidate design → conceptual critique →
  final design → obligations → contract assessment → ImplementationDAG →
  implement → verify` flow on a real free-form request, with the one-bounded-step
  contract preserved at each transition and a traceable `VerificationReport` at
  the end.

Durable principles to keep honoring as the rest lands: treat LLM output as
untrusted until validated; no implementation task without traceability to a
requirement, invariant, or accepted counterexample; deterministic validators run
before LLM critics; conceptual critique may propose better designs but adopted
changes must be reflected in the contract before implementation; "tests pass" is
never sufficient proof of completion. Use **contract assessment** (invariants /
boundaries / obligations) and **conceptual design critique** (philosophy /
alternatives) as the two named modes — never the bare phrase "design assessment".

### Heterogeneous multi-agent dispatch — *partial*

`computeDispatchCapacity({ pools, pendingItemTokens })` in `@audit-tools/shared`
sizes dispatch just in time, partitions pending token estimates across
`CapacityPool`s, and sums concurrent slots with per-pool quota summaries.
Remaining (deferred as `FINDING-020` — cross-package): per-packet provider
assignment, host-model detection for additional pools, and building a real second
pool such as an IDE model or another CLI provider.

### Stable, content-addressed finding IDs

Finding IDs are re-emitted per file/unit a finding touches and reused across audit
passes, so counts inflate badly (`MNT-6c66181b`: 26×`MNT-001`, 25×`MNT-002`… in
the older report; the 392-finding deliverable was really a few dozen distinct
problems). The 2026-06 synthesis already emits hash-suffixed IDs
(`COR-11b75f89`), which helps; finish the job so a finding has one stable
content-addressed ID across passes, enabling reliable dedup, cross-run diffing,
and honest counts.

### Make agent meta-audit reflections a first-class artifact

When auditing or remediating audit-tools itself (a meta-audit), auditors were
asked ad-hoc to append a reflection on their experience to
`.audit-tools/audit/agent-feedback.jsonl`. That feedback loop surfaced nearly all
the friction in this backlog — it should be canonical, not ad-hoc:

**v1 shipped 2026-06-09 (audit-code).** Stable `agent_reflection` schema
(`packages/audit-code/schemas/agent_reflection.schema.json`), an opt-in inline
reflection invitation in the audit worker prompt (`renderWorkerPrompt`), and a
pure aggregate/render (`src/reporting/agentReflections.ts`) wired into
`renderAuditReportMarkdown` via `options.reflections` (emits a "Process Feedback"
section). **Remaining:** (1) the synthesis disk-load that reads
`agent-feedback.jsonl` into the bundle and passes it as `options.reflections` —
deferred because it touches the artifact registry (`io/artifacts.ts`) and the
staleness DAG (`orchestrator/dependencyMap.ts`, a finalization-sensitive
subsystem); do it as a focused change with the dependency edge plus a
finalization re-check. (2) remediate-code prompt parity (document/implement
invitation) and aggregation into `remediation-report.md`.

- The packet/worker prompts (and remediate-code document/implement prompts) should
  explicitly invite a short structured reflection — ambiguities, tool friction,
  instruction clarity, severity, suggestion — appended to a known feedback
  artifact with a stable schema, rather than relying on a per-run instruction.
- Synthesis should aggregate the reflections into a dedicated "process feedback"
  section of the report (or a sibling artifact), deduped and themed, so recurring
  pain is visible without hand-reading the JSONL.
- Keep it opt-in and low-cost so it never competes with the actual audit/remediate
  obligation; most of the value is in the self-audit case, so it can be gated on a
  meta-audit flag or simply always-available-but-optional.

Goal: every self-audit run ends with both findings *and* an attributable,
structured account of how the tool felt to operate — closing by default the loop
that this cleanup had to run by hand.
