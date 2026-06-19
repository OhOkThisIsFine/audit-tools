import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StateStore, type RemediationState } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  RemediationBlock,
  RemediationItemState,
  RemediationPlan,
} from "../state/types.js";
import { readOptionalJsonFile, writeJsonFile, formatValidationIssues, isRecord, withFsRetry, RunLogger, DO_NOT_TOKEN_WRAP_NOTE, DISPATCH_PROMPT_HANDOFF_NOTE, coerceJsonObjectArg, createRollingDispatcher, setQuotaStateDir, interpretFreeFormIntent, advance, type ObligationDef, type ObligationOutcome, type InterpretedIntent, type SessionConfig, type HostModelRosterEntry, type CapacityPool, type RollingDispatchPacket, type RollingDispatchResult, type ProviderSlot } from "audit-tools/shared";
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
  createWorktree,
  removeWorktree,
  resetNodeWorktreeAndBranch,
  acceptNodeWorktree,
  recordNodeAcceptOutcome,
  ensureWorktreeNodeModules,
  seedUntrackedDeclaredPaths,
  worktreePath,
  worktreeBranchForBlock,
  blockScopesFromPlan,
} from "./dispatch.js";
import { makeProviderNodeDispatcher } from "./providerNodeDispatch.js";
import { prepareHostRollingDispatch } from "./rollingSession.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";
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
  buildNextContractPipelineStep,
  shouldEnterContractPipeline,
  writePathASeedFromFindings,
} from "./contractPipeline.js";
import {
  evaluateFastPath,
  buildLeanExtractedPlan,
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
import { runFindingFilterPass, type FindingFilterResult } from "../findingFilter.js";
import {
  intakePaths,
  isIntakeReady,
  readIntakeArtifacts,
  resolveManifestSources,
  type IntakeSourceManifest,
} from "../intake.js";
import type { IntentCheckpoint } from "audit-tools/shared";
import {
  clarificationPrompt,
  collectIntakeClarificationsPrompt,
  collectStartingPointPrompt,
  loaderCommand,
  reviewApprovalPrompt,
  synthesizeIntakePrompt,
  triagePrompt,
} from "./prompts.js";

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
  return resolve(root ?? ".");
}

function resolveArtifactsDir(root: string, artifactsDir?: string): string {
  return resolve(artifactsDir ?? join(root, ".audit-tools", "remediation"));
}

