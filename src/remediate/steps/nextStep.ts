import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StateStore, type RemediationState, type HostCapabilities } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  RemediationBlock,
  RemediationItemState,
  RemediationPlan,
} from "../state/types.js";
import { readOptionalJsonFile, writeJsonFile, writeTextFile, buildAuditDeliverablePair, formatValidationIssues, isRecord, withFsRetry, RunLogger, DISPATCH_PROMPT_HANDOFF_NOTE, renderQuotaCoverageNudge, renderTokenBudgetView, coerceJsonObjectArg, driveRolling, setQuotaStateDir, interpretFreeFormIntent, advance, decideFrictionTriage, buildFrictionTriageBlock, type FrictionTriageDecision, type ObligationDef, type ObligationOutcome, type InterpretedIntent, type SessionConfig, type HostModelRosterEntry, type CapacityPool, type PartialCompletionTerminal, type RollingDispatchResult, type ProviderSlot, type FrontierNode, type HybridSpillCoordinator, type NodeAssignment, planHybridDispatch, readSettledPools, addSettledPool, sourceByPoolId, classifyProvider, selectDispatchDriver, renderDispatchDriverInstruction, HostSessionQuotaSource, buildProviderModelKey, captureStepBoundaryFriction, LENSES, SEVERITIES, type ResolvedProviderName, type DispatchableSource } from "audit-tools/shared";
import type { CoverageLedger } from "../state/types.js";
import { applyPlanPipeline, buildCoverageLedger } from "../phases/plan.js";
import { groundExtractedFindings } from "../phases/grounding.js";
import { runTriagePhase } from "../phases/triage.js";
import { runClosePhase } from "../phases/close.js";
import { validateRemediationPlan } from "../validation/remediationState.js";
import {
  mergeImplementResults,
  prepareImplementDispatch,
  readExtractedPlanIfPresent,
  buildConfirmedPools,
  executeNodeInWorktree,
  blockScopesFromPlan,
  declaredPathsFromPlan,
  targetedCommandsForBlock,
  type WorktreeNodeWorker,
} from "./dispatch.js";
import { makeProviderNodeDispatcher } from "./providerNodeDispatch.js";
import { prepareHostRollingDispatch, nodeClaimRegistry, nodeSettledPoolsPath } from "./rollingSession.js";
import { ClaimRegistry } from "../../shared/quota/claimRegistry.js";
import { claimWithBackoff, withClaimHeartbeat } from "../../shared/quota/claimLease.js";
import { nodeClaimsPath, remediationArtifactsDir } from "../../shared/io/auditToolsPaths.js";
import { resolveRepoRoot } from "../../shared/io/repoRoot.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep, RemediationDispatchPlan } from "./types.js";
import { dependencyVerifiedComplete } from "./stepUtils.js";
import {
  isTerminalStatus,
  isVerifiedCompleteStatus,
  isSkipStatus,
} from "../state/itemStatus.js";
import {
  deduplicateCrossLensFindings,
  fixupBlocksAfterDedup,
} from "../dedup/crossLensDedup.js";
import { checkAffectedFileIntegrity } from "../utils/fileIntegrity.js";
import { resolveIntakeStep } from "./intakeResolver.js";
import { runCommand } from "../utils/commands.js";
import {
  runToolOwnedFinalGate,
  applyCoarseReblock,
  readFinalGateSidecar,
  writeFinalGateSidecar,
  type GateRunner,
} from "./finalGate.js";
import {
  buildNextContractPipelineStep,
  shouldEnterContractPipeline,
  writePathASeedFromFindings,
} from "./contractPipeline.js";
import {
  evaluateFastPath,
  buildLeanExtractedPlan,
  distinctAffectedFiles,
  interpretLeanLightReviewVerdict,
  LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
  type LeanLightReviewDisposition,
} from "./leanFastPath.js";
import {
  contractArtifactExists,
  contractPipelineDir,
} from "../contractPipeline/artifactStore.js";
import {
  buildReviewRequest,
  applyReviewResolution,
  type ReviewRequest,
  type ReviewResolution,
} from "../review/reviewGate.js";
import { buildAutonomousReviewDecision } from "../review/autonomousGate.js";
import { runFindingFilterPass, type FindingFilterResult } from "../findingFilter.js";
import {
  intakePaths,
  isIntakeReady,
  readIntakeArtifacts,
  resolveManifestSources,
  type IntakeSourceManifest,
} from "../intake.js";
import {
  ensureIntakeRiskSignal,
  readIntakeRiskSignal,
  writeIntakeRiskSignal,
  escalateRiskSignal,
} from "../riskSignal.js";
import type { IntentCheckpoint } from "audit-tools/shared";
import {
  ambiguityReviewPrompt,
  clarificationPrompt,
  collectIntakeClarificationsPrompt,
  collectStartingPointPrompt,
  loaderCommand,
  reviewApprovalPrompt,
  synthesizeIntakePrompt,
  triagePrompt,
} from "./prompts.js";

// Single-sourced prose renders of the canonical lens / severity vocabularies
// (`audit-tools/shared` `LENSES` / `SEVERITIES`) for the intent-checkpoint
// prompt copy. Previously these 11-lens / 5-severity lists were hand-copied as
// backtick-quoted literals in three places in this file and would silently drift
// from the canonical enum (the very drift `types/lens.ts` exists to prevent).
const VALID_LENSES_PROSE = LENSES.map((lens) => `\`${lens}\``).join(", ");
const VALID_SEVERITIES_PROSE = SEVERITIES.map((sev) => `\`${sev}\``).join(", ");

/**
 * The host's resolved provider identity for quota-key / driver-classification
 * purposes: the configured `sessionConfig.provider`, defaulting to the
 * conversation host (`claude-code`) when unset or `auto`. Single-sourced so the
 * `?? "claude-code"` default and the `auto`-exclusion live in ONE place rather
 * than being re-spelled (with an ad-hoc cast) at each dispatch call site.
 */
function resolveHostProviderName(
  sessionConfig: SessionConfig | null | undefined,
): ResolvedProviderName {
  const provider = sessionConfig?.provider;
  if (provider === undefined || provider === "auto") return "claude-code";
  return provider;
}

export interface NextStepOptions {
  root?: string;
  artifactsDir?: string;
  input?: string | string[];
  hostCanDispatchSubagents?: boolean;
  hostMaxConcurrent?: number;
  hostContextTokens?: number | null;
  hostOutputTokens?: number | null;
  /** Ordered model roster (lowest rank first); outranks the scalar pair. */
  hostModels?: HostModelRosterEntry[] | null;
  /** Opaque model identity for the quota key when no model name resolves. */
  hostModelId?: string | null;
  finalizeClosing?: boolean;
  forceReplan?: boolean;
  /**
   * True when this invocation supplied `--guidance-file` (folded into
   * intake/conversation-start.md before the step decision). Like a fresh
   * `--input`, a guidance file introduces NEW intake, so against a run already
   * past intake it must trip the resume-vs-restart conflict gate rather than
   * silently resuming (and executing) the old, unrelated run. Set once at the
   * bootstrap call; bare `next-step` follow-ups leave it undefined.
   */
  guidanceFileSupplied?: boolean;
  /**
   * Opt IN to the in-process rolling dispatch engine for the implement phase.
   * Defaults off (proven host-fanned wave path). See `resolveRollingEngineEnabled`.
   */
  rollingEngine?: boolean;
  sessionConfig?: SessionConfig | null;
  /**
   * Skip the tool-owned final completion gate (INV-RS-10) at the all-terminal
   * transition. Production never sets this; it is a test-hermeticity affordance
   * so suites that drive an unrelated flow to completion do not spawn a real
   * build. Also honored via `REMEDIATE_SKIP_FINAL_GATE`. The gate's correctness
   * is verified directly (rolling-scheduler.test.ts) regardless of this flag.
   */
  skipFinalGate?: boolean;
  /**
   * Injectable runner for the tool-owned final gate (INV-RS-10). When set, the
   * gate uses it instead of spawning real commands, so the all-terminal
   * transition (coarse re-block / bounded terminate) can be exercised
   * deterministically in tests. Unset in production → real env-scrubbed builds.
   */
  finalGateRunner?: GateRunner;
}

export function resolveHostDispatchCapability(options: {
  hostCanDispatchSubagents?: boolean;
  sessionConfig?: SessionConfig | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options.hostCanDispatchSubagents !== undefined) {
    return options.hostCanDispatchSubagents;
  }
  if (options.sessionConfig?.host_can_dispatch_subagents !== undefined) {
    return options.sessionConfig.host_can_dispatch_subagents;
  }
  const envValue = (options.env ?? process.env).REMEDIATE_HOST_CAN_DISPATCH;
  if (envValue === "true") return true;
  if (envValue === "false") return false;

  // Conversation-first default: an interactive agent host (e.g. Claude Code) can
  // dispatch callable subagents, so default to parallel wave dispatch. A host that
  // genuinely cannot dispatch opts out via host_can_dispatch_subagents:false,
  // REMEDIATE_HOST_CAN_DISPATCH=false, or --host-can-dispatch-subagents=false.
  return true;
}

/**
 * Whether the run is unattended (autonomous). Host-agnostic — ONE flag drives
 * the whole path. Resolution order: sessionConfig.autonomous_mode →
 * REMEDIATE_AUTONOMOUS env → false (attended/interactive default, so the review
 * gate halts for a human unless autonomy is explicitly requested).
 */
export function resolveAutonomousMode(options: {
  sessionConfig?: SessionConfig | null;
  env?: NodeJS.ProcessEnv;
} = {}): boolean {
  if (options.sessionConfig?.autonomous_mode !== undefined) {
    return options.sessionConfig.autonomous_mode;
  }
  const envValue = (options.env ?? process.env).REMEDIATE_AUTONOMOUS;
  if (envValue === "true") return true;
  if (envValue === "false") return false;
  return false;
}

/**
 * Whether the rolling dispatch engine drives the implement phase. Defaults to TRUE:
 * both rolling drivers on the shared `acceptNodeWorktree` core (per-node worktree →
 * tool-owned commit → verify → cherry-pick merge; verify-fail → triage) are now
 * validated end-to-end — the host-subagent driver via a real-subagent smoke
 * (f18138fe) and the in-process provider driver via a live-NIM run THROUGH
 * decideNextStep (2026-06-17, tests/nim-rolling-e2e.test.ts). The legacy host-fanned
 * wave (`dispatch_implement`) is retained as an explicit opt-OUT (rolling_engine:false
 * / REMEDIATE_ROLLING_ENGINE=false), not deleted. Resolution order: explicit option →
 * sessionConfig.dispatch.rolling_engine → REMEDIATE_ROLLING_ENGINE env → true.
 */
export function resolveRollingEngineEnabled(options: {
  rollingEngine?: boolean;
  sessionConfig?: SessionConfig | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options.rollingEngine !== undefined) return options.rollingEngine;
  const cfg = options.sessionConfig?.dispatch?.rolling_engine;
  if (cfg !== undefined) return cfg;
  const envValue = (options.env ?? process.env).REMEDIATE_ROLLING_ENGINE;
  if (envValue === "true") return true;
  if (envValue === "false") return false;
  return true;
}

/** The host-capability fields supplied explicitly on a single next-step call. */
export interface ExplicitHostCapabilities {
  can_dispatch_subagents?: boolean;
  max_concurrent?: number;
  context_tokens?: number | null;
  output_tokens?: number | null;
  model_id?: string | null;
  models?: unknown;
}

/** 32k context-window floor, applied ONLY at true first contact (nothing persisted). */
const HOST_CONTEXT_TOKENS_FLOOR = 32_000;

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Pure per-field host-capability resolver (C1). Each field resolves as
 * `explicit ?? persisted ?? floor` — a per-field merge, never a whole-object
 * clobber that would drop fields the current call omitted. The 32k context
 * floor applies ONLY at true first contact (no persisted handshake at all);
 * once a handshake exists, an omitted field reuses the persisted value rather
 * than re-flooring. Corrupt / non-finite persisted numbers degrade to undefined
 * without throwing.
 *
 * Returns:
 *  - `resolved` — the merged capabilities to drive downstream dispatch sizing;
 *  - `toPersist` — a delta of ONLY the explicitly-supplied fields, so a
 *    `store.mutate` merge never clobbers omitted fields.
 */
export function resolveHostCapabilities(
  explicit: ExplicitHostCapabilities | undefined,
  persisted: HostCapabilities | undefined,
): { resolved: HostCapabilities; toPersist: HostCapabilities } {
  const exp = explicit ?? {};
  const per = persisted && typeof persisted === "object" ? persisted : undefined;
  const firstContact = per === undefined;

  const pick = <T>(e: T | null | undefined, p: T | undefined): T | undefined =>
    e ?? p ?? undefined;

  const context_tokens =
    finiteOrUndefined(exp.context_tokens) ??
    finiteOrUndefined(per?.context_tokens) ??
    (firstContact ? HOST_CONTEXT_TOKENS_FLOOR : undefined);

  const resolved: HostCapabilities = {
    can_dispatch_subagents: pick(exp.can_dispatch_subagents, per?.can_dispatch_subagents),
    max_concurrent: finiteOrUndefined(exp.max_concurrent) ?? finiteOrUndefined(per?.max_concurrent),
    context_tokens,
    output_tokens:
      finiteOrUndefined(exp.output_tokens) ?? finiteOrUndefined(per?.output_tokens),
    model_id: pick(exp.model_id, per?.model_id),
    models: exp.models ?? per?.models,
  };

  // Persist ONLY the explicitly-supplied fields (the delta) — never the floor,
  // never an omitted field.
  const toPersist: HostCapabilities = {};
  if (exp.can_dispatch_subagents !== undefined)
    toPersist.can_dispatch_subagents = exp.can_dispatch_subagents;
  if (finiteOrUndefined(exp.max_concurrent) !== undefined)
    toPersist.max_concurrent = exp.max_concurrent as number;
  if (finiteOrUndefined(exp.context_tokens) !== undefined)
    toPersist.context_tokens = exp.context_tokens as number;
  if (finiteOrUndefined(exp.output_tokens) !== undefined)
    toPersist.output_tokens = exp.output_tokens as number;
  if (exp.model_id !== undefined && exp.model_id !== null)
    toPersist.model_id = exp.model_id;
  if (exp.models !== undefined) toPersist.models = exp.models;

  return { resolved, toPersist };
}

