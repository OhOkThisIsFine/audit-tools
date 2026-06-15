import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StateStore, type RemediationState } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  ItemSpec,
  RemediationBlock,
  RemediationItemState,
  RemediationPlan,
} from "../state/types.js";
import { readOptionalJsonFile, writeJsonFile, formatValidationIssues, isRecord, withFsRetry, RunLogger, DO_NOT_TOKEN_WRAP_NOTE, DISPATCH_PROMPT_HANDOFF_NOTE, coerceJsonObjectArg, createRollingDispatcher, setQuotaStateDir, type SessionConfig, type HostModelRosterEntry, type CapacityPool, type RollingDispatchPacket, type RollingDispatchResult, type ProviderSlot } from "@audit-tools/shared";
import type { CoverageLedger } from "../state/types.js";
import { runPlanPhase, applyPlanPipeline, buildCoverageLedger } from "../phases/plan.js";
import { groundExtractedFindings } from "../phases/grounding.js";
import { runTriagePhase } from "../phases/triage.js";
import { runClosePhase } from "../phases/close.js";
import { validateRemediationPlan } from "../validation/remediationState.js";
import {
  mergeImplementResults,
  prepareImplementDispatch,
  readExtractedPlanIfPresent,
} from "./dispatch.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";
import {
  dependenciesSatisfied,
  dependencyVerifiedComplete,
  isTerminalStatus,
  isVerifiedCompleteStatus,
  specIndicatesNoChange,
  classifyFindingRisk,
  type FindingRiskTier,
} from "./stepUtils.js";
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
  INTAKE_CLARIFICATION_SCHEMA_VERSION,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  blockingIntakeQuestions,
  buildConversationSourceManifest,
  buildDocumentSourceManifest,
  intakePaths,
  isIntakeReady,
  readIntakeArtifacts,
  resolveManifestSources,
  type IntakeSource,
  type IntakeSourceManifest,
  type IntakeSummary,
} from "../intake.js";
import type { IntentCheckpoint } from "@audit-tools/shared";
import {
  clarificationPrompt,
  collectIntakeClarificationsPrompt,
  collectStartingPointPrompt,
  loaderCommand,
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
node you just merged edited \`@audit-tools/shared\` (or any upstream package a later
node depends on), rebuild that surface ONCE — \`npm run build -w @audit-tools/shared\`
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

function formatAllowed(command: string): string {
  return `- \`${command}\``;
}