function stateRunId(state: RemediationState | null): string {
  return state?.plan?.plan_id ?? randomRunId("REMEDIATE");
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
    return {
      supplied: true,
      existing: checked.filter((candidate) => existsSync(candidate)),
      missing: checked.filter((candidate) => !existsSync(candidate)),
      checked,
    };
  }

  const checked = defaultInputCandidates(root);
  // Default discovery probes the same logical artifact (the audit output) in
  // several canonical locations and two formats. Select the single
  // highest-priority match — never feed both the structured contract and its
  // markdown render — so a lone .json input takes the lossless structured
  // fast-path instead of being demoted to multi-source LLM extraction.
  const best = checked.find((candidate) => existsSync(candidate));
  return {
    supplied: false,
    existing: best ? [best] : [],
    missing: [],
    checked,
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
// disposition (INV-RS-01). Concurrency is owned entirely by the quota scheduler
// (the `dispatch-quota.json` max_concurrent_agents from `scheduleWave` /
// `computeDispatchCapacity` — INV-S05 / INV-QD-11), never a separate wave cap.
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
 * Pure and deterministic: levels and the nodes within a level are ordered by
 * block_id so the interposed-rebuild boundaries are stable across runs.
 */
export function rollingDependencyLevels(
  state: RemediationState,
): RemediationBlock[][] {
  const plan = state.plan;
  const items = state.items;
  if (!plan || !items) return [];

  const blockById = new Map(plan.blocks.map((b) => [b.block_id, b]));
  const pendingBlocks = plan.blocks
    .filter((b) => b.items.some((id) => items[id]?.status === "pending"))
    .sort((a, b) => a.block_id.localeCompare(b.block_id));

  // A dependency edge is "completable" only when the dep node is itself pending
  // (will be satisfied by some level) or already verified-complete. A skipped /
  // blocked dependency makes the dependent permanently ineligible — such nodes
  // never enter a level (INV-RS-01).
  const isVerifiedNow = (depBlock: RemediationBlock): boolean =>
    depBlock.items.every((id) => isVerifiedCompleteStatus(items[id]?.status));
  const isPending = (depBlock: RemediationBlock): boolean =>
    depBlock.items.some((id) => items[id]?.status === "pending");

  const permanentlyIneligible = (block: RemediationBlock): boolean => {
    for (const depId of block.dependencies ?? []) {
      const dep = blockById.get(depId);
      if (!dep) continue; // dangling edge never strands the DAG
      if (!isVerifiedNow(dep) && !isPending(dep)) return true; // skipped/blocked dep
    }
    return false;
  };

  const levels: RemediationBlock[][] = [];
  const placed = new Set<string>();
  let remaining = pendingBlocks.filter((b) => !permanentlyIneligible(b));

  while (remaining.length > 0) {
    const ready = remaining.filter((block) =>
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
}

export interface DriveRollingDispatchResult {
  /** Per-level dispatch results, in level order. */
  levels: Array<{
    blockIds: string[];
    results: RollingDispatchResult<{ block_id: string }>[];
  }>;
  /** Number of inter-level shared rebuilds performed (== levels.length - 1 when >1 level). */
  rebuilds: number;
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
  const out: DriveRollingDispatchResult = { levels: [], rebuilds: 0 };

  let rebuildInFlight = false; // single-flight guard (CE-001)
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
    const level = levels[levelIndex]!;

    // Interpose the shared rebuild BEFORE every level after the first. Guarded so
    // it can never run twice or concurrently for the same boundary.
    if (levelIndex > 0) {
      if (rebuildInFlight) {
        throw new Error(
          "driveRollingDispatch: shared rebuild already in flight — single-flight invariant violated (CE-001).",
        );
      }
      rebuildInFlight = true;
      try {
        await options.rebuildSharedBetweenLevels();
        out.rebuilds += 1;
      } finally {
        rebuildInFlight = false;
      }
    }

    const blockByPacketId = new Map(level.map((b) => [b.block_id, b]));
    const packets: RollingDispatchPacket<{ block_id: string }>[] = level.map(
      (block) => ({
        id: block.block_id,
        payload: { block_id: block.block_id },
        estimatedTokens: estimateTokens(block),
        complexity: 0.5,
      }),
    );

    const dispatcher = createRollingDispatcher<{ block_id: string }>({
      confirmedPools: options.confirmedPools,
      sessionConfig: options.sessionConfig,
      dispatchPacket: async (packet, slot) => {
        const block = blockByPacketId.get(packet.payload.block_id)!;
        return options.dispatchNode(block, slot);
      },
    });
    dispatcher.enqueue(packets);
    const results = await dispatcher.run();
    out.levels.push({ blockIds: level.map((b) => b.block_id), results });
  }

  return out;
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

  // The live per-node worker: the configured provider, launched with the node's
  // worktree-rooted prompt and cwd = its worktree. Tests inject `options.dispatchNode`
  // to exercise the engine without spawning a real worker.
  const dispatchNode: ProgrammaticNodeDispatcher =
    options.dispatchNode ??
    makeProviderNodeDispatcher({
      root,
      artifactsDir,
      runId,
      sessionConfig: options.sessionConfig,
      promptPathByBlock,
    });

  // Confirmed pools: quota-derived concurrency, never the raw host flag (INV-QD-11).
  const confirmedPools = await buildConfirmedPools({
    sessionConfig: options.sessionConfig,
    hostMaxConcurrent: options.waveOptions?.hostMaxConcurrent,
    hostContextTokens: options.waveOptions?.hostContextTokens,
    hostOutputTokens: options.waveOptions?.hostOutputTokens,
    hostModels: options.waveOptions?.hostModels,
    hostModelId: options.waveOptions?.hostModelId,
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

  // Per-node worktree dispatch + verify-before-accept, wrapped so the rolling
  // engine's dispatchNode callback always RESOLVES (never rejects).
  const dispatchNodeWithWorktree: RollingNodeDispatcher = async (block, slot) => {
    const branch = worktreeBranchForBlock(block.block_id, runId);
    const wt = worktreePath(root, block.block_id, runId);
    const resultPath = resultPathByBlock.get(block.block_id)!;
    try {
      // Idempotent reset of any worktree dir AND leftover branch from a prior
      // attempt before creating this node's isolated worktree. A `rate_limited`
      // re-queue re-enters this dispatcher for the same block with the branch
      // still present; a bare `createWorktree -b` would then fail with "branch
      // already exists". `resetNodeWorktreeAndBranch` clears both (+ prunes stale
      // admin entries) so every (re-)dispatch starts clean from HEAD.
      resetNodeWorktreeAndBranch(root, wt, branch);
      createWorktree(root, wt, branch);
      // A fresh worktree has no node_modules (gitignored); link the main checkout's
      // so this node's verify commands can run.
      ensureWorktreeNodeModules(root, wt);
      // Bring in declared targets that are untracked/ignored in the main tree so a
      // committed-files-only worktree can still see this node's own targets.
      // `touched_files` is the block's authoritative declared write set (the same
      // source the dispatch plan's write scope is derived from).
      seedUntrackedDeclaredPaths(root, wt, block.touched_files ?? []);
      const result = await dispatchNode({
        block,
        slot,
        worktreeRoot: wt,
        resultPath,
      });
      // Shared post-worker lifecycle (commit → verify → merge), identical to the
      // host-subagent driver's `accept-node` callback. Records the LIFECYCLE
      // outcome but returns the worker's TRANSPORT result to the engine (so a
      // rate_limited worker re-queues; a verify-failure routes to triage via merge).
      const targeted = uniqueStrings(
        block.items.flatMap((id) => {
          const finding = state.plan?.findings.find((f) => f.id === id);
          return finding?.targeted_commands ?? [];
        }),
      );
      // The worker's self-reported amendments, adjudicated (never trusted as the
      // gate input) by the accept-time write-scope gate before the cherry-pick.
      const workerResult = await readOptionalJsonFile<{ amended_files?: string[] }>(resultPath);
      const accept = acceptNodeWorktree({
        root,
        runId,
        blockId: block.block_id,
        worktreeRoot: wt,
        branch,
        workerOutcome: result.outcome,
        targetedCommands: targeted,
        scope: { allBlockScopes, amendedFiles: workerResult?.amended_files ?? [] },
      });
      // Persist the tool-owned verify/merge outcome so finalization blocks a node
      // that self-reported resolved but never actually landed (OBL-DS-06). Parity
      // with the host-subagent driver's `accept-node` callback.
      await recordNodeAcceptOutcome(artifactsDir, runId, block.block_id, accept);
      nodeOutcomes.push({
        block_id: block.block_id,
        outcome: accept.outcome,
        verify_passed: accept.verifyPassed,
        merged: accept.merged,
      });
      return result;
    } catch (err) {
      removeWorktree(root, wt);
      await recordNodeAcceptOutcome(artifactsDir, runId, block.block_id, {
        outcome: "error",
        verifyPassed: false,
        merged: false,
      });
      nodeOutcomes.push({ block_id: block.block_id, outcome: "error", verify_passed: false, merged: false });
      return {
        packet: { id: block.block_id, payload: { block_id: block.block_id }, estimatedTokens: 0, complexity: 0.5 },
        outcome: "error",
        error: err,
      };
    }
  };

  await driveRollingDispatch(levels, {
    confirmedPools,
    sessionConfig: options.sessionConfig ?? {},
    dispatchNode: dispatchNodeWithWorktree,
    rebuildSharedBetweenLevels: options.rebuildSharedBetweenLevels,
    quotaStateDir: artifactsDir,
  });

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

/** Dedupe a string list preserving order (local helper for verify command sets). */
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

// ---------------------------------------------------------------------------
// Tool-owned final completion gate (INV-RS-10) + coarse re-block (INV-RS-09)
// ---------------------------------------------------------------------------
//
// INV-RS-10: the final completion gate is a TOOL-OWNED, NON-VACUOUS suite that
// is INDEPENDENT of any `plan.test_command`. A run can only land green when this
// suite passes; a vacuous/unset `plan.test_command` can never substitute for it.
// The suite is executed through the env-scrubbing `runTracked` path
// (`runCommand`), which strips CLAUDECODE / CLAUDE_CODE_* so the gate runs in a
// clean environment regardless of the host session.
//
// Hard floor (always run, in order — single package, single-flight build — CE-001):
//   1. npm run build                          (one tsc build for the whole package)
//   2. npm run check                          (typecheck, no emit)
//   3. BUILD-FREE unit suites at the repo root, each invoked directly so dist is
//      never rebuilt or raced:
//        - shared+audit:  node --import tsx/esm --test tests/shared/*.test.mjs tests/audit/*.test.mjs
//        - remediate-code: npx vitest run
//
// CE-002: the hard floor is scoped to build + typecheck + unit. The
// runtime/packaged-bin smoke surface (the `verify:release` smokes) is recorded
// as a DECLARED RESIDUAL the floor does not gate, rather than run inline — the
// packaged-bin smokes are the known Windows-flaky / EPERM surface and an in-loop
// gate must converge deterministically, so they are surfaced for a separate
// pass instead of being able to strand the run.

/** One command in the tool-owned final gate. */
export interface FinalGateCommandSpec {
  argv: string[];
  /** True for commands that neither build nor run a build-prepending test script. */
  build_free: boolean;
  /** The package this command's unit suite targets (single-flight key), if any. */
  package_dir?: string;
  /** Which layer of the floor this belongs to. */
  layer: "build" | "check" | "unit";
}

/**
 * Whether `root` is the audit-tools monorepo — the repo the tool-owned final
 * gate's suite (INV-RS-10, literally the audit-tools build/check/per-package
 * commands) applies to. The gate's command list is audit-tools-specific by
 * design (this remediation run remediates the audit-tools monorepo), so it is
 * scoped to that structure rather than fabricated for an arbitrary target repo.
 */
export function isAuditToolsMonorepo(root: string): boolean {
  // Single-package layout: the three subsystems are inlined under src/ and both
  // bins live at the repo root. (Name kept for continuity; it is now one package.)
  return (
    existsSync(join(root, "src", "shared")) &&
    existsSync(join(root, "src", "audit")) &&
    existsSync(join(root, "src", "remediate")) &&
    existsSync(join(root, "audit-code.mjs")) &&
    existsSync(join(root, "remediate-code.mjs"))
  );
}

/**
 * The tool-owned final-gate command list (INV-RS-10) for the audit-tools
 * monorepo. Pure and deterministic so tests can assert: it is non-vacuous
 * (always > 0 build + check + unit commands) for the audit-tools structure,
 * never references `plan.test_command`, every UNIT command is build-free, and no
 * package's unit suite appears twice (single-flight — CE-001). Returns `[]` when
 * `root` is not the audit-tools monorepo (the audit-tools-specific suite is
 * inapplicable there — see `runToolOwnedFinalGate`).
 */
export function toolOwnedFinalGateCommands(root: string): FinalGateCommandSpec[] {
  if (!isAuditToolsMonorepo(root)) return [];
  return [
    { argv: ["npm", "run", "build"], build_free: false, layer: "build" },
    { argv: ["npm", "run", "check"], build_free: true, layer: "check" },
    // BUILD-FREE unit suites at the repo root (single package — no `npm -w`, never
    // `npm test`, which prepends a build). node:test for shared+audit, vitest for remediate.
    {
      argv: ["node", "--import", "tsx/esm", "--test", "tests/shared/*.test.mjs", "tests/audit/*.test.mjs"],
      build_free: true,
      layer: "unit",
    },
    {
      argv: ["npx", "vitest", "run"],
      build_free: true,
      layer: "unit",
    },
  ];
}

/** A command's recorded outcome within a gate run. */
export interface FinalGateCommandResult {
  argv: string[];
  layer: FinalGateCommandSpec["layer"];
  package_dir?: string;
  exit_code: number | null;
  passed: boolean;
}

export interface ToolOwnedFinalGateResult {
  passed: boolean;
  results: FinalGateCommandResult[];
  /**
   * True when the audit-tools-specific suite did not apply (target is not the
   * audit-tools monorepo). The gate then does not block; it is a declared scope,
   * not a vacuous pass.
   */
  scoped_out: boolean;
  /**
   * The runtime/packaging surface the hard floor does NOT gate, declared as a
   * residual for a separate pass (CE-002). Always present (the floor is scoped
   * to build+check+unit by design).
   */
  runtime_residual: { surface: string; commands: string[] };
}

/** Injectable runner so the gate is unit-testable without spawning a real build. */
export type GateRunner = (
  argv: string[],
  cwd: string,
  packageDir?: string,
) => { status: number | null };

/**
 * Run the tool-owned final gate (INV-RS-10). Each command runs through
 * `runCommand` → shared `runTracked`, which scrubs CLAUDECODE / CLAUDE_CODE_*.
 * The first failing command short-circuits the floor (a broken build makes the
 * later layers meaningless). A `runner` may be injected for tests. When the
 * audit-tools suite does not apply (non-monorepo target), the gate is
 * `scoped_out` (does not block) rather than vacuously passing.
 */
export async function runToolOwnedFinalGate(
  root: string,
  opts: { runner?: GateRunner } = {},
): Promise<ToolOwnedFinalGateResult> {
  const runtime_residual = {
    surface: "runtime/packaged-bin smokes (verify:release)",
    commands: [
      "npm run smoke:packaged-audit-code",
      "npm run smoke:packaged-remediate-code",
    ],
  };

  const commands = toolOwnedFinalGateCommands(root);
  if (commands.length === 0) {
    // Audit-tools-specific suite does not apply here — declared scope, not a
    // vacuous pass (it never substitutes for a real gate on the audit-tools repo).
    return { passed: true, results: [], scoped_out: true, runtime_residual };
  }

  const runner: GateRunner =
    opts.runner ??
    ((argv, cwd, packageDir) => {
      const [command, ...args] = argv;
      // Package-scoped unit suites run with cwd at the package (no `npm -w`); the
      // monorepo-root build/check commands run at the repo root.
      const effectiveCwd = packageDir ? join(root, packageDir) : cwd;
      // runCommand → runTracked strips CLAUDECODE / CLAUDE_CODE_* (INV-RS-10).
      const result = runCommand(command, args, {
        cwd: effectiveCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: result.status };
    });

  const results: FinalGateCommandResult[] = [];
  let passed = true;
  for (const spec of commands) {
    const { status } = runner(spec.argv, root, spec.package_dir);
    const cmdPassed = status === 0;
    results.push({
      argv: spec.argv,
      layer: spec.layer,
      ...(spec.package_dir ? { package_dir: spec.package_dir } : {}),
      exit_code: status,
      passed: cmdPassed,
    });
    if (!cmdPassed) {
      passed = false;
      break; // short-circuit: later layers are meaningless on a broken floor
    }
  }

  return { passed, results, scoped_out: false, runtime_residual };
}

/**
 * The bound on coarse re-block iterations before the run converges to a terminal
 * `blocked` close (CE-003). Two re-block attempts give a flaky-but-recoverable
 * suite a chance to settle; the third unattributable red terminates
 * deterministically rather than livelocking.
 */
export const COARSE_REBLOCK_BOUND = 2;

const FINAL_GATE_STATE_FILENAME = "final-gate.json";

interface FinalGateSidecar {
  coarse_reblock_count: number;
  /** Set once the bounded backstop terminated; the gate is never re-run after. */
  terminated?: boolean;
}

async function readFinalGateSidecar(
  artifactsDir: string,
): Promise<{ count: number; terminated: boolean }> {
  const sidecar = await readOptionalJsonFile<FinalGateSidecar>(
    join(artifactsDir, FINAL_GATE_STATE_FILENAME),
  );
  const n = sidecar?.coarse_reblock_count;
  return {
    count: typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0,
    terminated: sidecar?.terminated === true,
  };
}

async function writeFinalGateSidecar(
  artifactsDir: string,
  count: number,
  terminated: boolean,
): Promise<void> {
  await writeJsonFile(join(artifactsDir, FINAL_GATE_STATE_FILENAME), {
    schema_version: "remediate-code-final-gate/v1alpha1",
    coarse_reblock_count: count,
    terminated,
  });
}

export type CoarseReblockAction = "reattempt_all" | "terminal_blocked";

export interface CoarseReblockDecision {
  state: RemediationState;
  action: CoarseReblockAction;
  next_count: number;
}

/**
 * Coarse re-block-ALL-non-terminal on an unattributable final-gate red
 * (INV-RS-09) with a bounded, monotonic auto-terminate (CE-003).
 *
 * The tool-owned gate is whole-repo, so a red is inherently unattributable to a
 * single node. Below the bound, EVERY non-skip item (including `resolved` ones —
 * a resolved item's own change may have caused the red) is re-opened to `pending`
 * and the run re-attempts the whole repo through the rolling scheduler
 * (`reattempt_all` → `implementing`). At or above the bound, the run STOPS
 * re-attempting and converges DETERMINISTICALLY: every non-skip item becomes
 * terminal `blocked` and the run advances to `closing`.
 *
 * CE-003 no-human-host guarantee: the loop is owned entirely by the gate + the
 * rolling scheduler — it NEVER routes through the human triage prompt
 * (`waiting_for_triage`) and is bounded by `bound`, so a permanently-red sibling
 * converges to a terminal `blocked` close deterministically: never livelocking,
 * never stranding on a human prompt, and never force-closed to green (a RED gate
 * always leaves `blocked` items, so close.ts's `!anyBlocked` guard keeps the run
 * out of the fully-green path). User SKIP dispositions (ignored /
 * deemed_inappropriate) are settled decisions and are left alone. Pure (the
 * counter is supplied / returned).
 */
export function applyCoarseReblock(
  state: RemediationState,
  currentCount: number,
  gateSummary: string,
  bound: number = COARSE_REBLOCK_BOUND,
): CoarseReblockDecision {
  const now = new Date().toISOString();

  if (currentCount >= bound) {
    // Bounded auto-terminate: converge DETERMINISTICALLY to a terminal `blocked`
    // close for a no-human host — never livelock, never a triage prompt, never green.
    for (const it of Object.values(state.items ?? {})) {
      if (isSkipStatus(it.status)) continue; // settled user decision — never overturn
      it.status = "blocked";
      it.started_at ??= now;
      it.completed_at = now;
      it.failure_reason =
        `Tool-owned final gate failed and the coarse re-block backstop reached its ` +
        `bound (${bound}); converging to a terminal blocked close (no-human host). ${gateSummary}`;
    }
    return { state, action: "terminal_blocked", next_count: currentCount };
  }

  // Below the bound: re-open every non-skip item to `pending` and re-attempt the
  // whole repo via the rolling scheduler (NOT the human triage prompt).
  for (const it of Object.values(state.items ?? {})) {
    if (isSkipStatus(it.status)) continue;
    it.status = "pending";
    it.failure_context =
      `Re-attempted by the coarse final-gate backstop (unattributable whole-repo red). ${gateSummary}`;
    delete it.completed_at;
  }
  return { state, action: "reattempt_all", next_count: currentCount + 1 };
}

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
            ...block,
          };
        })
      : findings.map((finding, index) => ({
          block_id: `B-${String(index + 1).padStart(3, "0")}`,
          items: [finding.id],
          parallel_safe: true,
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
  return writeCurrentStep({
    stepKind: "present_report",
    status: "complete",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# Present Remediation Report

Read \`${reportPath}\` and summarize the remediation outcome for the user.
Mention the resolved, ignored, and deemed-inappropriate counts plus the closing action.
Stop after presenting the summary.
`,
    allowedCommands: [],
    stopCondition: "Stop after presenting the remediation report summary.",
    artifactPaths: {
      final_report: reportPath,
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
      hostMaxConcurrent: options.hostMaxConcurrent,
      sessionConfig: sessionConfigImpl ?? null,
      hostContextTokens: options.hostContextTokens,
      hostOutputTokens: options.hostOutputTokens,
      hostModels: options.hostModels,
      hostModelId: options.hostModelId,
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
          hostMaxConcurrent: options.hostMaxConcurrent,
          hostContextTokens: options.hostContextTokens,
          hostOutputTokens: options.hostOutputTokens,
          hostModels: options.hostModels,
          hostModelId: options.hostModelId,
        },
      });
      // null = no eligible pending work this pass; the engine merges internally once
      // it has run, so only the empty-frontier case needs a merge here. Either way the
      // implement frontier is resolved — transition on the freshly-merged state so the
      // engine re-scans (triage / closing) without recursion.
      if (driven === null) {
        await mergeImplementResults({ root, artifactsDir }, runId);
      }
      return { kind: "transition", state: await store.loadState() };
    }

    if (rollingEngineEnabled && canDispatchImpl) {
      const rolling = await prepareHostRollingDispatch({ root, artifactsDir }, runId, waveOptsImpl);
      // Everything eligible may already be done/skipped — fold straight to merge
      // rather than emitting a dispatch step with zero nodes.
      if (rolling.session.frontier.length === 0) {
        await mergeImplementResults({ root, artifactsDir }, runId);
        return { kind: "transition", state: await store.loadState() };
      }
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

Each eligible node runs in its OWN git worktree (hard isolation between nodes). The
TOOL owns commit -> verify -> merge + write-scope; you only spawn a subagent per
node and call \`accept-node\` as each finishes.

Concurrency target: **${rolling.session.slots}** subagents at once (the quota
scheduler's \`max_concurrent_agents\`), NOT a wave cap.

Spawn ONE subagent for EACH initial node below. Give the subagent that node's
\`prompt\`, and set its working directory to the node's **worktree** path. The
subagent edits source files INSIDE that worktree and writes ONLY its result file.
Do NOT let any subagent edit the main repository tree.

Initial nodes (worktrees already created):
${nodeLines}

As EACH subagent finishes, run (substituting the finished node's block id):

\`${acceptCmd}\`

It runs the commit -> verify -> merge lifecycle for that node and prints a JSON
directive on stdout:
- \`{"directive":"dispatch","node":{...},"worktree_root":"..."}\` — spawn a subagent
  for that next node (its worktree is already created), keeping up to
  ${rolling.session.slots} running.
- \`{"directive":"wait",...}\` — other nodes are still in flight; do not spawn more yet.
- \`{"directive":"done",...}\` — every node has been accepted. Then run:

${DO_NOT_TOKEN_WRAP_NOTE}

\`${rollMerge}\`

Then run:

\`${rollNext}\`

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
    // no wave-size cap — concurrency is owned by the quota scheduler
    // (`dispatch-quota.json` max_concurrent_agents). `prepareImplementDispatch`
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
(INV-RS-01), so all of them are eligible to run now. Concurrency is owned by the
quota scheduler — maintain up to \`max_concurrent_agents\` subagents running
simultaneously (from the quota file), with no separate wave-size cap. Each item's
\`model_hint.tier\` suggests which model to use (small/standard/deep). If your
provider has rate limits, pace launches accordingly.

For each item in \`items\`, dispatch one subagent with that item's
\`prompt_path\`. Each subagent may edit source files needed for that bounded
block and must write only its assigned \`result_path\`.

${SHARED_REBUILD_BETWEEN_LEVELS_NOTE}

${DISPATCH_PROMPT_HANDOFF_NOTE}

After all results exist:

${DO_NOT_TOKEN_WRAP_NOTE}

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
): Promise<ReviewGateProceed | ReviewGateHalt> {
  const decisionPath = reviewDecisionPath(artifactsDir);

  // First crossing only: no decision yet AND the pipeline has not started.
  const gateOpen =
    survivors.length > 0 &&
    !existsSync(decisionPath) &&
    !contractArtifactExists(artifactsDir, "goal_spec");

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
        const gate = await runReviewApprovalGate(root, artifactsDir, filter.survivors);
        if (gate.kind === "halt") {
          return gate.step;
        }
        // Persist the filter dispositions so coverage is built over the originals.
        await persistReviewFilterDispositions(artifactsDir, originals, filter);

        // A1 — conservative lean fast path. When the approved set is a handful
        // of grounded, high-confidence, localized, non-cross-cutting findings,
        // skip the contract pipeline and synthesize the extracted plan directly;
        // the plan→implement→close machinery (per-node verify-before-merge + the
        // final whole-repo gate) is the retained safety net. Any doubt routes to
        // the full pipeline below. Runs only here — on Path A (structured_audit),
        // the only intake with a pre-existing finding set to judge.
        const fast = evaluateFastPath(gate.approved);
        if (fast.eligible) {
          const leanPlan = buildLeanExtractedPlan(
            gate.approved,
            randomRunId("LEAN"),
          );
          await writeJsonFile(intakePaths(artifactsDir).extractedPlan, leanPlan);
          process.stderr.write(
            `[remediate-code] Lean fast path: ${fast.reason}. Skipping the contract pipeline; routing straight to plan→implement.\n`,
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

  const step = await buildNextContractPipelineStep({
    root,
    artifactsDir,
    runId: randomRunId("CONTRACT"),
    sourcePaths: [...sourcePaths],
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
    return handleReadyIntakeContractPipeline(root, artifactsDir);
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
  return handleReadyIntakeContractPipeline(root, artifactsDir);
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
      : "(input supplied)";
  return writeCurrentStep({
    stepKind: "input_conflict",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# New \`--input\` given, but a remediation run is already in progress

A remediation run already exists in \`${artifactsDir}\` and has advanced past intake,
so the new \`--input\` you passed will **not** replace it — it would be ignored and the
existing plan resumed.

- **Current state**: \`${state.status}\`
- **Plan**: \`${planId}\` (${itemCount} item(s))
- **Supplied input**: ${suppliedInline}

Choose one explicitly and report the choice to the user:

1. **Resume the existing run** — re-run WITHOUT \`--input\`: \`${loaderCommand("next-step")}\`
2. **Start fresh from the new input** — first move aside or delete the existing
   \`${artifactsDir}\` directory (and the stale \`remediation-report.md\` /
   \`remediation-report.json\` in \`.audit-tools/\`, which would otherwise be overwritten on completion),
   then re-run \`${loaderCommand("next-step --input <path>")}\`.

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

interface PlanClarificationResolution {
  finding_id: string;
  action: "clarified" | "deemed_inappropriate";
  rationale?: string;
}

function normalizePlanClarificationResolutions(value: unknown): PlanClarificationResolution[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord).flatMap((entry) => {
      if (
        typeof entry.finding_id === "string" &&
        (entry.action === "clarified" || entry.action === "deemed_inappropriate")
      ) {
        return [
          {
            finding_id: entry.finding_id,
            action: entry.action as "clarified" | "deemed_inappropriate",
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
    if (entry.action !== "clarified" && entry.action !== "deemed_inappropriate") return [];
    return [{
      finding_id: typeof entry.finding_id === "string" ? entry.finding_id : findingId,
      action: entry.action as "clarified" | "deemed_inappropriate",
      rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
    }];
  });
}

/**
 * Consume clarification_resolution.json for plan-phase clarifications.
 * Mirrors the triage resolution consume: deemed_inappropriate → terminal,
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
    if (!item) continue;
    if (res.action === "deemed_inappropriate") {
      item.status = "deemed_inappropriate";
      item.failure_reason = res.rationale;
      item.started_at ??= now;
      item.completed_at = now;
    } else {
      item.status = "pending";
      item.clarification_context = res.rationale;
    }
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

async function handleAllTerminalTransition(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediateOutcome> {
  const gateDisabled =
    options.skipFinalGate === true ||
    process.env.REMEDIATE_SKIP_FINAL_GATE === "1" ||
    process.env.REMEDIATE_SKIP_FINAL_GATE === "true";

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
  // artifact dir is DELETED on a fully-green close (reload → null → randomRunId)
  // and PRESERVED on a not-green complete (reload → the saved complete state →
  // its plan_id). `store.loadState()` reproduces both, so present_report is
  // identical to the cascade. (Regression-locked in next-step-implement-dispatch.)
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

    const closingOptions = "`commit` or `none`";

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
narrow scope. Valid severities: \`critical\`, \`high\`, \`medium\`, \`low\`, \`info\`.
Valid lenses: \`correctness\`, \`architecture\`, \`maintainability\`, \`security\`,
\`reliability\`, \`performance\`, \`data_integrity\`, \`tests\`, \`operability\`,
\`config_deployment\`, \`observability\`.

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
  "free_form_intent": "<optional: guidance threaded into remediation worker prompts>",
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

- \`filters\` drop findings that don't match BEFORE planning, so only the work you want is remediated. Valid severities: \`critical\`, \`high\`, \`medium\`, \`low\`, \`info\`. Valid lenses: \`correctness\`, \`architecture\`, \`maintainability\`, \`security\`, \`reliability\`, \`performance\`, \`data_integrity\`, \`tests\`, \`operability\`, \`config_deployment\`, \`observability\`. Draw \`packages\`/\`themes\` from the findings in the audit report.
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
  const { existingCheckpoint, resumeAck, entryState, suppliedInputUnchanged } = snapshot;
  const ip = intakePaths(artifactsDir);
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  const ackPath = join(artifactsDir, "confirm_resume_ack.json");
  const interpretationPath = join(artifactsDir, INTENT_INTERPRETATION_FILENAME);
  const reportPath = join(dirname(artifactsDir), "remediation-report.md");
  // Fires at most once per host call; gates the leftover-report warning so a
  // re-scan after a transition cannot re-print it (mirrors the cascade's
  // single fall-through hit).
  const warned = { value: false };

  return [
    {
      // A new, DIFFERENT --input against a run already past intake must not
      // silently resume the old plan; require an explicit resume-vs-restart
      // choice. The SAME --input re-passed (the loader does this every next-step)
      // is an unchanged input → a resume, not a conflict. Derives from the frozen
      // entry state — never an intake-created one.
      id: "input_conflict",
      derive: () =>
        inputResolution.supplied &&
        !suppliedInputUnchanged &&
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
        const freshIntent =
          existsSync(ip.conversationStart) || existsSync(ip.extractedPlan);
        return freshIntent ? "satisfied" : "missing";
      },
      execute: async (state, c) => ({
        kind: "emit",
        step: await handleComplete(c.root, c.artifactsDir, state),
      }),
    },
    {
      // Diagnostic (not a gate): a leftover root report will be overwritten when a
      // fresh/active run completes. A transition (prints once, state unchanged);
      // its priority slot — after complete_redelivery, before complete — means a
      // re-presented/complete run never reaches it, exactly as the cascade's
      // fall-through ordering did.
      id: "report_warning",
      derive: (state) =>
        !warned.value &&
        existsSync(reportPath) &&
        state?.status !== "complete"
          ? "missing"
          : "satisfied",
      execute: async (state) => {
        warned.value = true;
        process.stderr.write(
          "[remediate-code] A previous remediation-report.md exists in .audit-tools/; it will be overwritten when this run completes.\n",
        );
        return { kind: "transition", state };
      },
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

  const main = await advance(
    { priority: MAIN_PRIORITY, obligations: buildMainObligations(ctx) },
    state,
    ctx,
  );
  if (main.step) return main.step;
  // The unhandled catch-all always emits on a non-null state, so a null step here
  // is unreachable; keep an explicit fallback rather than a non-null assertion.
  return handleUnhandledState(root, artifactsDir, state);
}
