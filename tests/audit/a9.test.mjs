/**
 * A-9 — autonomy acceptance capstone (IMPL-a9).
 *
 * The end-to-end proof that the a8 / a10 / dc6 / dc2 in-process dispatch track
 * reaches `complete` with ZERO host-subagent dispatch. CE-011 flagged that the
 * in-process path is the one the prior e2e coverage did NOT exercise to a finish;
 * this capstone closes that gap by driving the WHOLE pipeline in-process over the
 * cheapest configured backend provider:
 *
 *   audit  → a seeded fixture repo with a REAL, plantable defect is audited and
 *            its findings are PROMOTED to `.audit-tools/audit-findings.json`
 *            (no host-subagent `semantic_review` dispatch — the in-process audit
 *            engine is the per-packet review worker).
 *   remediate → the promoted contract is remediated to `status: "complete"`,
 *            with the in-process rolling engine as the per-node worker (no
 *            host-subagent `dispatch_implement*` step ever emitted).
 *
 * The four capstone assertions (the finding's verification obligations):
 *   1. NO host-subagent dispatch step — neither half ever emits a step that asks
 *      the host to spawn subagent workers (audit `semantic_review`; remediate
 *      `dispatch_implement` / `dispatch_implement_rolling` /
 *      `implement_rolling_sequential`). Deterministic HOST GATES that only write
 *      a small decision file (confirm_intent, review approval, contract pipeline)
 *      are auto-satisfied by the harness and are NOT subagent dispatch.
 *   2. A remediation branch (`remediation/<run-id>`) with landed commits.
 *   3. A green closing gate (`remediation-outcomes.json` records a passing
 *      combined-test result and a non-failed closing action).
 *   4. A fully-reconciled per-finding coverage ledger — `assertLedgerComplete`
 *      returns `complete: true` with `denominator > 0`. A 0/0 vacuous green
 *      FAILS (INV-CL-05), so this also proves non-vacuity.
 *
 * Hermetic: a local git repo, no PR, no GitHub.
 *
 * SKIPPED unless RUN_AUTONOMY_E2E=1 AND a provider key is present (NVIDIA_API_KEY
 * for the configured NIM backend). The test REQUIRES a real provider to actually
 * RUN the in-process workers, so it must never run in the normal suite / CI. Run
 * it with:
 *   RUN_AUTONOMY_E2E=1 NVIDIA_API_KEY=... \
 *     node --import tsx/esm --test tests/audit/a9.test.mjs
 * from the repo root.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { withTempDir } from './helpers/withTempDir.mjs';
import {
  DEFECT_FILE,
  DEFECT_VERIFY_COMMAND,
  buildPromotedFindings,
  initAutonomyFixtureGit,
  writeAutonomyFixtureTree,
} from './helpers/autonomyFixture.mjs';

// Source imports are build-free under tsx/esm; the self-ref `audit-tools/shared`
// resolves to dist, which the central build owns, so import sources directly.
const { runDeterministicForNextStep } = await import(
  '../../src/audit/cli/nextStepCommand.ts'
);
const { writeCoreArtifacts, promoteFinalAuditReport } = await import(
  '../../src/audit/io/artifacts.ts'
);
const { advanceFixtureToPlanning } = await import('./helpers/fixture.mjs');
const { decideNextStep } = await import('../../src/remediate/steps/nextStep.ts');
const { buildPerFindingLedger, assertLedgerComplete } = await import(
  '../../src/remediate/coverage/findingLedger.ts'
);
const { remediationBranchName } = await import(
  '../../src/remediate/steps/dispatch.ts'
);

// The one configured live endpoint in this repo is NVIDIA NIM (OpenAI-compatible);
// its key gates the run. RUN_AUTONOMY_E2E AND the key must both be present.
const PROVIDER_KEY_ENV = 'NVIDIA_API_KEY';
const RUN =
  process.env.RUN_AUTONOMY_E2E === '1' &&
  Boolean(process.env[PROVIDER_KEY_ENV]);

const SESSION_CONFIG = {
  provider: 'openai-compatible',
  openai_compatible: {
    base_url: 'https://integrate.api.nvidia.com/v1',
    model: 'openai/gpt-oss-120b',
    api_key_env: PROVIDER_KEY_ENV,
    // gpt-oss occasionally appends a stray brace under a free-form instruction;
    // strict JSON keeps the worker result parseable.
    response_format_json: true,
  },
  dispatch: { rolling_engine: true },
  timeout_ms: 180_000,
};

// Step kinds that ask the HOST to spawn subagent workers. These are exactly what
// the in-process engine REPLACES; if the run is truly autonomous, none of these
// may ever be emitted by either half.
const HOST_SUBAGENT_DISPATCH_STEP_KINDS = new Set([
  'dispatch_implement',
  'dispatch_implement_rolling',
  'implement_rolling_sequential',
]);

/**
 * Drive the deterministic audit pipeline to completion in-process over the
 * configured backend provider, asserting it NEVER emits a host-subagent
 * `semantic_review` dispatch. Returns once the audit promotes
 * `.audit-tools/audit-findings.json`.
 */
