// P56 CANDIDATE — the `GENERATED` section of the guard-reach registry.
//
// LANDING: this block is appended to `scripts/guard-reach-data.mjs` as a third
// exported section beside GUARDS and REACH. It is written here as a standalone
// module ONLY so the proposal can ship it without editing the tree; landing it
// as a separate file would be the second mechanism this proposal argues against.
//
// WHY NO `artifacts` LIST. An earlier draft of this file restated each
// generator's output paths. Six of sixteen were wrong on the first pass —
// checked against `git ls-files` and corrected — which is itself the argument
// against the field: every generator that routes through
// `scripts/shared/generatedArtifacts.mjs` ALREADY declares its targets as the
// `files` argument to `runGeneratedArtifactCli`, so a second copy in the
// registry is a restatement kept honest by memory, and this repo bans those.
// The registry's job is the AUTHORITY, not the target list. Two rows carry
// `artifacts` because their generators do not route through that substrate and
// the paths are load-bearing to the argument; both were verified tracked.
//
// SEMANTICS — read before editing:
//   • One row per tracked GENERATOR.
//   • Exactly one freshness authority per row, and it must EXIST:
//       authority: 'check'        + npmScript — the script runs the generator's
//                                   `--check` arm AND is inside verify:checks.
//                                   "a script in no gate is not a gate" applies
//                                   here exactly as it does to a smoke script.
//       authority: 'contractTest' + contractTest — a tracked test under tests/
//                                   that re-runs the extraction and diffs it
//                                   against the tracked render. CLAUDE.md
//                                   already rules a contract test "equally
//                                   binding and equally self-describing" as a
//                                   hook; this section applies the same rule.
//       onDemand: true            + reason — deliberately gated by nothing.
//                                   This is the registry's own
//                                   `guardedBy: 'declared-gap'` rule applied to
//                                   derived files: a gap is a decision, silence
//                                   is a defect.
//   • Bidirectional, like check:guard-reach: a tracked generator no row claims
//     is a red build, and a row naming an authority that does not exist is a
//     red build.

/**
 * @typedef {object} GeneratedRow
 * @property {string} generator repo path of the generator script
 * @property {'check'|'contractTest'} [authority]
 * @property {string} [npmScript] authority 'check' only
 * @property {string} [contractTest] authority 'contractTest' only
 * @property {boolean} [onDemand] deliberately ungated
 * @property {string} [reason] REQUIRED when onDemand
 * @property {string[]} [artifacts] only where the generator does not declare
 *   its own targets through runGeneratedArtifactCli
 * @property {string} [note]
 */

