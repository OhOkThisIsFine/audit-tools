// Guard-reach registry — the canonical declaration of every guard and what it
// actually covers (nightly determination ec64d159). Reconciled by
// `scripts/check-guard-reach.mjs` (`npm run check:guard-reach`, in
// verify:checks); the contract is pinned by tests/shared/guard-reach-gate.test.ts.
//
// SEMANTICS — read before editing:
//   • A `guardedBy` claim means "this guard actually scans or executes these
//     files", NEVER "these files are protected from every defect". A broad glob
//     with an inflated guard list is fake coverage — the exact failure this
//     registry exists to make visible.
//   • `uncovered` is the stated uncovered half, as data. The durable-traps
//     policy ("a partly-enforced trap must state the uncovered half") lives
//     HERE for reach, not in prose that decays.
//   • `guardedBy: 'declared-gap'` claims files deliberately guarded by nothing;
//     `note` must say why that is the accepted state. A gap is a decision,
//     silence is a defect.
//   • Overlap is expected (a file may be claimed by several rows); a tracked
//     file claimed by ZERO rows fails the build.
//
// Glob grammar is check-doc-manifest.mjs's: `*` within a segment, `**/` across
// segments, `?` one character.

import { RUNTIME_NAME_SOURCES } from "./shared/generate-runtime-artifact-names.mjs";
import { SPEC_MIRROR_DOCS, SPEC_MIRROR_SOURCE_FILES } from "./shared/spec-mirror-data.mjs";

/**
 * @typedef {object} GuardRow
 * @property {string} id
 * @property {'gate'|'hook'|'contract-test'} kind
 * @property {string} impl gate: npm script name, or a repo path referenced
 *   verbatim by a script reachable from verify:release; hook: the hook file's
 *   repo path (must be registered in .claude/settings.json); contract-test:
 *   the test file's repo path (must live under tests/ — vitest excludes
 *   .claude/**).
 * @property {false|'reach'|'always'|'final'} [preCommit] gates only, REQUIRED
 *   there (reconciled — a gate row without it is a red build): whether and how
 *   the pre-commit hook runs this gate as a derived leg
 *   (scripts/shared/derived-file-preflight.mjs `buildPreCommitLegs`).
 *   `false`   = deliberate CI-only. Omission is a STATEMENT, never silence.
 *   `'reach'` = run when the staged set intersects the union of the `files`
 *               globs of every REACH row citing this gate, ∪ the gate's own
 *               impl script path (parsed from package.json) ∪ package.json.
 *   `'always'`= unconditional whenever the repo wires the script
 *               (check:guard-reach — tree membership changes on ANY staged
 *               add/delete/rename, so there is no narrower honest trigger).
 *   `'final'` = reach-triggered but runs AFTER every structural refusal
 *               (check:doc-links only — the broadest trigger in the gate must
 *               never mask a more specific refusal behind it).
 * @property {string} [fix] one-line remediation hint printed by the pre-commit
 *   gate leg and the attest preflight when this gate fails.
 * @property {string} [note]
 */

/**
 * @typedef {object} ReachRow
 * @property {string} area
 * @property {string[]} files
 * @property {string[]|'declared-gap'} guardedBy
 * @property {string} [uncovered]
 * @property {string} [note]
 */