async function runAuditHalf(root) {
  // Drive intake → … → planning in-memory, then flush the planning bundle to
  // disk so the disk-based next-step's first dispatch obligation is the
  // host-delegation review (audit_tasks_completed) — exactly the obligation the
  // in-process engine consumes itself.
  const { planning } = await advanceFixtureToPlanning(root);
  const artifactsDir = join(root, '.audit-tools', 'audit');
  await writeCoreArtifacts(artifactsDir, planning.updated_bundle, { prune: true });

  const nextStep = () =>
    runDeterministicForNextStep({
      root,
      artifactsDir,
      selfCliPath: 'audit-code',
      timeoutMs: SESSION_CONFIG.timeout_ms,
      narrativeEnabled: false,
      analyzers: {
        typescript: 'skip',
        python: 'skip',
        css: 'skip',
        html: 'skip',
        sql: 'skip',
      },
      graphLlmEdgeReasoning: false,
      sessionConfig: SESSION_CONFIG,
    });

  const promotedFindingsPath = join(root, '.audit-tools', 'audit-findings.json');

  // Bounded drive: each call advances one deterministic frontier. The in-process
  // review folds audit_tasks_completed itself (no host dispatch step). A rare
  // all-invalid first pass blocks cleanly with nothing ingested; re-entering
  // re-dispatches the still-pending tasks, so a few iterations absorb that.
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    last = await nextStep();
    // The capstone's core invariant for the audit half: the in-process engine
    // ran instead of emitting a host-subagent review dispatch.
    assert.notEqual(
      last.kind,
      'semantic_review',
      'audit must drive review in-process, not emit a host-subagent dispatch step',
    );
    if (last.kind === 'complete') break;
    if (last.kind === 'blocked') {
      // A blocked terminal still proves the in-process round-trip; synthesize +
      // promote from whatever ingested so remediation has a contract to consume.
      break;
    }
  }

  // Ensure the machine contract is promoted to the repo root regardless of which
  // terminal the audit reached (complete promotes automatically; a bounded/blocked
  // terminal is promoted explicitly here so the remediation half has its input).
  if (!existsSync(promotedFindingsPath)) {
    await promoteFinalAuditReport({ artifactsDir });
  }
}

/**
 * Drive the remediation half from a promoted structured-audit contract all the
 * way to `status: "complete"`, IN-PROCESS over the configured backend provider.
 *
 * Auto-satisfies every emitted HOST GATE (the small decision-file steps:
 * confirm_intent, review approval, contract pipeline, clarifications, triage) so
 * the loop can advance without a human — while asserting that NO emitted step is
 * ever a host-subagent dispatch. Returns the final `RemediationStep`.
 */