/** @type {GeneratedRow[]} */
export const GENERATED = [
  // ---- authority: 'check' — 11 rows, every npmScript inside verify:checks ----
  { generator: 'scripts/shared/generate-backlog-index.mjs', authority: 'check', npmScript: 'check:backlog-index' },
  { generator: 'scripts/shared/generate-ci-trigger-paths.mjs', authority: 'check', npmScript: 'check:ci-trigger-paths',
    note: 'The one --check generator that does NOT route through generatedArtifacts.mjs; it predates that substrate.' },
  { generator: 'scripts/shared/generate-cli-surface.mjs', authority: 'check', npmScript: 'check:cli-surface' },
  { generator: 'scripts/shared/generate-constitutional-doc-paths.mjs', authority: 'check', npmScript: 'check:constitutional-doc-paths' },
  { generator: 'scripts/shared/generate-executor-producers.mjs', authority: 'check', npmScript: 'check:executor-producers' },
  { generator: 'scripts/shared/generate-friction-categories.mjs', authority: 'check', npmScript: 'check:friction-categories' },
  { generator: 'scripts/shared/generate-handoff-roadmap.mjs', authority: 'check', npmScript: 'check:handoff-roadmap' },
  { generator: 'scripts/shared/generate-ingestion-checks.mjs', authority: 'check', npmScript: 'check:ingestion-checks' },
  { generator: 'scripts/shared/generate-loop-core-patterns.mjs', authority: 'check', npmScript: 'check:loop-core-patterns' },
  { generator: 'scripts/shared/generate-runtime-artifact-names.mjs', authority: 'check', npmScript: 'check:runtime-artifact-names' },
  { generator: 'scripts/shared/generate-spec-mirrors.mjs', authority: 'check', npmScript: 'check:spec-mirrors' },

  // ---- authority: 'contractTest' — 3 rows ----
  {
    generator: 'scripts/shared/generate-filelock-export-surface.mjs',
    authority: 'contractTest',
    contractTest: 'tests/shared/filelock-export-surface.test.ts',
    artifacts: ['scripts/shared/filelock-export-surface.generated.json'],
    note:
      'The generator has NO --check arm, DELIBERATELY: an unwired one existed and was deleted ' +
      '(F7, ceremony review 2026-08-29) because enforcement is the drift test alone. The test ' +
      're-runs the structural extraction against the live source, diffs it against the tracked ' +
      'render, and holds mutation controls proving the diff actually fires. This row is why the ' +
      'registry needs a contractTest authority at all — without it the honest answer here would ' +
      'have to be a false onDemand, which would mis-declare a genuinely gated artifact as a gap.',
  },
  {
    generator: 'scripts/audit/generate-schemas.mjs',
    authority: 'contractTest',
    contractTest: 'tests/audit/worker-schema-generation.test.ts',
    note:
      'A6 drift guard: re-renders each committed worker JSON schema from its zod source and ' +
      'compares. The npm script `generate-schemas` is the WRITE arm only, and is in no gate — ' +
      'which is correct here, because the test is the authority.',
  },
  {
    generator: 'scripts/remediate/generate-auditor-contract-fixture.mjs',
    authority: 'contractTest',
    contractTest: 'tests/remediate/fixture-generator-drift-guard.test.ts',
    note:
      'Runs the real generator into a temp dir (argv-redirected, never over the committed ' +
      'fixture) and byte-compares raw UTF-8, so key-order / whitespace / newline drift is caught. ' +
      'The npm script `fixtures:auditor-contract` is the WRITE arm only.',
  },

  // ---- onDemand: deliberately ungated — 2 rows ----
  {
    generator: 'scripts/shared/generate-vitest-shard-baseline.mjs',
    onDemand: true,
    reason:
      'A shard baseline is a MEASUREMENT of this machine under this load, not a derivation from ' +
      'tracked source. A --check would go red on ordinary timing drift on any other machine — a ' +
      'false red on every clone, which is the corrosion this repo bans as loudly as a false ' +
      'green. Rewritten deliberately via `npm run generate:shard-baseline` when the shape of the ' +
      'suite changes. Same argument as the flake baseline, whose write is deliberate for the ' +
      'same reason (memory: flake-baseline-write-is-deliberate).',
  },
  {
    generator: 'scripts/nightly/render-inbox.mjs',
    artifacts: ['docs/nightly-inbox.md', '.audit-tools/nightly/open-items.json'],
    onDemand: true,
    reason:
      'PLACEHOLDER, AND THE RECOMMENDATION IS THAT IT MUST NOT STAY THIS WAY. This is the one ' +
      'artifact in the registry whose staleness caused CONFIRMED damage (2026-08-27: the ' +
      'rendered queue and its tracked snapshot outlived the ledger that settled them; a later ' +
      'lap read six settled propositions from the snapshot and put four back to the owner, one ' +
      'of which would have reverted a completed decision). Landing it as onDemand would DECLARE ' +
      'the known-damaging gap rather than close it. The residual decision is in the proposal ' +
      'record: add a --check to render-inbox.mjs reconciling the rendered queue and the snapshot ' +
      'against the answer ledger, and this row becomes authority:check.',
  },
];