export type {
  FindingRiskTier,
  FindingClassification,
} from "./stepUtils.js";
export {
  NO_CHANGE_RE,
  isTerminalStatus,
  isVerifiedCompleteStatus,
  dependenciesSatisfied,
  dependencyVerifiedComplete,
  specIndicatesNoChange,
  classifyFindingRisk,
} from "./stepUtils.js";

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
// typechecks/runs against the freshly-built upstream `@audit-tools/shared`
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
   * Rebuild `@audit-tools/shared` (and any upstream surface) BETWEEN dependency
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
// Hard floor (always run, in order, single-flight per package — CE-001):
//   1. npm run build -w @audit-tools/shared   (upstream surface first)
//   2. npm run build                          (all workspaces)
//   3. npm run check                          (typecheck, no emit)
//   4. per-package BUILD-FREE unit suite, each invoked directly so no package is
//      built twice or concurrently:
//        - shared:        node --import tsx/esm --test tests/*.test.mjs
//        - audit-code:    node --import tsx/esm --test tests/*.test.mjs
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
  return (
    existsSync(join(root, "packages", "shared", "package.json")) &&
    existsSync(join(root, "packages", "audit-code", "package.json")) &&
    existsSync(join(root, "packages", "remediate-code", "package.json"))
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
    { argv: ["npm", "run", "build", "-w", "@audit-tools/shared"], build_free: false, layer: "build" },
    { argv: ["npm", "run", "build"], build_free: false, layer: "build" },
    { argv: ["npm", "run", "check"], build_free: true, layer: "check" },
    // Per-package BUILD-FREE unit suites — invoked directly (never `npm test`,
    // which prepends a build). Single-flight: each package_dir appears once.
    {
      argv: ["node", "--import", "tsx/esm", "--test", "tests/*.test.mjs"],
      build_free: true,
      package_dir: "packages/shared",
      layer: "unit",
    },
    {
      argv: ["node", "--import", "tsx/esm", "--test", "tests/*.test.mjs"],
      build_free: true,
      package_dir: "packages/audit-code",
      layer: "unit",
    },
    {
      argv: ["npx", "vitest", "run"],
      build_free: true,
      package_dir: "packages/remediate-code",
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
      "npm run smoke:packaged-audit-code -w packages/audit-code",
      "npm run smoke:packaged -w packages/remediate-code",
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
  const isSkip = (s: string): boolean =>
    s === "ignored" || s === "deemed_inappropriate";

  if (currentCount >= bound) {
    // Bounded auto-terminate: converge DETERMINISTICALLY to a terminal `blocked`
    // close for a no-human host — never livelock, never a triage prompt, never green.
    for (const it of Object.values(state.items ?? {})) {
      if (isSkip(it.status)) continue; // settled user decision — never overturn
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
    if (isSkip(it.status)) continue;
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

// Shapes of the reviewed / preliminary risk-classification entries that drive
// the implement-preview tables. Module-scoped so the render helpers below can be
// hoisted out of the state-machine loop rather than re-created per invocation.
type ReviewedEntry = { finding_id: string; tier: string; reason: string };
type PrelimEntry = {
  finding_id: string;
  title: string;
  severity?: string;
  confidence?: string;
  lens?: string;
  summary?: string;
  evidence?: string[];
  concrete_change: string;
  no_change?: boolean;
  affected_files: string[];
  tests_to_write?: { name: string; assertions: string[] }[];
  preliminary_tier: string;
  preliminary_reason: string;
};

const PREVIEW_TIER_LABELS: Record<string, string> = {
  safe: "Straightforward",
  substantive: "Substantive",
  context_dependent: "Operator Context",
};

function previewTierLabel(tier: string): string {
  return PREVIEW_TIER_LABELS[tier] ?? tier;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim() || "-";
}

function previewPros(prelim: PrelimEntry | undefined): string {
  if (!prelim) return "-";
  const pros = [
    prelim.summary ? `Addresses: ${prelim.summary}` : undefined,
    prelim.tests_to_write && prelim.tests_to_write.length > 0
      ? `Planned tests: ${prelim.tests_to_write.map((test) => test.name).join(", ")}`
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return pros.length > 0 ? pros.join("; ") : "Implements the documented remediation change.";
}

function previewCons(
  prelim: PrelimEntry | undefined,
  reviewed: ReviewedEntry,
): string {
  const cons = [
    reviewed.reason ? `Reviewed risk: ${reviewed.reason}` : undefined,
    prelim?.affected_files && prelim.affected_files.length > 0
      ? `Touches ${prelim.affected_files.length} file(s): ${prelim.affected_files.join(", ")}`
      : undefined,
    prelim?.tests_to_write && prelim.tests_to_write.length === 0
      ? "No additional tests listed in the item spec."
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return cons.length > 0 ? cons.join("; ") : "No specific downside recorded beyond normal implementation risk.";
}

function isNoOpFinding(
  prelimMap: Map<string, PrelimEntry>,
  findingId: string,
): boolean {
  return specIndicatesNoChange(prelimMap.get(findingId));
}

function renderTierSection(
  reviewedMap: Map<string, ReviewedEntry>,
  prelimMap: Map<string, PrelimEntry>,
  tier: string,
): string {
  const matches = [...reviewedMap.values()].filter(
    (e) => e.tier === tier && !isNoOpFinding(prelimMap, e.finding_id),
  );
  if (matches.length === 0) return "";
  const header = "| ID | Decision Label | Title | Planned Change | Files | Reviewed Reason | Pros | Cons |";
  const sep = "|---|---|---|---|---|---|---|---|";
  const rows = matches.map((reviewed) => {
    const prelim = prelimMap.get(reviewed.finding_id);
    const files = prelim?.affected_files.join(", ") ?? "-";
    const change = prelim?.concrete_change ?? "-";
    const title = prelim?.title ?? "-";
    return [
      reviewed.finding_id,
      previewTierLabel(reviewed.tier),
      title,
      change,
      files,
      reviewed.reason,
      previewPros(prelim),
      previewCons(prelim, reviewed),
    ].map(markdownCell).join(" | ");
  });
  return `## ${previewTierLabel(tier)}\n\n${header}\n${sep}\n${rows.map((row) => `| ${row} |`).join("\n")}`;
}

function renderNoOpSection(
  reviewedMap: Map<string, ReviewedEntry>,
  prelimMap: Map<string, PrelimEntry>,
): string {
  const noOps = [...reviewedMap.values()].filter((e) =>
    isNoOpFinding(prelimMap, e.finding_id),
  );
  if (noOps.length === 0) return "";
  const rows = noOps.map((e) => {
    const title = (prelimMap.get(e.finding_id)?.title ?? "—").replaceAll("|", "\\|");
    return `- **${e.finding_id}**: ${title}`;
  });
  return `## Already Correct (no changes planned)\n\n${rows.join("\n")}`;
}


function previewAckIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

async function buildImplementDispatchStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  options: NextStepOptions;
  implementBlocks: RemediationBlock[];
  runLogger: RunLogger;
}): Promise<RemediationStep> {
  const { root, artifactsDir, state, options, implementBlocks, runLogger } = ctx;
    const preliminaryPath = join(artifactsDir, "impl_risk_preliminary.json");
    const reviewedPath = join(artifactsDir, "impl_risk_reviewed.json");
    const previewAckPath = join(artifactsDir, "impl_preview_acknowledged.json");

    // When no items have item_spec (document phase dissolved — N-R13), there is
    // nothing to classify or preview. Auto-acknowledge and skip straight to dispatch.
    const hasAnyItemSpec = (state.plan?.blocks ?? []).some((block) =>
      block.items.some((id) => !!state.items?.[id]?.item_spec),
    );
    if (!hasAnyItemSpec && !existsSync(previewAckPath)) {
      await writeJsonFile(previewAckPath, {
        status: "confirmed",
        ignored_findings: [],
        auto_ack: true,
        reason: "No item_spec entries; risk classify/preview skipped (document phase dissolved).",
      });
    }

    // Plan-identity check: if the ack file exists but carries a different plan_id
    // than the current plan, it was written for a stale plan (replan occurred after
    // the user confirmed). Delete the ack and re-emit the preview so the user
    // reviews the updated plan before implementation begins.
    if (existsSync(previewAckPath)) {
      const existingAck = await readOptionalJsonFile<{ plan_id?: string; status?: string }>(previewAckPath);
      const ackPlanId = typeof existingAck?.plan_id === "string" ? existingAck.plan_id : undefined;
      const currentPlanId = state.plan?.plan_id;
      if (ackPlanId !== undefined && currentPlanId !== undefined && ackPlanId !== currentPlanId) {
        process.stderr.write(
          `[remediate-code] impl_preview_acknowledged.json plan_id mismatch (ack=${ackPlanId}, current=${currentPlanId}); treating as absent and re-emitting preview.\n`,
        );
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(previewAckPath);
        } catch { /* already gone */ }
      }
    }

    if (!existsSync(previewAckPath)) {
      const nextCommand = loaderCommand("next-step");

      if (!existsSync(reviewedPath)) {
        // Write preliminary JSON and dispatch a bounded, model-agnostic review task.
        type PreliminaryEntry = {
          finding_id: string;
          title: string;
          severity: string;
          confidence: string;
          lens: string;
          affected_files: string[];
          summary: string;
          evidence: string[];
          concrete_change: string;
          no_change?: boolean;
          tests_to_write: { name: string; assertions: string[] }[];
          block_id: string;
          preliminary_tier: FindingRiskTier;
          preliminary_reason: string;
        };

        const entries: PreliminaryEntry[] = [];
        // Build the risk preview from EVERY block with documented work, not just
        // the dependency-ready wave-1 subset (implementableBlocks is now
        // dependency-gated). The preview/ack is one-shot, so a later dependency
        // wave would otherwise bypass the user's risk review entirely.
        for (const block of state.plan?.blocks ?? []) {
          for (const id of block.items) {
            const item = state.items?.[id];
            const finding = state.plan?.findings.find((f) => f.id === id);
            if (!item?.item_spec || !finding) continue;
            const spec = item.item_spec as ItemSpec;
            const { tier, reason } = classifyFindingRisk(finding, spec);
            entries.push({
              finding_id: finding.id,
              title: finding.title,
              severity: finding.severity,
              confidence: finding.confidence,
              lens: finding.lens,
              affected_files: finding.affected_files.map((f) => f.path),
              summary: finding.summary,
              evidence: finding.evidence ?? [],
              concrete_change: spec.concrete_change,
              no_change: spec.no_change,
              tests_to_write: spec.tests_to_write,
              block_id: block.block_id,
              preliminary_tier: tier,
              preliminary_reason: reason,
            });
          }
        }

        await writeJsonFile(preliminaryPath, {
            schema_version: "impl-risk-preliminary/v1",
            tier_definitions: {
              safe: "Style, formatting, config, or clearly correct bug-fixes that are unambiguously good regardless of project context.",
              substantive: "Changes that meaningfully affect correctness, security, or runtime behaviour.",
              context_dependent: "Changes whose appropriateness depends on project scope, user base, or deployment constraints. Covers low-confidence findings and anything that removes or disables existing behaviour.",
            },
            findings: entries,
          });

          return writeCurrentStep({
          stepKind: "classify_impl_risks",
          status: "ready",
          runId: stateRunId(state),
          repoRoot: root,
          artifactsDir,
          prompt: `
# Review Implementation Risk Classifications

A rule-based classifier has produced preliminary risk tiers for all planned
implementation changes. Read the preliminary classifications, review each one
against the full finding context, and write a reviewed result.

## Input

\`${preliminaryPath}\`

Read only that file. Do not read source code files.

## Tier definitions

- **safe**: Style, formatting, config, or clearly correct bug-fixes that are
  unambiguously good regardless of project context.
- **substantive**: Changes that meaningfully affect correctness, security,
  or runtime behaviour.
- **context_dependent**: Changes whose appropriateness depends on project
  scope, user base, or deployment constraints. Covers low-confidence findings
  and anything that removes or disables existing behaviour.

## Task

For each entry in \`findings\`:
1. Read \`preliminary_tier\` and \`preliminary_reason\`.
2. Check \`summary\`, \`evidence\`, \`concrete_change\`, and \`lens\` for signals the
   rule missed or misread.
3. Keep or adjust the tier. If you adjust, explain why in \`reason\`.

## Output

Write to exactly:

\`${reviewedPath}\`

\`\`\`json
{
  "schema_version": "impl-risk-reviewed/v1",
  "findings": [
    {
      "finding_id": "...",
      "tier": "safe | substantive | context_dependent",
      "reason": "one-line explanation"
    }
  ]
}
\`\`\`

Include every \`finding_id\` from the input. Then run:

\`${nextCommand}\`
`,
          allowedCommands: [nextCommand],
          stopCondition:
            "Stop after writing impl_risk_reviewed.json and running next-step.",
          artifactPaths: {
            preliminary: preliminaryPath,
            reviewed: reviewedPath,
          },
        });
      }

      // Reviewed classifications exist. Build the tiered display in the backend
      // so the preview step is pure present-and-confirm — no reasoning required.
      const reviewedFile = await readOptionalJsonFile<{ findings: ReviewedEntry[] }>(reviewedPath);
      const prelimFile = await readOptionalJsonFile<{ findings: PrelimEntry[] }>(preliminaryPath);

      const reviewedMap = new Map(
        (reviewedFile?.findings ?? []).map((e) => [e.finding_id, e]),
      );
      const prelimMap = new Map(
        (prelimFile?.findings ?? []).map((e) => [e.finding_id, e]),
      );

      // Fall back to preliminary tier for any finding the reviewer omitted.
      for (const [id, prelim] of prelimMap) {
        if (!reviewedMap.has(id)) {
          reviewedMap.set(id, {
            finding_id: id,
            tier: prelim.preliminary_tier,
            reason: prelim.preliminary_reason,
          });
        }
      }

      const sections = [
        renderTierSection(reviewedMap, prelimMap, "safe"),
        renderTierSection(reviewedMap, prelimMap, "substantive"),
        renderTierSection(reviewedMap, prelimMap, "context_dependent"),
        renderNoOpSection(reviewedMap, prelimMap),
      ]
        .filter(Boolean)
        .join("\n\n");

      return writeCurrentStep({
        stepKind: "preview_implement",
        status: "blocked",
        runId: stateRunId(state),
        repoRoot: root,
        artifactsDir,
        prompt: `
# Implementation Plan Preview

Show the tables below to the user exactly as written — every row, every column.
Do not summarise, abbreviate, or list only IDs. The user needs the title and
planned-change, reviewed-reason, Pros, and Cons columns to make an informed
decision.

${sections}

---

The LLM-assisted \`classify_impl_risks\` review has already written
\`impl_risk_reviewed.json\`; use those reviewed classifications as the source of
truth for this preview.

Ask the user to list any findings they want to ignore. They may ignore any
implementable finding below; an empty list means "implement everything."
Already-correct findings are excluded from this choice.

If the user confirms the preview, write the ack to exactly:

\`${previewAckPath}\`

\`\`\`json
{ "status": "confirmed", "ignored_findings": ["FINDING-ID-TO-IGNORE"], "plan_id": "${state.plan?.plan_id ?? ""}" }
\`\`\`

Use an empty \`ignored_findings\` array (\`[]\`) when the user approves
everything; otherwise list the exact finding IDs they chose to ignore. If the
user explicitly declines all implementation work, write:

\`\`\`json
{ "status": "declined", "ignored_findings": [], "plan_id": "${state.plan?.plan_id ?? ""}" }
\`\`\`

Then run:

\`${nextCommand}\`
`,
        allowedCommands: [nextCommand],
        stopCondition:
          "Present the plan to the user, get their decision. Write the ack file and run next-step only if approved.",
        artifactPaths: {
          preliminary: preliminaryPath,
          reviewed: reviewedPath,
          impl_preview_ack: previewAckPath,
        },
      });
    }

    // The preview ack may approve only part of the plan: honor ignored findings
    // by marking them terminal before dispatch so workers cannot resurrect them.
    const previewAck = await readOptionalJsonFile<{
      status?: string;
      ignored_findings?: unknown;
      skip?: unknown;
    }>(
      previewAckPath,
    );
    const ignoredIds = [
      ...previewAckIds(previewAck?.ignored_findings),
      // Legacy ack compatibility: older generated prompts used `skip`.
      ...previewAckIds(previewAck?.skip),
    ];
    const ackPrelimFile =
      ignoredIds.length > 0
        ? await readOptionalJsonFile<{ findings: PrelimEntry[] }>(preliminaryPath)
        : null;
    const ignoreableIds = new Set(
      (ackPrelimFile?.findings ?? [])
        .filter((entry) => !specIndicatesNoChange(entry))
        .map((entry) => entry.finding_id),
    );
    if (previewAck?.status === "declined") {
      let changed = false;
      for (const it of Object.values(state.items ?? {})) {
        if (!isTerminalStatus(it.status)) {
          it.status = "deemed_inappropriate";
          it.failure_reason = "Implementation declined by the user at the preview step.";
          it.started_at ??= new Date().toISOString();
          it.completed_at = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) await new StateStore(artifactsDir).saveState(state);
      return decideNextStepLoop(options, runLogger, true);
    }
    if (ignoredIds.length > 0) {
      let changed = false;
      for (const id of ignoredIds) {
        const it = state.items?.[id];
        const isAllowedIgnore =
          ignoreableIds.size === 0 || ignoreableIds.has(id);
        if (it && it.status === "pending" && isAllowedIgnore) {
          const now = new Date().toISOString();
          it.status = "ignored";
          it.failure_reason = "Ignored by the user at the implementation preview.";
          it.started_at ??= now;
          it.completed_at = now;
          changed = true;
        }
      }
      if (changed) await new StateStore(artifactsDir).saveState(state);
    }

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

    const runId = stateRunId(state);
    const waveOptsImpl = {
      hostMaxConcurrent: options.hostMaxConcurrent,
      sessionConfig: sessionConfigImpl ?? null,
      hostContextTokens: options.hostContextTokens,
      hostOutputTokens: options.hostOutputTokens,
      hostModels: options.hostModels,
      hostModelId: options.hostModelId,
    };
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
      return decideNextStepLoop(options, runLogger, true);
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
      return writeCurrentStep({
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
      });
    }

    return writeCurrentStep({
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
    const coverage = buildCoverageLedger({
      planId: pipelined.plan_id,
      sourceFindings,
      droppedNoEvidence: [],
      droppedByCheckpoint: [],
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

  // Path A: write the seed file so goal_normalization and context_collection
  // prompts can frame the pipeline around the auditor findings.
  if (intake.summary.source_type === "structured_audit" && intake.manifest) {
    const auditSource = resolveManifestSources(root, intake.manifest).resolved.find(
      (s) => s.type === "structured_audit",
    );
    if (auditSource) {
      try {
        const content = await readFile(auditSource.path, "utf8");
        const auditFindings = JSON.parse(content) as unknown;
        await writePathASeedFromFindings(artifactsDir, auditSource.path, auditFindings);
      } catch {
        // Best-effort: if the seed cannot be written, the pipeline still runs;
        // goal_normalization will use the source files from sourcePaths.
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
      sourcePaths.add(source.path);
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
  store: StateStore,
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

async function handlePlanning(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  options: NextStepOptions,
  store: StateStore,
  runLogger: RunLogger,
): Promise<RemediationStep> {
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
        return writeCurrentStep({
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
        });
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
  let changed = false;
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
        changed = true;
      }
    }
  }

  state.status = "implementing";
  await store.saveState(state);
  return decideNextStepLoop(options, runLogger, true);
}

async function handleImplementing(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  runLogger: RunLogger,
  store: StateStore,
  options: NextStepOptions,
): Promise<RemediationStep> {
  const triageStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "triage" });
  const triaged = await runTriagePhase(state, { root, artifactsDir });
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "triage", duration_ms: Date.now() - triageStart });
  await store.saveState(triaged);
  return decideNextStepLoop(options, runLogger, true);
}

function hasResolvedItems(state: RemediationState): boolean {
  return Object.values(state.items ?? {}).some(
    (it) => it.status === "resolved" || it.status === "resolved_no_change",
  );
}

async function handleAllTerminalTransition(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediationStep> {
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
      return decideNextStepLoop(options, runLogger, true);
    }
  }

  state.status = "closing";
  await store.saveState(state);
  return decideNextStepLoop(options, runLogger, true);
}

async function handleClosing(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  runLogger: RunLogger,
  store: StateStore,
  options: NextStepOptions,
): Promise<RemediationStep> {
  const closeStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "close" });
  const closed = await runClosePhase(state, { root, artifactsDir }, runLogger);
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "close", duration_ms: Date.now() - closeStart });
  if (closed.status !== "complete") {
    await store.saveState(closed);
  }
  return decideNextStepLoop(options, runLogger, true);
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
    const step = await decideNextStepLoop(normalizedOptions, runLogger, false);
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