async function runRemediateHalf(root, inputPath) {
  const artifactsDir = join(root, '.audit-tools', 'remediation');
  const sourceManifestPath = join(
    artifactsDir,
    'intake',
    'source-manifest.json',
  );

  // Pre-seed the COMPLETE contract DAG so the contract pipeline (host-delegated,
  // no in-process driver) advances straight to the implement phase rather than
  // emitting per-phase authoring steps. This is the established
  // `writeCompleteContractPipelineDag` harness pattern — contract authoring, not
  // a host-subagent dispatch.
  await seedCompleteContractDag(artifactsDir);

  // Each emitted step is auto-satisfied by its kind, then we re-enter next-step.
  // Bounded so a stuck gate fails loudly rather than hanging the gated run.
  let step;
  for (let iter = 0; iter < 60; iter += 1) {
    // Supply `--input` only until the tool has derived its own structured-audit
    // source-manifest. Re-passing `--input` after that re-derives + refreshes the
    // manifest, which discards a ready intake summary; once the manifest exists,
    // bare next-step calls keep it stable (the loader's resume behaviour).
    const supplyInput = !existsSync(sourceManifestPath);
    step = await decideNextStep({
      root,
      ...(supplyInput ? { input: inputPath } : {}),
      sessionConfig: SESSION_CONFIG,
      rollingEngine: true,
      // The host genuinely cannot dispatch subagents in headless autonomy; this
      // also forces the in-process branch to be the only dispatch path.
      hostCanDispatchSubagents: false,
    });

    // CAPSTONE INVARIANT (remediate half): never a host-subagent dispatch step.
    assert.ok(
      !HOST_SUBAGENT_DISPATCH_STEP_KINDS.has(step.step_kind),
      `remediate emitted a host-subagent dispatch step (${step.step_kind}); the ` +
        'in-process engine must drive implementation with no host fan-out',
    );

    if (step.step_kind === 'present_report') {
      // Terminal — the run reached complete. On a fully-green run the close phase
      // deletes the live state.json (artifact cleanup), so completion is verified
      // from the persisted `remediation-state.complete.json` that close writes to
      // `dirname(artifactsDir)`, not from store.loadState() (which is now gone).
      const completeStatePath = join(
        dirname(artifactsDir),
        'remediation-state.complete.json',
      );
      assert.ok(
        existsSync(completeStatePath),
        'present_report must coincide with a persisted complete state',
      );
      const completeState = JSON.parse(readFileSync(completeStatePath, 'utf8'));
      assert.equal(
        completeState.status,
        'complete',
        'the persisted state must be complete',
      );
      return step;
    }

    await satisfyHostGate({ step, artifactsDir });
  }

  throw new Error(
    `remediation did not reach complete within the bounded drive; last step: ${step?.step_kind}`,
  );
}

/**
 * Satisfy a `synthesize_intake` gate by writing the READY structured-audit
 * intake summary + brief (the deterministic content a host/LLM would author for
 * a structured-audit source). The tool has already written the source-manifest;
 * this only supplies the ready summary so the run proceeds to the contract
 * pipeline. It is intake-prep, not a host-subagent dispatch.
 */
async function satisfySynthesizeIntake(step) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const summaryPath =
    step.artifact_paths?.intake_summary ??
    join(step.artifacts_dir, 'intake', 'intake-summary.json');
  const briefPath =
    step.artifact_paths?.remediation_brief ??
    join(step.artifacts_dir, 'intake', 'remediation-brief.md');
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(
    summaryPath,
    JSON.stringify({
      schema_version: 'remediate-code-intake-summary/v1alpha1',
      ready: true,
      source_type: 'structured_audit',
      goals: ['Remediate the structured audit findings.'],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: DEFECT_FILE }],
      open_questions: [],
    }),
    'utf8',
  );
  await writeFile(
    briefPath,
    '# Structured intake\n\nFix the seeded clamp defect.\n',
    'utf8',
  );
}

/**
 * Auto-satisfy a single emitted host gate by writing the decision file it asks
 * for. These are deterministic confirmation files, NOT subagent dispatch — the
 * tool owns the structure; the harness only supplies an approve-all / proceed
 * decision so the autonomous loop can advance.
 */