function randomRunId(prefix = "RUN"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Host-facing note interposing a shared rebuild between rolling dependency
 * levels. The tool admits a downstream node only once its upstream node is
 * verified-complete; once that upstream edit lands, the host must rebuild the
 * shared surface before the next next-step pass so the downstream node
 * typechecks/runs against the realized output rather than stale `dist/`. The
 * rebuild is build-FREE single-flight at the package level — one central build,
 * never a per-node `npm run build` racing it (CE-001).
 */
const SHARED_REBUILD_BETWEEN_LEVELS_NOTE = `## Shared rebuild between dependency levels

These nodes were selected because their dependencies are verified-complete. When a
node you just merged edited a shared/upstream surface a later node depends on,
rebuild that surface ONCE — \`npm run build\`
— before the next \`next-step\` dispatches the now-eligible downstream nodes, so they
build against the realized upstream output. Do not run a per-node \`npm run build\`;
the central rebuild is single-flight (one build, never one-per-node racing \`dist/\`).`;

function resolveRoot(root?: string): string {
  // Anchor away from a drifted cwd — never trust bare `resolve(".")`. A run whose
  // cwd wandered into `.audit-tools/` would otherwise recompute repo_root as that
  // dir and fork a phantom nested tree. See src/shared/io/repoRoot.ts.
  return resolveRepoRoot(root ?? ".");
}

function resolveArtifactsDir(root: string, artifactsDir?: string): string {
  // The default rebases onto the anchored root via the shared helper (the sole
  // owner of the `.audit-tools/remediation` join literal); an explicit dir is
  // honored verbatim.
  return artifactsDir ? resolve(artifactsDir) : remediationArtifactsDir(root);
}

function stateRunId(state: RemediationState | null): string {
  // When the plan is absent (fully-green close deleted the state, or complete
  // was persisted without a plan), use the stable fallback "run" so the friction
  // record path is deterministic across multiple next-step calls on the same run.
  return state?.plan?.plan_id ?? "run";
}

function defaultInputCandidates(root: string): string[] {
  // Prefer the canonical machine contract (audit-findings.json) over its
  // human-facing render (audit-report.md). The JSON is the source of truth on
  // both sides of the audit -> remediate pipeline, and feeding it triggers the
  // lossless structured hand-off in the plan phase instead of a lossy LLM
  // re-extraction from the markdown render that sits beside it.
  return [
    join(root, ".audit-tools", "audit-findings.json"),
    join(root, ".audit-tools", "audit", "audit-findings.json"),
    join(root, "audit-findings.json"),
    join(root, ".audit-tools", "audit-report.md"),
    join(root, ".audit-tools", "audit", "audit-report.md"),
    join(root, "audit-report.md"),
  ];
}

interface InputResolution {
  supplied: boolean;
  existing: string[];
  missing: string[];
  checked: string[];
  /**
   * EVERY discovered source that exists — the full context set surfaced to the
   * host, not just the single `existing[0]` the pipeline auto-selects. On the
   * no-`--input` path this is all default candidates that exist on disk; on the
   * `--input` path it equals `existing`. Used only to build the awareness
   * manifest at the discovered-sources gate; never narrows the pipeline's own
   * single-best selection (which still uses `existing`).
   */
  allExisting: string[];
}

function inputValues(input?: string | string[]): string[] {
  if (input === undefined) return [];
  return Array.isArray(input) ? input : [input];
}

function resolveInputPaths(
  root: string,
  input?: string | string[],
): InputResolution {
  const values = inputValues(input).filter((value) => value.trim().length > 0);
  if (values.length > 0) {
    const checked = values.map((value) => resolve(root, value));
    const existing = checked.filter((candidate) => existsSync(candidate));
    return {
      supplied: true,
      existing,
      missing: checked.filter((candidate) => !existsSync(candidate)),
      checked,
      allExisting: existing,
    };
  }

  const checked = defaultInputCandidates(root);
  // Default discovery probes the same logical artifact (the audit output) in
  // several canonical locations and two formats. Select the single
  // highest-priority match — never feed both the structured contract and its
  // markdown render — so a lone .json input takes the lossless structured
  // fast-path instead of being demoted to multi-source LLM extraction.
  const allExisting = checked.filter((candidate) => existsSync(candidate));
  const best = allExisting[0];
  return {
    supplied: false,
    existing: best ? [best] : [],
    missing: [],
    checked,
    allExisting,
  };
}

/**
 * True when a supplied `--input` is the SAME input the existing run was already
 * built from (its recorded intake source manifest, `created_from: "input"`, with
 * a path set equal to the supplied paths). The `/remediate-code` loader re-passes
 * the same `--input` on every `next-step`; treating that unchanged input as a
 * RESUME — not an `input_conflict` — spares the host a needless resume/restart ack
 * dance, while a genuinely DIFFERENT input still trips the conflict gate. Enforced
 * in the tool, never by asking the loader to remember to drop the flag (a needed
 * manual flag is a bug signal).
 */
/**
 * True when `candidatePath` (the best default-discovered input, e.g.
 * `.audit-tools/audit-findings.json`) was modified more recently than
 * `reportPath` (a leftover `remediation-report.md`). A freshly-regenerated
 * audit doc postdating the last remediation report is a NEW remediation
 * source, not evidence the old run is still "the" answer — used to stop
 * `complete_redelivery` from silently re-presenting a stale report over it.
 * Missing/unreadable files compare as "not fresher" (fail toward redelivering,
 * the pre-existing behaviour) rather than throwing.
 */
function isDefaultCandidateFresherThanReport(
  candidatePath: string | undefined,
  reportPath: string,
): boolean {
  if (!candidatePath) return false;
  try {
    return statSync(candidatePath).mtimeMs > statSync(reportPath).mtimeMs;
  } catch {
    return false;
  }
}

function suppliedInputMatchesRun(
  inputResolution: InputResolution,
  manifest: IntakeSourceManifest | undefined,
): boolean {
  if (!inputResolution.supplied) return false;
  if (!manifest || manifest.created_from !== "input") return false;
  const supplied = new Set(inputResolution.checked.map((p) => resolve(p)));
  const recorded = new Set(manifest.sources.map((s) => resolve(s.path)));
  if (supplied.size === 0 || supplied.size !== recorded.size) return false;
  for (const p of supplied) if (!recorded.has(p)) return false;
  return true;
}

export type {
  FindingRiskTier,
  FindingClassification,
} from "./stepUtils.js";
export {
  NO_CHANGE_RE,
  dependenciesSatisfied,
  dependencyVerifiedComplete,
  specIndicatesNoChange,
  classifyFindingRisk,
} from "./stepUtils.js";
export { isTerminalStatus, isVerifiedCompleteStatus };

function documentableFindings(state: RemediationState): Finding[] {
  if (!state.plan || !state.items) return [];
  return state.plan.findings.filter(
    (finding) => state.items?.[finding.id]?.status === "pending",
  );
}

/**
 * Blocks/nodes eligible for the next rolling dispatch pass: those with pending
 * work AND every dependency VERIFIED-COMPLETE (INV-RS-01 — a SKIP or blocked
 * dependency never makes a dependent eligible). This is the rolling-scheduler
 * eligibility gate; it replaced the old `dependenciesSatisfied` (any-terminal)
 * wave gate so a node whose prerequisite was skipped/blocked is held back rather
 * than dispatched against a surface that never landed.
 */
function implementableBlocks(state: RemediationState): RemediationBlock[] {
  if (!state.plan || !state.items) return [];
  return state.plan.blocks.filter(
    (block) =>
      dependencyVerifiedComplete(block, state) &&
      block.items.some((findingId) => {
        const item = state.items?.[findingId];
        return item?.status === "pending";
      }),
  );
}

/**
 * Pending nodes that are NOT eligible because at least one dependency did not
 * reach a verified-complete disposition (a prerequisite was skipped, blocked, or
 * is still pending). Once no eligible block remains, these are dead-ended: the
 * rolling scheduler marks them `blocked` (their upstream surface never landed)
 * rather than looping forever. Used by `handlePlanning` to make that transition
 * deterministic.
 */
function blockedByUnsatisfiedDependency(
  state: RemediationState,
): RemediationBlock[] {
  if (!state.plan || !state.items) return [];
  return state.plan.blocks.filter(
    (block) =>
      !dependencyVerifiedComplete(block, state) &&
      block.items.some((findingId) => state.items?.[findingId]?.status === "pending"),
  );
}

// ---------------------------------------------------------------------------
// Rolling per-node scheduler (CP-BLOCK-N-rolling-scheduler)
// ---------------------------------------------------------------------------
//
// The rolling scheduler replaced the wave-batch shim: instead of dispatching one
// fixed-size wave per next-step and folding back through `implementing`, a node
// becomes eligible the instant every dependency reaches a verified-complete
// disposition (INV-RS-01). Concurrency is emergent from admission control (the
// `dispatch-quota.json` `admission.granted_packet_ids` the tool admits against the
// live budget — INV-S05 / INV-QD-11), never a computed wave cap.
// A shared rebuild is interposed between dependency levels so a downstream node
// typechecks/runs against the freshly-built upstream `audit-tools/shared`
// surface; the rebuild is single-flight (CE-001) so the same package is never
// built twice or concurrently within one dispatch run.

/**
 * Partition pending nodes into rolling dependency LEVELS. Level 0 is every
 * pending node already eligible (deps verified-complete now); each subsequent
 * level is the pending nodes that become eligible once all earlier levels are
 * assumed verified-complete. The boundary between two levels is exactly where a
 * shared rebuild is interposed (so a later level builds against the realized
 * upstream surface). A node with a permanently-unsatisfiable edge (its
 * prerequisite is skipped/blocked, not merely pending) is NOT placed in any
 * level — it is dead-ended by `handlePlanning`.
 *
 * Pure and deterministic: level MEMBERSHIP is fixed by the dependency predicate
 * (INV-RS-01) and is independent of node order; the interposed-rebuild boundaries
 * are therefore stable across runs without an in-level numeric sort. In-level
 * admission ORDER is no longer decided here — it is owned by the file-ownership
 * scheduler (`ownershipSubWaves`, INV-SOO-04/08), which applies its own explicit
 * block_id tie-break AFTER the disjointness filter. The numeric
 * `block_id.localeCompare` admission ordering that used to live here was removed
 * atomically with that change (INV-SOO-04).
 */
export function rollingDependencyLevels(
  state: RemediationState,
): RemediationBlock[][] {
  const plan = state.plan;
  const items = state.items;
  if (!plan || !items) return [];

  const blockById = new Map(plan.blocks.map((b) => [b.block_id, b]));
  const pendingBlocks = plan.blocks.filter((b) =>
    b.items.some((id) => items[id]?.status === "pending"),
  );

  // A dependency edge is "completable" only when the dep node is itself pending
  // (will be satisfied by some level) or already verified-complete. A skipped /
  // blocked dependency makes the dependent permanently ineligible — such nodes
  // never enter a level (INV-RS-01).
  const isVerifiedNow = (depBlock: RemediationBlock): boolean =>
    depBlock.items.every((id) => isVerifiedCompleteStatus(items[id]?.status));
  const isPending = (depBlock: RemediationBlock): boolean =>
    depBlock.items.some((id) => items[id]?.status === "pending");

  // Auto-phasing (T3): a block's foundations→consumers phase is a HARD barrier on
  // top of its explicit dependency edges. A block at phase p may only enter a level
  // once every block at a STRICTLY LOWER phase is VERIFIED-complete (resolved, not
  // merely placed) — so a planning pass emits only the lowest unfinished phase, its
  // foundations land + per-node verify, and the next pass opens the next phase. This
  // is the end-to-end ordering guarantee (INV-PHASE-01); an explicit whole-repo
  // suite gate at each phase boundary is the remaining T3 sliver (see backlog).
  // Absent ordinals (single-phase / non-auto-phased plan) collapse to phase 0 → no
  // barrier, identical to pre-auto-phasing behaviour.
  const phaseOf = (block: RemediationBlock): number => block.phase_ordinal ?? 0;
  const lowerPhaseBlocks = (p: number): RemediationBlock[] =>
    plan.blocks.filter((b) => phaseOf(b) < p);
  // The barrier is clear for phase p when every lower-phase block is verified-
  // complete now; it can NEVER clear if a lower-phase block is skipped/blocked.
  const phaseBarrierClear = (p: number): boolean =>
    lowerPhaseBlocks(p).every((b) => isVerifiedNow(b));
  const phaseBarrierUnsatisfiable = (p: number): boolean =>
    lowerPhaseBlocks(p).some((b) => !isVerifiedNow(b) && !isPending(b));

  const permanentlyIneligible = (block: RemediationBlock): boolean => {
    for (const depId of block.dependencies ?? []) {
      const dep = blockById.get(depId);
      if (!dep) continue; // dangling edge never strands the DAG
      if (!isVerifiedNow(dep) && !isPending(dep)) return true; // skipped/blocked dep
    }
    // A foundation a lower phase owns that can never verify-complete dead-ends every
    // consumer above it (same strand semantics as a skipped explicit dependency).
    if (phaseBarrierUnsatisfiable(phaseOf(block))) return true;
    return false;
  };

  const levels: RemediationBlock[][] = [];
  const placed = new Set<string>();
  let remaining = pendingBlocks.filter((b) => !permanentlyIneligible(b));

  while (remaining.length > 0) {
    const ready = remaining.filter((block) =>
      // Phase barrier first: a higher-phase block is never ready until every lower
      // phase is verified-complete (a foundations→consumers gate the explicit
      // dependency edges alone don't enforce across modules).
      phaseBarrierClear(phaseOf(block)) &&
      (block.dependencies ?? []).every((depId) => {
        const dep = blockById.get(depId);
        if (!dep) return true; // dangling edge
        // Satisfied if already verified-complete, or every pending item of the
        // dep was placed in an earlier level (so it will be verified by then).
        if (isVerifiedNow(dep)) return true;
        return dep.items.every(
          (id) =>
            isVerifiedCompleteStatus(items[id]?.status) ||
            (items[id]?.status === "pending" && placed.has(dep.block_id)),
        );
      }),
    );
    if (ready.length === 0) {
      // A cycle among the remaining pending nodes: no further level can form.
      // Leave them unplaced — `handlePlanning` marks them blocked deterministically.
      break;
    }
    levels.push(ready);
    for (const block of ready) placed.add(block.block_id);
    remaining = remaining.filter((b) => !placed.has(b.block_id));
  }

  return levels;
}

/**
 * The phase ordinal whose UNTOUCHED entry a whole-repo test-suite gate must run
 * before, or null when no per-phase gate is due this pass (auto-phasing, T3 —
 * the integration checkpoint layered on top of the INV-PHASE-01 ordering
 * barrier). A gate is due iff:
 *   - the eligible dispatch frontier this pass (`rollingDependencyLevels`, which
 *     already applies the phase barrier, so the frontier is a SINGLE phase) is at
 *     a phase P > 0 — i.e. a lower foundations phase precedes it (and, by the
 *     barrier, is fully VERIFIED-complete now); AND
 *   - phase P is at its untouched entry — every block at phase P still has all
 *     its items `pending` (nothing dispatched yet).
 * The second clause makes the predicate pure and reblock-safe: it fires exactly
 * once as foundations→consumers crosses into P, never again on P's later
 * intra-phase levels, and re-fires only if a coarse re-block reopens the lower
 * phases and the frontier later re-climbs to P. Phase 0 (and an ordinal-free
 * single-phase plan) is never gated here — there is no preceding phase to
 * validate; the all-terminal tool-owned final gate (INV-RS-10) is the whole-repo
 * checkpoint for the last/only phase.
 */
export function phaseBoundaryToGate(state: RemediationState): number | null {
  const plan = state.plan;
  const items = state.items;
  if (!plan || !items) return null;
  const frontier = rollingDependencyLevels(state).flat();
  if (frontier.length === 0) return null;
  const phaseOf = (b: RemediationBlock): number => b.phase_ordinal ?? 0;
  const dispatchPhase = Math.min(...frontier.map(phaseOf));
  if (dispatchPhase <= 0) return null;
  const pristine = plan.blocks
    .filter((b) => phaseOf(b) === dispatchPhase)
    .every((b) => b.items.every((id) => items[id]?.status === "pending"));
  return pristine ? dispatchPhase : null;
}

/** A single node's dispatch handler for the in-process rolling engine. */
export type RollingNodeDispatcher = (
  block: RemediationBlock,
  slot: ProviderSlot,
) => Promise<RollingDispatchResult<{ block_id: string }>>;

export interface DriveRollingDispatchOptions {
  /** Confirmed quota pools (scheduler-owned concurrency — no separate wave cap). */
  confirmedPools: CapacityPool[];
  sessionConfig: SessionConfig;
  /** Per-node dispatch (host subagent / tool worker). Must resolve, never reject. */
  dispatchNode: RollingNodeDispatcher;
  /**
   * Rebuild `audit-tools/shared` (and any upstream surface) BETWEEN dependency
   * levels. Single-flight is enforced by the driver: this is invoked at most
   * once per inter-level boundary and never concurrently with itself.
   */
  rebuildSharedBetweenLevels: () => Promise<void>;
  /** Per-node estimated input tokens (defaults to a flat overhead estimate). */
  estimateTokens?: (block: RemediationBlock) => number;
  /** Quota state dir for `recordWaveOutcome` (defaults to leaving it unset). */
  quotaStateDir?: string;
  /**
   * A block's declared write-scope, for file-ownership-disjoint admission
   * (INV-SOO). Defaults to `block.touched_files` (the block's authoritative
   * declared write set). An empty/unresolved scope is gated conservatively
   * (admitted only solo) by the ownership scheduler.
   */
  scopeForBlock?: (block: RemediationBlock) => string[];
  /** Repo root for canonical path identity (INV-SOO-09). Defaults to cwd. */
  root?: string;
  /**
   * The retained host-session source (SAME instance fed into `buildConfirmedPools`).
   * Wired into the dispatcher's `recordRateLimit` (write) + `isPacketEscalated`
   * (read) hooks so a same-packet account wall accrues the bounded re-limit count
   * and, past the bound, strands instead of livelocking. Omit to leave INV-QD-07
   * transient re-route behaviour unchanged (no escalation).
   */
  hostSession?: HostSessionQuotaSource;
}

export interface DriveRollingDispatchResult {
  /** Per-level dispatch results, in level order. */
  levels: Array<{
    blockIds: string[];
    results: RollingDispatchResult<{ block_id: string }>[];
  }>;
  /** Number of inter-level shared rebuilds performed (== levels.length - 1 when >1 level). */
  rebuilds: number;
  /**
   * The rolling engine's partial-completion terminal, if any wave stranded work
   * (piece D `quota_paused`, or the pre-existing `empty_pool`). Aggregated across
   * waves as the EARLIEST-reset terminal so the consumer can keep the stranded
   * nodes pending (quota_paused) or block them (empty_pool). Absent when every
   * packet completed.
   */
  terminal?: PartialCompletionTerminal;
}

/**
 * Drive a rolling per-node dispatch run IN PROCESS over the precomputed
 * dependency levels, wiring onto the shared `createRollingDispatcher`
 * (quota-only throttle; transient-429 re-queue + empty-pool stranding owned by
 * the shared engine). The driver's own responsibilities are the two properties
 * the shared engine does not own:
 *   1. SHARED-REBUILD-BETWEEN-LEVELS — after a level completes, rebuild the
 *      upstream surface before the next level dispatches, so dependents
 *      typecheck/run against the realized upstream output.
 *   2. SINGLE-FLIGHT BUILD (CE-001) — the rebuild runs exactly once per
 *      inter-level boundary, never twice or concurrently.
 *
 * Within a level, concurrency is whatever the shared engine's quota headroom
 * allows over `confirmedPools` — there is no wave-size cap (INV-S05).
 */
export async function driveRollingDispatch(
  levels: RemediationBlock[][],
  options: DriveRollingDispatchOptions,
): Promise<DriveRollingDispatchResult> {
  if (options.quotaStateDir) {
    setQuotaStateDir(options.quotaStateDir);
  }
  const estimateTokens = options.estimateTokens ?? (() => 2000);
  const scopeForBlock =
    options.scopeForBlock ?? ((b: RemediationBlock) => b.touched_files ?? []);
  const blockById = new Map(levels.flat().map((b) => [b.block_id, b]));
  const hostSession = options.hostSession;

  // The remediate terminal adapter over the unified shared driver. What stays here is
  // remediate's projection: a block → its ownership node (declared write-scope, so the
  // shared `ownershipSubWaves` serializes same-file nodes / parallelizes disjoint ones)
  // and → its dispatch packet; the shared rebuild between dependency levels; and the
  // host-session escalation wiring. The loop, sub-wave split, and quota_paused/empty_pool
  // terminal merge are the unified driver's.
  const run = await driveRolling<RemediationBlock, { block_id: string }>({
    levels,
    confirmedPools: options.confirmedPools,
    sessionConfig: options.sessionConfig,
    toNode: (b) => ({
      block_id: b.block_id,
      write_paths: scopeForBlock(b),
      ...(b.cofile_parallel_safe !== undefined
        ? { cofile_parallel_safe: b.cofile_parallel_safe }
        : {}),
    }),
    toPacket: (b) => ({
      id: b.block_id,
      payload: { block_id: b.block_id },
      estimatedTokens: estimateTokens(b),
      complexity: 0.5,
    }),
    dispatchPacket: async (packet, slot) =>
      options.dispatchNode(blockById.get(packet.payload.block_id)!, slot),
    ...(options.root !== undefined ? { root: options.root } : {}),
    // Single-flight (CE-001) is enforced by the unified driver.
    rebuildBetweenLevels: options.rebuildSharedBetweenLevels,
    // Host-session escalation: feed recordLimit (write) at the rate_limited observation
    // point and read isEscalated (strand-not-requeue). The SAME instance sized the pools,
    // so the bounded re-limit count is account-wide.
    ...(hostSession
      ? {
          recordRateLimit: (packet, result) =>
            hostSession.recordLimit(
              result.rateLimit?.channel ?? "error",
              result.rateLimit?.text ?? "",
              packet.id,
            ),
          isPacketEscalated: (packetId) => hostSession.isEscalated(packetId),
        }
      : {}),
  });

  return {
    levels: run.levels.map((l) => ({ blockIds: l.nodeIds, results: l.results })),
    rebuilds: run.rebuilds,
    ...(run.terminal ? { terminal: run.terminal } : {}),
  };
}

// ---------------------------------------------------------------------------
// In-process rolling implement dispatch (the live-path engine wiring)
// ---------------------------------------------------------------------------
//
// CE-001 anti-wedge: this is the rolling-engine path that runs ALONGSIDE the
// proven host-fanned wave step. It is engaged ONLY when (a) the rolling engine
// is opted in (`resolveRollingEngineEnabled`) AND (b) a programmatic per-node
// `dispatchNode` is supplied (a subprocess/CLI provider-backed worker). The
// conversation host fans out its own subagents and never supplies a
// `dispatchNode`, so it always takes the host-wave fallback. The atomic removal
// of that fallback is a DOCUMENTED REMAINING STEP, gated on a validated
// multi-worker rolling dispatch — it is intentionally NOT forced here.
//
// What this path adds over the host-wave step: concurrency is derived purely
// from quota (`createRollingDispatcher` over `buildConfirmedPools`, no wave-size
// cap — INV-S05); dispatch is rolling (a freed slot is filled the instant a node
// completes — `createRollingDispatcher.run`); each node runs in an ISOLATED git
// worktree whose branch diff is the write-scope ground truth; and a node's
// branch is merged into the main tree ONLY after its per-node verify passes
// (verify-before-accept). Results are then merged through the same deterministic
// `mergeImplementResults` the wave path uses (tolerant finding_id remap,
// write-scope + lost-update gates), so the contract output is identical.

/** A programmatic per-node implement worker: edits within the node's worktree, writes its result file. */
export type ProgrammaticNodeDispatcher = (args: {
  block: RemediationBlock;
  slot: ProviderSlot;
  /** The isolated worktree root the worker must edit within. */
  worktreeRoot: string;
  /** The absolute path the worker must write its result JSON to. */
  resultPath: string;
}) => Promise<RollingDispatchResult<{ block_id: string }>>;

export interface DriveRollingImplementDispatchOptions {
  root: string;
  artifactsDir: string;
  runId: string;
  sessionConfig: SessionConfig | null;
  /**
   * Programmatic per-node dispatcher. Defaults to the live provider-backed worker
   * (`makeProviderNodeDispatcher`: resolves the configured provider and launches it
   * with the node's worktree-rooted prompt). Tests inject a stub to exercise the
   * engine without spawning a real worker.
   */
  dispatchNode?: ProgrammaticNodeDispatcher;
  /** Rebuild the upstream shared surface between dependency levels (single-flight). */
  rebuildSharedBetweenLevels: () => Promise<void>;
  /** Wave/host inputs used to size the quota-derived confirmed pools. */
  waveOptions?: {
    hostMaxConcurrent?: number;
    hostContextTokens?: number | null;
    hostOutputTokens?: number | null;
    hostModels?: HostModelRosterEntry[] | null;
    hostModelId?: string | null;
  };
}

export interface DriveRollingImplementDispatchResult {
  /** Per-node verify + merge outcome, in dispatch order. */
  nodes: Array<{
    block_id: string;
    outcome: RollingDispatchResult<{ block_id: string }>["outcome"];
    verify_passed: boolean;
    merged: boolean;
  }>;
  /** Number of inter-level shared rebuilds performed. */
  rebuilds: number;
  /** The state status after the deterministic merge of all node results. */
  state_status: RemediationState["status"];
}

/**
 * Backends the orchestrator can drive IN-PROCESS as the per-node implement worker
 * via `driveRollingImplementDispatch` (it resolves + launches the provider with each
 * node's worktree-rooted prompt, cwd-confined to that worktree). The conversation
 * host (claude-code) and IDE-bound providers (vscode-task / antigravity) are
 * excluded: claude-code self-blocks inside a session, and the IDE providers have no
 * headless invocation. "auto" is intentionally absent — auto-resolution stays on the
 * conversation host-subagent default, so the in-process driver is opt-in via an
 * EXPLICIT backend provider in session config. When one is set, it takes precedence
 * over the host-subagent driver: an operator who configured a backend (e.g. a NIM
 * pool for headless autonomy) wants it to do the implement work, not the host.
 */
const IN_PROCESS_DISPATCH_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "codex",
  "opencode",
  "subprocess-template",
  "local-subprocess",
]);

function resolvesToInProcessDispatchProvider(
  sessionConfig: SessionConfig | null | undefined,
): boolean {
  const provider = sessionConfig?.provider;
  return provider !== undefined && IN_PROCESS_DISPATCH_PROVIDERS.has(provider);
}

/**
 * Whether a confirmed pool is one the orchestrator launches IN-PROCESS this cycle
 * (vs. the conversation host's subagent pool). The remediate classification for the
 * shared `planHybridDispatch` split — single-sourced off the same provider set
 * `resolvesToInProcessDispatchProvider` uses.
 */
function isInProcessPool(pool: { providerName: string }): boolean {
  return IN_PROCESS_DISPATCH_PROVIDERS.has(pool.providerName);
}

/**
 * Release a node's shared claim on a terminal accept (token-checked through the
 * registry), then drop the held token. Idempotent: a node with no held token (a
 * peer-owned skip, or a double-release) is a no-op. Single-sourced so both the
 * success and the error paths of the in-process driver free the claim identically.
 */
async function releaseNodeClaim(
  registry: ClaimRegistry,
  claimTokens: Map<string, string>,
  blockId: string,
): Promise<void> {
  const token = claimTokens.get(blockId);
  if (!token) return;
  await registry.release(blockId, token);
  claimTokens.delete(blockId);
}

/**
 * Drive the implement phase through the in-process rolling engine. Engages the
 * shared `createRollingDispatcher` (via `driveRollingDispatch`) over
 * quota-derived `confirmedPools`, runs each node in an isolated worktree, gates
 * acceptance on a per-node verify, and finally merges through the deterministic
 * `mergeImplementResults`. Returns null when there is no eligible pending work.
 *
 * SAFETY: this never touches the main tree except through `mergeWorktree` (which
 * cherry-picks a verified branch and aborts cleanly on conflict). A node whose
 * verify fails is NOT merged; its worktree is removed and the deterministic merge
 * marks it blocked (its result file is absent / unaccounted) so the run routes it
 * to triage rather than landing an unverified change.
 */