/** @type {GuardRow[]} */
export const GUARDS = [
  // ── gates (npm scripts reachable from verify:release) ──────────────────────
  { id: 'build', kind: 'gate', impl: 'build', preCommit: false, note: 'tsc over src/ + data-asset copy; the pre-commit gate hand-codes its `npm run check` leg' },
  { id: 'check:tests', kind: 'gate', impl: 'check:tests', preCommit: false, note: 'tsc over the test tree (tsconfig.test.json)' },
  {
    id: 'check:control-bytes',
    kind: 'gate',
    impl: 'check:control-bytes',
    preCommit: false,
    note: 'preCommit false is deliberate (CI-only; the tool-input-guard hook already refuses control bytes at write time) — cheap, flip to reach if wanted',
  },
  {
    id: 'check:shared-primitives',
    kind: 'gate',
    impl: 'check:shared-primitives',
    preCommit: 'reach',
    fix:
      'adopt the canonical shared helper the violation names (compareCodeUnits / isRecord / ' +
      'hashContent / pathContainment / paths.ts), or amend the DATA tables in ' +
      'scripts/check-shared-primitives.mjs — an exception is a file + reason row, never prose',
    note:
      'single-definition rules plus defect-class pattern rules (comparator body, containment ' +
      'predicate, sha256 chain, localeCompare/ICU collation) over tracked src/**/*.ts',
  },
  { id: 'check:deadcode', kind: 'gate', impl: 'check:deadcode', preCommit: false, note: 'knip, default mode' },
  {
    id: 'check:doc-manifest',
    kind: 'gate',
    impl: 'check:doc-manifest',
    preCommit: 'reach',
    fix:
      'register the staged doc (type + reason to exist) in scripts/doc-manifest-data.mjs and re-render ' +
      'with `node scripts/check-doc-manifest.mjs --write`, or delete the doc — this is the check that ' +
      'fails RELEASE CI and burns a release tag',
  },
  {
    id: 'check:doc-links',
    kind: 'gate',
    impl: 'check:doc-links',
    preCommit: 'final',
    fix:
      'a relative markdown link does not resolve on disk — if the dead link is in a GENERATED doc ' +
      '(docs/HANDOFF.md, docs/backlog.md), fix the LIFT in scripts/shared/rebase-relative-links.mjs; ' +
      'editing the generated file is overwritten by the next regeneration',
    note:
      'uncovered half: generated deliverable renders are excluded (shared/generated-renders.mjs) — ' +
      'their worker-authored prose may quote link-shaped text (2026-08-18)',
  },
  {
    id: 'check:doc-code-citations',
    kind: 'gate',
    impl: 'check:doc-code-citations',
    preCommit: 'reach',
    fix:
      'a backticked citation in a staged doc does not resolve — a slashed path must name a tracked file, ' +
      'a trailing-slash directory must exist (root- or doc-relative), and a bare filename must match ' +
      'exactly one tracked basename (a lone repo-root candidate wins a tie; run-artifact names from ' +
      'scripts/shared/runtime-artifact-names.generated.mjs are skipped) — fix the citation, cite the ' +
      'full path, or add a doc-citation-exempt marker',
    note:
      'uncovered halves, declared: unbackticked path mentions in prose/tables (the P29 glossary case) ' +
      'are out of scope; bare names with a leading dot or dash (.gitignore/.npmrc — extension-mention ' +
      'idiom) and bare names whose extension no tracked file uses go unchecked; slashed tokens with no ' +
      'extension and no trailing slash, and backslashed Windows-path prose, are skipped; gitignored and ' +
      'non-repo (~/drive/URL) citations are out of scope by construction (2026-08-18)',
  },
  {
    id: 'check:gate-enumeration',
    kind: 'gate',
    impl: 'check:gate-enumeration',
    preCommit: 'reach',
    fix:
      'add the step gloss to scripts/gate-enumeration-data.mjs and re-render with ' +
      '`node scripts/check-gate-enumeration.mjs --write`',
  },
  {
    id: 'check:philosophy-brief',
    kind: 'gate',
    impl: 'check:philosophy-brief',
    preCommit: 'reach',
    fix:
      "README.md's Philosophy section is GENERATED from docs/project-philosophy.md — regenerate with " +
      '`npm run check:philosophy-brief -- --write`; never hand-edit the rendered block',
  },
  {
    id: 'check:readme-sample-report',
    kind: 'gate',
    impl: 'check:readme-sample-report',
    preCommit: 'reach',
    fix:
      "README.md's sample-report block is GENERATED from the report renderer — regenerate with " +
      '`npm run check:readme-sample-report -- --write`; never hand-edit the rendered block',
  },
  {
    id: 'check:proposal-red-at',
    kind: 'gate',
    impl: 'check:proposal-red-at',
    preCommit: 'reach',
    fix:
      'a proposal dir ships a *.test.ts/*.test.mjs with no sibling RED-AT.txt — run the test at ' +
      'HEAD and record the exact command, sha, and verbatim failure (or one line stating why it ' +
      'cannot run at HEAD)',
  },
  {
    id: 'check:nightly-routine-prompt',
    kind: 'gate',
    impl: 'check:nightly-routine-prompt',
    preCommit: 'reach',
    fix:
      'docs/nightly-routine-prompt.md is generated from docs/nightly-routine.md + ' +
      'docs/doc-review-guidelines.md — run `node scripts/check-nightly-routine-prompt.mjs --write`, then re-stage the target',
  },
  { id: 'check:loop-core-patterns', kind: 'gate', impl: 'check:loop-core-patterns', preCommit: false },
  { id: 'check:constitutional-doc-paths', kind: 'gate', impl: 'check:constitutional-doc-paths', preCommit: false },
  {
    id: 'check:runtime-artifact-names',
    kind: 'gate',
    impl: 'check:runtime-artifact-names',
    preCommit: 'reach',
    fix: 'runtime-artifact-names.generated.mjs is stale — run node scripts/shared/generate-runtime-artifact-names.mjs',
  },
  {
    id: 'check:executor-producers',
    kind: 'gate',
    impl: 'check:executor-producers',
    preCommit: 'reach',
    fix:
      'spec/audit/executor-producers.generated.md is stale — run `node scripts/shared/generate-executor-producers.mjs`, ' +
      'then re-stage it. The producer relation is declared on EXECUTOR_REGISTRY[].produces; never hand-edit the render',
  },
  {
    id: 'check:spec-mirrors',
    kind: 'gate',
    impl: 'check:spec-mirrors',
    preCommit: 'reach',
    fix:
      'a generated table region in spec/audit/artifact-contract.md, executor-catalog.md or ' +
      'dependency-map.md is stale — run `node scripts/shared/generate-spec-mirrors.mjs`, then ' +
      're-stage the doc(s). Never hand-edit between the markers: the rows come from ' +
      'ARTIFACT_DEFINITIONS / EXECUTOR_REGISTRY / ARTIFACT_DEPENDS_ON_MAP and the Purpose/Notes ' +
      'prose from scripts/shared/spec-mirror-data.mjs. If the check instead names a row the ' +
      'declaration and the registry disagree about, fix the declaration — a new registry entry ' +
      'must be filed under a section with its prose before it can render',
  },
  {
    id: 'check:cli-surface',
    kind: 'gate',
    impl: 'check:cli-surface',
    preCommit: 'reach',
    fix:
      "docs/audit-pkg/product.md's installer-verb block is stale — run " +
      '`node scripts/shared/generate-cli-surface.mjs`, then re-stage it. The verbs and their ' +
      'summaries are declared in wrapper/installer-verb-help.mjs (what both bins answer ' +
      '`<verb> --help` from); never hand-edit inside the markers',
    note:
      'covers the four wrapper-intercepted INSTALLER verbs only. UNCOVERED HALF: every OTHER command ' +
      "wrapper/audit-code-wrapper-lib.mjs's printHelp() lists — `prompt-path`, `mcp`, `validate`, " +
      '`explain-task`, the ingest verbs — carries its one-line summary as loose prose rather than a ' +
      'declaration this render can read, so doc prose naming those stays hand-written and unchecked ' +
      '(lift them from printHelp to a declaration the way the installer verbs were)',
  },
  {
    id: 'check:handoff-roadmap',
    kind: 'gate',
    impl: 'check:handoff-roadmap',
    preCommit: 'reach',
    fix:
      'run `node scripts/shared/generate-handoff-roadmap.mjs`, then re-stage docs/HANDOFF.md. Do NOT ' +
      'hand-edit inside either generated block; queue detail lives in docs/nightly-inbox.md and ' +
      'roadmap entry text lives in the backlog. If the check instead names hand-written changelog ' +
      'creep (dated bullet / landing narrative / Verification-state heading), regenerating fixes ' +
      'NOTHING — trim or reword the named line; shipped-work narration belongs in git log, the ' +
      'backlog, or memory',
    note:
      'uncovered half of the hand-written creep leg: narration avoiding all three shapes passes — ' +
      'mid-line dates ("decided 2026-08-18"), a date as the bullet\'s second word, lowercase ' +
      '"landed", "is COMPLETE", novel phrasings; the nightly doc leg remains the semantic backstop ' +
      '(2026-08-18)',
  },
  {
    id: 'check:backlog-index',
    kind: 'gate',
    impl: 'check:backlog-index',
    preCommit: 'reach',
    fix:
      'run `node scripts/shared/generate-backlog-index.mjs`, then re-stage docs/backlog.md. Do NOT ' +
      'hand-patch line numbers inside the generated seek-index markers; they are derived, and the ' +
      'next backlog edit moves them again',
  },
  {
    id: 'check:backlog-budget',
    kind: 'gate',
    impl: 'check:backlog-budget',
    preCommit: 'reach',
    fix:
      'a staged backlog entry or file is over its size ceiling, and an over-budget file may only ' +
      'shrink — condense at write time: keep the MECHANISM and the open PROPERTY, link the primary ' +
      'record (git log, docs/reviews/) instead of retelling it. There is no per-entry ceiling to raise',
  },
  {
    id: 'check:backlog-status',
    kind: 'gate',
    impl: 'check:backlog-status',
    preCommit: 'reach',
    fix:
      'a staged backlog entry leads with a status label, and the backlog is a living to-do list, not a ' +
      'status log — a fully-closed entry is DELETED (durables move to their real home first), a ' +
      'partial one is TRIMMED to its open remainder. Only the leading-label form is refused',
  },
  {
    id: 'check:backlog-line-numbers',
    kind: 'gate',
    impl: 'check:backlog-line-numbers',
    preCommit: 'reach',
    fix:
      'a staged backlog entry cites a bare line number (a backticked `path:123` or a bare `:21` span) — ' +
      'cite the SYMBOL instead, or the file alone when no good symbol exists; never auto-resolve a ' +
      'drifted number to the nearest declaration (dropping the number beats false precision)',
  },
  {
    id: 'check:memory-citations',
    kind: 'gate',
    impl: 'check:memory-citations',
    preCommit: 'reach',
    fix: 'a staged doc cites a memory file that does not exist — fix the citation or restore the memory file',
    note:
      'uncovered halves: [[name]] cross-links between memory files are not checked; generated ' +
      'deliverable renders (.audit-tools/audit-report.md, remediation-report.md) are excluded — ' +
      'their worker-authored prose may quote citation-shaped text (2026-08-18)',
  },
  {
    id: 'check:version-gates',
    kind: 'gate',
    impl: 'check:version-gates',
    preCommit: false,
    note: 'preCommit false is deliberate (CI-only) — cheap, flip to reach if wanted',
  },
  {
    id: 'check:guard-reach',
    kind: 'gate',
    impl: 'check:guard-reach',
    preCommit: 'always',
    fix:
      "register the file or guard in scripts/guard-reach-data.mjs (guardedBy a real guard id, or " +
      "'declared-gap' with the reason in note)",
    note: 'this registry, reconciled; always: tree membership changes on ANY staged add/delete/rename',
  },
  {
    id: 'check:ci-trigger-paths',
    kind: 'gate',
    impl: 'check:ci-trigger-paths',
    preCommit: 'reach',
    fix:
      "ci.yml's paths: blocks are GENERATED from this registry — regenerate with " +
      '`node scripts/shared/generate-ci-trigger-paths.mjs` and re-stage .github/workflows/ci.yml',
    note:
      'derives the ci.yml trigger-path list from non-declared-gap REACH rows + the always-trigger ' +
      'base, so a new claimed tree cannot land outside the CI trigger set',
  },
  {
    id: 'check:offload-lanes',
    kind: 'gate',
    impl: 'check:offload-lanes',
    preCommit: 'reach',
    fix:
      'reconcile scripts/shared/offload-lane-data.mjs: every lane row needs a valid bounded probe or an ' +
      'unprobeableReason, plus a remedy, plus a configDirTrust check or a trustUncheckableReason; the ' +
      'session-start hook must iterate the registry (no /health, no hardcoded lane URL); ' +
      'DOC_LANE_MARKERS must map every documented lane spelling to a live row',
    note:
      'uncovered halves, stated as data: ~/.claude/CLAUDE.md is the true lane authority but untracked — ' +
      'a gate must not ask the local disk, so its lane list is NOT reconciled (scanned docs: ' +
      'docs/nightly-routine.md + docs/backlog/durable-traps.md only); a probe proves reachable ' +
      'TRANSPORT only, never that a model, quota, or dispatched session will serve; and the ' +
      'configDirTrust rows are reconciled for SHAPE only — the session-start leg reads the trust state ' +
      'and REPORTS it, while the file that would grant trust belongs to the launcher outside this repo, ' +
      'so trust can also change between session start and dispatch',
  },
  {
    id: 'check:lint',
    kind: 'gate',
    impl: 'check:lint',
    preCommit: false,
    note:
      'eslint, curated zero-tolerance ruleset (eslint.config.js): unused-vars + verified sonarjs ' +
      'correctness rules over src (type-aware), tests (type-aware, unused-vars only) and the ' +
      '.mjs script surface (scripts/wrapper/dispatch/root bins; typed by check:scripts since 2026-08-25)',
  },
  {
    id: 'check:scripts',
    kind: 'gate',
    impl: 'check:scripts',
    preCommit: 'reach',
    fix:
      'checkJs typecheck over scripts/, wrapper/, dispatch/, .claude/hooks/ and the root bins ' +
      '(tsconfig.scripts.json) failed — fix the type error or annotate with JSDoc; noImplicitAny ' +
      'stays relaxed there by design',
  },
  {
    id: 'check:dup',
    kind: 'gate',
    impl: 'check:dup',
    preCommit: false,
    note: 'jscpd duplication ratchet (.jscpd.json threshold) over src+scripts+tests',
  },
  {
    id: 'check:depgraph',
    kind: 'gate',
    impl: 'check:depgraph',
    preCommit: false,
    note:
      'dependency-cruiser (.dependency-cruiser.cjs): no runtime import cycles in src; ' +
      'src/shared never imports src/audit|src/remediate',
  },
  { id: 'verify:hosts', kind: 'gate', impl: 'verify:hosts', preCommit: false },
  { id: 'verify:remediate-hosts', kind: 'gate', impl: 'verify:remediate-hosts', preCommit: false },
  { id: 'pack:smoke', kind: 'gate', impl: 'pack:smoke', preCommit: false },
  { id: 'smoke:packaged-audit-code', kind: 'gate', impl: 'smoke:packaged-audit-code', preCommit: false },
  { id: 'smoke:packaged-remediate-code', kind: 'gate', impl: 'smoke:packaged-remediate-code', preCommit: false },
  { id: 'smoke:linked-audit-code', kind: 'gate', impl: 'smoke:linked-audit-code', preCommit: false },
  { id: 'smoke:linked-remediate-code', kind: 'gate', impl: 'smoke:linked-remediate-code', preCommit: false },
  {
    id: 'vitest-gate',
    kind: 'gate',
    impl: 'scripts/shared/run-vitest-gate.mjs',
    preCommit: false,
    note: 'the full suite, invoked by path in verify:release',
  },

  // ── hooks (registered in .claude/settings.json) ────────────────────────────
  { id: 'session-start', kind: 'hook', impl: '.claude/hooks/session-start.sh' },
  { id: 'nightly-surface', kind: 'hook', impl: '.claude/hooks/nightly-surface.mjs' },
  { id: 'session-start-guards', kind: 'hook', impl: '.claude/hooks/session-start-guards.mjs' },
  { id: 'shell-trap-guard', kind: 'hook', impl: '.claude/hooks/shell-trap-guard.mjs' },
  { id: 'pre-commit-gate', kind: 'hook', impl: '.claude/hooks/pre-commit-gate.mjs' },
  { id: 'tool-input-guard', kind: 'hook', impl: '.claude/hooks/tool-input-guard.mjs' },
  { id: 'question-philosophy-gate', kind: 'hook', impl: '.claude/hooks/question-philosophy-gate.mjs' },
  { id: 'async-typecheck', kind: 'hook', impl: '.claude/hooks/async-typecheck.mjs' },
  { id: 'friction-stop-gate', kind: 'hook', impl: '.claude/hooks/friction-stop-gate.mjs' },
  { id: 'closeout-challenge-gate', kind: 'hook', impl: '.claude/hooks/closeout-challenge-gate.mjs' },

  // ── contract tests (the guards' own guards) ────────────────────────────────
  {
    id: 'shared-primitives-gate-test',
    kind: 'contract-test',
    impl: 'tests/shared/check-shared-primitives.test.ts',
    note: 'pins the rule matching semantics of check:shared-primitives on synthetic content',
  },
  {
    id: 'suite-green-stamp-test',
    kind: 'contract-test',
    impl: 'tests/shared/suite-green-stamp.test.ts',
    note:
      'pins the full-suite green stamp (P48): the full-suite predicate, the tree-bound stamp path, ' +
      'the run-vitest-gate write wiring, and the closeout-challenge-gate read wiring',
  },
  { id: 'hook-trap-guards-test', kind: 'contract-test', impl: 'tests/shared/hook-trap-guards.test.ts' },
  { id: 'hook-session-gates-test', kind: 'contract-test', impl: 'tests/shared/hook-session-gates.test.ts' },
  {
    id: 'session-registry-test',
    kind: 'contract-test',
    impl: 'tests/shared/session-registry.test.ts',
    note:
      'session registry substrate (child-session split + closeout dirt partition): the registration ' +
      'leg end-to-end, the explicit-id CLI, and the readSessionRegistry predicate the session-scoped ' +
      'gates import',
  },
  {
    id: 'run-hermeticity-test',
    kind: 'contract-test',
    impl: 'tests/shared/run-hermeticity.test.ts',
    note:
      'the two teardown checks in tests/helpers/global-setup.ts: a run that ADDED a repo-root entry ' +
      'it does not own fails with the entry named (the shell-redirect artifacts — an empty ' +
      '`o.testId)` / `60s` / `0)` — are the observed shape), and a run whose own spawned child is ' +
      'still alive fails with pid and command named (ledger: tests/helpers/trackedSpawn.ts). ' +
      'UNCOVERED: a `shell: true` grandchild, since the ledger holds the pid of the cmd.exe its ' +
      'parent actually spawned, not of what cmd.exe started; sync spawns, which cannot straggle; ' +
      'and the CONTENT of root entries that were already there — the root check is a delta of ' +
      'names, so a run that rewrites a tracked root file passes it',
  },
  { id: 'nightly-routine-test', kind: 'contract-test', impl: 'tests/shared/nightly-routine.test.ts' },
  { id: 'nightly-items-mandatory-fields-test', kind: 'contract-test', impl: 'tests/shared/nightly-items-mandatory-fields.test.ts' },
  { id: 'nightly-scope-ledger-test', kind: 'contract-test', impl: 'tests/shared/nightly-scope-ledger.test.ts' },
  { id: 'hook-async-typecheck-test', kind: 'contract-test', impl: 'tests/shared/hook-async-typecheck.test.ts' },
  { id: 'hook-friction-stop-test', kind: 'contract-test', impl: 'tests/shared/hook-friction-stop-gate.test.ts' },
  { id: 'hook-session-start-guards-test', kind: 'contract-test', impl: 'tests/shared/hook-session-start-guards.test.ts' },
  { id: 'session-start-hook-test', kind: 'contract-test', impl: 'tests/audit/session-start-hook.test.ts' },
  {
    id: 'installer-verb-help-test',
    kind: 'contract-test',
    impl: 'tests/shared/installer-verb-help.test.ts',
    note:
      'the installer-verb declaration and its copies: every verb of both bins answers --help without ' +
      'installing, and the two enumerations that cannot import the module are pinned verb AND summary',
  },
  {
    id: 'shipped-doc-surface-test',
    kind: 'contract-test',
    impl: 'tests/shared/shipped-doc-surface.test.ts',
    note:
      'the npm tarball as a doc surface: which docs/ pages ship, README naming exactly them, no ' +
      'relative link or fragment leaving the set, every absolute github.com slug bound to ' +
      'package.json `repository`, and the target-directory rule stated once across the loader pair',
  },
  { id: 'doc-manifest-gate-test', kind: 'contract-test', impl: 'tests/shared/doc-manifest-gate.test.ts' },
  { id: 'guard-reach-gate-test', kind: 'contract-test', impl: 'tests/shared/guard-reach-gate.test.ts' },
  {
    id: 'sync-spawn-fold-safety-test',
    kind: 'contract-test',
    impl: 'tests/shared/sync-spawn-fold-safety.test.ts',
    note:
      'INV-SSF: the fold-reachable modules (shared git helpers, the disposition extractor, the ' +
      'analyzer-dep installer) spawn children only through the async exec twin — a synchronous child ' +
      'starves the held file lock’s mtime heartbeat until another process steals the LIVE lock; ' +
      'the sync twin itself requires a declared timeout at the type level (RunTrackedSyncOptions). ' +
      'UNCOVERED: the module list is the reviewed reachability claim — a NEW fold-reachable module ' +
      'must be added to the test by hand; and the remediate-side sync spawns (triage verify ' +
      'commands, hostHandoff git probes, findingGrounding / contractPipelineGates enumerations) are ' +
      'outside the scan — tracked in the open-bugs entry',
  },
  {
    id: 'submission-no-sizing-identity-test',
    kind: 'contract-test',
    impl: 'tests/shared/submission-contract-has-no-sizing-identity.test.ts',
    note:
      'mechanical replacement for a backlog note: the submission core must not re-grow a packet/shard/' +
      'provider/model/budget field, in the emitted objects OR as a source identifier',
  },
  {
    id: 'submission-path-tool-owned-test',
    kind: 'contract-test',
    impl: 'tests/shared/submission-path-is-tool-owned.test.ts',
    note:
      'scans all of src/ for a reintroduced host-typed drop directory — the guard that keeps the ' +
      'tool-owned submission path from being undone one call site at a time',
  },
  {
    id: 'pre-commit-staged-snapshot-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-staged-snapshot.test.ts',
    note: 'staged-snapshot leg of the pre-commit-gate-*.test.ts family (shared fixture: pre-commit-gate-harness.ts)',
  },
  {
    id: 'pre-commit-commit-detection-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-commit-detection.test.ts',
    note: 'commit-detection + crash-recovery + live-lock leg of the pre-commit-gate family',
  },
  {
    id: 'pre-commit-commit-creating-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-commit-creating.test.ts',
    note: 'P9 commit-creating-subcommand leg of the pre-commit-gate family',
  },
  {
    id: 'pre-commit-attestation-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-attestation.test.ts',
    note: 'spawns the pre-commit gate AND the attest-loop-core-review hook end-to-end',
  },
  {
    id: 'pre-commit-branch-strand-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-branch-strand.test.ts',
    note: 'branch-strand refusal + fail-open announcement leg of the pre-commit-gate family',
  },
  {
    id: 'pre-commit-child-session-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-child-session.test.ts',
    note: 'Build 1 (P23) child-session commit/push refusal + push narrowness leg of the pre-commit-gate family',
  },
  {
    id: 'pre-commit-target-repo-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-target-repo.test.ts',
    note:
      'target-repo scoping leg of the pre-commit-gate family: a commit/push into a DIFFERENT ' +
      'repository (via cd chain, `git -C`, or the payload cwd) is out of jurisdiction — closes the ' +
      '2026-08-19 false-RED class (an unrelated repo\'s commit blocked by audit-tools\' red index) — ' +
      'while linked worktrees of THIS repo and unresolvable targets stay gated, fail-closed',
  },
  {
    id: 'loop-core-gate-parity-test',
    kind: 'contract-test',
    impl: 'tests/shared/loop-core-gate-parity.test.ts',
    note: 'pins pattern + predicate parity between pre-commit-gate and attest-loop-core-review',
  },
  {
    id: 'attest-derived-file-preflight-test',
    kind: 'contract-test',
    impl: 'tests/shared/attest-derived-file-preflight.test.ts',
    note: 'P19: attest scripts run the gate-shared derived-file checks before binding and refuse a tree the gate would reject',
  },
  {
    id: 'precommit-leg-derivation-test',
    kind: 'contract-test',
    impl: 'tests/shared/precommit-leg-derivation.test.ts',
    note:
      'P34 unit matrix over buildPreCommitLegs: every derived leg trigger reproduces (or safely ' +
      'widens) the retired hand-coded trigger it replaced, against the LIVE registry',
  },
  {
    id: 'pre-commit-derived-legs-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-derived-legs.test.ts',
    note: 'P34 spawn smoke: the real hook runs the derived leg loop end-to-end (block on a wired failing leg, announced skip on an unwired one)',
  },
  {
    id: 'ci-trigger-paths-test',
    kind: 'contract-test',
    impl: 'tests/shared/ci-trigger-paths.test.ts',
    note: 'P26: derivation excludes declared-gap rows, keeps the always-trigger base, and the tracked ci.yml matches the generator byte-for-byte',
  },
  {
    id: 'runtime-artifact-names-drift-test',
    kind: 'contract-test',
    impl: 'tests/shared/runtime-artifact-names-drift.test.ts',
    note:
      'drift pin for the generated run-artifact name set the doc-citation gate consumes — re-runs the ' +
      'textual extraction against the runtime-layout sources and cross-checks ARTIFACT_DEFINITIONS directly',
  },
  {
    id: 'executor-producer-declaration-test',
    kind: 'contract-test',
    impl: 'tests/audit/executor-artifact-production-declaration.test.ts',
    note:
      'pins EXECUTOR_REGISTRY[].produces against what the executor sources actually write, in both ' +
      'directions (declared ⊇ extracted, and extracted ∪ data-declared dynamic contributors ⊇ declared), ' +
      'plus one primary producer per registry artifact and drift of the generated render',
  },
  {
    id: 'spec-mirror-drift-test',
    kind: 'contract-test',
    impl: 'tests/shared/spec-mirror-drift.test.ts',
    note:
      'asserts the three docs against a fresh render of the registries (not against themselves, which ' +
      'the gate already does), pins the both-way membership reconciliation red on a dropped and on an ' +
      'invented row, and pins the splice refusals for a missing / duplicated marker pair',
  },
  {
    id: 'offload-lane-probe-test',
    kind: 'contract-test',
    impl: 'tests/shared/offload-lane-probe.test.ts',
    note:
      'P36 red-green: a catch-all 200 classifies DOWN, the registry declares the headroom lane, the live ' +
      'registry/hook/docs reconcile clean, and the hook lane leg runs end-to-end against fake lane servers',
  },
  {
    id: 'lane-dispatch-driver-test',
    kind: 'contract-test',
    impl: 'tests/shared/lane-dispatch.test.ts',
    note:
      'P28 wrapper half (sol-3): the shared one-item-per-call dispatch driver — one lane call per ' +
      'item, resume drops errored rows and re-queues exactly them, preflight aborts with a stamped ' +
      'sidecar and a typed throw, per-item log redirect before parse, finish_reason/output_bytes on ' +
      'every lane-answered row, and the read-verbatim coverage-stamp field names/order the nightly ' +
      'routine consumes',
  },
  {
    id: 'prompt-capability-test',
    kind: 'contract-test',
    impl: 'tests/shared/prompt-capability.test.ts',
    note:
      'C2 (sol-10/P35): a rendered imperative must be satisfiable by the worker it is handed to — ' +
      'contract-pipeline Required Inputs are DERIVED from DEPENDENCY_MAP (no hand-kept per-role list), ' +
      'a tool-derived artifact is materialized at the host-facing input path as well as the canonical ' +
      'envelope, and every fan-out lane prompt ends with the chokepoint footer carrying its own bound ' +
      'path plus the read-only-executor alternative. Uncovered halves, declared: whether a named path ' +
      'EXISTS on disk is a run property (pinned only for the targeted single-phase scenario in ' +
      'tests/remediate/contract-pipeline-required-inputs.test.ts — a collapsed framing step ' +
      'legitimately names paths written later in the same round-trip); archived-artifact references ' +
      'are not pinned; renderContractRepairPrompt keeps its own declared six-input list and its ' +
      '"Regenerate IN FULL" instruction, so the INV-CO-13 in-full-vs-targeted trap (durable-traps) is ' +
      'out of this guard\'s reach; and the src scan is LITERAL (the "## Results path" heading and the ' +
      '"results path provided below" dangling reference), so a differently-worded per-emitter write ' +
      'imperative — including the driver-facing "The executor must write ... to:" step-prompt lines, ' +
      'which are deliberately in scope for neither — goes unflagged',
  },
  {
    id: 'prompt-renders-its-contract-test',
    kind: 'contract-test',
    impl: 'tests/shared/prompt-renders-its-contract.test.ts',
    note:
      'P41 (nightly 2026-08-25): typed prompt-contract registry records every known builder as ' +
      'derived, projection, or declared-gap; derived rows render fixtures and assert required ' +
      'top-level schema keys plus exhaustive closed enums, projection rows assert rendered field ' +
      'tokens and schema-subset membership where a zod object exists, and declared gaps require ' +
      'reasons. A recursive fs-only source reconciliation makes every exported /Prompt/ builder ' +
      'claim exactly one row. The two P40 behavioral/source pins remain.',
  },
];