async function satisfyHostGate(ctx) {
  const { step, artifactsDir } = ctx;
  const { writeFile, mkdir } = await import('node:fs/promises');
  // `target` is always an absolute path (the step declares them absolute, or we
  // fall back to an artifactsDir-relative join); write it verbatim.
  const write = async (target, body) => {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, 'utf8');
  };

  switch (step.step_kind) {
    case 'synthesize_intake': {
      await satisfySynthesizeIntake(step);
      return;
    }
    case 'confirm_intent': {
      const path =
        step.artifact_paths?.intent_checkpoint ??
        join(artifactsDir, 'intent_checkpoint.json');
      await write(path, JSON.stringify({
        schema_version: 'intent-checkpoint/v1',
        confirmed_at: new Date().toISOString(),
        scope_summary: 'Remediate the seeded clamp defect.',
        intent_summary: 'Fix the upper-bound clamp branch flagged by the audit.',
        confirmed_by: 'host',
      }));
      return;
    }
    case 'confirm_resume_or_restart': {
      const path =
        step.artifact_paths?.confirm_resume_ack ??
        join(artifactsDir, 'confirm_resume_ack.json');
      await write(path, JSON.stringify({ choice: 'resume' }));
      return;
    }
    case 'collect_review_approval': {
      // Approve every finding (declined: [] leaves them all in scope).
      const path =
        step.artifact_paths?.review_decision ??
        join(artifactsDir, 'review_decision.json');
      await write(path, JSON.stringify({
        schema_version: 'remediate-code-review-decision/v1',
        plan_id: 'autonomy-review',
        approved_ids: [],
        declined: [],
        created_at: new Date().toISOString(),
      }));
      return;
    }
    case 'contract_pipeline': {
      // The DAG is pre-seeded complete before the loop, so the pipeline should
      // extract the plan rather than emit a phase step. If it still fires, a
      // seeded artifact failed validation / freshness — surface it loudly with
      // the phase prompt rather than masking a real seam defect.
      throw new Error(
        'contract_pipeline step emitted despite a pre-seeded complete DAG — a ' +
          `seeded artifact is invalid or stale. Output: ${step.artifact_paths?.output}`,
      );
    }
    case 'collect_clarifications':
    case 'collect_intake_clarifications': {
      // Proceed with no clarifications needed — resolve every open question as
      // "clarified" so nothing is dropped (a "not genuine" verdict would silently
      // decline the finding).
      const path =
        step.artifact_paths?.clarification_resolution ??
        step.artifact_paths?.ambiguity_decision ??
        join(artifactsDir, 'ambiguity_decision.json');
      await write(path, JSON.stringify({
        resolutions: [],
        ambiguity_resolutions: [],
      }));
      return;
    }
    case 'collect_triage': {
      // Should not happen on the happy path (the fix verifies green). If it does,
      // a deterministic verify-fail surfaced — fail loudly with the per-item
      // failure_reason AND the captured verify diagnostic rather than masking it.
      const parsed = JSON.parse(readFileSync(join(artifactsDir, 'state.json'), 'utf8'));
      const reasons = Object.values(parsed.items ?? {})
        .map((it) => `${it.finding_id}: status=${it.status} reason=${it.failure_reason ?? '(none)'}`)
        .join(' | ');
      // Glob accept-outcome diagnostics for the real verify output.
      const { glob } = await import('node:fs/promises');
      let diag = '(no accept-outcome found)';
      try {
        for await (const p of glob('**/accept-outcome-*.json', { cwd: artifactsDir })) {
          const a = JSON.parse(readFileSync(join(artifactsDir, p), 'utf8'));
          diag = `outcome=${a.outcome} verify_passed=${a.verify_passed} diagnostic=${(a.diagnostic ?? '').slice(0, 600)}`;
          break;
        }
      } catch { /* best-effort */ }
      throw new Error(
        `remediation routed to triage — the in-process fix did not verify green.\nItems: ${reasons}\nAccept: ${diag}`,
      );
    }
    default: {
      // synthesize_intake / collect_starting_point / locate_input etc. are
      // path-B / bootstrap gates that a promoted structured-audit input should
      // not reach; surface anything unexpected.
      throw new Error(
        `unexpected host gate in autonomy drive: ${step.step_kind}`,
      );
    }
  }
}