export async function driveRollingImplementDispatch(
  options: DriveRollingImplementDispatchOptions,
): Promise<DriveRollingImplementDispatchResult | null> {
  const { root, artifactsDir, runId } = options;

  // Prepare the dispatch plan (eligible verified-complete frontier) with the SAME
  // quota-derived sizing the wave path uses. This writes per-node prompts +
  // dispatch-plan.json + dispatch-quota.json.
  const plan = await prepareImplementDispatch(
    { root, artifactsDir },
    runId,
    undefined,
    {
      hostMaxConcurrent: options.waveOptions?.hostMaxConcurrent,
      sessionConfig: options.sessionConfig,
      hostContextTokens: options.waveOptions?.hostContextTokens,
      hostOutputTokens: options.waveOptions?.hostOutputTokens,
      hostModels: options.waveOptions?.hostModels,
      hostModelId: options.waveOptions?.hostModelId,
      // Each node runs in its own worktree, so its prompt is rooted there.
      worktreeRootedPrompts: true,
      // The in-process rolling engine admits + leases per-packet itself, so the
      // dispatch-quota grant here must NOT lease (a host grant lease would
      // double-count the same work against the shared account budget).
      grantLeases: false,
    },
  );
  if (plan.items.length === 0) {
    return null;
  }

  // Map each planned block id to its result path so the per-node dispatcher
  // writes where the merge expects to read.
  const resultPathByBlock = new Map(
    plan.items
      .filter((i): i is typeof i & { block_id: string } => typeof i.block_id === "string")
      .map((i) => [i.block_id, i.result_path]),
  );
  // Every block's declared write scope, for the accept-time write-scope gate's
  // amendment ownership adjudication (so an amended path owned by a sibling block
  // is a seam conflict, not a silent grant). Built once from the in-memory plan.
  const allBlockScopes = blockScopesFromPlan(plan);
  // Map each planned block id to its worktree-rooted prompt path so the
  // provider-backed dispatcher launches the worker with the right prompt.
  const promptPathByBlock = new Map(
    plan.items
      .filter((i): i is typeof i & { block_id: string } => typeof i.block_id === "string")
      .map((i) => [i.block_id, i.prompt_path]),
  );

  // The RETAINED host-session source: threaded through pool sizing AND the
  // dispatcher's escalation hooks so the bounded re-limit chain (recordLimit →
  // escalate → strand → quota_escalation friction) is fed end-to-end. Its
  // onEscalation routes to the single step-boundary friction chokepoint with this
  // driver's artifactsDir/runId, so a bounded account-wall escalation surfaces as
  // reviewable friction instead of only a stderr line.
  const providerName = resolveHostProviderName(options.sessionConfig);
  const hostSessionModelKey = buildProviderModelKey(
    providerName,
    (options.sessionConfig as { block_quota?: { host_model?: string | null } } | undefined)
      ?.block_quota?.host_model ??
      options.waveOptions?.hostModelId ??
      null,
  );
  const hostSession = new HostSessionQuotaSource({
    providerModelKey: hostSessionModelKey,
    onEscalation: (escalation) => {
      void captureStepBoundaryFriction(
        artifactsDir,
        runId,
        {
          eventType: "quota_escalation",
          discriminator: escalation.packet_id,
          note: escalation.reason,
          severity: "high",
          category: "trap",
          area: "dispatch/quota",
        },
        "remediate-code",
      );
    },
  });

  // Confirmed pools: quota-derived concurrency, never the raw host flag (INV-QD-11).
  const confirmedPools = await buildConfirmedPools({
    sessionConfig: options.sessionConfig,
    hostMaxConcurrent: options.waveOptions?.hostMaxConcurrent,
    hostContextTokens: options.waveOptions?.hostContextTokens,
    hostOutputTokens: options.waveOptions?.hostOutputTokens,
    hostModels: options.waveOptions?.hostModels,
    hostModelId: options.waveOptions?.hostModelId,
    hostSession,
  });

  // The live per-node worker: the configured provider, launched with the node's
  // worktree-rooted prompt and cwd = its worktree. Tests inject `options.dispatchNode`
  // to exercise the engine without spawning a real worker. A node on a source-backed
  // pool launches FROM its source's config (A-8 generic dispatchable sources).
  const dispatchNode: ProgrammaticNodeDispatcher =
    options.dispatchNode ??
    makeProviderNodeDispatcher({
      root,
      artifactsDir,
      runId,
      sessionConfig: options.sessionConfig,
      promptPathByBlock,
      sourceByPoolId: sourceByPoolId(confirmedPools),
    });

  // Load state to partition the eligible frontier into rolling dependency levels.
  const state = await new StateStore(artifactsDir).loadState();
  if (!state) return null;
  const plannedBlockIds = new Set(resultPathByBlock.keys());
  const allLevels = rollingDependencyLevels(state);
  // Keep only the blocks that were actually planned this dispatch (eligible now).
  const levels = allLevels
    .map((level) => level.filter((b) => plannedBlockIds.has(b.block_id)))
    .filter((level) => level.length > 0);

  const nodeOutcomes: DriveRollingImplementDispatchResult["nodes"] = [];

  // The SAME file-backed claim registry the host-subagent driver claims through
  // (`nodeClaimRegistry`, keyed only to run + artifacts dir). Claiming a node here
  // BEFORE creating its worktree makes the in-process and host-subagent drivers
  // mutually exclusive on a node — exactly-one-claimant across both (A-10), the
  // cross-driver double-dispatch guard. Owner tokens are held in-memory for the
  // life of this run: a `rate_limited` re-queue re-enters for the same block, so a
  // node already claimed by THIS driver reuses its token rather than self-colliding.
  const registry = nodeClaimRegistry(artifactsDir, runId);
  const claimTokens = new Map<string, string>();

  // Per-node worktree dispatch + verify-before-accept, wrapped so the rolling
  // engine's dispatchNode callback always RESOLVES (never rejects).
  const dispatchNodeWithWorktree: RollingNodeDispatcher = async (block, slot) => {
    const resultPath = resultPathByBlock.get(block.block_id)!;
    // Claim BEFORE any worktree work (CE-001). A node THIS driver already holds (a
    // rate_limited re-queue) reuses its token. A node a PEER driver holds is its to
    // run — skip the worker + accept lifecycle entirely so we never double-dispatch
    // or double-merge it; the run-level `mergeImplementResults` reconciles from the
    // peer's accept outcome.
    if (!claimTokens.has(block.block_id)) {
      const claim = await registry.claim(block.block_id, "in-process");
      if (!claim.acquired) {
        nodeOutcomes.push({ block_id: block.block_id, outcome: "success", verify_passed: false, merged: false });
        return {
          packet: { id: block.block_id, payload: { block_id: block.block_id }, estimatedTokens: 0, complexity: 0.5 },
          outcome: "success",
        };
      }
      claimTokens.set(block.block_id, claim.ownerToken);
    }
    // The shared per-node worktree lifecycle (reset → create → link node_modules →
    // seed → dispatch → commit/verify/write-scope/merge → record), identical to the
    // A-8 hybrid executor and behaviourally to the host-subagent driver's
    // `accept-node` callback. `touched_files` is the block's authoritative declared
    // write set (the source the dispatch plan's write scope is derived from).
    const { result, accept } = await executeNodeInWorktree({
      block,
      slot,
      root,
      artifactsDir,
      runId,
      resultPath,
      seedPaths: block.touched_files ?? [],
      allBlockScopes,
      additionalVerifyCommands: targetedCommandsForBlock(state, block.block_id),
      dispatchNode,
    });
    nodeOutcomes.push({
      block_id: block.block_id,
      outcome: accept.outcome,
      verify_passed: accept.verifyPassed,
      merged: accept.merged,
    });
    // Release the claim ONLY on a terminal accept. A `rate_limited` worker re-queues
    // (still owned work — keep the claim so a peer can't grab it mid-retry); success /
    // error / timeout is terminal → free it through the shared registry (token-checked).
    if (result.outcome !== "rate_limited") {
      await releaseNodeClaim(registry, claimTokens, block.block_id);
    }
    return result;
  };

  // Declared write-scope per block, from the dispatch plan — the same authority
  // the merge-time write-scope gate reads — for file-ownership-disjoint admission
  // (INV-SOO). A block with no plan scope falls back to its touched_files.
  const writePathsByBlock = new Map(
    allBlockScopes.map((s) => [s.block_id, s.write_paths]),
  );
  const driven = await driveRollingDispatch(levels, {
    confirmedPools,
    sessionConfig: options.sessionConfig ?? {},
    dispatchNode: dispatchNodeWithWorktree,
    rebuildSharedBetweenLevels: options.rebuildSharedBetweenLevels,
    quotaStateDir: artifactsDir,
    root,
    hostSession,
    scopeForBlock: (block) =>
      writePathsByBlock.get(block.block_id) ?? block.touched_files ?? [],
  });

  // Piece D — persist the rolling engine's partial-completion terminal onto state
  // BEFORE the merge, so the merge can SKIP-block the quota_paused stranded nodes
  // (their worker rate-limited → no result file, but they must stay PENDING for a
  // later step to redispatch clean — the worktrees were PRESERVED by
  // acceptNodeWorktree). An `empty_pool` terminal does not affect the merge (its
  // nodes are genuine failures); the `partial_terminal` obligation blocks them.
  if (driven.terminal) {
    const pre = await new StateStore(artifactsDir).loadState();
    if (pre) {
      pre.partial_completion_terminal = driven.terminal;
      await new StateStore(artifactsDir).saveState(pre);
    }
  }

  // Deterministic merge: same path the wave flow uses (tolerant remap, write-scope
  // gate against each verified branch, lost-update detection). Worktrees are
  // already removed; the merge reads each node's result file + branch diff.
  const merged = await mergeImplementResults({ root, artifactsDir }, runId);

  return {
    nodes: nodeOutcomes,
    rebuilds: Math.max(0, levels.length - 1),
    state_status: merged.status,
  };
}

/**
 * Flat per-node input-token estimate for the A-8 hybrid frontier split. The
 * coordinator splits by per-pool SLOTS (concurrency) — host vs. backend — so a
 * uniform estimate is sufficient here; it matches the default the in-process engine
 * uses (`driveRollingDispatch`'s `() => 2000`), keeping the two paths consistent.
 */
const HYBRID_NODE_TOKEN_ESTIMATE = 2000;

/** Outcome of running the coordinator's in-process partition this cycle. */
export interface InProcessPartitionResult {
  nodes: Array<{
    block_id: string;
    outcome: RollingDispatchResult<{ block_id: string }>["outcome"];
    verify_passed: boolean;
    merged: boolean;
  }>;
}

/**
 * Run the A-8 coordinator's IN-PROCESS partition this cycle. Each node was already
 * claimed by the coordinator and assigned to a backend pool (NIM / codex / …), so it
 * is launched on THAT pool's provider — binding the slot's providerName to the
 * per-node assignment is what routes a node to its assigned backend — cwd-confined to
 * its worktree, through the shared `executeNodeInWorktree` lifecycle (commit → verify
 * → write-scope → merge); then the coordinator's claim is released.
 *
 * Nodes run concurrently: the coordinator's proactive split already bounded the
 * partition to the backend pools' capacity, so the partition size IS the safe
 * concurrency. The host partition runs in parallel via the host-subagent driver;
 * both write accept-outcome sidecars the run-level `mergeImplementResults` reconciles.
 *
 * Run-once (no in-pass re-queue): a node whose worker rate-limits or errors is not
 * merged (its worktree drops) and is routed to triage by the deterministic merge —
 * bounded, never a livelock. (Cross-cycle settled-pool re-balancing is a follow-up.)
 */
export async function executeInProcessPartition(params: {
  root: string;
  artifactsDir: string;
  runId: string;
  sessionConfig: SessionConfig | null;
  partition: NodeAssignment[];
  plan: RemediationDispatchPlan;
  coordinator: HybridSpillCoordinator;
  /**
   * Injectable per-node worker (tests). Defaults to the live provider-backed
   * dispatcher, which resolves each node's provider from its slot so the
   * coordinator's per-node pool assignment routes it (cross-provider dispatch).
   */
  dispatchNode?: WorktreeNodeWorker;
  /**
   * Per-pool dispatchable source (A-8 generic sources), keyed by pool id. Lets a node
   * launch FROM its source's own `{endpoint, model, parameters}` (so two sources of the
   * same provider — e.g. two NIM endpoints — dispatch distinctly). Built from the
   * confirmed pools by the caller; absent → the global per-provider config block.
   */
  sourceByPoolId?: Map<string, DispatchableSource>;
}): Promise<InProcessPartitionResult> {
  const { root, artifactsDir, runId, sessionConfig, partition, plan, coordinator } = params;
  if (partition.length === 0) return { nodes: [] };

  const allBlockScopes = blockScopesFromPlan(plan);
  const withBlockId = plan.items.filter(
    (i): i is typeof i & { block_id: string } => typeof i.block_id === "string",
  );
  const promptPathByBlock = new Map(withBlockId.map((i) => [i.block_id, i.prompt_path]));
  const resultPathByBlock = new Map(withBlockId.map((i) => [i.block_id, i.result_path]));
  const state = await new StateStore(artifactsDir).loadState();
  const blockById = new Map<string, RemediationBlock>(
    (state?.plan?.blocks ?? []).map((b) => [b.block_id, b]),
  );

  const dispatchNode =
    params.dispatchNode ??
    makeProviderNodeDispatcher({
      root,
      artifactsDir,
      runId,
      sessionConfig,
      promptPathByBlock,
      sourceByPoolId: params.sourceByPoolId,
    });

  const nodes = await Promise.all(
    partition.map(async (a) => {
      // `a` IS the coordinator's NodeAssignment — release it directly on terminal.
      const resultPath = resultPathByBlock.get(a.nodeId);
      if (!resultPath) {
        // No prepared prompt/result for this node — release + mark error (the merge
        // routes it to triage); never silently drop a claimed node.
        await coordinator.release(a);
        return { block_id: a.nodeId, outcome: "error" as const, verify_passed: false, merged: false };
      }
      const block = blockById.get(a.nodeId) ?? ({ block_id: a.nodeId } as RemediationBlock);
      const slot: ProviderSlot = {
        providerName: a.providerName,
        hostModel: a.hostModel,
        poolId: a.poolId,
      };
      const { accept } = await executeNodeInWorktree({
        block,
        slot,
        root,
        artifactsDir,
        runId,
        resultPath,
        seedPaths: declaredPathsFromPlan(plan, a.nodeId),
        allBlockScopes,
        additionalVerifyCommands: state ? targetedCommandsForBlock(state, a.nodeId) : [],
        dispatchNode,
      });
      // Run-once → terminal; free the coordinator claim (token-checked).
      await coordinator.release(a);
      return {
        block_id: a.nodeId,
        outcome: accept.outcome,
        verify_passed: accept.verifyPassed,
        merged: accept.merged,
      };
    }),
  );

  return { nodes };
}

// ---------------------------------------------------------------------------
// Tool-owned final completion gate (INV-RS-10) + coarse re-block (INV-RS-09)
// ---------------------------------------------------------------------------
//
// The gate runner, its bounded coarse-reblock backstop, and the sidecar counter
// I/O were extracted behaviour-preservingly into the sibling leaf module
// `finalGate.ts` (CP-NODE-1). They are imported below for local use in the
// completion handler and re-exported to preserve this module's public surface +
// existing test imports. See `finalGate.ts` for the INV-RS-10 / CE-001 / CE-002
// documentation.

export {
  isAuditToolsMonorepo,
  toolOwnedFinalGateCommands,
  runToolOwnedFinalGate,
  applyCoarseReblock,
  COARSE_REBLOCK_BOUND,
} from "./finalGate.js";
export type {
  FinalGateCommandSpec,
  FinalGateCommandResult,
  ToolOwnedFinalGateResult,
  GateRunner,
  CoarseReblockAction,
  CoarseReblockDecision,
} from "./finalGate.js";

function resolvedOrTerminalItems(state: RemediationState): RemediationItemState[] {
  return Object.values(state.items ?? {}).filter((item) =>
    isTerminalStatus(item.status),
  );
}

function allItemsTerminal(state: RemediationState): boolean {
  const items = Object.values(state.items ?? {});
  return items.length > 0 && resolvedOrTerminalItems(state).length === items.length;
}

function normalizeExtractedPlan(value: unknown): {
  plan: RemediationPlan;
  /** Findings as received (post-default, pre-dedup) for coverage accounting. */
  sourceFindings: Finding[];
  /** Cross-lens dedup absorbed→survivor map for the coverage ledger. */
  mergeMap: Map<string, string>;
} {
  if (!isRecord(value)) {
    throw new Error("extracted-plan.json must be an object.");
  }
  const rawFindings = Array.isArray(value.findings) ? value.findings : [];
  const findings = rawFindings.map((finding) => {
    if (!isRecord(finding)) return finding;
    return {
      category: "General",
      affected_files: [],
      evidence: [],
      ...finding,
    };
  }) as Finding[];
  const rawBlocks = Array.isArray(value.blocks) ? value.blocks : [];
  const blocks =
    rawBlocks.length > 0
      ? rawBlocks.map((block) => {
          if (!isRecord(block)) return block;
          return {
            parallel_safe: true,
            dependencies: [],
            // touched_files is REQUIRED on the block contract; default to an
            // empty array so a free-form block that omits it still validates,
            // while an explicit value on `block` wins via the spread below.
            touched_files: [],
            ...block,
          };
        })
      : findings.map((finding, index) => ({
          block_id: `B-${String(index + 1).padStart(3, "0")}`,
          items: [finding.id],
          parallel_safe: true,
          touched_files: finding.affected_files.map((af) => af.path),
        }));
  const dedup = deduplicateCrossLensFindings(findings);
  const dedupBlocks = fixupBlocksAfterDedup(
    blocks as RemediationBlock[],
    dedup.mergeMap,
  );
  const plan: RemediationPlan = {
    plan_id:
      typeof value.plan_id === "string" ? value.plan_id : randomRunId("PLAN"),
    ...(typeof value.goal_id === "string" ? { goal_id: value.goal_id } : {}),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
    findings: dedup.findings,
    blocks: dedupBlocks,
    project_type:
      typeof value.project_type === "string" ? value.project_type : "unknown",
    test_command:
      typeof value.test_command === "string" ? value.test_command : undefined,
    e2e_command:
      typeof value.e2e_command === "string" ? value.e2e_command : undefined,
    candidate_closing_actions: ["none"],
    block_strategy:
      value.block_strategy === "test_graph" ||
      value.block_strategy === "git_cocommit" ||
      value.block_strategy === "file_overlap" ||
      value.block_strategy === "manual"
        ? value.block_strategy
        : undefined,
  };

  const issues = validateRemediationPlan(plan).filter(
    (issue) => issue.severity === "error",
  );
  if (issues.length > 0) {
    throw new Error(`Invalid extracted plan:\n${formatValidationIssues(issues)}`);
  }
  if (plan.findings.length === 0) {
    throw new Error("Extracted plan contains zero findings.");
  }
  return { plan, sourceFindings: findings, mergeMap: dedup.mergeMap };
}

async function saveStateForPlan(
  artifactsDir: string,
  existing: RemediationState,
  plan: RemediationPlan,
  planCoverage?: CoverageLedger,
): Promise<RemediationState> {
  const items: Record<string, RemediationItemState> = {};
  for (const finding of plan.findings) {
    const block = plan.blocks.find((candidate) =>
      candidate.items.includes(finding.id),
    );
    items[finding.id] = {
      finding_id: finding.id,
      status: "pending",
      block_id: block?.block_id ?? "UNKNOWN",
    };
  }
  const state: RemediationState = {
    ...existing,
    status: "planning",
    plan,
    items,
    closing_plan: { action: "none" },
    ...(planCoverage ? { plan_coverage: planCoverage } : {}),
  };
  await new StateStore(artifactsDir).saveState(state);
  await writeJsonFile(join(artifactsDir, "remediation_plan.json"), plan);
  return state;
}

// Plan-time bookkeeping recomputed on every plan pass; it must not participate
// in the carry-forward identity of a finding.
const PLAN_TIME_BOOKKEEPING_KEYS = new Set([
  "hash_at_plan_time",
  "evidence_grounded",
]);

function stripPlanTimeBookkeeping(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripPlanTimeBookkeeping(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (PLAN_TIME_BOOKKEEPING_KEYS.has(key)) continue;
    stripped[key] = stripPlanTimeBookkeeping(value[key]);
  }
  return stripped;
}

function findingCarryForwardKey(finding: Finding): string {
  return JSON.stringify(stripPlanTimeBookkeeping(finding));
}

function blockIdsByFinding(plan: RemediationPlan): Map<string, string> {
  const byFinding = new Map<string, string>();
  for (const block of plan.blocks) {
    for (const id of block.items) {
      byFinding.set(id, block.block_id);
    }
  }
  return byFinding;
}

function carryForwardMatchingItems(
  previous: RemediationState,
  replanned: RemediationState,
): RemediationState {
  if (!previous.plan || !previous.items || !replanned.plan || !replanned.items) {
    return replanned;
  }

  const previousFindings = new Map(
    previous.plan.findings.map((finding) => [finding.id, finding]),
  );
  const replannedBlockIds = blockIdsByFinding(replanned.plan);
  const items = { ...replanned.items };
  let carried = false;

  for (const finding of replanned.plan.findings) {
    const previousFinding = previousFindings.get(finding.id);
    const previousItem = previous.items[finding.id];
    // Skip items that were never documented (pending with no item_spec). Under
    // N-R13 (document phase dissolved), a pending item that already has an
    // item_spec from a prior planning/document pass should carry forward
    // together with its spec rather than being discarded.
    if (!previousFinding || !previousItem) {
      continue;
    }
    if (previousItem.status === "pending" && !previousItem.item_spec) {
      continue;
    }
    if (findingCarryForwardKey(previousFinding) !== findingCarryForwardKey(finding)) {
      continue;
    }

    items[finding.id] = {
      ...previousItem,
      block_id: replannedBlockIds.get(finding.id) ?? previousItem.block_id,
    };
    carried = true;
  }

  if (!carried) {
    return replanned;
  }

  const hasPending = replanned.plan.findings.some(
    (finding) => items[finding.id]?.status === "pending",
  );

  return {
    ...replanned,
    items,
    status: hasPending ? "planning" : replanned.status,
  };
}

async function forceReplanFromExistingIntake(
  root: string,
  artifactsDir: string,
  previous: RemediationState,
  store: StateStore,
): Promise<RemediationState | null> {
  const pendingState: RemediationState = {
    status: "pending",
    started_at: previous.started_at,
    step_count: previous.step_count,
  };
  const extractedPlan = await readExtractedPlanIfPresent(artifactsDir);
  if (!extractedPlan) {
    await store.saveState(pendingState);
    return null;
  }

  const replanned = await handlePendingExtractedPlan(
    root,
    artifactsDir,
    pendingState,
    extractedPlan,
  );
  if (!replanned) {
    return null;
  }

  const carried = carryForwardMatchingItems(previous, replanned);
  await store.saveState(carried);
  return carried;
}

async function presentReportStep(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  const reportPath = join(dirname(artifactsDir), "remediation-report.md");
  // Terminal friction-TRIAGE close-out, folded into present_report (single-sourced in
  // `audit-tools/shared`). MANDATORY + BLOCKING: stays "dispose" until every mechanical
  // event + reflection is disposed AND ≥1 open observation written. Never trivially
  // satisfied by an empty event set — the host must actively confirm the friction state.
  //
  // When `artifactsDir` was deleted by a fully-green close (close.ts rm -rf on a
  // green run), there is nowhere to persist the friction record and no mechanical
  // events to triage — skip the triage entirely and go straight to complete.
  const artifactsDirExists = existsSync(artifactsDir);
  const triage = artifactsDirExists
    ? await decideRemediateFrictionCloseout(artifactsDir, state)
    : null;
  const frictionBlock = triage ? buildFrictionTriageBlock(triage) : "";
  const isBlocked = triage?.action === "dispose";
  return writeCurrentStep({
    stepKind: "present_report",
    status: isBlocked ? "ready" : "complete",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: isBlocked
      ? `# Remediation Run Friction Triage\n\nComplete friction triage before presenting the report.\n${frictionBlock}`
      : `# Present Remediation Report\n\nRead \`${reportPath}\` and summarize the remediation outcome.\nMention resolved, ignored, and deemed-inappropriate counts plus the closing action.\n${frictionBlock}`,
    allowedCommands: [],
    stopCondition: isBlocked
      ? "Complete friction triage (write dispositions and open_observations), then call next-step again."
      : "Present the remediation report summary and stop.",
    artifactPaths: {
      final_report: reportPath,
      ...(triage ? { friction_record: triage.recordPath } : {}),
    },
  });
}