/** @type {ReachRow[]} */
export const REACH = [
  {
    area: 'shared primitive single-source (comparator / containment / hash / paths / collation)',
    files: ['src/**/*.ts', 'scripts/check-shared-primitives.mjs'],
    guardedBy: ['check:shared-primitives', 'shared-primitives-gate-test'],
    uncovered:
      'tests/** is deliberately out of the scan set — a test oracle must not import the code it ' +
      'validates, so test-tree comparator copies are accepted; the pattern rules match SPELLINGS, ' +
      'not semantics — a first-segment-split containment re-roll, an aliased `relative as rel` ' +
      'import, or an equivalent comparator under a novel spelling (`a === b ? 0 : a < b ? -1 : 1`) ' +
      'under a NEW name passes (the known fork names are banned individually; review + jscpd are ' +
      'the layers behind the gate)',
  },
  {
    area: 'runtime artifact-name layout sources',
    // DERIVED from the generator's declared input set — never hand-listed. A path
    // added to RUNTIME_NAME_SOURCES joins the commit gate's reach in the same edit.
    files: [
      ...RUNTIME_NAME_SOURCES.map((s) => s.file),
      'scripts/shared/generate-runtime-artifact-names.mjs',
      'scripts/shared/runtime-artifact-names.generated.mjs',
    ],
    guardedBy: ['check:runtime-artifact-names'],
  },
  {
    area: 'executor→artifact producer relation',
    files: [
      'src/audit/orchestrator/executors.ts',
      'scripts/shared/executor-write-sites.mjs',
      'scripts/shared/generate-executor-producers.mjs',
      'spec/audit/executor-producers.generated.md',
    ],
    guardedBy: ['check:executor-producers', 'executor-producer-declaration-test'],
    uncovered:
      'the extraction reads DECLARED write sites (scopes and CLI rules in executor-write-sites.mjs) — a ' +
      'SOME-of-the-set relocation into a helper the site does not name is invisible to it, and the ' +
      'declared-⊇-extracted direction then passes vacuously for the moved artifact (the declared side is ' +
      'still caught by DECL-4). A renamed scope, and a relocation that empties the scope, both refuse loudly. ' +
      'Separately, design_review_contract and design_review_conceptual share ONE whole-file artifactsDirWrites ' +
      'rule over src/audit/cli/nextStepHelpers.ts, so the two cannot be told apart: a CLI-site write added there ' +
      'for only one of them forces BOTH to declare it and the render credits an executor that never writes it. ' +
      'A `no-writes` site is checked in the writes-appeared direction only when it names a file+scope: ' +
      'intent_equivalence_executor does, semantic_review_executor CANNOT (no deterministic runner exists — the ' +
      'host returns results through the submission ledger), so if that executor ever started writing an artifact ' +
      'nothing would extract it and its declared-⊇-extracted pin would stay vacuous. Within a `produces` entry only ' +
      'the artifact name is checked against the code: the `role` (primary vs refresh) and `note` fields are ' +
      'hand-authored and mechanically unchecked, so a wrong role or a stale note renders faithfully',
  },
  {
    area: 'spec/audit registry mirrors',
    // DERIVED from the render's own declared input/output sets — never hand-listed, so a
    // registry or doc added to the mirror joins the commit gate's reach in the same edit.
    files: [
      ...SPEC_MIRROR_SOURCE_FILES,
      ...SPEC_MIRROR_DOCS,
      'scripts/shared/generate-spec-mirrors.mjs',
      'scripts/shared/spec-mirror-data.mjs',
    ],
    guardedBy: ['check:spec-mirrors', 'spec-mirror-drift-test'],
    note:
      'the three tables that used to hand-mirror ARTIFACT_DEFINITIONS, EXECUTOR_REGISTRY and ' +
      'ARTIFACT_DEPENDS_ON_MAP. Membership is reconciled BOTH ways — a registry row no region ' +
      'declares, and a declared row no registry holds, are hard refusals — so the row set cannot ' +
      'drift; the two constant sources are read only to resolve filenames the registries name by ' +
      'identifier',
    uncovered:
      'only the registry-DERIVED cells are checked. The Purpose / Notes prose is hand-authored in ' +
      'spec-mirror-data.mjs and mechanically unverified, so a stale purpose renders faithfully ' +
      '(the same half the producer-relation row states for `role`/`note`). Section membership is ' +
      'declared, not derived, for two of the three: EXECUTOR_REGISTRY declares no pipeline stage ' +
      'and the DAG phases are not the artifact registry\'s phases, so an executor filed under the ' +
      'wrong stage — or a DAG row under the wrong phase — passes; only the artifact-contract ' +
      'regions pin membership against the registry phase. Row ORDER within a region is declaration ' +
      'order and is unchecked. The one declared non-registry row is checked only for being ABSENT ' +
      'from ARTIFACT_DEFINITIONS; nothing verifies the runtime submission it describes still behaves ' +
      'as stated',
  },
  {
    area: 'installer-verb surface render',
    files: ['wrapper/installer-verb-help.mjs', 'scripts/shared/generate-cli-surface.mjs'],
    guardedBy: ['check:cli-surface', 'vitest-gate', 'installer-verb-help-test'],
    note:
      'the declaration (verbs + summaries) both bins read, plus its doc render; the render target ' +
      'docs/audit-pkg/product.md is claimed by the shipped-doc-surface row. The two consumers that ' +
      'CANNOT import it — remediate-code.mjs (literal argv comparisons) and src/remediate/index.ts ' +
      '(no allowJs) — are pinned verb-and-summary by installer-verb-help-test, which also spawns ' +
      '`audit-code --help` and matches the printed listing against the declaration',
    uncovered:
      'the summaries are pinned only where a copy exists TODAY — a NEW hand-restatement in a third ' +
      'file is claimed by no rule, since only src/remediate/index.ts and remediate-code.mjs are ' +
      "scanned; and `remediate-code --help` (commander, dist-side) is not spawned, only its source " +
      "table read. printHelp()'s non-installer command lines stay prose (check:cli-surface note)",
  },
  {
    area: 'shipped doc surface',
    files: ['docs/audit-pkg/*.md'],
    guardedBy: ['check:cli-surface', 'vitest-gate', 'shipped-doc-surface-test'],
    note:
      'package.json `files` decides which of these reach npm; tests/shared/shipped-doc-surface.test.ts ' +
      'pins the shipped set, pins README to name exactly it, refuses a relative link that leaves it, ' +
      'resolves every relative link fragment against the target page\'s headings, and binds every ' +
      'absolute github.com owner/repo in a shipped page to package.json `repository`',
    uncovered:
      'only the owner/repo segment of an absolute URL is checked — the PATH after it is never ' +
      'fetched, so a page moved on GitHub goes stale silently, and the same slug in non-markdown ' +
      'sources (scripts/audit/postinstall.mjs) is outside this rule. Anchor resolution covers ' +
      'RELATIVE links only: a fragment on an absolute repository URL is unchecked. The loader-pair ' +
      'single-statement rule is pinned by exact flag spelling only — the literal substring ' +
      '`--root <path>`, so a restatement worded any other way (`--root <dir>`, `the --root flag`, ' +
      'or prose that omits the flag) passes green',
  },
  {
    area: 'source',
    files: ['src/**'],
    guardedBy: [
      'build',
      'check:tests',
      'vitest-gate',
      'check:deadcode',
      'check:lint',
      'check:dup',
      'check:depgraph',
      'pre-commit-gate',
      'prompt-capability-test',
      'prompt-renders-its-contract-test',
    ],
    uncovered:
      'the loop-core attestation half of pre-commit-gate covers only LOOP_CORE_PATTERNS prefixes ' +
      '(src/shared/loopCorePaths.ts), not every dispatch-adjacent CLI file; no gate refuses direct ' +
      'child_process.spawn that bypasses spawnLoggedCommand (durable-traps). Registry shape rules ' +
      'are not full field-set reconciliation; manual-validator consumers are declared-gap rows; ' +
      'render fixtures cover the rows that have them',
  },
  {
    area: 'tests',
    files: ['tests/**'],
    guardedBy: ['check:tests', 'vitest-gate', 'check:lint', 'check:dup'],
    uncovered:
      'checkJs:false excludes the deliberate .mjs holdout(s) from the typecheck (the 563/564 floor), ' +
      'and check:lint likewise lints only tests/**/*.ts; ' +
      'the vi.spyOn barrel guard (INV-remediate-tests-12) scans only tests/remediate',
  },
  {
    area: 'markdown corpus',
    files: ['**/*.md'],
    guardedBy: ['check:doc-manifest', 'check:doc-links', 'check:doc-code-citations', 'check:memory-citations'],
    note:
      'the four whole-corpus doc gates (memory-citations scans every tracked *.md for memory-file ' +
      'cites); backlog, HANDOFF, README and the nightly-prompt sources are additionally claimed by ' +
      'their own precise rows below',
  },
  {
    area: 'hooks',
    files: ['.claude/hooks/**'],
    guardedBy: [
      'hook-trap-guards-test',
      'hook-session-gates-test',
      'hook-async-typecheck-test',
      'hook-friction-stop-test',
      'hook-session-start-guards-test',
      'session-registry-test',
      'session-start-hook-test',
      'doc-manifest-gate-test',
      'pre-commit-staged-snapshot-test',
      'pre-commit-commit-detection-test',
      'pre-commit-commit-creating-test',
      'pre-commit-attestation-test',
      'pre-commit-branch-strand-test',
      'pre-commit-child-session-test',
      'pre-commit-target-repo-test',
      'pre-commit-derived-legs-test',
      'loop-core-gate-parity-test',
      'offload-lane-probe-test',
      'check:offload-lanes',
      'check:loop-core-patterns',
      'check:guard-reach',
      'check:scripts',
    ],
    uncovered:
      'shell-split (the trap-guard split helper, home of bypassEnabled) has no dedicated contract test ' +
      '— it is exercised only through hook-trap-guards-test and pre-commit-child-session-test. ' +
      '(question-philosophy-gate and closeout-challenge-gate are covered ' +
      'by hook-session-gates-test; attest-loop-core-review by the attestation and parity tests; ' +
      'nightly-surface by nightly-routine-test.)' +
      ' The P28 long-dispatch refusal in shell-trap-guard measures only the INLINE quoted prompt — a ' +
      'prompt delivered via a stdin file (`codex exec < prompt.txt`), `$(cat …)`, or a heredoc body ' +
      '(blanked before scanning) escapes measurement; scripts/shared/lane-dispatch.mjs is the primary fix. ' +
      '.claude/hooks/friction-stop-gate.mjs re-implements the friction-dir *.json listing by hand ' +
      '(readdirSync + .endsWith(".json")) because a pre-build hook cannot import built src — a ' +
      'hand-maintained duplicate of listFrictionRecordFilenames that drifts independently.',
  },
  {
    area: 'gate scripts (the guards themselves)',
    files: [
      'scripts/check-*.mjs',
      'scripts/doc-manifest-data.mjs',
      'scripts/guard-reach-data.mjs',
      'scripts/gate-enumeration-data.mjs',
      'scripts/shared/generate-*.mjs',
      'scripts/attest-constitutional-doc-change.mjs',
      'scripts/render-closeout.mjs',
      'scripts/closeout-sections-data.mjs',
    ],
    guardedBy: [
      'check:guard-reach',
      'doc-manifest-gate-test',
      'guard-reach-gate-test',
      'check:lint',
      'check:dup',
      // Area-granular citations (existing precedent in this row): each gate
      // READS its own data module here — doc-manifest-data.mjs,
      // gate-enumeration-data.mjs, guard-reach-data.mjs respectively.
      'check:doc-manifest',
      'check:gate-enumeration',
      'check:ci-trigger-paths',
      // Parity over its own generator (scripts/shared/generate-runtime-artifact-names.mjs --check).
      'check:runtime-artifact-names',
      'check:scripts',
    ],
    uncovered:
      'check:scripts typechecks the script trees with noImplicitAny relaxed — implicit-any ' +
      'signatures pass by design, so the typed floor is narrower than src strict; ' +
      'attest-constitutional-doc-change is invoked per constitutional override, wired into no verify gate; ' +
      'render-closeout is invoked per hand-back, wired into no verify gate either — its enforcement is ' +
      'the closeout-challenge Stop gate reading the record it writes, so a session that never renders is ' +
      'challenged, not blocked. That record OWNS ITS SESSION only by TIMESTAMP: the renderer cannot read ' +
      'a session id (CLAUDE_SESSION_ID does not reach a Bash-invoked script, and record.session_id is ' +
      'therefore null), so the gate compares rendered_at against the session registry registered_at. ' +
      "A CONCURRENT session that rendered after this one started still reads as this one's render — " +
      'the worktree-tree comparison is the only thing that catches it, and only when the content differs',
  },
  {
    area: 'pipeline, smoke & release scripts',
    files: [
      'scripts/audit/**',
      'scripts/remediate/**',
      'scripts/shared/**',
      'scripts/postinstall.mjs',
      'scripts/release-and-publish.mjs',
      'scripts/poll-log-throttle.mjs',
    ],
    guardedBy: [
      'pack:smoke',
      'smoke:packaged-audit-code',
      'smoke:packaged-remediate-code',
      'verify:hosts',
      'verify:remediate-hosts',
      'vitest-gate',
      'check:lint',
      'check:dup',
      // Executes scripts/shared/derived-file-preflight.mjs directly (P34).
      'precommit-leg-derivation-test',
      'lane-dispatch-driver-test',
      'check:scripts',
    ],
    uncovered:
      'release-and-publish, update-languages, triage-backlog, rebaseline-flakes and ' +
      'poll-log-throttle run only at release/maintenance time — no build gate executes them ' +
      "(triage-backlog's sweep driver is now shared lane-dispatch.mjs, gate-executed via " +
      "tests/shared/lane-dispatch.test.ts — the uncovered half is triage-backlog's HTTP lane + CLI " +
      'shell only)',
  },

  {
    area: 'nightly routine',
    files: ['scripts/nightly/**'],
    guardedBy: ['nightly-routine-test', 'nightly-scope-ledger-test', 'nightly-items-mandatory-fields-test', 'check:lint', 'check:dup', 'check:scripts'],
    note:
      'items.mjs, render-inbox.mjs, ingest-answers.mjs, answer.mjs and the nightly-surface hook are all ' +
      'exercised by tests/shared/nightly-routine.test.ts — subject-key identity, the settled/resolved ' +
      'partition, premise probing, the inbox round-trip (a ticked box becomes a ledger entry) and its ' +
      'refusals. The P32 answerability refusals in writeOpenItems (options[]/eli5) are pinned by ' +
      'tests/shared/nightly-items-mandatory-fields.test.ts. ' +
      'scope-ledger.mjs is covered by tests/shared/nightly-scope-ledger.test.ts — item ' +
      'identity, the refusal of an unanchored stamp, the never-examined window, and the coverage ' +
      'record. UNCOVERED HALF: nothing executes the routine end-to-end, so the ORDER of the legs, the ' +
      'decision to escalate-vs-apply, and whether a run actually CALLS `stamp` for the docs it claims ' +
      'to have examined all remain behavioural, guarded by docs/nightly-routine.md and the three-agent ' +
      'gate rather than by a test.',
  },
  {
    area: 'offload lane registry',
    files: ['scripts/shared/offload-lane-data.mjs'],
    guardedBy: ['check:offload-lanes', 'offload-lane-probe-test', 'check:lint', 'check:dup'],
    note:
      'lane rows + probe substrate the session-start lane-liveness leg iterates; reconciled against the ' +
      'hook source and the two tracked docs by check:offload-lanes',
  },
  {
    area: 'rendered host assets',
    files: ['skills/**', '.github/prompts/**', '.github/agents/**', '.gemini/**', '.agent/**', 'opencode.json'],
    guardedBy: ['verify:hosts', 'verify:remediate-hosts'],
    note: 'rendered per-IDE from universal sources; renderer drift is what the two gates pin',
  },
  {
    area: 'CI workflow trigger paths',
    files: ['.github/workflows/ci.yml'],
    guardedBy: ['check:ci-trigger-paths', 'ci-trigger-paths-test'],
    note:
      "ci.yml's two paths: blocks are GENERATED from this registry (non-declared-gap rows + the " +
      'always-trigger base) and reconciled by the gate; the rest of the yml is still unparsed locally',
  },
  {
    area: 'CI workflows',
    files: ['.github/workflows/**'],
    guardedBy: 'declared-gap',
    note:
      'CI definitions — validated by GitHub at push; latest-run OUTCOMES are surfaced by the closeout ' +
      'gate via scripts/shared/ciRedWorkflows.mjs, but no local gate parses the yml beyond ci.yml\'s ' +
      'generated paths blocks (row above). audit-code-test-suite.yml carries its OWN hand-written ' +
      'duplicated paths block — a known un-generated sibling (the P26 decision scoped generation to ' +
      'ci.yml only)',
  },
  {
    area: 'worker dispatch assets',
    files: ['dispatch/**'],
    guardedBy: ['vitest-gate', 'smoke:packaged-audit-code', 'check:scripts'],
    note: 'validate/merge exercised by tests/audit/dispatch-validate.test.ts and the packaged smoke',
  },
  {
    area: 'schemas',
    files: ['schemas/**'],
    guardedBy: ['vitest-gate'],
    note: 'generated by scripts/audit/generate-schemas.mjs; consumed by result validation and its tests',
  },
  {
    area: 'bins & wrapper',
    files: ['audit-code.mjs', 'remediate-code.mjs', 'wrapper/**'],
    guardedBy: [
      'smoke:packaged-audit-code',
      'smoke:packaged-remediate-code',
      'smoke:linked-audit-code',
      'smoke:linked-remediate-code',
      'vitest-gate',
      'check:lint',
      'check:scripts',
    ],
  },
  {
    area: 'toolchain config',
    files: [
      'package.json',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.test.json',
      'tsconfig.scripts.json',
      'vitest.config.ts',
      'knip.json',
      'eslint.config.js',
      '.jscpd.json',
      '.dependency-cruiser.cjs',
    ],
    guardedBy: [
      'build',
      'check:tests',
      'vitest-gate',
      'check:deadcode',
      'check:guard-reach',
      'check:lint',
      'check:dup',
      'check:depgraph',
    ],
    note:
      'each config is loaded by the gate it configures — malformed fails that gate loudly; the scripts ' +
      'wiring in package.json is what check:guard-reach reconciles',
  },
  {
    area: 'agent settings',
    files: ['.claude/settings.json'],
    guardedBy: ['check:guard-reach'],
    note: 'hook registrations reconciled against tracked hook files and this registry',
  },
  {
    area: 'owner skills',
    files: ['.claude/skills/**'],
    guardedBy: ['check:doc-manifest', 'check:doc-links', 'check:doc-code-citations'],
    note: 'markdown skills for the owner-side workflow; routed like any tracked doc',
  },
  // ── precise per-gate rows (P34): each names exactly what its gate READS, so
  // the derived pre-commit triggers reproduce the retired hand-coded ones
  // rather than silently narrowing them. Overlap with the markdown-corpus row
  // is expected — a file may be claimed by several rows.
  {
    area: 'backlog entry files',
    files: ['docs/backlog/*.md'],
    guardedBy: ['check:backlog-index', 'check:backlog-budget', 'check:backlog-status', 'check:backlog-line-numbers', 'check:handoff-roadmap'],
    note:
      'the five gates that actually read the split backlog files (seek-index parity, size budget, ' +
      'status-label ban, line-number-citation ban, roadmap title lift); the markdown-corpus row ' +
      'carries the generic doc gates',
  },
  {
    area: 'backlog seek index',
    files: ['docs/backlog.md'],
    guardedBy: ['check:backlog-index'],
    note:
      'the GENERATED router/index file — only the index-parity gate reads it (the budget, status and ' +
      'roadmap gates read the split entry files above, deliberately: firing the roadmap check on the ' +
      'generated index would train the regenerate step into noise)',
  },
  {
    area: 'nightly-prompt sources',
    files: ['docs/nightly-routine.md', 'docs/doc-review-guidelines.md', 'docs/nightly-routine-prompt.md'],
    guardedBy: ['check:nightly-routine-prompt'],
    note: 'the generated scheduler prompt and its two canonical sources — either direction of drift fails the gate',
  },
  {
    area: 'offload-lane doc markers',
    files: ['docs/nightly-routine.md', 'docs/backlog/durable-traps.md'],
    guardedBy: ['check:offload-lanes'],
    note: 'the two TRACKED docs the lane reconciler scans for DOC_LANE_MARKERS (SCANNED_DOCS in the registry)',
  },
  {
    area: 'philosophy pair',
    files: ['docs/project-philosophy.md', 'README.md'],
    guardedBy: ['check:philosophy-brief'],
    note: 'the gate reads ONLY these two — the README Philosophy block is generated from the brief',
  },
  {
    area: 'proposal-test RED-AT records',
    files: ['.audit-tools/nightly/proposals/**'],
    guardedBy: ['check:proposal-red-at'],
    note:
      'the gate scans the tracked proposals tree: a proposal dir shipping a *.test.ts/*.test.mjs ' +
      'must carry a non-empty sibling RED-AT.txt (measured red, or a declared not-runnable line). ' +
      'Uncovered half: the record body is free-form — the gate enforces existence and non-emptiness, ' +
      'not that the recorded run was real or fresh',
  },
  {
    area: 'README sample-report render',
    files: [
      'README.md',
      'src/audit/cli/sampleRunCommand.ts',
      'src/audit/reporting/synthesis.ts',
      'src/shared/reporting/findingDisplay.ts',
    ],
    guardedBy: ['check:readme-sample-report'],
    note:
      'the gate renders the sample bundle through the real renderer and diffs the README block — ' +
      'a renderer heading/bullet change reds it instead of silently drifting the README sample',
  },
  {
    area: 'gate-enumeration render target',
    files: ['.claude/skills/ship/SKILL.md'],
    guardedBy: ['check:gate-enumeration'],
    note: 'the one rendered enumeration block (ENUMERATION_TARGETS); step membership/order come from package.json',
  },
  {
    area: 'HANDOFF',
    files: ['docs/HANDOFF.md'],
    guardedBy: ['check:handoff-roadmap'],
    note: 'generated-block parity PLUS hand-written-region creep heuristics over the handoff itself; its queue/ledger sources have their own rows below',
  },
  {
    area: 'relative-link lift',
    files: ['scripts/shared/rebase-relative-links.mjs'],
    guardedBy: ['check:handoff-roadmap', 'check:backlog-index'],
    note:
      'both generators IMPORT the lift, so the two parity gates execute it — a lift edit stales the ' +
      'generated docs and the parity legs catch it (the retired hand trigger ran check:doc-links here, ' +
      'which scans only markdown and could never see a lift-only change)',
  },
  {
    area: 'backlog size ratchet baseline',
    files: ['docs/backlog/.size-baseline.json'],
    guardedBy: ['check:backlog-budget'],
    note: 'the per-file ratchet data the budget gate compares against',
  },
  {
    area: 'nightly determinations ledger',
    files: ['.claude/nightly-decisions.json'],
    guardedBy: [
      'check:handoff-roadmap',
      'pre-commit-gate',
      'closeout-challenge-gate',
    ],
    note:
      'read/written by scripts/nightly/answer.mjs and surfaced by the nightly-surface hook; HANDOFF ' +
      'parity now reads it in verify:checks, at commit when the ledger changes, and at closeout. ' +
      'UNCOVERED HALF: canonical readDecisions remains fail-soft, so parity guards the rendered view ' +
      'but does not schema-validate a malformed ledger.',
  },
  {
    area: 'nightly open queue projection',
    files: ['.audit-tools/nightly/open-items.json'],
    guardedBy: [
      'check:handoff-roadmap',
      'pre-commit-gate',
      'closeout-challenge-gate',
    ],
    note:
      'authoritative persisted queue; strictly read by the generated HANDOFF parity check, with queue ' +
      'and decision edits triggering the same check before commit; current premise-probe source paths ' +
      'are derived from the queue, and positive probe needles use staged git-pickaxe reach so moved ' +
      'copies can trigger parity too',
  },
  {
    area: 'promoted deliverables',
    files: [
      '.audit-tools/audit-findings.json',
      '.audit-tools/audit-report.md',
      '.audit-tools/remediation-outcomes.json',
      '.audit-tools/remediation-report.md',
      '.audit-tools/nightly/proposals/**',
    ],
    guardedBy: 'declared-gap',
    note: 'run outputs promoted for reference (tracked deliberately); products, not sources',
  },
  {
    area: 'operator examples',
    files: ['examples/**'],
    guardedBy: 'declared-gap',
    note:
      'operator templates and catalog samples for off-repo declarations (~/.audit-code); read by no ' +
      'gate — the same untested-territory fact recorded for sources-declared.json',
  },
  {
    area: 'repo meta',
    files: ['LICENSE', '.gitignore', '.gitattributes', '.audit-tools-visibility', 'package-lock.json'],
    guardedBy: 'declared-gap',
    note:
      'inert by content or npm-owned; the .gitignore hook-whitelist half is enforced by the pre-commit ' +
      'gate (a settings.json referencing a hook the commit does not carry is refused)',
  },
];