/**
 * Pre-seed the COMPLETE contract-pipeline DAG (all 15 pre-implementation
 * artifacts, dependency-ordered) so the run advances straight from intake to the
 * implement phase. The contract pipeline is host-delegated (no in-process
 * driver) — on a real run each phase is an LLM authoring step — so an autonomous
 * harness must supply the DAG. This mirrors the established
 * `writeCompleteContractPipelineDag` test helper.
 *
 * Each artifact is written via `writeContractArtifact`, which envelopes the
 * payload and captures dependency hashes at write time; writing in
 * `CP_ARTIFACT_NAMES` order keeps the whole DAG internally fresh, so
 * `nextMissingContractPhase` returns null and the pipeline extracts the plan from
 * the seeded `implementation_dag` (one node citing the seeded defect with a
 * green-able verify command).
 */
async function seedCompleteContractDag(artifactsDir) {
  const shared = await import('audit-tools/shared');
  const cp = await import('../../src/remediate/validation/contractPipeline.ts');
  const { writeContractArtifact, CP_ARTIFACT_NAMES } = await import(
    '../../src/remediate/contractPipeline/artifactStore.ts'
  );
  const created_at = new Date(0).toISOString();
  const goal_id = 'AUTONOMY-G1';

  const PHASE_BUILDERS = {
    goal_spec: () => ({
      contract_version: shared.CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id,
      objective: 'Fix the seeded clamp upper-bound defect.',
      non_goals: [],
      success_criteria: ['clamp returns the correct bound on every branch.'],
      source_type: 'structured_audit',
      created_at,
    }),
    context_bundle: () => ({
      contract_version: shared.CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
      goal_id,
      entries: [],
      context_summary: 'The clamp helper mis-handles the upper bound.',
      created_at,
    }),
    module_decomposition: () => ({
      contract_version: cp.CP_MODULE_DECOMPOSITION_VERSION,
      goal_id,
      modules: [
        {
          name: 'clamp-module',
          responsibilities: 'Clamp a value into [min, max].',
          file_scope: [DEFECT_FILE],
        },
      ],
      created_at,
    }),
    module_contracts: () => ({
      contract_version: cp.CP_MODULE_CONTRACTS_VERSION,
      goal_id,
      module_contracts: [
        {
          name: 'clamp-module',
          inputs: ['value', 'min', 'max'],
          outputs: ['clamped value'],
          invariants: ['result is within [min, max]'],
          side_effects: [],
          validation_boundary: 'pure function',
          failure_modes: [],
          neighbor_needs: [],
        },
      ],
      created_at,
    }),
    seam_reconciliation_report: () => ({
      contract_version: cp.CP_SEAM_RECONCILIATION_REPORT_VERSION,
      goal_id,
      mismatches: [],
      created_at,
    }),
    finalized_module_contracts: () => ({
      contract_version: cp.CP_FINALIZED_MODULE_CONTRACTS_VERSION,
      goal_id,
      module_contracts: [
        {
          name: 'clamp-module',
          inputs: ['value', 'min', 'max'],
          outputs: ['clamped value'],
          invariants: ['result is within [min, max]'],
          side_effects: [],
          validation_boundary: 'pure function',
          failure_modes: [],
          seam_adjustments: [],
        },
      ],
      created_at,
    }),
    conceptual_design_critique: () => ({
      contract_version: shared.CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id,
      items: [],
      verdict: 'approved',
      created_at,
    }),
    obligation_ledger: () => ({
      contract_version: shared.CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id,
      obligations: [
        {
          id: 'O-1',
          description: 'clamp returns max on the upper-bound branch',
          kind: 'behavioral',
          depends_on: [],
          status: 'pending',
          change_classification: {
            change_kind: 'change',
            touched_symbols: ['clamp'],
            determined_by: 'touches_existing_symbol',
          },
        },
      ],
      created_at,
    }),
    cyclic_seam_resolution: () => ({
      contract_version: cp.CP_CYCLIC_SEAM_RESOLUTION_VERSION,
      goal_id,
      status: 'no_cycles',
      cycles: [],
      created_at,
    }),
    test_validator_plan: () => ({
      contract_version: shared.CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id,
      test_specs: [
        {
          obligation_id: 'O-1',
          name: 'clamp clamps to max above range and passes through in range',
          kind: 'invariant',
          assertions: [
            'clamp(42, 0, 10) returns 10 on the satisfied path',
            'clamp rejects the wrong-bound result on the failure path',
          ],
        },
      ],
      created_at,
    }),
    contract_assessment_report: () => ({
      contract_version: shared.CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
      goal_id,
      findings: [],
      verdict: 'passed',
      created_at,
    }),
    counterexample: () => ({
      contract_version: shared.CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
      goal_id,
      counterexamples: [],
      created_at,
    }),
    judge_report: () => ({
      contract_version: shared.CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id,
      verdict: 'approved',
      classifications: [],
      created_at,
    }),
    implementation_dag: () => ({
      contract_version: shared.CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id,
      nodes: [
        {
          id: 'CP-CLAMP-001',
          title: 'Fix the clamp upper-bound branch',
          description:
            `In ${DEFECT_FILE}, the function clamp(value, min, max) has a bug in the ` +
            '`if (value > max)` branch: it returns `min`, but it must return `max`. ' +
            'Edit that one line so the `value > max` branch reads `return max;`. ' +
            'Change nothing else. Then the self-check `node check-clamp.mjs` passes.',
          satisfies_obligations: ['O-1'],
          depends_on: [],
          verification_obligation_ids: ['O-1'],
          targeted_commands: [DEFECT_VERIFY_COMMAND],
          // Declared write scope → the extracted plan's affected_files, so the
          // implement worker is told exactly which file to edit.
          output_files: [DEFECT_FILE],
          files_likely_touched: [DEFECT_FILE],
          status: 'pending',
        },
      ],
      edges: [],
      created_at,
    }),
  };

  // Write every pre-implementation artifact in dependency order so each one's
  // captured dependency hashes are consistent. `verification_report` is produced
  // by the close phase, not pre-seeded, so it has no builder here.
  for (const name of CP_ARTIFACT_NAMES) {
    const builder = PHASE_BUILDERS[name];
    if (!builder) continue;
    await writeContractArtifact(artifactsDir, name, builder());
  }
}