async function buildImplementDispatchStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  options: NextStepOptions;
  store: StateStore;
}): Promise<RemediateOutcome> {
  const { root, artifactsDir, state, options, store } = ctx;

    const sessionConfigImpl = options.sessionConfig ??
      await readOptionalJsonFile<SessionConfig>(
        join(root, ".remediation-artifacts", "session-config.json"),
      ) ?? await readOptionalJsonFile<SessionConfig>(
        join(root, "session-config.json"),
      );
    const canDispatchImpl = resolveHostDispatchCapability({
      hostCanDispatchSubagents: options.hostCanDispatchSubagents,
      sessionConfig: sessionConfigImpl,
    });

    // C1: merge the explicitly-supplied host-* options with the persisted
    // handshake (per-field `explicit ?? persisted ?? floor`), persist ONLY the
    // explicitly-supplied delta (never clobbering omitted fields), and feed the
    // resolved values into downstream dispatch sizing. A later call that omits a
    // flag reuses the persisted value rather than re-flooring.
    const { resolved: resolvedHostCaps, toPersist: hostCapsDelta } =
      resolveHostCapabilities(
        {
          can_dispatch_subagents: options.hostCanDispatchSubagents,
          max_concurrent: options.hostMaxConcurrent,
          context_tokens: options.hostContextTokens,
          output_tokens: options.hostOutputTokens,
          model_id: options.hostModelId,
          models: options.hostModels ?? undefined,
        },
        state.host_capabilities,
      );
    if (Object.keys(hostCapsDelta).length > 0) {
      await store.mutate(async (current) => ({
        ...(current ?? state),
        host_capabilities: {
          ...(current?.host_capabilities ?? state.host_capabilities ?? {}),
          ...hostCapsDelta,
        },
      }));
    }
    const resolvedHostMaxConcurrent = resolvedHostCaps.max_concurrent;
    const resolvedHostContextTokens = resolvedHostCaps.context_tokens ?? null;
    const resolvedHostOutputTokens = resolvedHostCaps.output_tokens ?? null;
    const resolvedHostModels =
      (resolvedHostCaps.models as HostModelRosterEntry[] | undefined) ?? null;
    const resolvedHostModelId = resolvedHostCaps.model_id ?? null;

    // A8 host-subagent rolling driver: when the rolling engine is enabled AND the
    // host can dispatch subagents, drive a FULL-ROLLING, worktree-isolated flow via
    // the `accept-node` per-completion callback — the conversation-first co-equal of
    // the in-process provider engine (`driveRollingImplementDispatch`), sharing the
    // same `acceptNodeWorktree` core. Gated behind the flag so the default stays the
    // proven host-fanned wave step until the rolling path is validated end-to-end.
    const rollingEngineEnabled = resolveRollingEngineEnabled({
      rollingEngine: options.rollingEngine,
      sessionConfig: sessionConfigImpl,
    });

    const runId = stateRunId(state);
    const waveOptsImpl = {
      hostMaxConcurrent: resolvedHostMaxConcurrent,
      sessionConfig: sessionConfigImpl ?? null,
      hostContextTokens: resolvedHostContextTokens,
      hostOutputTokens: resolvedHostOutputTokens,
      hostModels: resolvedHostModels,
      hostModelId: resolvedHostModelId,
    };

    // A8 in-process provider driver: when the rolling engine is enabled AND the
    // operator EXPLICITLY configured a programmatic backend provider (openai-compatible
    // / codex / opencode / …), the orchestrator drives the FULL rolling implement
    // dispatch ITSELF — the configured provider is the per-node worker, cwd-confined to
    // each node's worktree, sharing the same `acceptNodeWorktree` core (commit → verify
    // → merge, verify-fail → triage) as the host-subagent driver. Checked BEFORE the
    // host-subagent branch so an explicit backend (e.g. a NIM pool for headless
    // autonomy) drives the work rather than the conversation host's subagents.
    if (rollingEngineEnabled && resolvesToInProcessDispatchProvider(sessionConfigImpl)) {
      const driven = await driveRollingImplementDispatch({
        root,
        artifactsDir,
        runId,
        sessionConfig: sessionConfigImpl ?? null,
        // Per-node verify (targeted_commands) owns each node's build/test; an
        // inter-level "shared surface" rebuild is a monorepo-self-remediation concern
        // the host-driven paths handle, not a generic target-repo step → no-op here.
        rebuildSharedBetweenLevels: async () => {},
        waveOptions: {
          hostMaxConcurrent: resolvedHostMaxConcurrent,
          hostContextTokens: resolvedHostContextTokens,
          hostOutputTokens: resolvedHostOutputTokens,
          hostModels: resolvedHostModels,
          hostModelId: resolvedHostModelId,
        },
      });
      // null = no eligible pending work this pass; the engine merges internally once
      // it has run, so only the empty-frontier case needs a merge here. Either way the
      // implement frontier is resolved — transition on the freshly-merged state so the
      // engine re-scans (triage / closing) without recursion.
      if (driven === null) {
        const merged = await mergeImplementResults({ root, artifactsDir }, runId);
        return { kind: "transition", state: merged };
      }
      return { kind: "transition", state: await store.loadState() };
    }

    if (rollingEngineEnabled && canDispatchImpl) {
      // A-8 hybrid spill: when an in-process backend pool is ALSO confirmed (a
      // configured NIM/openai-compatible endpoint alongside the conversation host),
      // split the eligible frontier across BOTH pool classes via the shared
      // HybridSpillCoordinator (single claimant, proactive capacity split) — the
      // orchestrator runs the in-process partition THIS cycle while the host spawns
      // subagents for its partition. Pure host-subagent dispatch falls out when no
      // backend pool is confirmed (the coordinator has nothing to split against).
      // Retained host-session source for the hybrid pool-sizing pre-wall throttle
      // (this branch previously sized pools with no account-wall awareness at all,
      // unlike the primary path above). This branch has its own already-working,
      // bounded rate-limited/settle mechanism below (DC-4) rather than routing
      // through HostSessionQuotaSource.recordLimit/isEscalated, so onEscalation is
      // unused here — the source only feeds buildConfirmedPools' sizing.
      const hybridProviderName = resolveHostProviderName(sessionConfigImpl);
      const hybridHostSessionModelKey = buildProviderModelKey(
        hybridProviderName,
        (sessionConfigImpl as { block_quota?: { host_model?: string | null } } | undefined)
          ?.block_quota?.host_model ??
          resolvedHostModelId ??
          null,
      );
      const hybridHostSession = new HostSessionQuotaSource({
        providerModelKey: hybridHostSessionModelKey,
      });
      const confirmedPools = await buildConfirmedPools({
        sessionConfig: sessionConfigImpl ?? null,
        hostMaxConcurrent: resolvedHostMaxConcurrent,
        hostContextTokens: resolvedHostContextTokens,
        hostOutputTokens: resolvedHostOutputTokens,
        hostModels: resolvedHostModels,
        hostModelId: resolvedHostModelId,
        hostSession: hybridHostSession,
      });
      const backendPools = confirmedPools.filter(isInProcessPool);

      let rolling: Awaited<ReturnType<typeof prepareHostRollingDispatch>>;
      if (backendPools.length > 0) {
        // Prepare the frontier ONCE (worktree-rooted prompts) so the coordinator
        // split, the in-process executor, and the host driver all read the same plan.
        const plan = await prepareImplementDispatch({ root, artifactsDir }, runId, undefined, {
          ...waveOptsImpl,
          worktreeRootedPrompts: true,
        });
        const frontier: FrontierNode[] = plan.items
          .filter((i): i is typeof i & { block_id: string } => typeof i.block_id === "string")
          .map((i) => ({ id: i.block_id, estimatedTokens: HYBRID_NODE_TOKEN_ESTIMATE }));
        if (frontier.length === 0) {
          const merged = await mergeImplementResults({ root, artifactsDir }, runId);
          return { kind: "transition", state: merged };
        }
        // One coordinator over the shared claim registry splits + claims each node to
        // exactly one pool. DC-4: the settled set is cross-cycle (persisted) — a backend
        // pool that exhausted on a prior cycle is excluded here, so its work falls to the
        // host-subagent pool instead of re-looping on a dead backend.
        const settledPath = nodeSettledPoolsPath(artifactsDir, runId);
        const settled = await readSettledPools(settledPath);
        const partition = await planHybridDispatch({
          frontier,
          pools: confirmedPools,
          sessionConfig: sessionConfigImpl ?? {},
          claimRegistry: nodeClaimRegistry(artifactsDir, runId),
          readSettled: () => settled,
          onSettle: async (id) => {
            settled.add(id);
            await addSettledPool(settledPath, id);
          },
          isInProcess: isInProcessPool,
        });
        // Run the in-process partition now (each node on its assigned backend pool,
        // launched FROM that pool's source config — A-8 generic dispatchable sources).
        const inProcessOutcome = await executeInProcessPartition({
          root,
          artifactsDir,
          runId,
          sessionConfig: sessionConfigImpl ?? null,
          partition: partition.inProcess,
          plan,
          coordinator: partition.coordinator,
          sourceByPoolId: sourceByPoolId(confirmedPools),
        });
        // DC-4: a backend pool whose node rate-limited is exhausted → settle it
        // (cross-cycle) so the next cycle routes its share to the host pool.
        const rateLimited = new Set(
          inProcessOutcome.nodes.filter((n) => n.outcome === "rate_limited").map((n) => n.block_id),
        );
        const exhaustedPools = new Set(
          partition.inProcess.filter((a) => rateLimited.has(a.nodeId)).map((a) => a.poolId),
        );
        for (const poolId of exhaustedPools) {
          await partition.coordinator.settlePool(poolId);
        }
        // Surface each rate-limited node as reviewable friction (not just the
        // settle side-effect above). The shared step-boundary chokepoint dedupes
        // on {eventType, runId, discriminator}, so a chronically-exhausted backend
        // pool re-hitting the same block_id across cycles collapses to one record.
        for (const blockId of rateLimited) {
          void captureStepBoundaryFriction(
            artifactsDir,
            runId,
            {
              eventType: "quota_escalation",
              discriminator: blockId,
              note: "A-8 hybrid in-process node rate-limited; its backend pool was settled for this run.",
              severity: "high",
              category: "trap",
              area: "dispatch/quota",
            },
            "remediate-code",
          );
        }
        // The backend carried the whole batch (or every host node was contested by a
        // peer driver) → nothing for the host this cycle; merge what landed + transition.
        if (partition.host.length === 0) {
          const merged = await mergeImplementResults({ root, artifactsDir }, runId);
          return { kind: "transition", state: merged };
        }
        // Hand the host partition (pre-claimed) to the host-subagent driver.
        rolling = await prepareHostRollingDispatch({ root, artifactsDir }, runId, waveOptsImpl, {
          plan,
          partition: partition.host.map((a) => ({ block_id: a.nodeId, ownerToken: a.ownerToken })),
        });
      } else {
        rolling = await prepareHostRollingDispatch({ root, artifactsDir }, runId, waveOptsImpl);
      }
      // Everything eligible may already be done/skipped — fold straight to merge
      // rather than emitting a dispatch step with zero nodes.
      if (rolling.session.frontier.length === 0) {
        await mergeImplementResults({ root, artifactsDir }, runId);
        return { kind: "transition", state: await store.loadState() };
      }
      // S-BROKER-WIRING: pick the dispatch DRIVER (delegate the rolling loop to a
      // dedicated dispatcher subagent vs. drive it from the top host) off the
      // single classification + the live frontier/slot count — not host prose.
      const hostProvider: ResolvedProviderName = resolveHostProviderName(sessionConfigImpl);
      const driverSelection = selectDispatchDriver({
        classification: classifyProvider(hostProvider),
        eligibleItemCount: rolling.session.frontier.length,
        // The granted set's size IS the instantaneous admission width — there is no
        // separate concurrency number. The whole granted set runs at once, so the
        // driver-selection "slots" is the granted-set size.
        slots: rolling.session.frontier.length,
      });
      const rollMerge = loaderCommand(`merge-implement-results --run-id ${runId}`);
      const rollNext = loaderCommand("next-step");
      const acceptCmd = loaderCommand(`accept-node --id <BLOCK_ID> --run-id ${runId}`);
      const nodeLines = rolling.initial
        .map(
          (n) =>
            `- \`${n.block_id}\` — prompt: \`${n.prompt_path}\` — worktree (subagent cwd): \`${n.worktree_root}\``,
        )
        .join("\n");
      return { kind: "emit", step: await writeCurrentStep({
        stepKind: "dispatch_implement_rolling",
        status: "ready",
        runId,
        repoRoot: root,
        artifactsDir,
        prompt: `
# Dispatch Implementation Work (host-subagent rolling, worktree-isolated)

Each granted node runs in its OWN git worktree (hard isolation between nodes). The
TOOL owns commit -> verify -> merge + write-scope; you only spawn a subagent per
node and call \`accept-node\` as each finishes.

The tool ADMITTED this set against the live budget (and any declared in-flight cap):
dispatch EXACTLY the ${rolling.session.frontier.length} node(s) below and no more.
Their count is the whole grant — there is no separate concurrency cap. When they are
all accepted, merge and re-invoke next-step; the tool re-grants the pending remainder.

${renderDispatchDriverInstruction(driverSelection, `the ${rolling.session.frontier.length} granted node(s)`)}

Spawn ONE subagent for EACH granted node below. Give the subagent that node's
\`prompt\`, and set its working directory to the node's **worktree** path. The
subagent edits source files INSIDE that worktree and writes ONLY its result file.
Do NOT let any subagent edit the main repository tree.

Granted nodes (worktrees already created):
${nodeLines}

As EACH subagent finishes, run (substituting the finished node's block id):

\`${acceptCmd}\`

It runs the commit -> verify -> merge lifecycle for that node and prints a JSON
directive on stdout:
- \`{"directive":"wait",...}\` — other granted nodes are still in flight; do not spawn more.
- \`{"directive":"done",...}\` — every granted node has been accepted. Then run:

\`${rollMerge}\`

Then run:

\`${rollNext}\`

${renderQuotaCoverageNudge(rolling.quotaPath, artifactsDir)}

${renderTokenBudgetView(rolling.quotaPath)}

${DISPATCH_PROMPT_HANDOFF_NOTE}
`,
        allowedCommands: [acceptCmd, rollMerge, rollNext],
        stopCondition:
          "Stop after every node has been accepted (accept-node returns done), results merged, and next-step has been run.",
        artifactPaths: { dispatch_plan: rolling.planPath, dispatch_quota: rolling.quotaPath },
      }) };
    }
    // Rolling per-node dispatch: prepare EVERY currently-eligible node (deps all
    // verified-complete), never a single artificially-serialized block. There is
    // no wave-size cap — concurrency is emergent from admission control
    // (`dispatch-quota.json` `admission.granted_packet_ids`). `prepareImplementDispatch`
    // itself only admits verified-complete-eligible blocks
    // (`dependencyVerifiedComplete`), so this is the rolling-eligible frontier.
    const dispatchPlan = await prepareImplementDispatch(
      { root, artifactsDir },
      runId,
      undefined,
      waveOptsImpl,
    );
    // Everything eligible may already be done or skipped (e.g. every Tier 3
    // finding excluded) — fold straight to merge rather than dispatching a wave
    // of zero workers.
    if (dispatchPlan.items.length === 0) {
      await mergeImplementResults({ root, artifactsDir }, runId);
      return { kind: "transition", state: await store.loadState() };
    }
    const planPath = join(artifactsDir, "runs", runId, "implement", "dispatch-plan.json");
    const mergeCommand = loaderCommand(`merge-implement-results --run-id ${runId}`);
    const nextCommand = loaderCommand("next-step");
    const implQuotaPath = join(artifactsDir, "runs", runId, "implement", "dispatch-quota.json");

    if (!canDispatchImpl) {
      // A host that cannot dispatch parallel subagents runs the eligible nodes
      // ITSELF, one at a time — but the orchestrator still emits the FULL eligible
      // frontier (not one node per next-step). The shared rebuild between
      // dependency levels happens naturally on the next next-step pass: this
      // level's results are merged, and the next pass emits the now-eligible
      // downstream level after the host rebuilds the shared surface.
      return { kind: "emit", step: await writeCurrentStep({
        stepKind: "implement_rolling_sequential",
        status: "ready",
        runId,
        repoRoot: root,
        artifactsDir,
        prompt: `
# Implement Eligible Remediation Nodes (sequential)

Read the dispatch plan:

\`${planPath}\`

Every item in \`items\` is a node whose dependencies are all verified-complete, so
they are safe to implement now. Work through them ONE AT A TIME, in order: for each
item, read and follow only its \`prompt_path\`, then move to the next.

${SHARED_REBUILD_BETWEEN_LEVELS_NOTE}

After all results in this plan exist:

\`${mergeCommand}\`

Then run:

\`${nextCommand}\`
`,
        allowedCommands: [mergeCommand, nextCommand],
        stopCondition:
          "Stop after every eligible node's result has been merged and next-step has been run.",
        artifactPaths: {
          dispatch_plan: planPath,
          dispatch_quota: implQuotaPath,
        },
      }) };
    }

    return { kind: "emit", step: await writeCurrentStep({
      stepKind: "dispatch_implement",
      status: "ready",
      runId,
      repoRoot: root,
      artifactsDir,
      prompt: `
# Dispatch Implementation Work (rolling)

Read the dispatch plan and quota JSONs:

\`${planPath}\`
\`${implQuotaPath}\`

Every item in \`items\` is a node whose dependencies are all VERIFIED-COMPLETE
(INV-RS-01). The tool admitted a budget-bounded subset: dispatch EXACTLY the block
ids in the quota file's \`admission.granted_packet_ids\` and no others — that granted
set is the whole grant (there is no separate concurrency cap). Each item's
\`model_hint.tier\` suggests which model to use (small/standard/deep). If your
provider has rate limits, pace launches accordingly.

For each GRANTED item in \`items\` (its \`block_id\` in \`admission.granted_packet_ids\`),
dispatch one subagent with that item's \`prompt_path\`. Each subagent may edit source
files needed for that bounded block and must write only its assigned \`result_path\`.
After the granted set is merged and you run next-step, the tool re-grants the pending
remainder.

${SHARED_REBUILD_BETWEEN_LEVELS_NOTE}

${renderQuotaCoverageNudge(implQuotaPath, artifactsDir)}

${renderTokenBudgetView(implQuotaPath)}

${DISPATCH_PROMPT_HANDOFF_NOTE}

After all results exist:

\`${mergeCommand}\`

Then run:

\`${nextCommand}\`
`,
      allowedCommands: [mergeCommand, nextCommand],
      stopCondition:
        "Stop after all implementation results have been merged and next-step has been run.",
      artifactPaths: { dispatch_plan: planPath, dispatch_quota: implQuotaPath },
    }) };
}

/**
 * Piece D — the quota-paused resumable step. The rolling engine stranded one or
 * more nodes because every eligible provider pool hit a host session limit and is
 * paused until its stated reset. The stranded nodes stay PENDING (their worktrees
 * were preserved), so re-running next-step at/after `resetAt` redispatches them
 * clean. Emitted (not blocked) so the run is resumable, never a failure.
 */
async function buildQuotaPausedStep(params: {
  root: string;
  artifactsDir: string;
  runId: string;
  strandedIds: string[];
  resetAt: string | null;
}): Promise<RemediationStep> {
  const { root, artifactsDir, runId, strandedIds, resetAt } = params;
  const nextCommand = loaderCommand("next-step");
  const resetLine = resetAt
    ? `The earliest provider reset is \`${resetAt}\`. Wait until then, then run:`
    : `Wait for the provider session limit to reset, then run:`;
  return writeCurrentStep({
    stepKind: "quota_paused",
    status: "ready",
    runId,
    repoRoot: root,
    artifactsDir,
    prompt: `
# Remediation paused — provider session limit

Every eligible provider pool hit a host session limit and is paused until its
stated reset. ${strandedIds.length} node(s) are stranded and remain PENDING —
their worktrees were preserved, so they will redispatch clean on resume. Nothing
was blocked or failed; this is a resumable pause.

${resetLine}

\`${nextCommand}\`
`,
    allowedCommands: [nextCommand],
    stopCondition:
      "Stop and wait for the provider reset. Re-running next-step resumes the stranded nodes.",
  });
}

// Cooperative multi-agent (slice 4): the single mutex node guarding this run's
// in-process serial state-machine advance, and the heartbeat interval (well inside
// STALE_LOCK_MS so a live long phase is never reclaimed).
const REMEDIATE_PHASE_NODE = "phase:main";
const PHASE_CLAIM_HEARTBEAT_MS = 10_000;

// Cooperative multi-agent (slice 4, spec/multi-ide-concurrent-runs-design.md):
// emitted when another agent/IDE currently holds the phase mutex and is advancing
// this run's serial state machine. A non-blocking "retry shortly" — the host
// re-runs next-step and joins once the peer yields (or finishes into the pooled
// implement phase this peer can then join).
async function buildPhaseBusyStep(params: {
  root: string;
  artifactsDir: string;
  runId: string;
}): Promise<RemediationStep> {
  const { root, artifactsDir, runId } = params;
  const nextCommand = loaderCommand("next-step");
  return writeCurrentStep({
    stepKind: "phase_busy",
    status: "ready",
    runId,
    repoRoot: root,
    artifactsDir,
    prompt: `
# Remediation busy — another agent is advancing this run

Another agent/IDE is currently advancing this remediation's state machine (a
serial phase — plan, triage, or close). Nothing is wrong; this is the cooperative
multi-agent guard that stops two agents from running the same phase at once.

Wait a few seconds, then run:

\`${nextCommand}\`

Once the peer yields — or the run reaches the parallel implement phase — your
next-step joins in and takes on unclaimed work.
`,
    allowedCommands: [nextCommand],
    stopCondition:
      "Stop briefly, then re-run next-step to join the run once the peer yields the phase.",
  });
}

// --- Per-state handlers -----------------------------------------------------
// Each handler owns one branch of the original decideNextStepInner dispatch.
// Handlers that emit a step return RemediationStep directly; handlers that need
// the loop to continue with mutated state return { continueWithState }.

async function handleComplete(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  return presentReportStep(root, artifactsDir, state);
}

/**
 * The terminal friction-TRIAGE close-out for the remediate half. Thin delegation to
 * the single-sourced `decideFrictionTriage` (`audit-tools/shared`) — the exact analog
 * of audit-code's `decideAuditFrictionCloseout`, so the triage shape, disposition
 * vocabulary, blocking semantics, and close-out logic cannot drift between the two
 * halves. Drops the former false-green (an empty up-front record no longer satisfies):
 * the blocking triage stays unsatisfied ("dispose") until every captured mechanical
 * event AND every surfaced agent-feedback reflection carries a disposition; an empty
 * set (zero events AND zero reflections) is trivially "disposed". Keyed only off
 * `(artifactsDir, runId)`; never coupled to any repo's backlog doc.
 */
export async function decideRemediateFrictionCloseout(
  artifactsDir: string,
  state: RemediationState | null,
): Promise<FrictionTriageDecision> {
  return decideFrictionTriage(artifactsDir, stateRunId(state), "remediate-code");
}

async function handlePendingExtractedPlan(
  root: string,
  artifactsDir: string,
  existing: RemediationState,
  extractedPlan: unknown,
): Promise<RemediationState | null> {
  try {
    const { plan, sourceFindings, mergeMap } =
      normalizeExtractedPlan(extractedPlan);

    // Deterministic grounding for the LLM-extracted plan (this path never sees
    // structured audit findings): strip phantom affected_files paths, drop
    // findings whose every cited path was phantom, and classify evidence. No
    // bounded LLM repair here — the host re-extracts with the corrected prompt
    // if the whole plan grounds to nothing. Contract-pipeline-promoted plans
    // are grounded by construction (the traceability gate ties every node to
    // obligations/accepted counterexamples), so their obligation-reference
    // evidence is exempt from the path-citation check.
    const grounding = await groundExtractedFindings(plan.findings, {
      root,
      evidenceGrounding: plan.source !== "contract_pipeline",
    });
    if (grounding.dropped.length > 0) {
      process.stderr.write(
        `[remediate-code] Grounding dropped ${grounding.dropped.length} extracted finding(s) whose cited paths do not exist: ${grounding.dropped.map((d) => `${d.finding.id} (${d.phantomPaths.join(", ")})`).join("; ")}\n`,
      );
    }
    plan.findings = grounding.findings;
    const keptIds = new Set(plan.findings.map((f) => f.id));
    plan.blocks = plan.blocks
      .map((b) => ({ ...b, items: (b.items ?? []).filter((id) => keptIds.has(id)) }))
      .filter((b) => (b.items ?? []).length > 0);
    if (plan.findings.length === 0) {
      throw new Error(
        "Every extracted finding cited only phantom paths; re-extract with real repo-relative paths.",
      );
    }

    const pipelined = await applyPlanPipeline(plan, { root, artifactsDir });
    const reviewDecision = await readOptionalJsonFile<ReviewDecisionRecord>(
      reviewDecisionPath(artifactsDir),
    );
    // Coverage ledger. Path A (structured_audit): the single filter pass ran at
    // intake over the ORIGINAL findings and persisted its dispositions — build
    // coverage over those originals so every audit finding gets exactly one
    // disposition (planned / folded_into / dropped_* / dropped_by_checkpoint /
    // declined_by_review), reconciling to the original count. Path B (no persisted
    // dispositions): build over the post-pipeline node findings as before. Either
    // way declined findings are recorded; their payloads recover at close from the
    // unfiltered intake source.
    const filterDisp = await readOptionalJsonFile<PersistedReviewFilterDispositions>(
      reviewFilterDispositionsPath(artifactsDir),
    );
    const coverage = filterDisp
      ? buildCoverageLedger({
          planId: pipelined.plan_id,
          sourceFindings: filterDisp.originals,
          droppedNoEvidence: filterDisp.droppedNoEvidence,
          droppedByCheckpoint: filterDisp.droppedByCheckpoint,
          declinedByReview: reviewDecision?.declined ?? [],
          droppedPhantomPaths: new Map(filterDisp.droppedPhantomPaths),
          phantomPathsRemoved: new Map(filterDisp.phantomPathsRemoved),
          mergeMap: new Map(filterDisp.mergeMap),
          items: {}, // originals carry no node block_id; planned entries omit it
        })
      : buildCoverageLedger({
          planId: pipelined.plan_id,
          sourceFindings,
          droppedNoEvidence: [],
          droppedByCheckpoint: [],
          declinedByReview: reviewDecision?.declined ?? [],
          droppedPhantomPaths: new Map(
            grounding.dropped.map((d) => [d.finding.id, d.phantomPaths]),
          ),
          phantomPathsRemoved: grounding.phantomPathsByFinding,
          mergeMap,
          items: Object.fromEntries(
            pipelined.findings.map((finding) => [
              finding.id,
              {
                finding_id: finding.id,
                status: "pending" as const,
                block_id:
                  pipelined.blocks.find((b) => b.items.includes(finding.id))
                    ?.block_id ?? "UNKNOWN",
              },
            ]),
          ),
        });
    return await saveStateForPlan(artifactsDir, existing, pipelined, coverage);
  } catch (error) {
    const paths = intakePaths(artifactsDir);
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(paths.extractedPlan);
    } catch { /* already gone */ }
    process.stderr.write(
      `[remediate-code] Corrupted extracted-plan.json removed (${error instanceof Error ? error.message : String(error)}). Re-emitting extraction step.\n`,
    );
    return null;
  }
}