async function decideNextStepLoop(
  options: NextStepOptions,
  runLogger: RunLogger,
  skipCount: boolean,
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
  let countedStateStep = skipCount;
  const countStateStep = async (): Promise<void> => {
    if (!state || countedStateStep) return;
    if (!state.started_at) {
      state.started_at = new Date().toISOString();
    }
    state.step_count = (state.step_count ?? 0) + 1;
    countedStateStep = true;
    await store.saveState(state);
  };

  const inputResolution = resolveInputPaths(root, options.input);

  // forceReplan runs only on the first (non-recursive) call — skipCount is true
  // on every recursive decideNextStepLoop call, so this guard prevents an
  // infinite replan loop when the loop folds through planning → implementing.
  if (options.forceReplan && !skipCount && state != null) {
    await countStateStep();
    state = await forceReplanFromExistingIntake(root, artifactsDir, state, store);
  }

  // A new --input against a run that already advanced past intake must not
  // silently resume the old plan (nor silently complete on a stale report).
  // Require the caller to choose resume-vs-restart explicitly.
  if (inputResolution.supplied && state != null && state.status !== "pending") {
    await countStateStep();
    return handleInputConflict(root, artifactsDir, state, inputResolution);
  }

  // Bare re-invocation (no --input) with an in-progress run: require an explicit
  // resume/restart/merge choice rather than silently resuming. Gate on
  // confirm_resume_ack.json so the choice is only presented once per run.
  if (
    !inputResolution.supplied &&
    state != null &&
    state.status !== "complete" &&
    state.status !== "pending"
  ) {
    const ackPath = join(artifactsDir, "confirm_resume_ack.json");
    const ack = await readOptionalJsonFile<{ choice?: string }>(ackPath);
    if (!ack || !ack.choice) {
      await countStateStep();
      return buildConfirmResumeOrRestartStep({ root, artifactsDir, state, ackPath });
    }
    // choice === 'resume': fall through to normal dispatch
    // choice === 'restart' or 'merge': the caller handles the file deletion / new
    // --input; if state still exists here it means they haven't acted yet, so
    // present the choice again until they do.
    if (ack.choice !== "resume") {
      await countStateStep();
      return buildConfirmResumeOrRestartStep({ root, artifactsDir, state, ackPath });
    }
  }

  const ip = intakePaths(artifactsDir);
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  // Read the checkpoint (if it exists) to check whether it is a draft sentinel.
  const existingCheckpoint = existsSync(checkpointPath)
    ? await readOptionalJsonFile<IntentCheckpoint>(checkpointPath)
    : undefined;
  const checkpointIsDraft = existingCheckpoint?.confirmed_by === "draft";

  // Intent gate: fire when no confirmed checkpoint exists. This covers:
  // - No checkpoint at all and any intake artifact exists (summary, extracted plan, or active state)
  // - A draft checkpoint exists (confirmed_by: "draft") even if extracted-plan.json is present
  // Do NOT fire for complete/closing states — those runs already had their checkpoint confirmed.
  const activeRunState =
    state != null && state.status !== "pending" && state.status !== "complete" && state.status !== "closing";
  if (
    checkpointIsDraft ||
    (!existsSync(checkpointPath) &&
      (existsSync(ip.summary) || existsSync(ip.extractedPlan) || activeRunState))
  ) {
    await countStateStep();
    return buildConfirmIntentStep({ root, artifactsDir, state });
  }

  // A finished run deletes .remediation-artifacts/ at close (state.json included),
  // leaving durable root outputs. On a bare re-invocation with NO fresh-run intent
  // (no --input, no conversation brief, no extracted plan), re-present the report
  // instead of asking for a new starting point. Any fresh intent falls through and
  // starts a new run, ignoring the stale report.
  if (
    state == null &&
    !inputResolution.supplied &&
    existsSync(join(dirname(artifactsDir), "remediation-report.md"))
  ) {
    const ip = intakePaths(artifactsDir);
    const freshIntent =
      existsSync(ip.conversationStart) || existsSync(ip.extractedPlan);
    if (!freshIntent) {
      return handleComplete(root, artifactsDir, state);
    }
  }

  // A leftover remediation-report.md while a fresh run IS being started will be
  // overwritten at close — warn rather than treating it as "done".
  if (
    existsSync(join(dirname(artifactsDir), "remediation-report.md")) &&
    state?.status !== "complete"
  ) {
    process.stderr.write(
      "[remediate-code] A previous remediation-report.md exists in .audit-tools/; it will be overwritten when this run completes.\n",
    );
  }

  if (state?.status === "complete") {
    await countStateStep();
    return handleComplete(root, artifactsDir, state);
  }

  if (!state) {
    const intakeOutcome = await handlePendingIntake(root, artifactsDir, options, store);
    if (intakeOutcome && "step_kind" in intakeOutcome) return intakeOutcome;
    state = intakeOutcome;
  }

  if (!state) {
    return handleNoState(root, artifactsDir);
  }

  await countStateStep();

  if (state.status === "waiting_for_clarification") {
    const clarResolutionPath = join(artifactsDir, "clarification_resolution.json");
    if (existsSync(clarResolutionPath)) {
      await applyPlanClarificationResolution(artifactsDir, state, store);
      return decideNextStepLoop(options, runLogger, true);
    }
    return handleWaitingForClarification(root, artifactsDir, state);
  }

  if (state.status === "waiting_for_triage") {
    const resolutionPath = join(artifactsDir, "triage_resolution.json");
    if (existsSync(resolutionPath)) {
      state.status = "triage";
      await store.saveState(state);
      return decideNextStepLoop(options, runLogger, true);
    }
    return handleWaitingForTriage(root, artifactsDir, state);
  }

  if (state.status === "planning" && documentableFindings(state).length > 0) {
    return handlePlanning(root, artifactsDir, state, options, store, runLogger);
  }

  // Partial-completion terminal hook (OBL-S09 / INV-X06 / OBL-SEAM-RSD-01):
  // Workstream-C consume side. The shared rolling-dispatch engine
  // (createRollingDispatcher) re-queues a transient rate_limited/exhausted
  // packet and re-selects a pool within headroom on the next pass; only when no
  // pool survives does it surface a PartialCompletionTerminal{reason:'empty_pool',
  // stranded_ids} (via getTerminal()). remediate-code consumes that terminal
  // here: the precisely-named stranded ids get a stranded disposition, any other
  // still-non-terminal item is blocked too (the pool is exhausted, so it cannot
  // proceed either — this is the no-livelock guarantee), then the run advances
  // to close. The host-driven dispatch path writes the same terminal shape onto
  // state, so both producers funnel through this one consumer.
  if (
    state.partial_completion_terminal &&
    !allItemsTerminal(state)
  ) {
    const terminal = state.partial_completion_terminal;
    const strandedSet = new Set(terminal.stranded_ids ?? []);
    for (const it of Object.values(state.items ?? {})) {
      if (isTerminalStatus(it.status)) continue;
      it.status = "blocked";
      const stranded = strandedSet.has(it.finding_id);
      it.failure_reason =
        it.failure_reason ??
        (stranded
          ? `Stranded by partial-completion terminal (${terminal.reason}): the provider pool was exhausted before this item could be dispatched (no pool survived re-routing).`
          : `Blocked after partial-completion terminal (${terminal.reason}): no provider pool remained to dispatch this item.`);
    }
    // Clear the terminal flag so the recursive fold doesn't re-enter this branch:
    // 'blocked' is not a terminal status, so without clearing, the check would
    // re-fire on the recursive call and loop indefinitely.
    delete state.partial_completion_terminal;
    await store.saveState(state);
    return handleAllTerminalTransition(root, artifactsDir, state, store, options, runLogger);
  }

  if (state.status === "implementing") {
    // If there are pending implementable blocks, dispatch them — triage only
    // runs after all items have left the "pending" state.
    const pendingBlocks = implementableBlocks(state);
    if (pendingBlocks.length > 0) {
      return buildImplementDispatchStep({
        root,
        artifactsDir,
        state,
        options,
        implementBlocks: pendingBlocks,
        runLogger,
      });
    }
    // No eligible block remains, but pending nodes whose dependency never reached
    // verified-complete (a prerequisite was skipped/blocked) would otherwise loop
    // forever in implementing → triage (triage only acts on `blocked`, not
    // `pending`). Dead-end them deterministically (INV-RS-01): a node whose
    // upstream surface never landed is blocked, not dispatched. Without this the
    // stricter verified-complete gate could livelock the implementing phase.
    const deadEnded = blockedByUnsatisfiedDependency(state);
    if (deadEnded.length > 0) {
      const now = new Date().toISOString();
      let changed = false;
      for (const block of deadEnded) {
        for (const findingId of block.items) {
          const it = state.items?.[findingId];
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
        await store.saveState(state);
        return decideNextStepLoop(options, runLogger, true);
      }
    }
    return handleImplementing(root, artifactsDir, state, runLogger, store, options);
  }

  if (state.status === "triage") {
    return handleImplementing(root, artifactsDir, state, runLogger, store, options);
  }

  // Early guard: planning with zero documentable findings is a user question,
  // not a diagnostic dead-end. Present explicit choices so the user can adjust
  // scope, supply different input, or stop. Must fire BEFORE allItemsTerminal
  // so a planning state with all-resolved items doesn't silently advance to close.
  if (state.status === "planning" && documentableFindings(state).length === 0) {
    return handleZeroDocumentableFindings(root, artifactsDir, state);
  }

  if (allItemsTerminal(state) && state.status !== "closing") {
    return handleAllTerminalTransition(root, artifactsDir, state, store, options, runLogger);
  }

  if (state.status === "closing") {
    return handleClosing(root, artifactsDir, state, runLogger, store, options);
  }

  return handleUnhandledState(root, artifactsDir, state);
}
