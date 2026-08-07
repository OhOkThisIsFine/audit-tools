# External-analyzer sweep 2026-08-07 — verified findings, fixes, and the permanent fixtures

Date: 2026-08-07 · Inputs: the owner's Codex-lane analyzer runs in `analysis-results-2026-08-07/`
(jscpd, similarity-ts, eslint+sonarjs, knip, ts-prune, madge, dependency-cruiser, sonar-attempt) ·
Verification: every lead below was checked against source before a verdict (parallel agent fan-out +
relay-lane dispatch + inline reads); an analyzer hit is a LEAD, not a finding.

**This document is the record of (1) which tools became permanent dev fixtures and why, (2) which
were declined and why, (3) every verified finding and its disposition.** Fix-now items were applied
the same day (this doc's commit and its neighbors); backlog items live in
[`open-bugs.md`](../backlog/open-bugs.md) / [`forward-tracks.md`](../backlog/forward-tracks.md)
as usual — this doc is the evidence trail, not a second tracker.

---

## 1. Tool adoption — the permanent dev-side fixtures

These gate the DEVELOPMENT of audit-tools (wired into `verify:checks`, registered in
`scripts/guard-reach-data.mjs`). They are distinct from the audit-tools *product's* acquired-analyzer
surface (`src/shared/analyzers/`), which stays leads-not-verdicts.

| Tool | Verdict | Gate | Config |
|---|---|---|---|
| eslint + @typescript-eslint + sonarjs | **ADOPT** | `check:lint` | `eslint.config.js` — curated zero-tolerance ruleset, NOT the recommended presets |
| dependency-cruiser | **ADOPT** | `check:depgraph` | `.dependency-cruiser.cjs` — no runtime cycles; shared never imports orchestrators |
| jscpd | **ADOPT** | `check:dup` | `.jscpd.json` — duplicated-lines ratchet at 5.5% (baseline 4.9%) |
| knip | already adopted | `check:deadcode` | project widened to include `tests/**` so test-helper consumers count |
| @kongyo2/similarity-ts | keep, manual-only | — | periodic sweep tool (overlap mode), never a gate — too noisy for zero-tolerance |
| ts-prune | **DECLINE + removed** | — | 985 rows, verified ~100% false-positive here (can't trace barrel re-exports / dispatch tables); knip owns dead code |
| madge | **DECLINE + removed** | — | subsumed by dependency-cruiser's `no-circular` (and madge misses type-only cycles) |
| sonar-scanner | **DECLINE** | — | needs an external Sonar host/token; nothing local to run |

Calibration decisions worth keeping (they explain the configs):

- **The recommended presets are not adoptable here.** The full sonarjs+ts-eslint recommended run
  produced 1,366 errors, dominated by style/judgment rules (cognitive-complexity ×195,
  no-nested-conditional ×94, nested-template-literals ×38) and by rules that are *wrong for this
  repo*: `sonarjs/no-alphabetical-sort` (×87) demands `localeCompare`, which is locale-dependent and
  would violate the deterministic stable-order invariant — default lexicographic `sort()` is the
  *correct* choice here. The regex-perf family (`super-linear-regex` ×55, char-class rules)
  false-positives on idiomatic patterns (`[A-Za-z_]` is not a "single-char class"; `/^_+|_+$/` is
  linear). The curated config keeps only verified-real defect classes, all as errors, tree at zero.
- **The owner's one-shot run had two silent coverage gaps** the permanent config closes: the tests
  tree produced 589 parse errors (project pointed at `tsconfig.json`, which excludes tests) so tests
  were never actually linted, and the `**/*.{js,ts,tsx}` glob missed every `.mjs` file — i.e. the
  typechecker-invisible `scripts/`/`wrapper/`/`dispatch/` surface, exactly where a lint floor
  matters most. The permanent config linting that surface is what caught the wrapper/scripts dead
  code below.
- **jscpd is a ratchet, not a mandate.** Barrel re-exports, per-orchestrator adapter boilerplate,
  zod shapes, fixture setup and lookup tables are *accepted* duplication (verified class-by-class,
  §3). The threshold exists to stop drift, and breaches are investigated with
  `npx jscpd --reporters consoleFull src scripts tests`.
- **dependency-cruiser bans runtime cycles only.** Three type-only cycles existed at adoption
  (`quota/limits↔scheduler`, `remediate state/itemStatus↔types`, `contractPipeline
  artifactStore↔semanticProjection`) — type-erased at runtime, tolerated by the rule
  (`viaOnly: dependencyTypesNot type-only`), tracked as cleanup below. This is also why madge's
  "no cycles" was misleading: it never saw type edges.
- **No orphan/reachability rule** — deliberately. The tested-but-unwired class stays a periodic
  manual audit (CLAUDE.md "Dead-code release gate"): reachability can't trace this codebase's
  dispatch-table/string-keyed wiring and would false-positive like `knip --production` does.

## 2. Fixes applied 2026-08-07 (verified, same-day)

- **`src/shared` layering violation** — `contentKey.ts` imported `normalizeForMetadataHash` from
  `src/audit/orchestrator/artifactFreshness.ts`, dragging orchestrator code into the
  `audit-tools/shared` export. The module MOVED down to `src/shared/artifactFreshness.ts` (it is
  shared substrate; remediate's `semanticProjection` already documented itself as its mirror). The
  new `check:depgraph` rule makes recurrence impossible.
- **Unused-import purge** — 114 unused imports removed across ~75 files (sonarjs/unused-import
  suggestion-fixes applied mechanically from the JSON report).
- **`(t)` callback-param purge** — 104 leftover node:test-style `t` params from the vitest
  migration removed across the test tree (plus the typed `(t: TestContext)` variant).
- **Dead code deleted from src** (each grep-verified zero consumers): `allPoolsExhausted()` in
  `rollingDispatch.ts` (superseded by `noPoolCanAcceptNow`); `assertLensArray` (byte-identical twin
  of `assertStringArray`, callers repointed); `HIGH_RISK_PERMISSION_TOKENS` (never-wired const in
  `browserExtension.ts`); `buildCoverageIndex` (taskBuilder); `INTERACTIVE_PROVIDER_OPTIONS` +
  `formatQuotedList` pair (operatorHandoff); `dedupe` (changeClassification); `markStarted`
  (marshal); `itemReadFileLists` write-only collection (marshal); `originalToCurrent` write-only map
  (modularity); `DispatchBatchRun` interface (io/runArtifactTypes); wrapper-lib's `setDefaultFlag` +
  then-orphaned `hasFlag`.
- **Dead stores / redundant control flow**: `state.ts` status double-assignment; `scheduler.ts`
  `bindingCap` dead init; `triage.ts` write-only `reconciledSatisfied`; `contractPipeline.ts` unused
  `cpDir`; redundant `continue`/`return` (scoreAudit, ownershipRegistry); `smoke-packaged-audit-code`
  dead `stepStart` init. `release-and-publish.mjs`'s tracked-but-unread `lastResult` now feeds the
  registry-timeout error message (the read it was always meant to have).
- **Unused-param/caught-error hygiene** across src/tests/scripts (`^_` convention), including
  restoring signature-required params as `_`-prefixed rather than deleting them.
- **Two weak tests strengthened, one incomplete invariant completed**: `io-remediation` now asserts
  both copies were attempted (`copyCallCount`); `field-trial-remediation`'s default-session-config
  test now asserts what its name claims; `remediate-tests-invariants`' constants check now includes
  the `importsFromValidation` disjunct its own comment promised (the variable was computed and
  dropped).
- **`charterPackets.ts`** `/^[\s]/` → `/^\s/` (behavior-identical).

## 3. Verified-benign duplication (declined, so it is not re-litigated)

jscpd counts these; they are deliberate architecture, not drift:

- **Per-orchestrator barrel/adapter mirroring** — `src/{audit,remediate}/providers/index.ts` and
  `quota/index.ts` re-export the same shared surface per "one core, two draws"; unifying would add
  indirection with no semantic gain.
- **Engine-vs-consumer interface mirroring** — `rollingDispatch` callback signatures appear in both
  the shared engine contract and remediate's options; two abstraction boundaries, same shape.
- **Test fixture boilerplate** — friction-test helpers, step-driving loops, temp-repo setup.
  (The wrapper/next-step/pre-commit harness extractions that DID happen were T4 splits, where the
  sharing was within one suite family.)
- **Lookup tables** — `allowlistedExec.ts` rg/ripgrep alias flag sets and similar data tables.

## 4. Backlog-grade findings (real, need their own bounded work)

Filed in the backlog (owning file noted per entry there); evidence summarized here:

1. **scoreAudit/scoreTokens drifted mirror** — `ratio`/`pct`/regression-predicate/markdown-render
   duplicated; `scoreTokens.ts:222` even documents itself as an exact mirror. They have already
   drifted (direction-flipped predicates). Extract the shared pure helpers.
2. **claimRegistry/reservationLedger copied store scaffolding** — mint-token/read/write/type-guard
   substrate byte-copied ("the ClaimRegistry pattern generalized"); collapse the I/O scaffolding,
   keep the claim-vs-lease semantics distinct.
3. **`compareGraphEdges` private copies** in `reviewPacketGraphClustering` + `reviewPacketGraphContext`
   — load-bearing for stable edge ordering; single-source next to `graphEdgeConfidence`.
4. **rollingAuditDispatch vs providerNodeDispatch prep** — identical provider-resolve/sidecar-write/
   launch head; the one-core-two-draws shape says this belongs in the shared rolling-dispatch fabric.
5. **reviewPacketMetrics/reviewPackets helper twins** (`normalizePriority`, `lineCountForPath`) and
   **acceptNode.ts intra-file outcome-object twins** (733/786) — mechanical extractions, loop-core
   files, deserve their own attested commit.
6. **`nextStepCommand.ts` conceptual-dispatch near-twins** (491/632) and
   **cargo/packageJson workspace-pattern processing** — extract after confirming the contextual
   differences are incidental.
7. **`parseEntries`/`parseBulletEntries`** in `check-backlog-budget` / `generate-handoff-roadmap` —
   same bullet-list parsing in the typechecker-invisible scripts tree.
8. **Step-driving harness unification** — `audit-code-completion.test.ts`'s `advanceToDispatchReady`
   vs the (now shared) `wrapper-harness.ts` `startDispatchRun`, and the simpler
   `helpers/run-wrapper.mjs` vs the harness spawn plumbing: one parameterized driver would serve all.
9. **Three type-only import cycles** (§1) — break by moving the shared types down.
10. **Regex-perf triage tail** — the super-linear/complexity hits on patterns that DO process
    audited-repo content (`graphPythonImports`, `graphRoutes`, `changeClassification`,
    `autonomousGate`, `worktreeLifecycle`, `stepBoundaryCapture`): per-pattern judgment, not
    mechanical; the rest of the regex family was verified false-positive.

## 5. Leads that dissolved on verification

- **ts-prune's 985 rows** — spot-verified ~15 across the shapes (barrel re-exports, dispatch tables,
  test-only seams): every one had real consumers. The tool cannot trace re-export chains; its output
  here is noise. (This is why it was removed rather than kept "for another opinion".)
- **sonarjs "always-false comparison" (×14)** — the flagged `arr[i] === undefined` checks are valid
  defensive guards (`noUncheckedIndexedAccess` is off); the rule, not the code, is wrong here.
- **sonarjs deprecation (×11)** — stale against current source.
- **`arguments-order` (×4)** — the `addEdge(from,to)/addEdge(to,from)` pair is deliberate
  bidirectional construction, commented as such.
- **similarity-ts strict modes** (functions/types/classes at 0.9) — zero pairs: no near-identical
  function/type/class bodies at that threshold anywhere in src.