// ── Review-approval gate (go-forward program item 1) ───────────────────────────
//
// Between the audit findings and the contract pipeline, every ORIGINAL finding is
// presented to the user bucketed by review-necessity (src/review/reviewGate.ts).
// Approved findings seed the pipeline; disapproved findings are excluded from it
// AND recorded as a declined disposition (review_decision.json) — never silently
// swept to a terminal status inside a quality-tail node, the 2026-06-15 failure
// this gate exists to prevent.
//
// Fires only on Path A (structured_audit) — the only intake path with a
// pre-existing finding set; document/conversation runs derive findings inside the
// pipeline. File-driven and pre-state (no RemediationState exists at intake yet),
// mirroring the intake-clarification gate rather than waiting_for_clarification.

const REVIEW_DECISION_SCHEMA_VERSION = "remediate-code-review-decision/v1" as const;
/** Stable, informational plan id for the pre-plan review request/decision pair. */
const REVIEW_GATE_PLAN_ID = "path-a-review";

interface ReviewDecisionRecord {
  schema_version: typeof REVIEW_DECISION_SCHEMA_VERSION;
  plan_id: string;
  approved_ids: string[];
  declined: Array<{ finding_id: string; reason: string }>;
  created_at: string;
}

function reviewRequestPath(artifactsDir: string): string {
  return join(artifactsDir, "review_request.json");
}
function reviewResolutionPath(artifactsDir: string): string {
  return join(artifactsDir, "review_resolution.json");
}
function reviewDecisionPath(artifactsDir: string): string {
  return join(artifactsDir, "review_decision.json");
}

// Up-front ambiguity gate (note 3, part A) — its own request/resolution/decision
// files, mirroring the review gate so it fires (and halts) at most once per run.
function ambiguityRequestPath(artifactsDir: string): string {
  return join(artifactsDir, "ambiguity_request.json");
}
function ambiguityResolutionPath(artifactsDir: string): string {
  return join(artifactsDir, "ambiguity_resolution.json");
}
function ambiguityDecisionPath(artifactsDir: string): string {
  return join(artifactsDir, "ambiguity_decision.json");
}

/** Pull the Finding[] out of a parsed audit-findings.json payload. */
function extractAuditFindings(parsed: unknown): Finding[] {
  if (isRecord(parsed) && Array.isArray(parsed.findings)) {
    return (parsed.findings as unknown[]).filter(
      (f): f is Finding => isRecord(f) && typeof f.id === "string",
    );
  }
  return [];
}

async function handleWaitingForReviewApproval(
  root: string,
  artifactsDir: string,
  request: ReviewRequest,
): Promise<RemediationStep> {
  return writeCurrentStep({
    stepKind: "collect_review_approval",
    status: "blocked",
    runId: randomRunId("REVIEW"),
    repoRoot: root,
    artifactsDir,
    prompt: reviewApprovalPrompt(request, reviewResolutionPath(artifactsDir)),
    allowedCommands: [loaderCommand("next-step")],
    stopCondition:
      "Stop after presenting the findings for approval and collecting the user's approve/disapprove decision, unless the decision is already recorded and the prompt told you to continue.",
    artifactPaths: {
      review_request: reviewRequestPath(artifactsDir),
      review_resolution: reviewResolutionPath(artifactsDir),
    },
  });
}

interface ReviewGateProceed {
  kind: "proceed";
  /** Survivors approved to seed the pipeline (declined excluded). */
  approved: Finding[];
  /** Declined survivors with the recorded reason — for the coverage ledger + the durable record. */
  declined: Array<{ finding_id: string; reason: string }>;
}
interface ReviewGateHalt {
  kind: "halt";
  step: RemediationStep;
}

/**
 * Run the review-approval gate over the SURVIVOR finding set (already passed
 * through the single filter pass: deduped, evidence-bearing, path-grounded,
 * checkpoint-kept). Returns a halt step while awaiting the user's decision, or a
 * `proceed` splitting the survivors into approved (seed the pipeline) and declined
 * (recorded, never acted on).
 *
 * Idempotent across the many pipeline next-step calls: once review_decision.json
 * exists the gate consumes it directly and proceeds, so it fires (and halts) at
 * most once per run. Empty survivors → nothing to review → approve-none/proceed.
 */
async function runReviewApprovalGate(
  root: string,
  artifactsDir: string,
  survivors: Finding[],
  autonomous = false,
): Promise<ReviewGateProceed | ReviewGateHalt> {
  const decisionPath = reviewDecisionPath(artifactsDir);

  // First crossing only: no decision yet AND the pipeline has not started.
  const gateOpen =
    survivors.length > 0 &&
    !existsSync(decisionPath) &&
    !contractArtifactExists(artifactsDir, "goal_spec");

  // Autonomous (unattended) mode: the gate NEVER halts. It re-evaluates the
  // survivors FRESH (no prior-run memory) and auto-approves only tier-safe +
  // allowlisted-change-kind findings; everything else is left LIVE. Leftovers
  // are re-emitted as a re-consumable audit deliverable pair (NO durable
  // rejection — leftovers carry no declined disposition). Idempotent: once
  // review_decision.json exists it is consumed directly below.
  if (gateOpen && autonomous) {
    const auto = buildAutonomousReviewDecision(survivors);
    const approvedSet = new Set(auto.approved_ids);
    // Leftovers stay LIVE: declined is EMPTY (no durable rejection). The split
    // below excludes nothing, so every leftover remains a live finding.
    const record: ReviewDecisionRecord = {
      schema_version: REVIEW_DECISION_SCHEMA_VERSION,
      plan_id: REVIEW_GATE_PLAN_ID,
      approved_ids: auto.approved_ids,
      declined: [],
      created_at: new Date().toISOString(),
    };
    await writeJsonFile(decisionPath, record);
    // Re-emit the leftovers as a standard, re-consumable audit deliverable pair
    // so the next nightly run picks them up via defaultInputCandidates. Always
    // on disk regardless of whether a git remote / PR is available.
    const leftovers = survivors.filter((f) => !approvedSet.has(f.id));
    await emitAutonomousLeftoverDeliverable(root, artifactsDir, leftovers);
    return {
      kind: "proceed",
      approved: survivors.filter((f) => approvedSet.has(f.id)),
      declined: [],
    };
  }

  if (gateOpen) {
    const resolutionPath = reviewResolutionPath(artifactsDir);
    const requestPath = reviewRequestPath(artifactsDir);
    if (!existsSync(resolutionPath)) {
      // Halt: present the tiered survivors and wait for the user's decision.
      const request = buildReviewRequest(survivors, REVIEW_GATE_PLAN_ID);
      await writeJsonFile(requestPath, request);
      return {
        kind: "halt",
        step: await handleWaitingForReviewApproval(root, artifactsDir, request),
      };
    }
    // Consume the resolution into a durable, reasoned decision record.
    const request =
      (await readOptionalJsonFile<ReviewRequest>(requestPath)) ??
      buildReviewRequest(survivors, REVIEW_GATE_PLAN_ID);
    const resolution = await readOptionalJsonFile<ReviewResolution>(resolutionPath);
    const decision = applyReviewResolution(request, resolution);
    const record: ReviewDecisionRecord = {
      schema_version: REVIEW_DECISION_SCHEMA_VERSION,
      plan_id: REVIEW_GATE_PLAN_ID,
      approved_ids: decision.approved_ids,
      declined: decision.declined,
      created_at: new Date().toISOString(),
    };
    await writeJsonFile(decisionPath, record);
    // Archive the consumed inputs so the gate cannot re-halt.
    for (const p of [resolutionPath, requestPath]) {
      if (existsSync(p)) {
        await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
      }
    }
  }

  // Decision recorded (now or on a prior call): split the survivors.
  const decision = await readOptionalJsonFile<ReviewDecisionRecord>(decisionPath);
  const declined = decision?.declined ?? [];
  const declinedIds = new Set(declined.map((d) => d.finding_id));
  return {
    kind: "proceed",
    approved: survivors.filter((f) => !declinedIds.has(f.id)),
    declined,
  };
}

// ── T1 slice 3b — lean-path light adversarial review gate ───────────────────────
//
// Mirrors the review-approval gate's emit→resume→consume idiom, but the step is
// WORK (status "ready"), not a human decision — so it runs identically in
// attended and autonomous modes (the host agent executes the light pass like any
// phase). Fires (and at most once) only when the fast path is eligible.

function leanLightReviewVerdictPath(artifactsDir: string): string {
  return join(artifactsDir, "lean_light_review_verdict.json");
}
function leanLightReviewDecisionPath(artifactsDir: string): string {
  return join(artifactsDir, "lean_light_review_decision.json");
}

interface LeanLightReviewDecisionRecord {
  schema_version: typeof LEAN_LIGHT_REVIEW_SCHEMA_VERSION;
  disposition: LeanLightReviewDisposition;
  concerns: string[];
  created_at: string;
}

type LeanLightReviewOutcome =
  | { kind: "halt"; step: RemediationStep }
  | { kind: "clear" }
  | { kind: "escalate"; concerns: string[] };

/** Render the bounded light-adversarial-review prompt over the approved findings. */
function leanLightReviewPrompt(approved: Finding[], verdictPath: string): string {
  const findingLines = approved
    .map((f) => {
      const files = (f.affected_files ?? [])
        .map((loc) => loc?.path)
        .filter((p): p is string => Boolean(p))
        .join(", ");
      return `- \`${f.id}\` — ${f.title ?? "(untitled)"}${files ? ` (${files})` : ""}`;
    })
    .join("\n");
  const nextCommand = loaderCommand("next-step");
  return `# Lean fast path — light adversarial review

These findings cleared the simplicity gate and are headed for the lean fast path (straight to plan→implement, skipping the full contract pipeline). Before they are trusted, do ONE **lightweight adversarial pass** — the floor that replaces the full design loop here. This is proportionate, not an exhaustive counterexample search: remediation legitimately catches upstream audit errors, so nothing skips review entirely.

## Findings to review
${findingLines || "_(none)_"}

## Your task
Adopt a brief adversarial stance and ask, across the set:
- Is any finding actually wrong, already-fixed, or not grounded in the cited code?
- Would the proposed fix break a caller, an invariant, or an adjacent behavior?
- Are any two of these coupled / sharing a file in a way that needs seam reconciliation (i.e. NOT really independent)?
- Is anything subtler or more architectural than the simplicity gate assumed?

Write your verdict to exactly:

\`${verdictPath}\`

\`\`\`json
{
  "schema_version": "${LEAN_LIGHT_REVIEW_SCHEMA_VERSION}",
  "disposition": "clear | escalate",
  "concerns": ["<required & non-empty when escalate; the concrete concern(s)>"],
  "created_at": "<ISO-8601>"
}
\`\`\`

- **clear** — the light pass surfaced no real concern; the lean path may proceed.
- **escalate** — a genuine concern surfaced. This is evidence the change is harder than assessed; the run escalates to the full contract pipeline (full independent review). When in doubt, escalate — a wrong call costs extra pipeline work, never a skipped review.

After writing the verdict, run:

\`${nextCommand}\`
`;
}

/**
 * The lean light-review gate. Idempotent across next-step calls: once a decision
 * is recorded it is consumed directly. Returns a halt step while awaiting the
 * host's verdict, then `clear` (proceed to the lean plan) or `escalate` (route to
 * the full pipeline with the concerns).
 */
async function runLeanLightReviewGate(
  root: string,
  artifactsDir: string,
  approved: Finding[],
): Promise<LeanLightReviewOutcome> {
  const decisionPath = leanLightReviewDecisionPath(artifactsDir);
  const existing =
    await readOptionalJsonFile<LeanLightReviewDecisionRecord>(decisionPath);
  if (existing) {
    return existing.disposition === "clear"
      ? { kind: "clear" }
      : { kind: "escalate", concerns: existing.concerns ?? [] };
  }

  const verdictPath = leanLightReviewVerdictPath(artifactsDir);
  if (!existsSync(verdictPath)) {
    const step = await writeCurrentStep({
      stepKind: "lean_light_review",
      status: "ready",
      runId: randomRunId("LEANREVIEW"),
      repoRoot: root,
      artifactsDir,
      prompt: leanLightReviewPrompt(approved, verdictPath),
      allowedCommands: [loaderCommand("next-step")],
      stopCondition:
        "Stop after writing the lean light-review verdict and running next-step.",
      artifactPaths: { lean_light_review_verdict: verdictPath },
    });
    return { kind: "halt", step };
  }

  // Verdict present → interpret + record a durable decision, then archive the
  // consumed verdict so the gate can never re-emit.
  const raw = await readOptionalJsonFile<unknown>(verdictPath);
  const interp = interpretLeanLightReviewVerdict(raw);
  const record: LeanLightReviewDecisionRecord = {
    schema_version: LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
    disposition: interp.disposition,
    concerns: interp.concerns,
    created_at: new Date().toISOString(),
  };
  await writeJsonFile(decisionPath, record);
  if (existsSync(verdictPath)) {
    await withFsRetry(() =>
      rename(verdictPath, `${verdictPath}.consumed-${Date.now()}`),
    );
  }
  return interp.disposition === "clear"
    ? { kind: "clear" }
    : { kind: "escalate", concerns: interp.concerns };
}

/**
 * Re-emit the autonomous-run leftovers (findings left LIVE, neither auto-fixed
 * nor durably rejected) as a standard, re-consumable audit deliverable pair:
 * `audit-findings.json` (machine contract, source of truth) + `audit-report.md`
 * (human render), built by the SHARED emitter. Written to `<repo>/.audit-tools/`
 * — exactly where the remediator's `defaultInputCandidates` looks first — so the
 * next nightly run round-trips them straight back through intake and re-evaluates
 * the allowlist FRESH. Always on disk regardless of any git remote / PR.
 *
 * Empty leftovers still emit an (empty) pair so a downstream "is there work?"
 * probe sees a deterministic deliverable rather than a stale one.
 */
async function emitAutonomousLeftoverDeliverable(
  root: string,
  artifactsDir: string,
  leftovers: Finding[],
): Promise<void> {
  const pair = buildAuditDeliverablePair(leftovers, {
    title: "Audit Report — Autonomous Leftovers",
    intro:
      "Findings left LIVE by an unattended (autonomous) remediation run: not on the " +
      "fail-closed non-destructiveness allowlist (or not tier-safe), so not auto-fixed. " +
      "They carry NO declined disposition — re-run remediation to re-evaluate them.",
  });
  // Prefer the canonical `.audit-tools/` location (defaultInputCandidates[0]);
  // fall back to the artifacts dir's parent when artifactsDir is non-standard.
  const auditToolsDir = join(root, ".audit-tools");
  const outDir = existsSync(auditToolsDir) ? auditToolsDir : dirname(artifactsDir);
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeJsonFile(join(outDir, "audit-findings.json"), pair.findings_report),
    writeTextFile(join(outDir, "audit-report.md"), pair.report_markdown),
  ]);
}

// ── Path-A filter dispositions (persisted for the coverage ledger) ──────────────
// The single filter pass runs at intake over the ORIGINAL findings; its
// dispositions are persisted here so handlePendingExtractedPlan can build the
// coverage ledger over the originals (every audit finding → exactly one
// disposition), even though it runs after the pipeline has collapsed the approved
// survivors into DAG nodes. Maps are serialized as entry arrays for JSON.

const REVIEW_FILTER_DISPOSITIONS_FILENAME = "review_filter_dispositions.json";

interface PersistedReviewFilterDispositions {
  originals: Finding[];
  mergeMap: [string, string][];
  droppedNoEvidence: string[];
  droppedPhantomPaths: [string, string[]][];
  phantomPathsRemoved: [string, string[]][];
  droppedByCheckpoint: string[];
}

function reviewFilterDispositionsPath(artifactsDir: string): string {
  return join(artifactsDir, REVIEW_FILTER_DISPOSITIONS_FILENAME);
}

async function persistReviewFilterDispositions(
  artifactsDir: string,
  originals: Finding[],
  filter: FindingFilterResult,
): Promise<void> {
  const payload: PersistedReviewFilterDispositions = {
    originals,
    mergeMap: [...filter.mergeMap.entries()],
    droppedNoEvidence: filter.droppedNoEvidence,
    droppedPhantomPaths: [...filter.droppedPhantomPaths.entries()],
    phantomPathsRemoved: [...filter.phantomPathsRemoved.entries()],
    droppedByCheckpoint: filter.droppedByCheckpoint,
  };
  await writeJsonFile(reviewFilterDispositionsPath(artifactsDir), payload);
}

async function handleReadyIntakeContractPipeline(
  root: string,
  artifactsDir: string,
  options?: NextStepOptions,
): Promise<RemediationStep | RemediationState | null> {
  // Fast path: if an extracted-plan.json already exists (pipeline complete or
  // promoted from a previous contract pipeline run), consume it directly without
  // requiring intake artifacts. This handles both "plan promoted, ready to
  // ground+plan" and the grounding tests that write extracted-plan.json directly.
  const earlyExtractedPlan = await readExtractedPlanIfPresent(artifactsDir);
  if (earlyExtractedPlan) {
    return handlePendingExtractedPlan(
      root,
      artifactsDir,
      { status: "pending" },
      earlyExtractedPlan,
    );
  }

  const intake = await readIntakeArtifacts(artifactsDir);
  if (!intake.summary || !isIntakeReady(intake.summary)) {
    return null;
  }

  // Slice 2 — compute & persist the shared intake risk/complexity signal the
  // self-scaling dials (Slices 3/4) will read. Idempotent: recorded once from
  // intake-available data only (affected_files + goals + path-risk patterns), so
  // a later escalate-on-evidence raise is never clobbered. The input is gathered
  // lazily (only on the run that actually computes), and for structured_audit —
  // where the top-level summary.affected_files is legitimately empty (paths live
  // per-finding) — it unions the per-finding affected files so the path-risk
  // patterns actually fire (fail-closed: a risky-subsystem audit must not land
  // `low`). No behavior keys on it yet — this establishes the source of truth.
  await ensureIntakeRiskSignal(artifactsDir, async () => {
    const summary = intake.summary!;
    const affectedFiles = summary.affected_files.map((f) => f.path);
    if (summary.source_type === "structured_audit" && intake.manifest) {
      const auditSource = resolveManifestSources(root, intake.manifest).resolved.find(
        (s) => s.type === "structured_audit",
      );
      if (auditSource) {
        try {
          const parsed = JSON.parse(await readFile(auditSource.path, "utf8")) as unknown;
          affectedFiles.push(...distinctAffectedFiles(extractAuditFindings(parsed)));
        } catch {
          // Unreadable audit source — leave the summary-derived list; an empty
          // list with non-empty goals still rates conservatively via intent.
        }
      }
    }
    return { affectedFiles, goals: summary.goals };
  });

  const pipeline = shouldEnterContractPipeline(
    artifactsDir,
    intake.summary.source_type,
  );
  if (!pipeline.shouldHandleContractPipeline) {
    return null;
  }

  // Path A: run the single filter pass over the ORIGINAL findings, present the
  // SURVIVORS at the review gate (deduped / evidence-bearing / path-grounded /
  // checkpoint-kept, tiered by review-necessity), then seed the pipeline with the
  // approved survivors. The filter dispositions are persisted so the coverage
  // ledger is built over the originals (every audit finding → exactly one
  // disposition). The gate may halt to collect the user's decision.
  let reviewSourceSwap: { from: string; to: string } | undefined;
  if (intake.summary.source_type === "structured_audit" && intake.manifest) {
    const auditSource = resolveManifestSources(root, intake.manifest).resolved.find(
      (s) => s.type === "structured_audit",
    );
    if (auditSource) {
      let auditFindings: unknown;
      try {
        auditFindings = JSON.parse(await readFile(auditSource.path, "utf8")) as unknown;
      } catch {
        auditFindings = undefined;
      }
      const originals = extractAuditFindings(auditFindings);
      if (originals.length > 0) {
        const checkpoint = await readOptionalJsonFile<IntentCheckpoint>(
          join(artifactsDir, "intent_checkpoint.json"),
        );
        const filter = await runFindingFilterPass(originals, {
          root,
          checkpoint: checkpoint ?? undefined,
          evidenceGrounding: true,
        });
        const gate = await runReviewApprovalGate(
          root,
          artifactsDir,
          filter.survivors,
          resolveAutonomousMode(options ?? {}),
        );
        if (gate.kind === "halt") {
          return gate.step;
        }
        // Persist the filter dispositions so coverage is built over the originals.
        await persistReviewFilterDispositions(artifactsDir, originals, filter);

        // A1 — conservative lean fast path. When the approved set is a handful
        // of grounded, high-confidence, localized, non-cross-cutting findings,
        // the run skips the heavy contract DESIGN loop and synthesizes the
        // extracted plan directly; the plan→implement→close machinery (per-node
        // verify-before-merge + the final whole-repo gate) is the retained safety
        // net. Runs only here — on Path A (structured_audit), the only intake
        // with a pre-existing finding set to judge.
        //
        // T1 slice 3b — the fast path is NOT zero-scrutiny: an eligible run first
        // runs a bounded LIGHT adversarial review over the approved findings (the
        // floor, never off). A clear verdict proceeds to the lean plan; a verdict
        // that surfaces a real concern escalates the risk signal (evidence the
        // work is harder than assessed) and routes to the full pipeline below.
        const fast = evaluateFastPath(gate.approved);
        if (fast.eligible) {
          const review = await runLeanLightReviewGate(
            root,
            artifactsDir,
            gate.approved,
          );
          if (review.kind === "halt") {
            return review.step;
          }
          if (review.kind === "escalate") {
            // Escalate-on-evidence: raise the signal to at least `medium` so the
            // full pipeline's adversarial depth is `full` (see slice 3a), then
            // fall through to the full pipeline.
            const current = await readIntakeRiskSignal(artifactsDir);
            if (current) {
              await writeIntakeRiskSignal(
                artifactsDir,
                escalateRiskSignal(current, {
                  tier: "medium",
                  reason: `lean light review surfaced a concern: ${review.concerns.join("; ")}`,
                }),
              );
            }
            process.stderr.write(
              `[remediate-code] Lean light review escalated (${review.concerns.join("; ")}); routing to the full contract pipeline.\n`,
            );
          } else {
            // Clear verdict → proceed with the lean plan.
            const leanPlan = buildLeanExtractedPlan(
              gate.approved,
              randomRunId("LEAN"),
            );
            await writeJsonFile(
              intakePaths(artifactsDir).extractedPlan,
              leanPlan,
            );
            process.stderr.write(
              `[remediate-code] Lean fast path: ${fast.reason}; light review clear. Routing to plan→implement.\n`,
            );
            const planned = await handlePendingExtractedPlan(
              root,
              artifactsDir,
              { status: "pending" },
              leanPlan,
            );
            if (planned) {
              return planned;
            }
            // Defensive: a deterministically-built lean plan should always
            // normalize. If it somehow didn't, handlePendingExtractedPlan removed
            // the file; fall through to the full pipeline (the safety net) rather
            // than stalling the run.
            process.stderr.write(
              "[remediate-code] Lean fast-path plan failed to materialize; falling back to the contract pipeline.\n",
            );
          }
        }

        // Seed the pipeline with the approved survivors only. When that set is
        // narrower than the originals (anything filtered or declined), route the
        // seed AND the pipeline's source inputs at a filtered file so a removed
        // finding can never re-enter via the raw audit-findings.json (tool-enforced).
        const approvedPayload = isRecord(auditFindings)
          ? { ...auditFindings, findings: gate.approved }
          : { findings: gate.approved };
        let seedSourcePath = auditSource.path;
        if (gate.approved.length < originals.length) {
          await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
          seedSourcePath = join(contractPipelineDir(artifactsDir), "approved-findings.json");
          await writeJsonFile(seedSourcePath, approvedPayload);
          reviewSourceSwap = { from: auditSource.path, to: seedSourcePath };
        }
        try {
          await writePathASeedFromFindings(artifactsDir, seedSourcePath, approvedPayload);
        } catch {
          // If the seed cannot be written, the pipeline still runs; the LLM
          // phases use the source files from sourcePaths.
        }
      }
    }
  }

  const paths = intakePaths(artifactsDir);
  const sourcePaths = new Set<string>();
  if (existsSync(paths.brief)) {
    sourcePaths.add(paths.brief);
  }
  if (intake.manifest) {
    for (const source of resolveManifestSources(root, intake.manifest).resolved) {
      // Swap the raw audit-findings.json for the approved-only filtered file so a
      // declined finding can never re-enter the pipeline as a source input.
      sourcePaths.add(
        reviewSourceSwap && source.path === reviewSourceSwap.from
          ? reviewSourceSwap.to
          : source.path,
      );
    }
  }

  // Resolve the independent-critic dispatch capability from the SAME handshake
  // (`resolveHostDispatchCapability`) implement dispatch uses — never a manual
  // flag. Threaded into the contract pipeline so the adversarial 'critique' /
  // 'critic' prompts MANDATE an independent sub-agent reviewer when the host can
  // dispatch one (fail-safe: mandate by default).
  const sessionConfigForDispatch =
    options?.sessionConfig ??
    (await readOptionalJsonFile<SessionConfig>(
      join(root, ".remediation-artifacts", "session-config.json"),
    )) ??
    (await readOptionalJsonFile<SessionConfig>(
      join(root, "session-config.json"),
    ));
  const hostCanDispatchSubagents = resolveHostDispatchCapability({
    hostCanDispatchSubagents: options?.hostCanDispatchSubagents,
    sessionConfig: sessionConfigForDispatch,
  });

  const step = await buildNextContractPipelineStep({
    root,
    artifactsDir,
    runId: randomRunId("CONTRACT"),
    sourcePaths: [...sourcePaths],
    sessionConfig: sessionConfigForDispatch,
    hostCanDispatchSubagents,
  });
  if (step) {
    return step;
  }

  const extractedPlan = await readExtractedPlanIfPresent(artifactsDir);
  if (!extractedPlan) {
    return null;
  }
  return handlePendingExtractedPlan(
    root,
    artifactsDir,
    { status: "pending" },
    extractedPlan,
  );
}

