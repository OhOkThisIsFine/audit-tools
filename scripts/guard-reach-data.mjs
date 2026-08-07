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

/**
 * @typedef {object} GuardRow
 * @property {string} id
 * @property {'gate'|'hook'|'contract-test'} kind
 * @property {string} impl gate: npm script name, or a repo path referenced
 *   verbatim by a script reachable from verify:release; hook: the hook file's
 *   repo path (must be registered in .claude/settings.json); contract-test:
 *   the test file's repo path (must live under tests/ — vitest excludes
 *   .claude/**).
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
  { id: 'build', kind: 'gate', impl: 'build', note: 'tsc over src/ + data-asset copy' },
  { id: 'check:tests', kind: 'gate', impl: 'check:tests', note: 'tsc over the test tree (tsconfig.test.json)' },
  { id: 'check:control-bytes', kind: 'gate', impl: 'check:control-bytes' },
  { id: 'check:deadcode', kind: 'gate', impl: 'check:deadcode', note: 'knip, default mode' },
  { id: 'check:doc-manifest', kind: 'gate', impl: 'check:doc-manifest' },
  { id: 'check:doc-links', kind: 'gate', impl: 'check:doc-links' },
  { id: 'check:doc-code-citations', kind: 'gate', impl: 'check:doc-code-citations' },
  { id: 'check:gate-enumeration', kind: 'gate', impl: 'check:gate-enumeration' },
  { id: 'check:philosophy-brief', kind: 'gate', impl: 'check:philosophy-brief' },
  { id: 'check:nightly-routine-prompt', kind: 'gate', impl: 'check:nightly-routine-prompt' },
  { id: 'check:loop-core-patterns', kind: 'gate', impl: 'check:loop-core-patterns' },
  { id: 'check:constitutional-doc-paths', kind: 'gate', impl: 'check:constitutional-doc-paths' },
  { id: 'check:handoff-roadmap', kind: 'gate', impl: 'check:handoff-roadmap' },
  { id: 'check:backlog-index', kind: 'gate', impl: 'check:backlog-index' },
  { id: 'check:backlog-budget', kind: 'gate', impl: 'check:backlog-budget' },
  { id: 'check:backlog-status', kind: 'gate', impl: 'check:backlog-status' },
  { id: 'check:memory-citations', kind: 'gate', impl: 'check:memory-citations' },
  { id: 'check:version-gates', kind: 'gate', impl: 'check:version-gates' },
  { id: 'check:guard-reach', kind: 'gate', impl: 'check:guard-reach', note: 'this registry, reconciled' },
  {
    id: 'check:lint',
    kind: 'gate',
    impl: 'check:lint',
    note:
      'eslint, curated zero-tolerance ruleset (eslint.config.js): unused-vars + verified sonarjs ' +
      'correctness rules over src (type-aware), tests (type-aware, unused-vars only) and the ' +
      'typechecker-invisible .mjs surface (scripts/wrapper/dispatch/root bins)',
  },
  {
    id: 'check:dup',
    kind: 'gate',
    impl: 'check:dup',
    note: 'jscpd duplication ratchet (.jscpd.json threshold) over src+scripts+tests',
  },
  {
    id: 'check:depgraph',
    kind: 'gate',
    impl: 'check:depgraph',
    note:
      'dependency-cruiser (.dependency-cruiser.cjs): no runtime import cycles in src; ' +
      'src/shared never imports src/audit|src/remediate',
  },
  { id: 'verify:hosts', kind: 'gate', impl: 'verify:hosts' },
  { id: 'verify:remediate-hosts', kind: 'gate', impl: 'verify:remediate-hosts' },
  { id: 'pack:smoke', kind: 'gate', impl: 'pack:smoke' },
  { id: 'smoke:packaged-audit-code', kind: 'gate', impl: 'smoke:packaged-audit-code' },
  { id: 'smoke:packaged-remediate-code', kind: 'gate', impl: 'smoke:packaged-remediate-code' },
  { id: 'smoke:linked-audit-code', kind: 'gate', impl: 'smoke:linked-audit-code' },
  { id: 'smoke:linked-remediate-code', kind: 'gate', impl: 'smoke:linked-remediate-code' },
  {
    id: 'vitest-gate',
    kind: 'gate',
    impl: 'scripts/shared/run-vitest-gate.mjs',
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
  { id: 'hook-trap-guards-test', kind: 'contract-test', impl: 'tests/shared/hook-trap-guards.test.ts' },
  { id: 'hook-session-gates-test', kind: 'contract-test', impl: 'tests/shared/hook-session-gates.test.ts' },
  { id: 'nightly-routine-test', kind: 'contract-test', impl: 'tests/shared/nightly-routine.test.ts' },
  { id: 'hook-async-typecheck-test', kind: 'contract-test', impl: 'tests/shared/hook-async-typecheck.test.ts' },
  { id: 'hook-friction-stop-test', kind: 'contract-test', impl: 'tests/shared/hook-friction-stop-gate.test.ts' },
  { id: 'hook-session-start-guards-test', kind: 'contract-test', impl: 'tests/shared/hook-session-start-guards.test.ts' },
  { id: 'session-start-hook-test', kind: 'contract-test', impl: 'tests/audit/session-start-hook.test.ts' },
  { id: 'doc-manifest-gate-test', kind: 'contract-test', impl: 'tests/shared/doc-manifest-gate.test.ts' },
  { id: 'guard-reach-gate-test', kind: 'contract-test', impl: 'tests/shared/guard-reach-gate.test.ts' },
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
    id: 'loop-core-gate-parity-test',
    kind: 'contract-test',
    impl: 'tests/shared/loop-core-gate-parity.test.ts',
    note: 'pins pattern parity between pre-commit-gate and attest-loop-core-review',
  },
];

/** @type {ReachRow[]} */
export const REACH = [
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
    ],
    uncovered:
      'the loop-core attestation half of pre-commit-gate covers only the LOOP_CORE_PATTERNS prefixes ' +
      '(src/shared/loopCorePaths.ts), not every dispatch-adjacent CLI file; no gate refuses a direct ' +
      'child_process.spawn that bypasses spawnLoggedCommand (durable-traps)',
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
    guardedBy: ['check:doc-manifest', 'check:doc-links', 'check:doc-code-citations'],
    note:
      'backlog, HANDOFF, README and memory citations additionally gated by check:backlog-*, ' +
      'check:handoff-roadmap, check:philosophy-brief, check:memory-citations',
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
      'session-start-hook-test',
      'doc-manifest-gate-test',
      'pre-commit-staged-snapshot-test',
      'pre-commit-commit-detection-test',
      'pre-commit-commit-creating-test',
      'pre-commit-attestation-test',
      'pre-commit-branch-strand-test',
      'loop-core-gate-parity-test',
      'check:loop-core-patterns',
      'check:guard-reach',
    ],
    uncovered:
      'shell-split (the trap-guard split helper) has no dedicated contract test — it is exercised only ' +
      'through hook-trap-guards-test. (question-philosophy-gate and closeout-challenge-gate are covered ' +
      'by hook-session-gates-test; attest-loop-core-review by the attestation and parity tests; ' +
      'nightly-surface by nightly-routine-test.)',
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
    ],
    guardedBy: ['check:guard-reach', 'doc-manifest-gate-test', 'guard-reach-gate-test', 'check:lint', 'check:dup'],
    uncovered:
      'scripts/ is reached by no tsconfig — deliberate (validate at the construction site; check:lint ' +
      'gives an untyped no-undef/no-unused-vars floor, not a typecheck); ' +
      'attest-constitutional-doc-change is invoked per constitutional override, wired into no verify gate',
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
    ],
    uncovered:
      'release-and-publish, update-models, update-languages, triage-backlog, rebaseline-flakes and ' +
      'poll-log-throttle run only at release/maintenance time — no build gate executes them; no ' +
      'typecheck over scripts/ (deliberate; check:lint is an untyped floor)',
  },
  {
    area: 'nightly routine',
    files: ['scripts/nightly/**'],
    guardedBy: ['nightly-routine-test', 'check:lint', 'check:dup'],
    note:
      'items.mjs, render-inbox.mjs, ingest-answers.mjs, answer.mjs and the nightly-surface hook are all ' +
      'exercised by tests/shared/nightly-routine.test.ts — subject-key identity, the settled/resolved ' +
      'partition, premise probing, the inbox round-trip (a ticked box becomes a ledger entry) and its ' +
      'refusals. UNCOVERED HALF: nothing executes the routine end-to-end, so the ORDER of the legs and ' +
      'the decision to escalate-vs-apply remain behavioural, guarded by docs/nightly-routine.md and the ' +
      'three-agent gate rather than by a test.',
  },
  {
    area: 'rendered host assets',
    files: ['skills/**', '.github/prompts/**', '.github/agents/**', '.gemini/**', '.agent/**', 'opencode.json'],
    guardedBy: ['verify:hosts', 'verify:remediate-hosts'],
    note: 'rendered per-IDE from universal sources; renderer drift is what the two gates pin',
  },
  {
    area: 'CI workflows',
    files: ['.github/workflows/**'],
    guardedBy: 'declared-gap',
    note:
      'CI definitions — validated by GitHub at push; latest-run OUTCOMES are surfaced by the closeout ' +
      'gate via scripts/shared/ciRedWorkflows.mjs, but no local gate parses the yml',
  },
  {
    area: 'worker dispatch assets',
    files: ['dispatch/**'],
    guardedBy: ['vitest-gate', 'smoke:packaged-audit-code'],
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
    ],
  },
  {
    area: 'toolchain config',
    files: [
      'package.json',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.test.json',
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
  {
    area: 'backlog size ratchet baseline',
    files: ['docs/backlog/.size-baseline.json'],
    guardedBy: ['check:backlog-budget'],
    note: 'the per-file ratchet data the budget gate compares against',
  },
  {
    area: 'nightly determinations ledger',
    files: ['.claude/nightly-decisions.json'],
    guardedBy: 'declared-gap',
    note:
      'read/written by scripts/nightly/answer.mjs, surfaced by the nightly-surface hook; no build gate ' +
      'validates it',
  },
  {
    area: 'promoted deliverables',
    files: ['.audit-tools/**'],
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