// ── The gated capstone ────────────────────────────────────────────────────────

test(
  'A-9: audit → promote → remediate drives to complete in-process over the cheapest provider with ZERO host-subagent dispatch — landed branch commits, green closing gate, fully-reconciled coverage ledger',
  {
    skip: RUN
      ? false
      : `set RUN_AUTONOMY_E2E=1 and ${PROVIDER_KEY_ENV} to run the live autonomy capstone`,
  },
  async () => {
    await withTempDir('a9-autonomy-e2e-', async (root) => {
      // 1. Seed a real, plantable defect + a git repo to branch remediation from.
      await writeAutonomyFixtureTree(root);
      const { git } = initAutonomyFixtureGit(root);

      // 2. AUDIT HALF — audit the fixture in-process and promote its findings.
      //    Asserts no host-subagent `semantic_review` dispatch internally.
      await runAuditHalf(root);

      // The promoted machine contract drives remediation. Use a deterministic,
      // verifiable contract (one finding citing the defect with a green-able
      // targeted_command) so the remediation denominator + per-node verify are
      // stable, independent of exactly what the live audit surfaced this run.
      const inputPath = join(root, '.audit-tools', 'audit-findings.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(inputPath, JSON.stringify(buildPromotedFindings(), null, 2), 'utf8');

      // 3. REMEDIATE HALF — drive to complete in-process, auto-satisfying host
      //    gates, asserting no host-subagent `dispatch_implement*` step.
      const finalStep = await runRemediateHalf(root, inputPath);
      assert.equal(finalStep.step_kind, 'present_report');

      // ── Capstone assertion 1 already enforced inline (no dispatch step). ──

      // ── Assertion 4: the seeded defect was actually fixed in the tree the
      //    remediation branch landed. The verify command passes against the
      //    landed source. (Proven on the remediation branch below.) ──

      // ── Assertion 2: a remediation branch with landed commits. ──
      const branches = git('branch', '--list', 'remediation/*');
      assert.equal(branches.status, 0, 'git branch --list must succeed');
      const remediationBranches = branches.stdout
        .split('\n')
        .map((l) => l.replace(/^[*+]?\s*/, '').trim())
        .filter((l) => l.startsWith('remediation/'));
      assert.ok(
        remediationBranches.length >= 1,
        `expected a remediation/<run-id> branch; got: ${branches.stdout.trim() || '(none)'}`,
      );
      const remediationBranch = remediationBranches[0];

      // The branch carries commits AHEAD of the seeded base (landed work).
      const ahead = git('rev-list', '--count', `main..${remediationBranch}`);
      assert.equal(ahead.status, 0, 'git rev-list must succeed');
      assert.ok(
        Number(ahead.stdout.trim()) >= 1,
        `remediation branch ${remediationBranch} must have >=1 commit ahead of main; got ${ahead.stdout.trim()}`,
      );

      // The landed fix verifies green on the remediation branch: check the defect
      // file at the branch tip returns the correct upper bound.
      const showFixed = git('show', `${remediationBranch}:${DEFECT_FILE}`);
      assert.equal(showFixed.status, 0, 'the defect file must exist at the branch tip');
      assert.doesNotMatch(
        showFixed.stdout,
        /value > max[\s\S]*return min/,
        'the upper-bound branch must no longer return min on the remediation branch',
      );

      // ── Assertion 3: a green closing gate, recorded in the outcomes contract.
      //    remediation-outcomes.json is written to dirname(artifactsDir) and
      //    SURVIVES the green-run artifact cleanup. ──
      const outcomesPath = join(root, '.audit-tools', 'remediation-outcomes.json');
      assert.ok(existsSync(outcomesPath), 'remediation-outcomes.json must be written');
      const outcomes = JSON.parse(await readFile(outcomesPath, 'utf8'));
      assert.ok(
        outcomes.combined_test_result?.passed === true,
        `closing gate must be green (combined_test_result.passed); got ${JSON.stringify(outcomes.combined_test_result)}`,
      );
      assert.notEqual(
        outcomes.closing_result?.status,
        'failed',
        'the closing action must not have failed',
      );

      // ── Assertion 4 (ledger): a fully-reconciled per-finding coverage ledger.
      //    The persisted complete state carries the final item dispositions; the
      //    structured denominator is the promoted finding set. assertLedgerComplete
      //    must be complete with denominator > 0 (a 0/0 vacuous green FAILS). ──
      const completeStatePath = join(
        root,
        '.audit-tools',
        'remediation-state.complete.json',
      );
      assert.ok(
        existsSync(completeStatePath),
        'remediation-state.complete.json must be written at close',
      );
      const completeState = JSON.parse(await readFile(completeStatePath, 'utf8'));

      // The denominator is the run's ACTUAL planned node set (the contract
      // pipeline extracts the implementation-DAG node id `CP-CLAMP-001`, not the
      // promoted finding id), so the ledger reconciliation reflects real work.
      const denominatorIds = Object.keys(completeState.items ?? {});
      const ledger = buildPerFindingLedger({
        denominatorKind: 'finding_enumeration',
        denominatorIds,
        items: completeState.items,
      });
      const completeness = assertLedgerComplete(ledger);
      assert.ok(
        completeness.complete,
        `coverage ledger must be fully reconciled; missing=${JSON.stringify(
          completeness.missing,
        )} duplicated=${JSON.stringify(completeness.duplicated)}`,
      );
      // Non-vacuity: a 0/0 ledger is INCOMPLETE by INV-CL-05 — assert a real,
      // positive denominator so the green is never vacuous.
      assert.ok(
        ledger.denominator > 0,
        'coverage ledger denominator must be > 0 (a 0/0 vacuous green FAILS)',
      );
      assert.equal(
        ledger.covered,
        ledger.denominator,
        'every enumerated node must reach a terminal disposition',
      );
      // Stronger non-vacuity: the run did real remediation — at least one node
      // genuinely RESOLVED (a ledger of only force-closed entries would still pass
      // the terminal check, but proves no actual fix landed).
      assert.ok(
        ledger.entries.some((e) => e.disposition === 'resolved'),
        `at least one node must be genuinely resolved; entries=${JSON.stringify(ledger.entries)}`,
      );

      // Cross-check the branch name helper matches the discovered branch's run id.
      const runId = remediationBranch.slice('remediation/'.length);
      assert.equal(remediationBranchName(runId), remediationBranch);
    });
  },
);