async function handlePendingIntake(
  root: string,
  artifactsDir: string,
  options: NextStepOptions,
): Promise<RemediationStep | RemediationState | null> {
  // Short-circuit: if an extracted-plan.json already exists (promoted from the
  // contract pipeline), consume it directly without requiring intake artifacts.
  // This allows decideNextStep to resume a plan-grounding pass even when the
  // full intake artifact set is no longer present.
  const earlyExtractedPlan = await readExtractedPlanIfPresent(artifactsDir);
  if (earlyExtractedPlan) {
    return handleReadyIntakeContractPipeline(root, artifactsDir, options);
  }

  const inputResolution = resolveInputPaths(root, options.input);
  const intakeResult = await resolveIntakeStep({
    root,
    artifactsDir,
    input: options.input,
    inputResolution,
    loaderCommand,
    randomRunId,
    collectStartingPointPrompt,
    synthesizeIntakePrompt,
    collectIntakeClarificationsPrompt,
  });
  if (intakeResult.kind === "step") {
    return intakeResult.step;
  }
  // Intake is complete — route both paths through the contract pipeline.
  return handleReadyIntakeContractPipeline(root, artifactsDir, options);
}

async function handleNoState(
  root: string,
  artifactsDir: string,
): Promise<RemediationStep> {
  const paths = intakePaths(artifactsDir);
  return writeCurrentStep({
    stepKind: "collect_starting_point",
    status: "blocked",
    runId: randomRunId("INPUT"),
    repoRoot: root,
    artifactsDir,
    prompt: collectStartingPointPrompt(
      root,
      defaultInputCandidates(root),
      [],
      paths,
    ),
    allowedCommands: [loaderCommand("next-step"), loaderCommand("next-step --input <path>")],
    stopCondition:
      "Stop after collecting a remediation starting point and rerunning next-step.",
    artifactPaths: {
      source_manifest: paths.sourceManifest,
      conversation_start: paths.conversationStart,
    },
  });
}

async function handleInputConflict(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  inputResolution: InputResolution,
): Promise<RemediationStep> {
  const planId = state.plan?.plan_id ?? "(none)";
  const itemCount = state.items ? Object.keys(state.items).length : 0;
  const suppliedInline =
    inputResolution.checked.length > 0
      ? inputResolution.checked.map((p) => `\`${p}\``).join(", ")
      : "(new intake source via `--guidance-file`)";
  return writeCurrentStep({
    stepKind: "input_conflict",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# New intake source given, but a remediation run is already in progress

A remediation run already exists in \`${artifactsDir}\` and has advanced past intake,
so the new intake source you passed (\`--input\` or \`--guidance-file\`) will **not**
replace it — it would be ignored and the existing plan resumed and executed.

- **Current state**: \`${state.status}\`
- **Plan**: \`${planId}\` (${itemCount} item(s))
- **Supplied input**: ${suppliedInline}

Choose one explicitly and report the choice to the user:

1. **Resume the existing run** — re-run WITHOUT any \`--input\`/\`--guidance-file\`: \`${loaderCommand("next-step")}\`
2. **Start fresh from the new source** — first move aside or delete the existing
   \`${artifactsDir}\` directory (and the stale \`remediation-report.md\` /
   \`remediation-outcomes.json\` in \`.audit-tools/\`, which would otherwise be overwritten on completion),
   then re-run with your new source (\`${loaderCommand("next-step --input <path>")}\` or \`--guidance-file <path>\`).

Stop after presenting this choice. Do not advance the run until the user decides.
`,
    allowedCommands: [
      loaderCommand("next-step"),
      loaderCommand("next-step --input <path>"),
    ],
    stopCondition:
      "Stop after presenting the resume-vs-restart choice to the user.",
    artifactPaths: {
      state_file: join(artifactsDir, "state.json"),
    },
  });
}

// Action tokens are deliberately unambiguous so a host CANNOT lose an
// approved finding by a natural word choice at the ambiguity gate: "this
// candidate ambiguity isn't genuine" reads as a comment on the AMBIGUITY, so it
// must map to `clarified` (proceed with the finding), never to a drop. The
// finding-dropping token is named `reject_finding` — it speaks about the
// FINDING, not the ambiguity, and so can't be confused with "no ambiguity here."
type PlanClarificationAction = "clarified" | "reject_finding" | "defer";

const PLAN_CLARIFICATION_ACTIONS: readonly PlanClarificationAction[] = [
  "clarified",
  "reject_finding",
  "defer",
];

function isPlanClarificationAction(value: unknown): value is PlanClarificationAction {
  return (
    typeof value === "string" &&
    (PLAN_CLARIFICATION_ACTIONS as readonly string[]).includes(value)
  );
}

interface PlanClarificationResolution {
  finding_id: string;
  action: PlanClarificationAction;
  rationale?: string;
}

function normalizePlanClarificationResolutions(value: unknown): PlanClarificationResolution[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord).flatMap((entry) => {
      if (typeof entry.finding_id === "string" && isPlanClarificationAction(entry.action)) {
        return [
          {
            finding_id: entry.finding_id,
            action: entry.action,
            rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
          },
        ];
      }
      return [];
    });
  }
  if (!isRecord(value)) return [];
  if (Array.isArray((value as Record<string, unknown>).resolutions)) {
    return normalizePlanClarificationResolutions((value as Record<string, unknown>).resolutions);
  }
  if (Array.isArray((value as Record<string, unknown>).items)) {
    return normalizePlanClarificationResolutions((value as Record<string, unknown>).items);
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([findingId, entry]) => {
    if (!isRecord(entry)) return [];
    if (!isPlanClarificationAction(entry.action)) return [];
    return [{
      finding_id: typeof entry.finding_id === "string" ? entry.finding_id : findingId,
      action: entry.action,
      rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
    }];
  });
}

/**
 * Apply one clarification resolution to its item. Single-sourced so the up-front
 * ambiguity gate (part A) and the mid-run clarification round (part B) settle an
 * item identically: `clarified` re-opens it (pending) with the answer as context,
 * `reject_finding` closes it as not-a-real-issue (terminal `deemed_inappropriate`
 * disposition), and `defer` closes it as an explicit user deferral for this run.
 * Never resurrects a terminal item.
 */
function applyClarificationActionToItem(
  item: RemediationItemState,
  res: PlanClarificationResolution,
  now: string,
): void {
  if (res.action === "reject_finding") {
    item.status = "deemed_inappropriate";
    item.failure_reason = res.rationale;
    item.started_at ??= now;
    item.completed_at = now;
  } else if (res.action === "defer") {
    item.status = "ignored";
    item.failure_reason = res.rationale
      ? `User-deferred for this run: ${res.rationale}`
      : "User-deferred for this run.";
    item.started_at ??= now;
    item.completed_at = now;
  } else {
    item.status = "pending";
    item.clarification_context = res.rationale;
  }
}

/**
 * Consume clarification_resolution.json for plan-phase clarifications.
 * Mirrors the triage resolution consume: reject_finding → terminal,
 * clarified → re-open (pending) for implement dispatch. Archives the file.
 */
async function applyPlanClarificationResolution(
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
): Promise<RemediationState> {
  if (!state.plan || !state.items) return state;
  const resolutionPath = join(artifactsDir, "clarification_resolution.json");
  const resolutions = normalizePlanClarificationResolutions(
    await readOptionalJsonFile<unknown>(resolutionPath),
  );
  const now = new Date().toISOString();
  for (const res of resolutions) {
    const item = state.items[res.finding_id];
    if (!item || isTerminalStatus(item.status)) continue;
    applyClarificationActionToItem(item, res, now);
  }
  if (existsSync(resolutionPath)) {
    await withFsRetry(() => rename(resolutionPath, `${resolutionPath}.consumed-${Date.now()}`));
  }
  const remainingPending = state.plan.findings.some(
    (f) => state.items?.[f.id]?.status === "pending",
  );
  state.status = remainingPending ? "implementing" : "closing";
  state.clarifications = [];
  state.closing_plan ??= { action: "none" };
  await store.saveState(state);
  return state;
}

async function handleWaitingForClarification(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
  const clarifications =
    state.clarifications ??
    (await readOptionalJsonFile<ClarificationRequest[]>(
      join(artifactsDir, "clarification_request.json"),
    )) ??
    [];
  const resolutionPath = join(artifactsDir, "clarification_resolution.json");
  return writeCurrentStep({
    stepKind: "collect_clarifications",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: clarificationPrompt(clarifications, resolutionPath),
    allowedCommands: [loaderCommand("next-step")],
    stopCondition:
      "Stop after asking the user for clarification answers, unless the answers are already available and the prompt told you to continue.",
    artifactPaths: {
      clarification_request: join(artifactsDir, "clarification_request.json"),
      clarification_resolution: resolutionPath,
    },
  });
}

async function handleWaitingForTriage(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
  const resolutionPath = join(artifactsDir, "triage_resolution.json");
  return writeCurrentStep({
    stepKind: "collect_triage",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: triagePrompt(state, resolutionPath),
    allowedCommands: [loaderCommand("next-step")],
    stopCondition:
      "Stop after asking the user for triage decisions, unless the decisions are already available and the prompt told you to continue.",
    artifactPaths: {
      triage_batch: join(artifactsDir, "triage_batch.json"),
      triage_resolution: resolutionPath,
    },
  });
}

/** Stable, informational plan id for the Path-B (planning-point) review pair. */
const REVIEW_GATE_PLAN_ID_PATH_B = "path-b-review";

/**
 * Path-B (document / conversation) review-necessity gate, fired at the PLANNING
 * point over the deduped/grounded node findings. Path A records its review
 * decision at intake over the ORIGINAL findings — before the contract pipeline
 * collapses them into DAG nodes (`runReviewApprovalGate`). Path B has no
 * pre-pipeline finding set (its findings are DERIVED inside the pipeline), so it
 * is gated here instead. The decision is applied to the existing plan state:
 * declined nodes become a RECORDED terminal disposition (`ignored`) rather than
 * being silently bulk-dispositioned inside a quality-tail node — the 2026-06-15
 * failure this gate exists to prevent.
 *
 * The caller fires this only when `review_decision.json` is ABSENT, so Path A
 * (decision already written at intake) never reaches it — no double review.
 * Returns a halt step while awaiting the user's decision, or null to proceed
 * (decision recorded, any declined nodes marked terminal).
 */
async function runPlanningReviewGate(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
): Promise<RemediationStep | null> {
  const findings = state.plan?.findings ?? [];
  if (findings.length === 0) return null;

  const requestPath = reviewRequestPath(artifactsDir);
  const resolutionPath = reviewResolutionPath(artifactsDir);
  const decisionPath = reviewDecisionPath(artifactsDir);

  if (!existsSync(resolutionPath)) {
    // Halt: present the tiered node findings and wait for the user's decision.
    const request = buildReviewRequest(findings, REVIEW_GATE_PLAN_ID_PATH_B);
    await writeJsonFile(requestPath, request);
    return handleWaitingForReviewApproval(root, artifactsDir, request);
  }

  // Resolution present: consume it into a durable, reasoned decision record.
  const request =
    (await readOptionalJsonFile<ReviewRequest>(requestPath)) ??
    buildReviewRequest(findings, REVIEW_GATE_PLAN_ID_PATH_B);
  const resolution = await readOptionalJsonFile<ReviewResolution>(resolutionPath);
  const decision = applyReviewResolution(request, resolution);
  const record: ReviewDecisionRecord = {
    schema_version: REVIEW_DECISION_SCHEMA_VERSION,
    plan_id: REVIEW_GATE_PLAN_ID_PATH_B,
    approved_ids: decision.approved_ids,
    declined: decision.declined,
    created_at: new Date().toISOString(),
  };
  await writeJsonFile(decisionPath, record);
  // Archive the consumed inputs so the gate cannot re-halt.
  for (const p of [resolutionPath, requestPath]) {
    if (existsSync(p)) {
      await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
    }
  }

  // Declined nodes → recorded terminal disposition (never a silent close).
  let changed = false;
  for (const { finding_id, reason } of decision.declined) {
    const it = state.items?.[finding_id];
    if (it && !isTerminalStatus(it.status)) {
      const now = new Date().toISOString();
      it.status = "ignored";
      it.failure_reason = reason;
      it.started_at ??= now;
      it.completed_at = now;
      changed = true;
    }
  }
  if (changed) await store.saveState(state);
  return null;
}

/**
 * Deterministic first pass (note 3, part A): scan the plan's non-terminal
 * findings for scoping/judgment ambiguity, classified into the canonical
 * clarification categories. These are CANDIDATES — the host reviews them against
 * the repo, dismisses false positives, and adds any it finds, before batching one
 * user round. Conservative by design: a candidate the host dismisses costs one
 * read; a real scoping question that falls silently to mid-run triage is the bug
 * this gate exists to prevent.
 */
function detectPlanAmbiguities(
  findings: Finding[],
  items: Record<string, RemediationItemState> | undefined,
): ClarificationRequest[] {
  const out: ClarificationRequest[] = [];
  for (const f of findings) {
    const item = items?.[f.id];
    if (item && isTerminalStatus(item.status)) continue;
    const lens = (f.lens ?? "").toLowerCase();
    const fileCount = f.affected_files?.length ?? 0;
    const broadScope =
      (lens === "architecture" || lens === "maintainability") &&
      (fileCount === 0 || fileCount >= 5);
    if (broadScope) {
      out.push({
        finding_id: f.id,
        category: "scope_of_fix",
        description:
          `"${f.title}" is a ${lens} finding with ${fileCount === 0 ? "no cited files" : `${fileCount} affected files`}; ` +
          "confirm how far the fix should reach (minimal local change vs. broader restructuring).",
      });
      continue;
    }
    if (f.confidence === "low") {
      out.push({
        finding_id: f.id,
        category: "issue_appropriateness",
        description:
          `"${f.title}" is a low-confidence finding; confirm it is a real issue worth fixing in this run.`,
      });
    }
  }
  return out;
}

/**
 * Up-front ambiguity gate (note 3, part A). Mirrors {@link runPlanningReviewGate}:
 * it fires once at planning, BEFORE any implement dispatch, so scoping/judgment
 * ambiguity is asked as a single batched question up front rather than falling
 * silently to triage mid-run. Deterministic heuristics seed CANDIDATES; the host
 * reviews them with repo access, dismisses/adds, and batches one user round. Each
 * item is resolved as `clarified` (answered → re-opened), `deemed_inappropriate`
 * (not a real issue), or `defer` (the user's explicit choice to skip this run).
 *
 * Idempotent: once `ambiguity_decision.json` exists the gate is done and never
 * re-halts. An empty resolution proceeds (the host found nothing to ask).
 */
async function runPlanAmbiguityGate(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
): Promise<RemediationStep | null> {
  const findings = state.plan?.findings ?? [];
  if (findings.length === 0) return null;

  const requestPath = ambiguityRequestPath(artifactsDir);
  const resolutionPath = ambiguityResolutionPath(artifactsDir);
  const decisionPath = ambiguityDecisionPath(artifactsDir);

  if (!existsSync(resolutionPath)) {
    // Deterministic detection is the gate trigger: with zero candidates there is
    // nothing for the host to review, so the plan proceeds without a round. Any
    // ambiguity the heuristics miss is still caught by the mid-run escape hatch
    // (part B). When candidates exist, halt for the host's review + the user's
    // batched answers.
    const candidates = detectPlanAmbiguities(findings, state.items);
    if (candidates.length === 0) return null;
    await writeJsonFile(requestPath, candidates);
    return writeCurrentStep({
      stepKind: "collect_clarifications",
      status: "blocked",
      runId: stateRunId(state),
      repoRoot: root,
      artifactsDir,
      prompt: ambiguityReviewPrompt(candidates, resolutionPath),
      allowedCommands: [loaderCommand("next-step")],
      stopCondition:
        "Stop after reviewing the candidate ambiguities (and asking the user any genuine ones), unless the resolution is already written and the prompt told you to continue.",
      artifactPaths: {
        ambiguity_request: requestPath,
        ambiguity_resolution: resolutionPath,
      },
    });
  }

  // Resolution present: apply it to items, mark the gate done, archive inputs so
  // it cannot re-halt.
  const resolutions = normalizePlanClarificationResolutions(
    await readOptionalJsonFile<unknown>(resolutionPath),
  );
  const now = new Date().toISOString();
  let changed = false;
  for (const res of resolutions) {
    const item = state.items?.[res.finding_id];
    if (!item || isTerminalStatus(item.status)) continue;
    applyClarificationActionToItem(item, res, now);
    changed = true;
  }
  await writeJsonFile(decisionPath, { resolved_at: now, resolution_count: resolutions.length });
  for (const p of [resolutionPath, requestPath]) {
    if (existsSync(p)) {
      await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
    }
  }
  if (changed) await store.saveState(state);
  return null;
}

async function handlePlanning(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
): Promise<RemediateOutcome> {
  // Review-necessity gate (Path B). Path A records its review decision at intake,
  // over the ORIGINAL findings, before the contract pipeline collapses them into
  // DAG nodes; Path B (document / conversation) derives findings INSIDE the
  // pipeline, so it is gated here, at the planning point, over the deduped/
  // grounded node findings. Fires only when no decision exists yet, so Path A
  // (decision already written) never double-reviews. Declined nodes get a
  // recorded terminal disposition.
  if (state.plan && !existsSync(reviewDecisionPath(artifactsDir))) {
    const halt = await runPlanningReviewGate(root, artifactsDir, state, store);
    if (halt) return { kind: "emit", step: halt };
  }

  // Up-front ambiguity gate (note 3, part A): resolve every scoping/judgment
  // ambiguity in ONE batched round here, before any implement dispatch, so a
  // question never falls silently to mid-run triage. Fires at most once per run.
  if (state.plan && !existsSync(ambiguityDecisionPath(artifactsDir))) {
    const halt = await runPlanAmbiguityGate(root, artifactsDir, state, store);
    if (halt) return { kind: "emit", step: halt };
  }

  // Document phase dissolved: planning transitions directly to implementing.
  // The rolling implement dispatch reads item_spec from the plan DAG node when
  // present, or uses finding context directly when absent.
  const implementBlocks = implementableBlocks(state);
  if (implementBlocks.length > 0) {
    if (state.plan) {
      const integrity = await checkAffectedFileIntegrity(root, state.plan.findings);
      if (!integrity.is_clean) {
        const details = [
          ...integrity.changed.map((p) => `changed: ${p}`),
          ...integrity.missing.map((p) => `missing: ${p}`),
          ...integrity.io_errors.map((p) => `io-error: ${p}`),
        ];
        const replanCommand = loaderCommand("next-step --force-replan");
        return { kind: "emit", step: await writeCurrentStep({
          stepKind: "collect_starting_point",
          status: "blocked",
          runId: stateRunId(state),
          repoRoot: root,
          artifactsDir,
          prompt: [
            "## File integrity check failed",
            "",
            "The following files have changed since the remediation plan was created:",
            ...details.map((d) => `- ${d}`),
            "",
            "Re-run planning to pick up the current file state before implementation begins.",
            "Run:",
            "",
            `\`${replanCommand}\``,
          ].join("\n"),
          allowedCommands: [replanCommand],
          stopCondition: "Stop after re-planning completes.",
        }) };
      }
    }
  }

  // Transition directly to implementing — no separate document round.
  // Any pending item whose node is NOT eligible for any rolling dispatch pass is
  // dead-ended (INV-RS-01): a prerequisite was skipped/blocked, so its
  // verified-complete edge can never be satisfied — never dispatch a dependent
  // against an upstream surface that did not land. Mark it blocked so the run
  // advances to close rather than looping forever. A node that is merely
  // waiting on a still-running prerequisite is NOT here (it would appear in a
  // later eligible pass); only nodes with a permanently-unsatisfiable edge are.
  if (implementBlocks.length === 0) {
    for (const block of blockedByUnsatisfiedDependency(state)) {
      for (const findingId of block.items) {
        const it = state.items?.[findingId];
        if (!it || it.status !== "pending") continue;
        it.status = "blocked";
        it.failure_reason =
          it.failure_reason ??
          "A dependency node did not reach a verified-complete disposition " +
          "(a prerequisite was skipped, blocked, or the dependencies are cyclic); " +
          "the rolling scheduler will not dispatch this node against an upstream " +
          "surface that never landed (INV-RS-01).";
      }
    }
  }

  state.status = "implementing";
  await store.saveState(state);
  return { kind: "transition", state };
}

async function handleImplementing(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  runLogger: RunLogger,
  store: StateStore,
): Promise<RemediateOutcome> {
  const triageStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "triage" });
  const triaged = await runTriagePhase(state, { root, artifactsDir });
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "triage", duration_ms: Date.now() - triageStart });
  await store.saveState(triaged);
  return { kind: "transition", state: triaged };
}

function hasResolvedItems(state: RemediationState): boolean {
  return Object.values(state.items ?? {}).some((it) =>
    isVerifiedCompleteStatus(it.status),
  );
}

/**
 * The tool-owned final gate (INV-RS-10) is disabled for this run — explicitly via
 * `skipFinalGate` (test hermeticity) or `REMEDIATE_SKIP_FINAL_GATE`. Single-sourced
 * so the all-terminal gate and the per-phase boundary gate agree.
 */
function finalGateDisabled(options: NextStepOptions): boolean {
  return (
    options.skipFinalGate === true ||
    process.env.REMEDIATE_SKIP_FINAL_GATE === "1" ||
    process.env.REMEDIATE_SKIP_FINAL_GATE === "true"
  );
}

/**
 * Whole-repo test-suite gate at a foundations→consumers PHASE BOUNDARY (T3). Runs
 * the tool-owned final gate (INV-RS-10) INLINE before the next phase dispatches,
 * so an integration break introduced by a just-completed foundations phase is
 * caught — and attributed to that phase — before consumers are built on top of it
 * (strictly earlier + more attributable than the all-terminal gate, whose red is
 * unattributable across every phase). Reuses the all-terminal gate's coarse
 * re-block + bounded auto-terminate machinery (INV-RS-09 / CE-003) and its shared
 * sidecar so a no-human host converges deterministically.
 *
 * Returns a re-block / terminate transition when the gate is RED, or null when no
 * gate is due this pass OR the gate is GREEN — in which case the caller proceeds
 * to dispatch the phase.
 */
async function runPhaseBoundaryGate(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  options: NextStepOptions;
  store: StateStore;
  runLogger: RunLogger;
}): Promise<RemediateOutcome | null> {
  const { root, artifactsDir, state, options, store, runLogger } = ctx;
  if (finalGateDisabled(options)) return null;
  const phase = phaseBoundaryToGate(state);
  if (phase == null) return null;

  const sidecar = await readFinalGateSidecar(artifactsDir);
  if (sidecar.terminated) return null; // bounded backstop already converged

  const gateStart = Date.now();
  runLogger.event({
    phase: "next-step",
    kind: "executor_start",
    obligation: state.status,
    note: `phase_boundary_gate phase=${phase}`,
  });
  const gate = await runToolOwnedFinalGate(root, { runner: options.finalGateRunner });
  runLogger.event({
    phase: "next-step",
    kind: "executor_end",
    obligation: state.status,
    note: `phase_boundary_gate phase=${phase} passed=${gate.passed}`,
    duration_ms: Date.now() - gateStart,
  });
  if (gate.passed) return null; // green → dispatch this phase

  // RED at the boundary: the just-completed lower phases broke the whole-repo
  // suite. Coarse re-block (INV-RS-09) + bounded auto-terminate (CE-003), exactly
  // as the all-terminal gate — never the human triage prompt.
  const failedCmd = gate.results.find((r) => !r.passed);
  const summary = failedCmd
    ? `Phase ${phase} boundary gate — failing command: ${failedCmd.argv.join(" ")} (exit ${failedCmd.exit_code}).`
    : `Phase ${phase} boundary gate failed.`;
  const decision = applyCoarseReblock(state, sidecar.count, summary);
  await writeFinalGateSidecar(
    artifactsDir,
    decision.next_count,
    decision.action === "terminal_blocked",
  );
  runLogger.event({
    phase: "next-step",
    kind: "outcome",
    obligation: state.status,
    note: `phase_boundary_coarse_reblock phase=${phase} action=${decision.action} count=${decision.next_count}`,
  });
  decision.state.status =
    decision.action === "reattempt_all" ? "implementing" : "closing";
  await store.saveState(decision.state);
  return { kind: "transition", state: decision.state };
}

async function handleAllTerminalTransition(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediateOutcome> {
  const gateDisabled = finalGateDisabled(options);

  const sidecar = await readFinalGateSidecar(artifactsDir);

  // The tool-owned final gate (INV-RS-10) runs at the single all-terminal →
  // closing funnel, exactly once per arrival here. It is skipped when:
  //  - there is nothing resolved to validate (everything blocked/skipped), or
  //  - the bounded backstop already terminated (CE-003 — never re-run after), or
  //  - it is explicitly disabled for test hermeticity.
  // The gate is INDEPENDENT of plan.test_command and runs through the
  // env-scrubbing runTracked path.
  if (!gateDisabled && !sidecar.terminated && hasResolvedItems(state)) {
    const gateStart = Date.now();
    runLogger.event({
      phase: "next-step",
      kind: "executor_start",
      obligation: state.status,
      note: "tool_owned_final_gate",
    });
    const gate = await runToolOwnedFinalGate(root, { runner: options.finalGateRunner });
    runLogger.event({
      phase: "next-step",
      kind: "executor_end",
      obligation: state.status,
      note: `tool_owned_final_gate passed=${gate.passed}`,
      duration_ms: Date.now() - gateStart,
    });

    if (!gate.passed) {
      // INV-RS-09: a whole-repo gate red is unattributable → coarse re-block.
      // CE-003: bounded, monotonic auto-terminate to terminal `blocked`.
      const failedCmd = gate.results.find((r) => !r.passed);
      const summary = failedCmd
        ? `Failing command: ${failedCmd.argv.join(" ")} (exit ${failedCmd.exit_code}).`
        : "Tool-owned final gate failed.";
      const decision = applyCoarseReblock(state, sidecar.count, summary);
      await writeFinalGateSidecar(
        artifactsDir,
        decision.next_count,
        decision.action === "terminal_blocked",
      );
      runLogger.event({
        phase: "next-step",
        kind: "outcome",
        obligation: state.status,
        note: `coarse_reblock action=${decision.action} count=${decision.next_count}`,
      });
      // reattempt_all → re-open items to pending and re-run the rolling scheduler
      // (NEVER the human triage prompt — CE-003 no-human-host path); terminal_blocked
      // → everything non-skip is now blocked, so close writes the partial report.
      decision.state.status =
        decision.action === "reattempt_all" ? "implementing" : "closing";
      await store.saveState(decision.state);
      return { kind: "transition", state: decision.state };
    }
  }

  state.status = "closing";
  await store.saveState(state);
  return { kind: "transition", state };
}

async function handleClosing(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  runLogger: RunLogger,
  store: StateStore,
): Promise<RemediateOutcome> {
  const closeStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "close" });
  const closed = await runClosePhase(state, { root, artifactsDir }, runLogger);
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "close", duration_ms: Date.now() - closeStart });
  if (closed.status !== "complete") {
    // Not done (preview / re-blocked to triage): persist and re-scan.
    await store.saveState(closed);
    return { kind: "transition", state: closed };
  }
  // Close-complete CROSSES the engine boundary: `complete` is a pre-intake
  // obligation, unreachable from a main-engine transition. Emit the durable
  // report directly, passing exactly what the original recursion reloaded — the
  // artifact dir is DELETED on a fully-green close (reload → null → stateRunId
  // falls back to "run") and PRESERVED on a not-green complete (reload → the
  // saved complete state → its plan_id). `store.loadState()` reproduces both, so
  // present_report is identical to the cascade.
  // (Regression-locked in next-step-implement-dispatch.)
  return {
    kind: "emit",
    step: await handleComplete(root, artifactsDir, await store.loadState()),
  };
}

async function handleZeroDocumentableFindings(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
  const nextStepCommand = loaderCommand("next-step");
  const nextStepInputCommand = loaderCommand("next-step --input <path>");
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  return writeCurrentStep({
    stepKind: "zero_documentable_findings",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# No Documentable Findings

The remediation plan is in the \`planning\` state but there are no findings with
status \`pending\` — every finding has already been documented, ignored, or
deemed inappropriate.

Choose one of the following options:

1. **Adjust or remove the intent checkpoint** — edit or delete
   \`${checkpointPath}\`, then re-run:

   \`${nextStepCommand}\`

2. **Supply a different input file** — provide a new audit report or feedback
   file as the remediation source, then re-run with:

   \`${nextStepInputCommand}\`

3. **Stop** — no further remediation work is needed. You may stop now.

Report this situation to the user and let them choose.
`,
    allowedCommands: [nextStepCommand, nextStepInputCommand],
    stopCondition:
      "Stop after presenting the three choices to the user and waiting for their decision.",
  });
}

async function handleUnhandledState(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
  const itemsByStatus: Record<string, string[]> = {};
  for (const item of Object.values(state.items ?? {})) {
    (itemsByStatus[item.status] ??= []).push(item.finding_id);
  }
  const statusBreakdown = Object.entries(itemsByStatus)
    .map(([status, ids]) => `- **${status}**: ${ids.join(", ")}`)
    .join("\n");

  return writeCurrentStep({
    stepKind: "unhandled_state",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# Unhandled State

The remediation workflow reached a state it has no transition for.

- **State status**: \`${state.status}\`
- **State file**: \`${join(artifactsDir, "state.json")}\`

## Item Breakdown

${statusBreakdown || "No items in state."}

Report this diagnostic to the user and stop. Do not attempt to advance the run.
`,
    allowedCommands: [],
    stopCondition: "Stop after reporting the diagnostic to the user.",
  });
}

export async function decideNextStep(
  options: NextStepOptions | string = {},
): Promise<RemediationStep> {
  const normalizedOptions = coerceJsonObjectArg<Record<string, unknown>>(
    options as Record<string, unknown> | string | undefined,
    "decideNextStep options",
  ) as NextStepOptions;
  const root = resolveRoot(normalizedOptions.root);
  const artifactsDir = resolveArtifactsDir(root, normalizedOptions.artifactsDir);
  const sessionConfig =
    normalizedOptions.sessionConfig ??
    (await readOptionalJsonFile<SessionConfig>(
      join(root, "session-config.json"),
    ));
  const runLogger = new RunLogger(join(artifactsDir, "run.log.jsonl"), {
    enabled: sessionConfig?.observability?.run_log ?? true,
  });
  const startedAt = Date.now();
  try {
    const step = await decideNextStepLoop(normalizedOptions, runLogger);
    runLogger.event({
      phase: "next-step",
      kind: "step",
      obligation: step.step_kind,
      note: step.status,
      duration_ms: Date.now() - startedAt,
    });
    return step;
  } catch (error) {
    runLogger.event({
      phase: "next-step",
      kind: "error",
      duration_ms: Date.now() - startedAt,
      note: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function buildConfirmResumeOrRestartStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  ackPath: string;
}): Promise<RemediationStep> {
  const { root, artifactsDir, state, ackPath } = ctx;
  const runId = stateRunId(state);
  const nextCommand = loaderCommand("next-step");

  const itemsByStatus: Record<string, number> = {};
  for (const item of Object.values(state.items ?? {})) {
    itemsByStatus[item.status] = (itemsByStatus[item.status] ?? 0) + 1;
  }
  const statusLines = Object.entries(itemsByStatus)
    .map(([status, count]) => `- **${status}**: ${count}`)
    .join("\n");

  return writeCurrentStep({
    stepKind: "confirm_resume_or_restart",
    status: "blocked",
    runId,
    repoRoot: root,
    artifactsDir,
    prompt: [
      "# Remediation Run Already In Progress",
      "",
      "A remediation run is already in progress. Choose what to do:",
      "",
      `- **Current state**: \`${state.status}\``,
      `- **Plan**: \`${state.plan?.plan_id ?? "(none)"}\``,
      `- **Started**: ${state.started_at ?? "(unknown)"}`,
      "",
      "## Item Counts",
      "",
      statusLines || "No items in state.",
      "",
      "## Choices",
      "",
      "1. **Resume** — continue the existing run. Write to the ack file:",
      "   ```json",
      '   { "choice": "resume" }',
      "   ```",
      "   Then re-run without `--input`:",
      `   \`${nextCommand}\``,
      "",
      "2. **Restart from new input** — delete the existing run and start fresh.",
      "   Write to the ack file:",
      "   ```json",
      '   { "choice": "restart" }',
      "   ```",
      `   Then delete \`${artifactsDir}\` and re-run with \`--input <path>\`.`,
      "",
      "3. **Merge new recommendations into existing plan** — carry the current plan",
      "   forward with additional findings merged in. Write to the ack file:",
      "   ```json",
      '   { "choice": "merge" }',
      "   ```",
      `   Then re-run with \`--input <path>\` pointing at your new recommendations.`,
      "",
      `Write your choice to: \`${ackPath}\``,
    ].join("\n"),
    allowedCommands: [nextCommand, loaderCommand("next-step --input <path>")],
    stopCondition:
      "Stop after presenting the resume/restart/merge choice to the user and writing the ack.",
    artifactPaths: {
      state_file: join(artifactsDir, "state.json"),
      confirm_resume_ack: ackPath,
    },
  });
}

async function buildConfirmIntentStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState | null;
}): Promise<RemediationStep> {
  const { root, artifactsDir, state } = ctx;
  const runId = stateRunId(state);
  const nextCommand = loaderCommand("next-step");
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");

  // Read the pre-drafted checkpoint if one exists (confirmed_by: "draft").
  const draft = await readOptionalJsonFile<IntentCheckpoint>(checkpointPath);
  const isDraft = draft?.confirmed_by === "draft";

  let prompt: string;
  if (isDraft && draft) {
    // Build a consolidated single-stop proposal from the draft.
    const draftRaw = draft as unknown as Record<string, unknown>;
    const preDraftQuestions: Array<{ id: string; question: string; blocking?: boolean }> =
      Array.isArray(draftRaw.pre_draft_questions)
        ? (draftRaw.pre_draft_questions as Array<{ id: string; question: string; blocking?: boolean }>)
        : [];
    // INV-remediate-state-06: only explicit blocking===true is blocking.
    const blockingQs = preDraftQuestions.filter((q) => q.blocking === true);
    const nonBlockingQs = preDraftQuestions.filter((q) => q.blocking !== true);
    const intentInterpretation = typeof draftRaw.intent_interpretation === "string" ? draftRaw.intent_interpretation : undefined;
    const suggestedClosingAction = typeof draftRaw.closing_action === "string" ? draftRaw.closing_action : undefined;

    const questionLines = [
      ...blockingQs.map((q) => `- **[blocking] ${q.id}**: ${q.question}`),
      ...nonBlockingQs.map((q) => `- **[FYI] ${q.id}**: ${q.question}`),
    ].join("\n") || "- None";

    const filtersBlock = draft.filters && Object.keys(draft.filters).length > 0
      ? `\`\`\`json\n${JSON.stringify(draft.filters, null, 2)}\n\`\`\``
      : "(none — remediating all findings)";

    const closingOptions =
      "`commit`, `merge-to-base` (land the run as one revertable `--no-ff` merge into the branch you launched from; safe — aborts and leaves the base untouched on any conflict), or `none`";

    prompt = `
# Confirm Remediation Scope and Intent

The intake worker has pre-populated the following proposal. Review each section
and adjust where needed, then confirm by writing the final \`intent_checkpoint.json\`.

## Proposed Scope

${draft.scope_summary ?? "(not set)"}

## Proposed Intent

${draft.intent_summary ?? "(not set)"}
${intentInterpretation ? `\n**How free-form intent was interpreted:** ${intentInterpretation}\n` : ""}
## Proposed Filters

${filtersBlock}

## Open Questions

${questionLines}

## Suggested Closing Action

${suggestedClosingAction ?? "commit"} (valid options: ${closingOptions})

---

To confirm, write the final checkpoint to:

\`${checkpointPath}\`

\`\`\`json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp>",
  "confirmed_by": "host",
  "scope_summary": "${draft.scope_summary ?? "<the files/areas in scope>"}",
  "intent_summary": "${draft.intent_summary ?? "<the goal>"}",
  "free_form_intent": "<optional: additional guidance>",
  "filters": ${JSON.stringify(draft.filters ?? {}, null, 2)},
  "excluded_scope": [],
  "must_not_touch": []
}
\`\`\`

Adjust \`filters\`, \`excluded_scope\`, \`must_not_touch\`, or \`free_form_intent\` to
narrow scope. Valid severities: ${VALID_SEVERITIES_PROSE}.
Valid lenses: ${VALID_LENSES_PROSE}.

Once written with \`"confirmed_by": "host"\`, run:

\`${nextCommand}\`
`;
  } else {
    // Fallback for when there is no pre-drafted checkpoint.
    prompt = `
# Confirm Remediation Scope and Intent

Please review the intake summary at \`.audit-tools/remediation/intake/intake-summary.json\` (and the audit report, if this run consumes one).

Confirm or refine the remediation scope and intent by writing a valid \`intent_checkpoint.json\` artifact under \`.audit-tools/remediation/\`.

Only \`scope_summary\` and \`intent_summary\` are required; add the optional fields to narrow what gets remediated:

\`\`\`json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp>",
  "confirmed_by": "host",
  "scope_summary": "<the files/areas in scope>",
  "intent_summary": "<the goal, e.g. full-remediation / security-only>",
  "free_form_intent": "<optional: interpreted into lens/priority ordering at planning; never threaded verbatim into worker prompts>",
  "filters": {
    "severity": ["critical", "high"],
    "lenses": ["security", "reliability"],
    "packages": ["<package or path prefix>"],
    "themes": ["<theme id>"]
  },
  "excluded_scope": [{ "path": "<path or prefix>", "reason": "<why>" }],
  "must_not_touch": ["<glob>"]
}
\`\`\`

- \`filters\` drop findings that don't match BEFORE planning, so only the work you want is remediated. Valid severities: ${VALID_SEVERITIES_PROSE}. Valid lenses: ${VALID_LENSES_PROSE}. Draw \`packages\`/\`themes\` from the findings in the audit report.
- \`excluded_scope\` drops findings whose files match a path or directory prefix; \`must_not_touch\` globs are never written.
- Skipped findings are listed in the final remediation report under "Skipped by Intent Checkpoint".
- Leave the optional fields out to remediate everything in the report.

Once the file is written, run:

\`${nextCommand}\`
`;
  }

  return writeCurrentStep({
    stepKind: "confirm_intent",
    status: "ready",
    runId,
    repoRoot: root,
    artifactsDir,
    prompt,
    allowedCommands: [nextCommand],
    stopCondition: "Stop after writing intent_checkpoint.json and running next-step.",
    artifactPaths: {
      intent_checkpoint: checkpointPath,
    },
  });
}

// ---------------------------------------------------------------------------
// Deterministic free_form_intent interpretation at the call site (INV-S04)
// ---------------------------------------------------------------------------
//
// The IntentCheckpoint contract states `free_form_intent` is "interpreted into
// priority/lens/scope signals at planning time via freeFormIntentInterpreter.
// Never threaded verbatim into worker or dispatch prompts (INV-S04)." This is
// the call site that honours that: when a CONFIRMED checkpoint carries a
// free_form_intent, we run the shared deterministic interpreter HERE — never
// pass the raw string downstream — and persist the structured signals so
// planning consumes the encoded lens-weights/priority/scope, and so the
// unencodable clauses are surfaced (never silently dropped) rather than relying
// on an LLM-authored free-text `intent_interpretation`.

/** Sidecar artifact recording the deterministic interpretation of free_form_intent. */
export const INTENT_INTERPRETATION_FILENAME = "intent-interpretation.json";
export const INTENT_INTERPRETATION_SCHEMA_VERSION =
  "remediate-code-intent-interpretation/v1alpha1";

export interface PersistedIntentInterpretation {
  schema_version: typeof INTENT_INTERPRETATION_SCHEMA_VERSION;
  /** The interpreter's structured output (lens weights / priority / scope). */
  interpreted: InterpretedIntent;
  /**
   * Clauses the interpreter could not encode as a lens weight, priority signal,
   * or scope emphasis. Surfaced so the host can promote them to constraints —
   * never silently dropped.
   */
  unencodable_clauses: string[];
  created_at: string;
}

/**
 * Interpret a confirmed checkpoint's `free_form_intent` via the shared
 * deterministic interpreter and persist the structured signals to a sidecar
 * artifact. Idempotent and best-effort: returns the persisted interpretation (or
 * null when there is nothing to interpret / no confirmed checkpoint) and never
 * throws into the decide loop. The raw `free_form_intent` string is NOT returned
 * or threaded anywhere — only the structured `InterpretedIntent` is (INV-S04).
 */
export async function interpretConfirmedCheckpointIntent(
  artifactsDir: string,
  checkpoint: IntentCheckpoint | undefined,
): Promise<PersistedIntentInterpretation | null> {
  if (!checkpoint || checkpoint.confirmed_by !== "host") return null;
  const raw = checkpoint.free_form_intent;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  const interpreted = interpretFreeFormIntent(raw);
  const persisted: PersistedIntentInterpretation = {
    schema_version: INTENT_INTERPRETATION_SCHEMA_VERSION,
    interpreted,
    unencodable_clauses: interpreted.unencodableClauses,
    created_at: new Date().toISOString(),
  };
  try {
    await writeJsonFile(
      join(artifactsDir, INTENT_INTERPRETATION_FILENAME),
      persisted,
    );
  } catch {
    // Best-effort sidecar: a write failure must never block the decide loop.
  }
  if (interpreted.unencodableClauses.length > 0) {
    process.stderr.write(
      `[remediate-code] free_form_intent: ${interpreted.unencodableClauses.length} ` +
        `clause(s) could not be encoded as lens/priority/scope signals and are ` +
        `surfaced for promotion to constraints: ` +
        `${interpreted.unencodableClauses.join("; ")}\n`,
    );
  }
  return persisted;
}

/** Execution dependencies threaded to every remediate obligation executor. */
interface RemediateCtx {
  root: string;
  artifactsDir: string;
  options: NextStepOptions;
  runLogger: RunLogger;
  store: StateStore;
  inputResolution: InputResolution;
  /** Increment step_count once per host call (guarded; no-ops on re-entry). */
  countStep: (state: RemediationState | null) => Promise<void>;
}

/** The once-async-read signals the pre-intake derive()s consume synchronously. */
interface PreIntakeSnapshot {
  existingCheckpoint: IntentCheckpoint | undefined;
  resumeAck: { choice?: string } | undefined;
  /**
   * The state as loaded at advance-entry (post-forceReplan, pre-intake). The
   * resume/conflict/leftover-report gates are about a *pre-existing* run, so they
   * derive from this frozen value — never from a state that `pending_intake`
   * creates mid-call (the original cascade evaluated them before intake and never
   * re-checked, so a re-scan must not resurrect them against an intake-built state).
   */
  entryState: RemediationState | null;
  /**
   * True when the supplied `--input` is identical to the input the existing run
   * was built from — so the conflict gate treats it as a resume, not a conflict.
   */
  suppliedInputUnchanged: boolean;
  /**
   * True when `--guidance-file` was supplied this invocation — a fresh intake
   * source, so it trips the input_conflict gate against an already-advanced run.
   */
  guidanceFileSupplied: boolean;
}

type RemediateObligation = ObligationDef<
  RemediationState | null,
  RemediateCtx,
  RemediationStep
>;

/**
 * What a remediate phase handler / dispatch builder returns to the engine: a
 * `transition` (state advanced; `advance` re-scans within the same call) or an
 * `emit` (a host-actionable step; `advance` returns it). Replaces the handlers'
 * former internal `return decideNextStepLoop(...true)` recursion (A3 slice 2b) so
 * the engine drives every fold with zero recursion.
 */
type RemediateOutcome = ObligationOutcome<RemediationState | null, RemediationStep>;

/**
 * Narrow a nullable engine state to non-null inside an executor whose `derive`
 * only marks it actionable when the state is present — a violation is an engine
 * contract bug, not a runtime condition.
 */
function requireState(state: RemediationState | null): RemediationState {
  if (!state) {
    throw new Error(
      "remediate obligation executor reached with a null state — derive() contract violated",
    );
  }
  return state;
}

/**
 * Priority order for the pre-intake obligations — mirrors the original cascade's
 * top-down guard order exactly so selection cannot drift.
 */
const PRE_INTAKE_PRIORITY: readonly string[] = [
  "input_conflict",
  "confirm_resume",
  "confirm_intent",
  "interpret_intent",
  "complete_redelivery",
  "report_warning",
  "complete",
  "pending_intake",
];

/**
 * The linear pre-intake gates as declarative obligations (A3 slice 1). Built per
 * call so each `derive` can close over `ctx` paths + the pre-read `snapshot` and
 * read the remaining signals (existsSync, status, inputResolution) synchronously.
 * The matching executors are the original cascade handlers, classified emit vs
 * transition; the host-facing behaviour is unchanged.
 */
function buildPreIntakeObligations(
  ctx: RemediateCtx,
  snapshot: PreIntakeSnapshot,
): RemediateObligation[] {
  const { artifactsDir, inputResolution } = ctx;
  const { existingCheckpoint, resumeAck, entryState, suppliedInputUnchanged, guidanceFileSupplied } = snapshot;
  const ip = intakePaths(artifactsDir);
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  const ackPath = join(artifactsDir, "confirm_resume_ack.json");
  const interpretationPath = join(artifactsDir, INTENT_INTERPRETATION_FILENAME);
  const reportPath = join(dirname(artifactsDir), "remediation-report.md");

  return [
    {
      // A new, DIFFERENT intake source against a run already past intake must not
      // silently resume (and re-execute) the old plan; require an explicit
      // resume-vs-restart choice. Two ways a fresh source arrives: a new `--input`
      // (the SAME --input re-passed by the loader every next-step is an unchanged
      // input → a resume, not a conflict), OR a `--guidance-file` (a one-shot
      // bootstrap that lands as conversation-start.md — it has no
      // "unchanged" notion, so any guidance file against an advanced run conflicts;
      // bare follow-ups don't set the flag). Derives from the frozen entry state.
      id: "input_conflict",
      derive: () =>
        ((inputResolution.supplied && !suppliedInputUnchanged) ||
          guidanceFileSupplied) &&
        entryState != null &&
        entryState.status !== "pending"
          ? "missing"
          : "satisfied",
      execute: async (_state, c) => {
        const s = requireState(entryState);
        await c.countStep(s);
        return {
          kind: "emit",
          step: await handleInputConflict(c.root, c.artifactsDir, s, c.inputResolution),
        };
      },
    },
    {
      // Bare re-invocation of an in-progress run: present resume/restart/merge
      // once (gated on the ack file) rather than silently resuming. An ack of
      // choice==='resume' is satisfied — fall through to normal dispatch. Derives
      // from the frozen entry state (a resume is of a *pre-existing* run).
      id: "confirm_resume",
      derive: () => {
        if (
          inputResolution.supplied ||
          entryState == null ||
          entryState.status === "complete" ||
          entryState.status === "pending"
        ) {
          return "satisfied";
        }
        return !resumeAck || resumeAck.choice !== "resume" ? "missing" : "satisfied";
      },
      execute: async (_state, c) => {
        const s = requireState(entryState);
        await c.countStep(s);
        return {
          kind: "emit",
          step: await buildConfirmResumeOrRestartStep({
            root: c.root,
            artifactsDir: c.artifactsDir,
            state: s,
            ackPath,
          }),
        };
      },
    },
    {
      // Intent gate: fire when no confirmed checkpoint exists (no checkpoint + any
      // intake artifact or an active run, or a draft checkpoint). Never for
      // complete/closing — those already confirmed their checkpoint.
      id: "confirm_intent",
      derive: (state) => {
        const checkpointIsDraft = existingCheckpoint?.confirmed_by === "draft";
        const activeRunState =
          state != null &&
          state.status !== "pending" &&
          state.status !== "complete" &&
          state.status !== "closing";
        const fires =
          checkpointIsDraft ||
          (!existsSync(checkpointPath) &&
            (existsSync(ip.summary) ||
              existsSync(ip.extractedPlan) ||
              activeRunState));
        return fires ? "missing" : "satisfied";
      },
      execute: async (state, c) => {
        await c.countStep(state);
        return {
          kind: "emit",
          step: await buildConfirmIntentStep({
            root: c.root,
            artifactsDir: c.artifactsDir,
            state,
          }),
        };
      },
    },
    {
      // Past the intent gate: interpret the confirmed checkpoint's
      // free_form_intent once (INV-S04) and persist the structured signals. A
      // transition (state unchanged) — the re-scan skips it once the sidecar
      // exists.
      id: "interpret_intent",
      derive: () =>
        existingCheckpoint?.confirmed_by === "host" &&
        typeof existingCheckpoint.free_form_intent === "string" &&
        existingCheckpoint.free_form_intent.trim().length > 0 &&
        !existsSync(interpretationPath)
          ? "missing"
          : "satisfied",
      execute: async (state) => {
        await interpretConfirmedCheckpointIntent(artifactsDir, existingCheckpoint);
        return { kind: "transition", state };
      },
    },
    {
      // Finished runs delete the artifact dir but leave the root report. A bare
      // re-invocation with no fresh intent re-presents that report instead of
      // asking for a new starting point.
      id: "complete_redelivery",
      derive: (state) => {
        if (state != null || inputResolution.supplied || !existsSync(reportPath)) {
          return "satisfied";
        }
        // A ready intake-summary + host-confirmed checkpoint with no state.json is
        // the signal a NEW run carries right after confirm_intent (plan not yet
        // built) — an active run, not a finished one. A fully-green close deletes
        // the whole artifact dir (close.ts), so the summary + checkpoint can only
        // co-exist for a live run; never re-deliver the leftover root report over it.
        //
        // A freshly-regenerated default-discovered audit doc (audit-findings.json /
        // audit-report.md newer than the leftover report) is the same "don't
        // redeliver" signal — a fresh audit run just landed and a bare next-step
        // must fall through to pending_intake (which re-presents the discovered
        // file for confirmation via confirm_auto_discovered_input, mtime + type +
        // finding count included) rather than silently re-showing the stale report.
        const freshIntent =
          existsSync(ip.conversationStart) ||
          existsSync(ip.extractedPlan) ||
          (existsSync(ip.summary) && existingCheckpoint?.confirmed_by === "host") ||
          isDefaultCandidateFresherThanReport(inputResolution.existing[0], reportPath);
        return freshIntent ? "satisfied" : "missing";
      },
      execute: async (state, c) => ({
        kind: "emit",
        step: await handleComplete(c.root, c.artifactsDir, state),
      }),
    },
    {
      id: "complete",
      derive: (state) => (state?.status === "complete" ? "missing" : "satisfied"),
      execute: async (state, c) => {
        await c.countStep(state);
        return {
          kind: "emit",
          step: await handleComplete(c.root, c.artifactsDir, state),
        };
      },
    },
    {
      // No state yet: resolve intake. A produced step is emitted; a produced state
      // transitions (the re-scan falls through to the inline tail); a null result
      // emits the collect-starting-point step (the folded old no-state branch).
      id: "pending_intake",
      derive: (state) => (state == null ? "missing" : "satisfied"),
      execute: async (_state, c) => {
        const outcome = await handlePendingIntake(
          c.root,
          c.artifactsDir,
          c.options,
        );
        if (outcome && "step_kind" in outcome) {
          return { kind: "emit", step: outcome };
        }
        if (outcome) {
          return { kind: "transition", state: outcome };
        }
        return { kind: "emit", step: await handleNoState(c.root, c.artifactsDir) };
      },
    },
  ];
}

/**
 * Priority order for the main (post-intake) obligations — mirrors the original
 * cascade tail's guard order exactly so selection cannot drift.
 */
const MAIN_PRIORITY: readonly string[] = [
  "waiting_for_clarification",
  "waiting_for_triage",
  "planning_documentable",
  "partial_terminal",
  "implementing",
  "triage",
  "planning_zero",
  "all_terminal",
  "closing",
  "unhandled",
];

/**
 * The post-intake cascade tail as declarative obligations (A3 slice 2). Runs on a
 * non-null state (pre-intake resolved it). Every phase handler returns a
 * `RemediateOutcome` — a `transition` (planning→implementing, triage, the
 * re-block/close funnel, the dispatch merge-then-reenter folds) or an `emit` (a
 * host-actionable step). `advance` drives the whole fold with ZERO recursion
 * (slice 2b). The one cross-engine case — `handleClosing` reaching `complete`,
 * which lives in the pre-intake engine — emits the report directly rather than
 * transitioning (a main transition could never select it).
 */
function buildMainObligations(ctx: RemediateCtx): RemediateObligation[] {
  const { root, artifactsDir, options, runLogger, store } = ctx;
  const clarificationResolutionPath = join(
    artifactsDir,
    "clarification_resolution.json",
  );
  const triageResolutionPath = join(artifactsDir, "triage_resolution.json");

  return [
    {
      // Plan-phase clarification wait: apply a resolution if present (transition →
      // re-scan), else surface the wait step.
      id: "waiting_for_clarification",
      derive: (state) =>
        state?.status === "waiting_for_clarification" ? "missing" : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        if (existsSync(clarificationResolutionPath)) {
          const next = await applyPlanClarificationResolution(artifactsDir, s, store);
          return { kind: "transition", state: next };
        }
        return {
          kind: "emit",
          step: await handleWaitingForClarification(root, artifactsDir, s),
        };
      },
    },
    {
      // Triage wait: apply a resolution (→ triage, transition) if present, else
      // surface the wait step.
      id: "waiting_for_triage",
      derive: (state) =>
        state?.status === "waiting_for_triage" ? "missing" : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        if (existsSync(triageResolutionPath)) {
          s.status = "triage";
          await store.saveState(s);
          return { kind: "transition", state: s };
        }
        return {
          kind: "emit",
          step: await handleWaitingForTriage(root, artifactsDir, s),
        };
      },
    },
    {
      id: "planning_documentable",
      derive: (state) =>
        state != null &&
        state.status === "planning" &&
        documentableFindings(state).length > 0
          ? "missing"
          : "satisfied",
      execute: async (state) =>
        handlePlanning(root, artifactsDir, requireState(state), store),
    },
    {
      // Partial-completion terminal consume (OBL-S09 / INV-X06): block the
      // precisely-named stranded ids + every other non-terminal item (the
      // no-livelock guarantee), clear the flag, then force the close transition
      // via handleAllTerminalTransition (blocked is non-terminal, so all_terminal
      // would not otherwise fire).
      id: "partial_terminal",
      derive: (state) =>
        state != null &&
        state.partial_completion_terminal != null &&
        !allItemsTerminal(state)
          ? "missing"
          : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        const terminal = s.partial_completion_terminal;
        if (!terminal) return { kind: "transition", state: s };
        // Piece D — quota_paused is a RETRYABLE pause, NOT a failure. The stranded
        // nodes stay PENDING (their worktrees were preserved), nothing is blocked,
        // and the close transition is NOT forced. EMIT a paused step (terminating
        // this advance loop) that tells the host to re-run next-step at/after the
        // stated reset, when the pool's session limit has cleared and the stranded
        // nodes redispatch clean. Clearing the terminal here (before the emit) so
        // the resuming step starts fresh; the pending nodes are the durable signal.
        if (terminal.reason === "quota_paused") {
          const resetAt = terminal.earliest_reset_at ?? null;
          delete s.partial_completion_terminal;
          await store.saveState(s);
          return {
            kind: "emit",
            step: await buildQuotaPausedStep({
              root,
              artifactsDir,
              runId: stateRunId(s),
              strandedIds: terminal.stranded_ids ?? [],
              resetAt,
            }),
          };
        }
        const strandedSet = new Set(terminal.stranded_ids ?? []);
        for (const it of Object.values(s.items ?? {})) {
          if (isTerminalStatus(it.status)) continue;
          it.status = "blocked";
          const stranded = strandedSet.has(it.finding_id);
          it.failure_reason =
            it.failure_reason ??
            (stranded
              ? `Stranded by partial-completion terminal (${terminal.reason}): the provider pool was exhausted before this item could be dispatched (no pool survived re-routing).`
              : `Blocked after partial-completion terminal (${terminal.reason}): no provider pool remained to dispatch this item.`);
        }
        delete s.partial_completion_terminal;
        await store.saveState(s);
        return handleAllTerminalTransition(
          root,
          artifactsDir,
          s,
          store,
          options,
          runLogger,
        );
      },
    },
    {
      id: "implementing",
      derive: (state) =>
        state?.status === "implementing" ? "missing" : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        // Pending implementable blocks dispatch; triage only runs once every item
        // has left "pending".
        const pendingBlocks = implementableBlocks(s);
        if (pendingBlocks.length > 0) {
          // Per-phase boundary gate (T3): before opening a phase P > 0, run the
          // whole-repo suite once over the just-landed foundations. A red re-blocks
          // here (transition); green / no-boundary falls through to dispatch.
          const gated = await runPhaseBoundaryGate({
            root,
            artifactsDir,
            state: s,
            options,
            store,
            runLogger,
          });
          if (gated) return gated;
          return buildImplementDispatchStep({
            root,
            artifactsDir,
            state: s,
            options,
            store,
          });
        }
        // Dead-end pending nodes whose dependency never reached verified-complete
        // (INV-RS-01) so the implementing→triage loop can't livelock; transition
        // so the engine re-scans on the updated state.
        const deadEnded = blockedByUnsatisfiedDependency(s);
        if (deadEnded.length > 0) {
          const now = new Date().toISOString();
          let changed = false;
          for (const block of deadEnded) {
            for (const findingId of block.items) {
              const it = s.items?.[findingId];
              if (!it || it.status !== "pending") continue;
              it.status = "blocked";
              it.started_at ??= now;
              it.completed_at = now;
              it.failure_reason =
                it.failure_reason ??
                "A dependency node did not reach a verified-complete disposition " +
                "(a prerequisite was skipped, blocked, or the dependencies are cyclic); " +
                "the rolling scheduler will not dispatch this node (INV-RS-01).";
              changed = true;
            }
          }
          if (changed) {
            await store.saveState(s);
            return { kind: "transition", state: s };
          }
        }
        return handleImplementing(root, artifactsDir, s, runLogger, store);
      },
    },
    {
      id: "triage",
      derive: (state) => (state?.status === "triage" ? "missing" : "satisfied"),
      execute: async (state) =>
        handleImplementing(root, artifactsDir, requireState(state), runLogger, store),
    },
    {
      // planning with zero documentable findings is a user question, not a
      // dead-end — must fire BEFORE all_terminal so an all-resolved planning state
      // doesn't silently advance to close.
      id: "planning_zero",
      derive: (state) =>
        state != null &&
        state.status === "planning" &&
        documentableFindings(state).length === 0
          ? "missing"
          : "satisfied",
      execute: async (state) => ({
        kind: "emit",
        step: await handleZeroDocumentableFindings(
          root,
          artifactsDir,
          requireState(state),
        ),
      }),
    },
    {
      id: "all_terminal",
      derive: (state) =>
        state != null && allItemsTerminal(state) && state.status !== "closing"
          ? "missing"
          : "satisfied",
      execute: async (state) =>
        handleAllTerminalTransition(
          root,
          artifactsDir,
          requireState(state),
          store,
          options,
          runLogger,
        ),
    },
    {
      id: "closing",
      derive: (state) => (state?.status === "closing" ? "missing" : "satisfied"),
      execute: async (state) =>
        handleClosing(root, artifactsDir, requireState(state), runLogger, store),
    },
    {
      // Catch-all: reached only when no specific obligation matched. Always
      // actionable on a non-null state (the lowest-priority slot), so `advance`
      // surfaces the diagnostic rather than returning a null step.
      id: "unhandled",
      derive: (state) => (state != null ? "missing" : "satisfied"),
      execute: async (state) => ({
        kind: "emit",
        step: await handleUnhandledState(root, artifactsDir, requireState(state)),
      }),
    },
  ];
}

async function decideNextStepLoop(
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediationStep> {
  const root = resolveRoot(options.root);
  const artifactsDir = resolveArtifactsDir(root, options.artifactsDir);
  await mkdir(artifactsDir, { recursive: true });
  const store = new StateStore(artifactsDir);
  let state = await store.loadState();
  runLogger.event({
    phase: "next-step",
    kind: "state",
    obligation: state?.status ?? "pending",
  });
  // step_count is incremented once per host invocation. The `counted` flag guards
  // the shared `countStep` closure so the forceReplan preamble, the pre-intake
  // obligation executors, and the post-intake count point can never double-count
  // within a call. step_count is not embedded in the emitted step, so the
  // count-vs-build ordering is unobservable. (Every phase handler now returns a
  // transition/emit outcome, so `advance` drives the whole fold in ONE call —
  // there is no recursive re-entry to guard against.)
  const counted = { value: false };
  const countStep = async (current: RemediationState | null): Promise<void> => {
    if (!current || counted.value) return;
    if (!current.started_at) current.started_at = new Date().toISOString();
    current.step_count = (current.step_count ?? 0) + 1;
    counted.value = true;
    await store.saveState(current);
  };

  const inputResolution = resolveInputPaths(root, options.input);

  // Preamble — forceReplan re-grounds from existing intake. The whole decide loop
  // runs once per host call (the engine folds planning → implementing → … through
  // transitions, never a recursive decideNextStepLoop), so this fires at most once.
  if (options.forceReplan && state != null) {
    await countStep(state);
    state = await forceReplanFromExistingIntake(root, artifactsDir, state, store);
  }

  // Pre-read the once-async signals the pre-intake derive()s consume
  // synchronously (no transition inside this advance call rewrites either file).
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  const existingCheckpoint = existsSync(checkpointPath)
    ? await readOptionalJsonFile<IntentCheckpoint>(checkpointPath)
    : undefined;
  const resumeAck = await readOptionalJsonFile<{ choice?: string }>(
    join(artifactsDir, "confirm_resume_ack.json"),
  );
  // Whether a supplied `--input` matches the input the existing run was built
  // from — so re-passing the same `--input` (the loader does this each next-step)
  // resumes rather than tripping the input_conflict gate.
  const suppliedInputUnchanged = suppliedInputMatchesRun(
    inputResolution,
    await readOptionalJsonFile<IntakeSourceManifest>(
      intakePaths(artifactsDir).sourceManifest,
    ),
  );

  // The linear pre-intake gates run as obligations through the shared advance
  // loop. An emit returns to the host; a transition re-scans within this call;
  // exhausting them (step === null) means the run is past intake and falls
  // through to the post-intake `advance` (MAIN_PRIORITY) below.
  const ctx: RemediateCtx = {
    root,
    artifactsDir,
    options,
    runLogger,
    store,
    inputResolution,
    countStep,
  };
  const preIntake = await advance(
    {
      priority: PRE_INTAKE_PRIORITY,
      obligations: buildPreIntakeObligations(ctx, {
        existingCheckpoint,
        resumeAck,
        entryState: state,
        suppliedInputUnchanged,
        guidanceFileSupplied: Boolean(options.guidanceFileSupplied),
      }),
    },
    state,
    ctx,
  );
  if (preIntake.step) return preIntake.step;
  state = preIntake.state;

  // pending_intake folds the old no-state branch (it emits handleNoState on a
  // null intake), so advance only falls through here with a non-null state; keep
  // the guard as the type narrowing + a defensive fallback.
  if (!state) {
    return handleNoState(root, artifactsDir);
  }

  await countStep(state);

  // Cooperative multi-agent (slice 4): a single phase mutex serializes the
  // in-process MAIN advance so two joining peers never run the same SERIAL phase
  // (planning / triage / close) and clobber state.json. This does NOT serialize
  // the heavy implement work — that runs out-of-process via per-node claims; the
  // mutex only guards the quick in-process advance + dispatch-emission, during
  // which each peer claims its own disjoint nodes. Mirrors audit's bundle-mutation
  // mutex (slice 1). Registry is the repo-level remediation node-claims file
  // (distinct from the per-run implement node-claims under runs/<runId>/implement).
  const phaseRegistry = new ClaimRegistry(nodeClaimsPath(artifactsDir));
  const phaseRunId = stateRunId(state);
  const phaseClaim = await claimWithBackoff(phaseRegistry, REMEDIATE_PHASE_NODE, {
    poolId: phaseRunId,
  });
  if (!phaseClaim.acquired) {
    return buildPhaseBusyStep({ root, artifactsDir, runId: phaseRunId });
  }
  try {
    // Re-load fresh under the mutex: a peer may have advanced (and persisted)
    // state between our initial load and winning the claim. For an established
    // run (the multi-agent case) the pre-intake gates above were all no-ops, so
    // the reload is simply the latest persisted state.
    const advanceState = (await store.loadState()) ?? state;
    const main = await withClaimHeartbeat(
      phaseRegistry,
      REMEDIATE_PHASE_NODE,
      phaseClaim.ownerToken,
      { intervalMs: PHASE_CLAIM_HEARTBEAT_MS },
      () =>
        advance(
          { priority: MAIN_PRIORITY, obligations: buildMainObligations(ctx) },
          advanceState,
          ctx,
        ),
    );
    if (main.step) return main.step;
    // The unhandled catch-all always emits on a non-null state, so a null step
    // here is unreachable; keep an explicit fallback rather than a non-null assert.
    return handleUnhandledState(root, artifactsDir, advanceState);
  } finally {
    await phaseRegistry.release(REMEDIATE_PHASE_NODE, phaseClaim.ownerToken);
  }
}
