import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
  DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
} from "@audit-tools/shared";
import type {
  ProviderRateLimits,
  SessionConfig,
  DispatchModelHint,
  DispatchModelTier,
  HostModelRosterEntry,
  GraphBundle,
} from "@audit-tools/shared";
import { buildQuotaSource } from "@audit-tools/shared/quota/compositeQuotaSource";
import type {
  ActiveDispatchState,
  DispatchResultMapEntry,
  DispatchResultMap,
} from "../types/activeDispatch.js";
import {
  DISPATCH_RESULT_MAP_FILENAME,
  ACTIVE_DISPATCH_FILENAME,
} from "../types/activeDispatch.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { loadArtifactBundle } from "../io/artifacts.js";
import { writePacketSchemaFiles } from "../io/runArtifacts.js";
import type { AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import {
  orderTasksForPacketReview,
  buildReviewPacketsFromPartition,
  sizeIndexFromManifest,
} from "../orchestrator/reviewPackets.js";
import type { ReviewPacket } from "../types/reviewPlanning.js";
import {
  buildTaskAffinityGraph,
  filterTaskAffinityGraph,
  type TaskAffinityGraph,
} from "../orchestrator/taskAffinityGraph.js";
import { buildFileAnchorSummary, type FileAnchorSummary } from "../orchestrator/fileAnchors.js";
import { resolveFreshSessionProviderName } from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import {
  computeDispatchCapacity,
  buildProviderModelKey,
  resolveHostModel,
  readQuotaState,
  resolveHostActiveSubagentLimit,
  lookupDiscoveredLimits,
  mergeDiscoveredLimits,
  summarizeDispatchCapacityPools,
} from "../quota/index.js";
import type { CapacityPool, DiscoveredRateLimits, DispatchQuota } from "../quota/index.js";
import {
  taskResultPath,
  packetPromptPath,
  artifactNameForId,
  fromBase64Url,
  getFlag,
} from "./args.js";

export const LARGE_FILE_PACKET_TARGET_LINES = 2500;
export const DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS = 9000;

/**
 * Default relative cut points mapping a packet's `routing_risk` (max member
 * risk, in [0,1]) to a relative model rank. Provider-neutral: these are
 * positions on a normalized risk scale, never named models or model windows
 * (the no-hardcoded-models invariant). Overridable via
 * `sessionConfig.dispatch.routing_tiers`.
 */
export const DEFAULT_DEEP_ROUTING_RISK = 0.66;
export const DEFAULT_STANDARD_ROUTING_RISK = 0.33;

export interface DispatchComplexity {
  priority: NonNullable<AuditTask["priority"]>;
  task_count: number;
  file_count: number;
  total_lines: number;
  estimated_tokens: number;
  lenses: AuditTask["lens"][];
  tags: string[];
  large_file_mode: boolean;
}

export type {
  ActiveDispatchState,
  DispatchResultMapEntry,
  DispatchResultMap,
} from "../types/activeDispatch.js";
export {
  DISPATCH_RESULT_MAP_FILENAME,
  ACTIVE_DISPATCH_FILENAME,
} from "../types/activeDispatch.js";

export const DEFAULT_DISPATCH_CONFIRM_THRESHOLD = 10;

export interface DispatchFanout {
  agent_count: number;
  max_concurrent_agents: number;
  confirmation_recommended: boolean;
  dispatch_summary: string;
}

export function computeDispatchFanout(params: {
  agentCount: number;
  maxConcurrent: number;
  confirmThreshold?: number;
}): DispatchFanout {
  const agentCount = params.agentCount;
  const maxConcurrent = params.maxConcurrent;
  const confirmThreshold =
    params.confirmThreshold ?? DEFAULT_DISPATCH_CONFIRM_THRESHOLD;
  const confirmationRecommended = agentCount > confirmThreshold;
  const dispatchSummary =
    `${agentCount} agent${agentCount !== 1 ? "s" : ""}, ` +
    `max ${maxConcurrent} concurrent (rolling)`;
  return {
    agent_count: agentCount,
    max_concurrent_agents: maxConcurrent,
    confirmation_recommended: confirmationRecommended,
    dispatch_summary: dispatchSummary,
  };
}

export interface PrepareDispatchResult {
  run_id: string;
  dispatch_plan_path: string;
  dispatch_quota_path: string | null;
  packet_count: number;
  task_count: number;
  skipped_task_count: number;
  /** Max subagents running simultaneously (rolling dispatch). */
  max_concurrent_agents: number;
  /** Total agents that will be launched this run (packet_count after budget filtering). */
  agent_count: number;
  /** True when agent_count exceeds sessionConfig.dispatch?.confirm_threshold (default 10). */
  confirmation_recommended: boolean;
  /** Human-readable summary, e.g. "12 agents, max 4 concurrent (rolling)". */
  dispatch_summary: string;
  /** True when a max_packets budget capped the emitted packets this run. */
  budget_capped: boolean;
  /** Number of packets deferred (not emitted) due to the budget cap. */
  deferred_packet_count: number;
  largest_packet: {
    packet_id: string;
    total_lines: number;
    estimated_tokens: number;
  } | null;
  warning_count: number;
  dispatch_warnings_path: string | null;
}

export interface DispatchPlanEntry {
  packet_id: string;
  description: string;
  prompt_path: string;
  /** Path where the host/skill should write the worker's captured inline AuditResult[] payload. */
  result_path: string;
  complexity: DispatchComplexity;
  model_hint: DispatchModelHint;
  access: { read_paths: string[]; write_paths: string[]; forbidden_patterns: string[] };
}

export function dispatchResultMapPath(runDir: string): string {
  return join(runDir, DISPATCH_RESULT_MAP_FILENAME);
}

export function resolveRunScopedArg(
  argv: string[],
  rawFlag: string,
  b64Flag: string,
): string | undefined {
  const raw = getFlag(argv, rawFlag);
  const encoded = getFlag(argv, b64Flag);
  return raw ?? (encoded ? fromBase64Url(encoded) : undefined);
}

export async function loadDispatchResultMap(
  runDir: string,
): Promise<DispatchResultMap | null> {
  try {
    return await readJsonFile<DispatchResultMap>(dispatchResultMapPath(runDir));
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    return null;
  }
}

export function entriesByTaskId(
  entries: DispatchResultMapEntry[],
): Map<string, DispatchResultMapEntry> {
  return new Map(entries.map((entry) => [entry.task_id, entry]));
}

export function isIsolatedLargeFilePacket(packet: {
  file_paths: string[];
  total_lines: number;
}): boolean {
  return (
    packet.file_paths.length === 1 &&
    packet.total_lines > LARGE_FILE_PACKET_TARGET_LINES
  );
}

export function buildDispatchComplexity(
  packet: {
    task_ids: string[];
    file_paths: string[];
    total_lines: number;
    estimated_tokens: number;
    priority: NonNullable<AuditTask["priority"]>;
    lenses: AuditTask["lens"][];
    tags?: string[];
  },
  largeFileMode: boolean,
): DispatchComplexity {
  return {
    priority: packet.priority,
    task_count: packet.task_ids.length,
    file_count: packet.file_paths.length,
    total_lines: packet.total_lines,
    estimated_tokens: packet.estimated_tokens,
    lenses: packet.lenses,
    tags: packet.tags ?? [],
    large_file_mode: largeFileMode,
  };
}

const TIER_RANK: Record<DispatchModelTier, number> = {
  small: 0,
  standard: 1,
  deep: 2,
};

const SENSITIVE_HINT_LENSES = new Set(["security", "data_integrity", "reliability"]);

/**
 * Derive a packet's relative model rank from its `routing_risk` (the JIT graph
 * partition's max member risk) — the risk-primary baseline — with complexity
 * signals acting as ESCALATORS ONLY: they can raise the tier (a genuinely
 * large/critical-flow packet still gets the top rank at low risk) but never
 * lower the risk baseline. Cut points are relative positions on the normalized
 * risk scale, never model names (no-hardcoded-models invariant).
 */
export function resolveDispatchTier(params: {
  /** Max member risk from the partition; undefined when no partition ran. */
  routingRisk: number | undefined;
  complexity: DispatchComplexity;
  /** Relative cut-point overrides (sessionConfig.dispatch.routing_tiers). */
  routingTiers?: { deep_at?: number; standard_at?: number };
}): DispatchModelHint {
  const { routingRisk, complexity } = params;
  const deepAt = params.routingTiers?.deep_at ?? DEFAULT_DEEP_ROUTING_RISK;
  const standardAt =
    params.routingTiers?.standard_at ?? DEFAULT_STANDARD_ROUTING_RISK;

  const baseline: DispatchModelTier =
    routingRisk === undefined
      ? "small"
      : routingRisk >= deepAt
        ? "deep"
        : routingRisk >= standardAt
          ? "standard"
          : "small";
  const reasons: string[] = [
    routingRisk === undefined
      ? "routing_risk:unknown"
      : `routing_risk:${routingRisk.toFixed(2)}`,
  ];

  const deepEscalators: string[] = [];
  if (complexity.large_file_mode) deepEscalators.push("isolated_large_file");
  if (complexity.estimated_tokens >= DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS) {
    deepEscalators.push("high_estimated_tokens");
  }
  if (
    complexity.tags.some(
      (tag) => tag === "critical_flow" || tag.startsWith("critical_flow:"),
    )
  ) {
    deepEscalators.push("critical_flow");
  }
  if (
    complexity.tags.some(
      (tag) =>
        tag === "external_analyzer_signal" || tag.startsWith("external_tool:"),
    )
  ) {
    deepEscalators.push("external_analyzer_signal");
  }
  if (complexity.tags.includes("lens_verification")) {
    deepEscalators.push("lens_verification");
  }

  const standardEscalators: string[] = [];
  if (complexity.lenses.some((lens) => SENSITIVE_HINT_LENSES.has(lens))) {
    standardEscalators.push("sensitive_lens");
  }
  if (complexity.priority === "medium") {
    standardEscalators.push("medium_priority");
  }

  let tier = baseline;
  if (deepEscalators.length > 0 && TIER_RANK.deep > TIER_RANK[tier]) {
    tier = "deep";
  }
  if (standardEscalators.length > 0 && TIER_RANK.standard > TIER_RANK[tier]) {
    tier = "standard";
  }
  // Reasons stay attributable: the risk baseline first, then every escalator
  // that fired (even ones below the final tier — they explain the floor).
  reasons.push(...deepEscalators, ...standardEscalators);
  return { tier, reasons };
}

export function withinRoot(root: string, path: string): string {
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, path);
  const relativePath = relative(rootPath, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Path '${path}' escapes repository root '${rootPath}'.`);
  }
  return absolutePath;
}

function renderAnchorPreview(
  summary: FileAnchorSummary,
  anchorPath: string,
): string[] {
  const preview = summary.anchors.slice(0, 24).map((anchor) => {
    const location = anchor.line ? `${summary.path}:${anchor.line}` : summary.path;
    const detail = anchor.detail ? ` - ${anchor.detail}` : "";
    return `- ${location} [${anchor.kind}] ${anchor.name}${detail}`;
  });
  return [
    "## Large File Review Mode",
    "This packet is intentionally isolated because it covers one large file.",
    "Use targeted reads/searches within this file, guided by the mechanical anchors.",
    "Do not read unrelated files unless a finding cannot be evidenced without a direct boundary check.",
    `Anchor file: ${anchorPath}`,
    `Anchor counts: symbols=${summary.counts.symbols}, routes=${summary.counts.routes}, keywords=${summary.counts.keywords}, graph_edges=${summary.counts.graph_edges}, analyzer_signals=${summary.counts.analyzer_signals}, omitted=${summary.omitted_anchor_count}`,
    "Anchor preview:",
    ...(preview.length > 0 ? preview : ["- no anchors extracted beyond file boundaries"]),
    "",
  ];
}

function formatPacketConfidence(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "n/a";
}

function renderPacketGraphContext(packet: {
  entrypoints?: string[];
  key_edges?: Array<{
    from: string;
    to: string;
    kind?: string;
    confidence?: number;
    reason?: string;
  }>;
  boundary_files?: string[];
  quality?: {
    cohesion_score: number;
    internal_edge_count: number;
    boundary_edge_count: number;
    unexplained_file_count: number;
  };
}): string[] {
  const hasContext =
    (packet.entrypoints?.length ?? 0) > 0 ||
    (packet.key_edges?.length ?? 0) > 0 ||
    (packet.boundary_files?.length ?? 0) > 0 ||
    packet.quality !== undefined;
  if (!hasContext) {
    return [];
  }

  const lines = ["## Packet graph context"];
  if (packet.entrypoints?.length) {
    lines.push("Entrypoints:");
    lines.push(...packet.entrypoints.map((entrypoint) => `- ${entrypoint}`));
  }
  if (packet.key_edges?.length) {
    lines.push("Key internal edges:");
    lines.push(
      ...packet.key_edges.map((edge) => {
        const kind = edge.kind ? ` [${edge.kind}]` : "";
        const reason = edge.reason ? ` - ${edge.reason}` : "";
        return `- ${edge.from} -> ${edge.to}${kind} confidence=${formatPacketConfidence(edge.confidence)}${reason}`;
      }),
    );
  }
  if (packet.boundary_files?.length) {
    lines.push("Boundary files to check only when evidence crosses the packet:");
    lines.push(...packet.boundary_files.map((path) => `- ${path}`));
  }
  if (packet.quality) {
    lines.push(
      `Quality: cohesion=${packet.quality.cohesion_score}, internal_edges=${packet.quality.internal_edge_count}, boundary_edges=${packet.quality.boundary_edge_count}, unexplained_files=${packet.quality.unexplained_file_count}`,
    );
  }
  lines.push("");
  return lines;
}

export function buildPendingAuditTasks(bundle: ArtifactBundle) {
  const completedTaskIds = new Set(
    (bundle.audit_results ?? []).map((result) => result.task_id),
  );
  const pendingTasks = (bundle.audit_tasks ?? []).filter(
    (task) => task.status !== "complete" && !completedTaskIds.has(task.task_id),
  );
  const lineIndex = Object.fromEntries(
    pendingTasks.flatMap((task) => Object.entries(task.file_line_counts ?? {})),
  );
  return orderTasksForPacketReview(pendingTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex: sizeIndexFromManifest(bundle.repo_manifest),
  });
}

interface FilterPacketsResult {
  emitPackets: ReviewPacket[];
  deferredPackets: ReviewPacket[];
}

/**
 * Encapsulates the budget-cap filtering logic.
 * Returns the subset of packets to emit this round plus deferred packets.
 */
export function filterPackets(
  packets: ReviewPacket[],
  sessionConfig: SessionConfig,
): FilterPacketsResult {
  const maxPackets = sessionConfig.dispatch?.max_packets;
  const budgetCapped =
    typeof maxPackets === "number" &&
    maxPackets >= 0 &&
    maxPackets < packets.length;
  const emitPackets = budgetCapped
    ? packets.slice(0, maxPackets)
    : packets;
  const deferredPackets = budgetCapped
    ? packets.slice(maxPackets)
    : [];

  return { emitPackets, deferredPackets };
}

/**
 * Encapsulates large-file anchor extraction for a single packet.
 * Appends to the provided warnings array on unavailability or failure.
 */
async function extractPacketAnchor(params: {
  packet: ReviewPacket;
  reviewRoot: string | undefined;
  bundle: Awaited<ReturnType<typeof loadArtifactBundle>>;
  taskResultsDir: string;
  warnings: Array<{ code: string; message: string }>;
}): Promise<{ anchorPath: string | null; anchorSummary: FileAnchorSummary | null }> {
  const { packet, reviewRoot, bundle, taskResultsDir, warnings } = params;
  if (!reviewRoot) {
    warnings.push({
      code: "large_file_anchor_unavailable",
      message: `large single-file packet ${packet.packet_id} has no repo root available for anchor extraction`,
    });
    return { anchorPath: null, anchorSummary: null };
  }
  try {
    const filePath = packet.file_paths[0]!;
    const totalLines = packet.file_line_counts[filePath] ?? packet.total_lines;
    const content = await readFile(withinRoot(reviewRoot, filePath), "utf8");
    const anchorSummary = buildFileAnchorSummary({
      path: filePath,
      content,
      totalLines,
      graphBundle: bundle.graph_bundle,
      externalAnalyzerResults: bundle.external_analyzer_results,
    });
    const anchorPath = join(taskResultsDir, artifactNameForId(packet.packet_id, "anchors.json"));
    await writeJsonFile(anchorPath, anchorSummary);
    return { anchorPath, anchorSummary };
  } catch (error) {
    warnings.push({
      code: "large_file_anchor_failed",
      message:
        `large single-file packet ${packet.packet_id} could not be anchored mechanically: ` +
        (error instanceof Error ? error.message : String(error)),
    });
    return { anchorPath: null, anchorSummary: null };
  }
}

/**
 * Extracts the per-task flatMap that builds task section lines.
 */
export function buildTaskSections(
  packetTasks: AuditTask[],
  lensDefs: Record<string, { description: string; do_not_report: string }>,
  lineIndex: Record<string, number>,
): string[] {
  return packetTasks.flatMap((task) => {
    const lensDef = lensDefs[task.lens];
    const inputLines = task.inputs
      ? Object.entries(task.inputs)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `input.${key}: ${value}`)
      : [];
    const isLensVerification = task.tags?.includes("lens_verification") ?? false;
    const coverageTemplate = task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts?.[path] ?? lineIndex[path] ?? 0,
    }));
    return [
      `### ${task.task_id}`,
      `unit_id: ${task.unit_id}`,
      `pass_id: ${task.pass_id}`,
      `lens: ${task.lens}`,
      ...(task.tags?.length ? [`tags: ${task.tags.join(", ")}`] : []),
      ...inputLines,
      `rationale: ${task.rationale}`,
      "",
      `Lens guidance: ${lensDef?.description ?? task.lens}`,
      `Do NOT report: ${lensDef?.do_not_report ?? "N/A"}`,
      ...(isLensVerification
        ? [
            "",
            "Lens verification mode: review the prior result summary in the rationale and use only targeted source checks.",
            "Do not redo every packet and do not write direct findings for this task.",
            "Return findings: [] plus verification metadata. Include followup_tasks only for bounded, specific re-review packets.",
          ]
        : []),
      "",
      "file_coverage (copy exactly into your AuditResult for this task):",
      "```json",
      JSON.stringify(coverageTemplate),
      "```",
      "",
    ];
  });
}

/**
 * Wraps the array-join block and returns the assembled prompt string.
 * Workers emit AuditResult[] inline in their response; the skill/host captures
 * and writes the JSON to `result_path` on their behalf. No shell submit command.
 */
export function buildPacketPrompt(params: {
  packet: ReviewPacket;
  packetTasks: AuditTask[];
  fileList: string;
  largeFileSection: string[];
  taskSections: string[];
  resultPath: string;
  repoRoot?: string;
  freeFormIntent?: string;
}): string {
  const { packet, fileList, largeFileSection, taskSections, resultPath, repoRoot, freeFormIntent } = params;
  const largeFileMode = isIsolatedLargeFilePacket(packet);
  const intentSection = freeFormIntent?.trim()
    ? ["## Audit intent", freeFormIntent.trim(), ""]
    : [];
  return [
    "You are a code auditor. Review this packet once, then emit exactly one result per listed task.",
    repoRoot ? `Repository root: ${repoRoot}` : "Repository root: use the root from the step contract.",
    "Set the shell/tool workdir to the repository root when running backend commands.",
    "",
    ...intentSection,
    "## Packet",
    `packet_id: ${packet.packet_id}`,
    `task_count: ${packet.task_ids.length}`,
    `lenses: ${packet.lenses.join(", ")}`,
    `estimated_tokens: ${packet.estimated_tokens}`,
    `result_path: ${resultPath}`,
    "",
    "## Files to read",
    largeFileMode
      ? "Use targeted Read/Grep calls. Paths are repo-relative to the repository root above."
      : "Use your Read tool. Paths are repo-relative to the repository root above.",
    "Use host Read and Grep tools for source inspection. Do not use shell search commands.",
    fileList,
    "",
    ...renderPacketGraphContext(packet),
    ...largeFileSection,
    "## Tasks",
    ...taskSections,
    "## Output",
    "Do not write files, run shell commands, or edit source files. Do not use a Write tool or",
    "create temp files. Produce one JSON array containing exactly one AuditResult object for",
    "each listed task and emit it INLINE in your response (do NOT write files yourself —",
    "the skill captures your inline payload and writes it to result_path on your behalf).",
    "Windows PowerShell: do not pipe an inline foreach statement directly into ConvertTo-Json.",
    "Assign the foreach output to a variable first, then pipe that variable to ConvertTo-Json.",
    "PowerShell also unwraps single-element arrays: @(@{...}) collapses to one object, so a",
    "one-result submission serializes as an object (not a 1-element array) and is rejected. Wrap it",
    "yourself: '[' + (ConvertTo-Json $obj -Depth 12) + ']', or build the array with Write-Output -NoEnumerate.",
    "",
    "Schema file (resolve relative to this prompt's directory): audit_result.schema.json",
    "  $refs resolved from the same directory: finding.schema.json, audit_task.schema.json",
    "You MAY validate your JSON array against the schema before emitting. This is optional.",
    "",
    "Required AuditResult fields:",
    "  task_id       copy from the task metadata",
    "  unit_id       copy from the task metadata",
    "  pass_id       copy from the task metadata",
    "  lens          copy from the task metadata",
    "  file_coverage [{path, total_lines}] - copy the exact template from each task section above. You MUST include total_lines. Do not omit or zero it out, as this will cause fatal validation errors.",
    "  findings      [] or array of finding objects",
    "",
    "Lens verification tasks:",
    "  tasks tagged lens_verification must use findings: [] and include verification:",
    "  {verified: boolean, needs_followup: boolean, concerns?: string[],",
    "   coverage_concerns?: string[], confidence_concerns?: string[],",
    "   followup_tasks?: AuditTask[]}.",
    "  Follow-up AuditTask suggestions must stay bounded to files in this packet and use the same lens.",
    "",
    "Each finding object:",
    "  id            unique ID, e.g. \"COR-001\"",
    "  title         short title",
    "  category      specific finding category, such as missing-validation or command-execution",
    "  severity      critical|high|medium|low|info",
    "  confidence    high|medium|low",
    "  lens          must match the task lens exactly",
    "  summary       1-2 sentence description",
    "  affected_files  [{path, line_start?, line_end?, symbol?}] - objects, not strings; min 1 entry",
    "  evidence     [\"path/to/file.ts:42 - description of what you see there\"] - min 1 entry",
    "",
    "Constraints:",
    "1. line_end must not exceed the file's actual line count.",
    "2. affected_files entries are objects with a path key, not plain strings.",
    "3. Only reference files from the packet unless a finding genuinely crosses a boundary.",
    "4. findings: [] is correct when you find nothing genuine.",
    "",
    "## Final response",
    `Emit the JSON array inline. Reply exactly: valid: ${packet.packet_id}, findings=<total finding count>`,
  ].join("\n");
}

interface ResolvedDispatchPool {
  /**
   * Capacity pools available to this dispatch — one per reported roster rank,
   * or a single pool for the scalar/absent handshake.
   */
  pools: CapacityPool[];
  hostModel: string | null;
  /**
   * Per-packet input-token ceiling for the INITIAL partition: the largest
   * rank's resolved context window minus its reserved output budget. Coherent
   * clusters partition under the most generous window first; the per-tier
   * re-fit pass then re-splits any packet routed to a smaller rank.
   */
  contextBudgetTokens: number;
  /**
   * Per-tier packet input budgets (context − output) when the host reported a
   * model roster; null for the single-window handshake (every tier shares
   * `contextBudgetTokens`).
   */
  tierBudgets: Record<DispatchModelTier, number> | null;
}

const TIER_ORDER: DispatchModelTier[] = ["small", "standard", "deep"];

/**
 * Fill per-tier budgets from the reported roster ranks. A tier the host did
 * not report falls back to the nearest reported rank (preferring the more
 * capable one on ties), mirroring how a host maps a tier hint onto its closest
 * available model.
 */
export function resolveTierBudgets(
  perRank: ReadonlyMap<DispatchModelTier, number>,
): Record<DispatchModelTier, number> {
  if (perRank.size === 0) {
    throw new Error("resolveTierBudgets requires at least one reported rank.");
  }
  const out = {} as Record<DispatchModelTier, number>;
  TIER_ORDER.forEach((tier, i) => {
    const direct = perRank.get(tier);
    if (direct !== undefined) {
      out[tier] = direct;
      return;
    }
    for (let distance = 1; distance < TIER_ORDER.length; distance++) {
      const up = TIER_ORDER[i + distance];
      const down = TIER_ORDER[i - distance];
      if (up && perRank.has(up)) {
        out[tier] = perRank.get(up)!;
        return;
      }
      if (down && perRank.has(down)) {
        out[tier] = perRank.get(down)!;
        return;
      }
    }
  });
  return out;
}

/**
 * Resolve the dispatching host pool(s) (host-model resolution, quota state
 * lookup, provider-limits query) and probe their resolved context budgets —
 * everything needed to size the JIT graph partition. The pools are reused by
 * `finalizeDispatchQuota` after packetization, so this work happens once.
 *
 * With a host model roster (`--host-models`), one pool is built per reported
 * rank, each with its own discovered window; otherwise the scalar handshake
 * (or nothing) yields the single conservative pool exactly as before.
 *
 * The probe runs `computeDispatchCapacity` with no pending work: resolved limits
 * are model-derived (not work-derived), so the context window is available
 * before any packet exists. This is the quota-before-packetization reorder.
 */
async function buildDispatchPool(params: {
  sessionConfig: SessionConfig;
  hostModel: string | null | undefined;
  queryLimits: ((model: string | null) => Promise<ProviderRateLimits | null>) | undefined;
  hostActiveSubagentLimit: number | null | undefined;
  /** Context window the host reports for its dispatch model (handshake). */
  hostContextTokens?: number | null;
  /** Output cap the host reports for its dispatch model (handshake). */
  hostOutputTokens?: number | null;
  /** Ordered model roster (lowest rank first); outranks the scalar pair. */
  hostModelRoster?: HostModelRosterEntry[] | null;
}): Promise<ResolvedDispatchPool> {
  const { sessionConfig, queryLimits, hostActiveSubagentLimit } = params;
  const quotaProviderName = resolveFreshSessionProviderName(undefined, sessionConfig);
  const hostModel = resolveHostModel({
    providerName: quotaProviderName,
    sessionConfig,
    explicitModel: params.hostModel,
    envVar: "AUDIT_CODE_HOST_MODEL",
  });
  const quotaProviderKey = buildProviderModelKey(quotaProviderName, hostModel);
  const quotaState = await readQuotaState().catch((): { version: 2; entries: Record<string, never> } => ({ version: 2, entries: {} }));
  const quotaStateEntry = quotaState.entries[quotaProviderKey] ?? null;
  const hostConcurrencyLimit = resolveHostActiveSubagentLimit({
    explicitLimit: hostActiveSubagentLimit,
    sessionConfig,
  });
  const providerLimits: DiscoveredRateLimits | null =
    await queryLimits?.(hostModel)
      .then((r) => r ? { ...r, source: "provider_query" } : null)
      .catch(() => null)
    ?? null;
  const dispatchCachedLimits = await lookupDiscoveredLimits(quotaProviderKey).catch(() => null);
  const halfLifeHours =
    sessionConfig.quota?.empirical_half_life_hours ??
    DEFAULT_EMPIRICAL_HALF_LIFE_HOURS;
  const quotaSource = buildQuotaSource({ halfLifeHours });
  const quotaSourceSnapshot = await quotaSource.queryCurrentUsage(quotaProviderKey).catch(() => null);

  // The capability handshake limits are merged FIRST so they outrank the
  // queried and cached limits for context/output (the discovered-capability
  // rung then sizes the partition to the real window). RPM/TPM stay null in
  // the capability entry and fill from the queried/cached sources.
  const buildPool = (
    capability: DiscoveredRateLimits | null,
    rank?: DispatchModelTier,
  ): CapacityPool => ({
    id: quotaProviderKey,
    providerName: quotaProviderName,
    hostModel,
    ...(rank ? { rank } : {}),
    hostConcurrencyLimit,
    quotaStateEntry,
    discoveredLimits: mergeDiscoveredLimits(
      capability,
      providerLimits,
      dispatchCachedLimits,
    ),
    quotaSourceSnapshot,
  });
  const probeBudget = (pool: CapacityPool): number => {
    const probe = computeDispatchCapacity({
      pools: [pool],
      sessionConfig,
      pendingItemTokens: [],
    });
    const limits = probe.primary.schedule.resolved_limits;
    return Math.max(1, limits.context_tokens - limits.output_tokens);
  };

  const roster = params.hostModelRoster ?? null;
  if (roster && roster.length > 0) {
    const pools: CapacityPool[] = [];
    const perRank = new Map<DispatchModelTier, number>();
    for (const entry of roster) {
      const pool = buildPool(
        {
          context_tokens: entry.context_tokens,
          output_tokens: entry.output_tokens,
          source: "host_capability",
        },
        entry.rank,
      );
      pools.push(pool);
      perRank.set(entry.rank, probeBudget(pool));
    }
    const tierBudgets = resolveTierBudgets(perRank);
    return {
      pools,
      hostModel,
      contextBudgetTokens: Math.max(...Object.values(tierBudgets)),
      tierBudgets,
    };
  }

  // Single-window handshake (scalar shorthand) or no handshake at all: one
  // pool, conservative floor when nothing was reported — unchanged behavior.
  const hostCapabilityLimits: DiscoveredRateLimits | null =
    params.hostContextTokens != null || params.hostOutputTokens != null
      ? {
          context_tokens: params.hostContextTokens ?? null,
          output_tokens: params.hostOutputTokens ?? null,
          source: "host_capability",
        }
      : null;
  const hostPool = buildPool(hostCapabilityLimits);
  return {
    pools: [hostPool],
    hostModel,
    contextBudgetTokens: probeBudget(hostPool),
    tierBudgets: null,
  };
}

/**
 * Compute just-in-time dispatch capacity for the already-resolved pool against
 * the real per-packet token layout, and write the dispatch-quota artifact.
 * Runs AFTER packetization so capacity reflects the actual partitioned packets.
 */
async function finalizeDispatchQuota(params: {
  runId: string;
  runDir: string;
  sessionConfig: SessionConfig;
  pools: CapacityPool[];
  hostModel: string | null;
  perPacketTokens: number[];
  /** Echo of the host's reported roster, when one was given. */
  hostModelRoster?: HostModelRosterEntry[] | null;
  /** Per-tier packet input budgets derived from the roster, when given. */
  tierBudgets?: Record<DispatchModelTier, number> | null;
}): Promise<{
  dispatchQuota: DispatchQuota;
  dispatchQuotaPath: string;
  waveSchedule: ReturnType<typeof computeDispatchCapacity>["primary"]["schedule"];
  dispatchCapacity: ReturnType<typeof computeDispatchCapacity>;
}> {
  const { runId, runDir, sessionConfig, hostModel, perPacketTokens } = params;
  // Most-capable rank first: computeDispatchCapacity hands the largest pending
  // items to the first pool, and the biggest packets belong on the rank with
  // the largest window.
  const rankOrder = (pool: CapacityPool): number =>
    pool.rank ? TIER_ORDER.indexOf(pool.rank) : TIER_ORDER.length;
  const pools = [...params.pools].sort((a, b) => rankOrder(b) - rankOrder(a));
  const dispatchCapacity = computeDispatchCapacity({
    pools,
    sessionConfig,
    pendingItemTokens: perPacketTokens,
  });
  const waveSchedule = dispatchCapacity.primary.schedule;
  const dispatchQuota: DispatchQuota = {
    contract_version: "audit-code-dispatch-quota/v1alpha2",
    run_id: runId,
    model: hostModel,
    resolved_limits: waveSchedule.resolved_limits,
    confidence: waveSchedule.confidence,
    source: waveSchedule.source,
    host_concurrency_limit: waveSchedule.host_concurrency_limit,
    max_concurrent_agents: dispatchCapacity.total_slots,
    cooldown_until: dispatchCapacity.cooldown_until,
    binding_cap: dispatchCapacity.binding_cap,
    capacity_pools: summarizeDispatchCapacityPools(dispatchCapacity),
    ...(params.hostModelRoster?.length
      ? { host_model_roster: params.hostModelRoster }
      : {}),
    ...(params.tierBudgets ? { tier_budgets: params.tierBudgets } : {}),
    quota_source_snapshot: waveSchedule.quota_source_snapshot ?? null,
    backoff_state: null,
  };
  const dispatchQuotaPath = join(runDir, "dispatch-quota.json");
  await writeJsonFile(dispatchQuotaPath, dispatchQuota);
  return { dispatchQuota, dispatchQuotaPath, waveSchedule, dispatchCapacity };
}

/**
 * Resolve the task-affinity graph to partition at dispatch: prefer the persisted
 * provider-neutral graph (built + frozen at planning) restricted to the still-
 * pending tasks; fall back to building one from the dispatch tasks when the
 * persisted graph is missing or doesn't cover every pending task (older
 * artifacts or freshly generated tasks). Frozen per-task estimates live on the
 * tasks, so a rebuild reuses the same node numbers.
 */
function resolveDispatchTaskGraph(
  bundle: ArtifactBundle,
  orderedTasks: AuditTask[],
): TaskAffinityGraph {
  const pendingIds = new Set(orderedTasks.map((task) => task.task_id));
  const persisted = bundle.task_affinity_graph;
  if (persisted && persisted.nodes.length > 0) {
    const covered = persisted.nodes.filter((node) =>
      pendingIds.has(node.task_id),
    ).length;
    if (covered === pendingIds.size) {
      return filterTaskAffinityGraph(persisted, pendingIds);
    }
  }
  return buildTaskAffinityGraph(orderedTasks, {
    graphBundle: bundle.graph_bundle,
  });
}

/**
 * Per-tier re-fit pass (partition-then-validate, design (a) of the roster
 * handshake): the initial partition runs under the LARGEST reported window so
 * coherent clusters are not over-split, but risk routing may then assign a
 * packet to a rank with a smaller window. Re-partition just that packet's
 * subgraph under its assigned tier's budget. The re-split sub-packets get
 * their own tiers, so iterate to a bounded fixed point; a packet that cannot
 * split further (single task, or the partition refuses) is left for the
 * oversized-packet warning.
 */
export function fitPacketsToTierBudgets(params: {
  packets: ReviewPacket[];
  taskGraph: TaskAffinityGraph;
  orderedTasks: AuditTask[];
  tierBudgets: Record<DispatchModelTier, number>;
  sessionConfig: SessionConfig;
  lineIndex?: Record<string, number>;
  sizeIndex?: Record<string, number>;
  graphBundle?: GraphBundle;
}): ReviewPacket[] {
  const { tierBudgets, sessionConfig } = params;
  let packets = params.packets;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const next: ReviewPacket[] = [];
    for (const packet of packets) {
      const hint = resolveDispatchTier({
        routingRisk: packet.routing_risk,
        complexity: buildDispatchComplexity(
          packet,
          isIsolatedLargeFilePacket(packet),
        ),
        routingTiers: sessionConfig.dispatch?.routing_tiers,
      });
      if (
        packet.estimated_tokens <= tierBudgets[hint.tier] ||
        packet.task_ids.length <= 1
      ) {
        next.push(packet);
        continue;
      }
      const memberIds = new Set(packet.task_ids);
      const subPackets = buildReviewPacketsFromPartition(
        params.orderedTasks.filter((task) => memberIds.has(task.task_id)),
        {
          graph: filterTaskAffinityGraph(params.taskGraph, memberIds),
          contextTokenBudget: tierBudgets[hint.tier],
          riskMassBudget: sessionConfig.dispatch?.risk_mass_budget,
          graphBundle: params.graphBundle,
          lineIndex: params.lineIndex,
          sizeIndex: params.sizeIndex,
        },
      );
      if (subPackets.length <= 1) {
        next.push(packet);
        continue;
      }
      next.push(...subPackets);
      changed = true;
    }
    packets = next;
    if (!changed) break;
  }
  return packets;
}

/**
 * Extracts the context-budget warning loop.
 * Returns warnings for packets whose estimated token count exceeds the context
 * budget — the assigned tier's budget when the host reported a roster, the
 * single resolved window otherwise.
 * When confidence is 'low', returns an empty array (limits are unreliable).
 */
export function collectOversizedWarnings(
  plan: Array<{
    packet_id: string;
    complexity: DispatchComplexity;
    model_hint?: DispatchModelHint;
  }>,
  waveSchedule: { confidence: string; resolved_limits: { context_tokens: number; output_tokens: number } },
  tierBudgets?: Record<DispatchModelTier, number> | null,
): Array<{ code: string; message: string }> {
  if (waveSchedule.confidence === "low") {
    return [];
  }
  const fallbackBudget =
    waveSchedule.resolved_limits.context_tokens - waveSchedule.resolved_limits.output_tokens;
  const warnings: Array<{ code: string; message: string }> = [];
  for (const p of plan) {
    const tier = p.model_hint?.tier;
    const contextBudget =
      tierBudgets && tier ? tierBudgets[tier] : fallbackBudget;
    if (p.complexity.estimated_tokens > contextBudget) {
      warnings.push({
        code: "oversized_packet",
        message:
          `Packet ${p.packet_id} estimated tokens (${p.complexity.estimated_tokens}) exceed ` +
          `context budget (${contextBudget}). This packet may fail at dispatch. ` +
          `Set quota.default_context_tokens or quota.models in session-config.json to override.`,
      });
    }
  }
  return warnings;
}

export async function prepareDispatchArtifacts(params: {
  packageRoot: string;
  runId: string;
  artifactsDir: string;
  root?: string;
  sessionConfig?: SessionConfig;
  hostModel?: string | null;
  queryLimits?: (model: string | null) => Promise<ProviderRateLimits | null>;
  hostActiveSubagentLimit?: number | null;
  /** Context window the host reports for its dispatch model (handshake). */
  hostContextTokens?: number | null;
  /** Output cap the host reports for its dispatch model (handshake). */
  hostOutputTokens?: number | null;
  /** Ordered model roster (lowest rank first); outranks the scalar pair. */
  hostModelRoster?: HostModelRosterEntry[] | null;
}): Promise<PrepareDispatchResult> {
  const runId = params.runId;
  const artifactsDir = params.artifactsDir;
  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  const dispatchPlanPath = join(runDir, "dispatch-plan.json");
  let reviewRoot = params.root;
  try {
    const workerTask = await readJsonFile<WorkerTask>(join(runDir, "task.json"));
    reviewRoot ??= workerTask.repo_root;
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }

  const bundle = await loadArtifactBundle(artifactsDir);
  const tasksPath = join(runDir, "pending-audit-tasks.json");
  const tasks = await readJsonFile<AuditTask[]>(tasksPath).catch(async (error) => {
    if (isFileMissingError(error)) {
      const generated = buildPendingAuditTasks(bundle);
      await writeJsonFile(tasksPath, generated);
      return generated;
    }
    throw error;
  });
  const sessionConfig: SessionConfig =
    params.sessionConfig ?? (await loadSessionConfig(artifactsDir).catch(() => ({} as SessionConfig)));
  const lensDefsPath = join(params.packageRoot, "dispatch", "lens-definitions.json");
  const lensDefs = await readJsonFile<Record<string, { description: string; do_not_report: string }>>(lensDefsPath);

  await mkdir(taskResultsDir, { recursive: true });

  // FINDING-009: make the AuditResult JSON-Schema (and the two sibling schemas
  // it $refs) reachable from this run's task-results directory so packet workers
  // can optionally self-validate before calling submit-packet.
  await writePacketSchemaFiles(taskResultsDir, params.packageRoot);

  const priorResultTaskIds = new Set<string>();
  for (const task of tasks) {
    if (existsSync(taskResultPath(taskResultsDir, task.task_id))) {
      priorResultTaskIds.add(task.task_id);
    }
  }
  const dispatchTasks = priorResultTaskIds.size > 0
    ? tasks.filter((task) => !priorResultTaskIds.has(task.task_id))
    : tasks;

  const lineIndex = Object.fromEntries(
    dispatchTasks.flatMap((task) =>
      Object.entries(task.file_line_counts ?? {}),
    ),
  );
  const sizeIndex = sizeIndexFromManifest(bundle.repo_manifest);
  const orderedTasks = orderTasksForPacketReview(dispatchTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex,
  });

  // Quota-before-packetization: resolve the dispatching model's context budget
  // first, then partition the provider-neutral task-affinity graph into packets
  // sized to that budget (JIT). This replaces the frozen plan-time packet cap —
  // a run started under one model re-partitions cleanly under another's window.
  const dispatchPool = await buildDispatchPool({
    sessionConfig,
    hostModel: params.hostModel,
    queryLimits: params.queryLimits,
    hostActiveSubagentLimit: params.hostActiveSubagentLimit,
    hostContextTokens: params.hostContextTokens,
    hostOutputTokens: params.hostOutputTokens,
    hostModelRoster: params.hostModelRoster,
  });
  const taskGraph = resolveDispatchTaskGraph(bundle, orderedTasks);
  let packets = buildReviewPacketsFromPartition(orderedTasks, {
    graph: taskGraph,
    contextTokenBudget: dispatchPool.contextBudgetTokens,
    riskMassBudget: sessionConfig.dispatch?.risk_mass_budget,
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex,
  });
  if (dispatchPool.tierBudgets) {
    packets = fitPacketsToTierBudgets({
      packets,
      taskGraph,
      orderedTasks,
      tierBudgets: dispatchPool.tierBudgets,
      sessionConfig,
      lineIndex,
      sizeIndex,
      graphBundle: bundle.graph_bundle,
    });
  }
  const tasksById = new Map(orderedTasks.map((task) => [task.task_id, task]));
  const resultPathByTaskId = new Map(
    orderedTasks.map((task) => [
      task.task_id,
      taskResultPath(taskResultsDir, task.task_id),
    ]),
  );
  const resultPathSet = new Set(resultPathByTaskId.values());
  if (resultPathSet.size !== resultPathByTaskId.size) {
    throw new Error(
      "prepare-dispatch generated duplicate result paths; task ids must be uniquely addressable.",
    );
  }

  // Packets come back priority-ordered (high -> medium -> low), so packets[0] is
  // the top-priority packet. Budget cap (top-K) is the only filter.
  //
  // FINDING-013: top-K coverage budget. Budget defaults OFF (no cap) so default
  // behavior is unchanged.
  const { emitPackets, deferredPackets } =
    filterPackets(packets, sessionConfig);
  const budgetCapped = deferredPackets.length > 0;

  const plan: DispatchPlanEntry[] = [];
  const resultMapEntries: DispatchResultMapEntry[] = [];
  for (const task of tasks) {
    if (priorResultTaskIds.has(task.task_id)) {
      resultMapEntries.push({
        packet_id: "__prior_dispatch__",
        task_id: task.task_id,
        result_path: taskResultPath(taskResultsDir, task.task_id),
      });
    }
  }
  let largestPacketId: string | null = null;
  let largestLines = 0;
  let largestEstimatedTokens = 0;
  const warnings: Array<{ code: string; message: string }> = [];

  for (const packet of emitPackets) {
    const promptPath = packetPromptPath(taskResultsDir, packet.packet_id);
    const packetTasks = packet.task_ids
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is AuditTask => task !== undefined);

    if (packet.total_lines > largestLines) {
      largestLines = packet.total_lines;
      largestEstimatedTokens = packet.estimated_tokens;
      largestPacketId = packet.packet_id;
    }
    const largeFileMode = isIsolatedLargeFilePacket(packet);
    if (packet.total_lines > LARGE_FILE_PACKET_TARGET_LINES && !largeFileMode) {
      warnings.push({
        code: "large_packet",
        message: `large packet ${packet.packet_id} (~${packet.total_lines} lines) may hit quota limits`,
      });
    }

    for (const task of packetTasks) {
      if (!lensDefs[task.lens]) {
        warnings.push({
          code: "missing_lens_definition",
          message: `no lens definition for '${task.lens}' (task ${task.task_id})`,
        });
      }
    }

    const fileList = packet.file_paths.map((path) => {
      const lines = packet.file_line_counts[path] ?? 0;
      return `- ${path} (${lines} lines)`;
    }).join("\n");
    const { anchorPath, anchorSummary } = largeFileMode
      ? await extractPacketAnchor({ packet, reviewRoot, bundle, taskResultsDir, warnings })
      : { anchorPath: null, anchorSummary: null };
    const largeFileSection =
      anchorSummary && anchorPath
        ? renderAnchorPreview(anchorSummary, anchorPath)
        : largeFileMode
          ? [
              "## Large File Review Mode",
              "This packet is intentionally isolated because it covers one large file.",
              "Use targeted reads/searches within this file only.",
              "No mechanical anchor file was available, so rely on targeted symbol and keyword searches before reading broad ranges.",
              "",
            ]
          : [];
    const taskSections = buildTaskSections(packetTasks, lensDefs, lineIndex);
    // Inline emit: the worker emits AuditResult[] in their response; the
    // skill/host captures and writes to packetResultPath. Per-task result paths
    // are kept in the result map for ingestion after capture.
    const packetResultPath = join(taskResultsDir, artifactNameForId(packet.packet_id, "inline-result.json"));
    const complexity = buildDispatchComplexity(packet, largeFileMode);
    for (const task of packetTasks) {
      resultMapEntries.push({
        packet_id: packet.packet_id,
        task_id: task.task_id,
        result_path: resultPathByTaskId.get(task.task_id)!,
      });
    }

    const prompt = buildPacketPrompt({ packet, packetTasks, fileList, largeFileSection, taskSections, resultPath: packetResultPath, repoRoot: reviewRoot, freeFormIntent: bundle.intent_checkpoint?.free_form_intent });
    await writeFile(promptPath, prompt, "utf8");
    const packetWritePaths = packetTasks
      .map((task) => resultPathByTaskId.get(task.task_id))
      .filter((p): p is string => p !== undefined);
    plan.push({
      packet_id: packet.packet_id,
      description:
        `Audit ${packet.file_paths.length} file(s), ${packet.task_ids.length} task(s), ${packet.lenses.length} lens(es) (~${packet.total_lines} lines)` +
        (largeFileMode ? " [isolated large-file mode]" : ""),
      prompt_path: promptPath,
      result_path: packetResultPath,
      complexity,
      model_hint: resolveDispatchTier({
        routingRisk: packet.routing_risk,
        complexity,
        routingTiers: sessionConfig.dispatch?.routing_tiers,
      }),
      access: {
        read_paths: [
          promptPath,
          ...(reviewRoot
            ? packet.file_paths.map((p) => join(reviewRoot, p))
            : packet.file_paths),
        ],
        write_paths: packetWritePaths,
        forbidden_patterns: ["packet-*-result.json", "audit_result_*.json"],
      },
    });
  }

  await writeJsonFile(dispatchPlanPath, plan);
  await writeJsonFile(dispatchResultMapPath(runDir), {
    contract_version: "audit-code-dispatch-results/v1alpha1",
    run_id: runId,
    entries: resultMapEntries,
  } satisfies DispatchResultMap);

  const perPacketTokens = plan.map((p) => p.complexity.estimated_tokens);
  // Size the dispatch just-in-time against the partitioned packet layout (one
  // token estimate per emitted packet) and the host pool resolved above, rather
  // than a preset wave size. `parallel_workers` is no longer the ambition — it
  // is folded into hostConcurrencyLimit as a ceiling. Today there is a single
  // pool (the conversation host's subagents); a heterogeneous provider pool
  // slots in here without changing the call.
  const { dispatchQuotaPath, waveSchedule, dispatchCapacity } = await finalizeDispatchQuota({
    runId,
    runDir,
    sessionConfig,
    pools: dispatchPool.pools,
    hostModel: dispatchPool.hostModel,
    perPacketTokens,
    hostModelRoster: params.hostModelRoster,
    tierBudgets: dispatchPool.tierBudgets,
  });

  warnings.push(
    ...collectOversizedWarnings(plan, waveSchedule, dispatchPool.tierBudgets),
  );

  const warningsPath = warnings.length > 0
    ? join(runDir, "dispatch-warnings.json")
    : null;
  if (warningsPath) {
    await writeJsonFile(warningsPath, warnings);
  }

  // FINDING-013: record deferred packets/tasks so the completion obligation can
  // exclude them under a budget cap (present only when actually capped).
  const deferredPacketIds = deferredPackets.map((packet) => packet.packet_id);
  const deferredTaskIds = deferredPackets.flatMap((packet) => packet.task_ids);
  const activeDispatch: ActiveDispatchState = {
    run_id: runId,
    created_at: new Date().toISOString(),
    packet_count: plan.length,
    task_count: orderedTasks.length,
    status: "active",
    ...(budgetCapped
      ? {
          budget_packet_count: packets.length,
          deferred_packet_ids: deferredPacketIds,
          deferred_task_ids: deferredTaskIds,
        }
      : {}),
  };
  await writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), activeDispatch);

  // FINDING-012: pure-arithmetic fan-out summary the loader can gate on.
  const fanout = computeDispatchFanout({
    agentCount: plan.length,
    maxConcurrent: dispatchCapacity.total_slots,
    confirmThreshold: sessionConfig.dispatch?.confirm_threshold,
  });

  return {
    run_id: runId,
    dispatch_plan_path: dispatchPlanPath,
    dispatch_quota_path: dispatchQuotaPath,
    packet_count: plan.length,
    task_count: orderedTasks.length,
    skipped_task_count: priorResultTaskIds.size,
    max_concurrent_agents: dispatchCapacity.total_slots,
    agent_count: fanout.agent_count,
    confirmation_recommended: fanout.confirmation_recommended,
    dispatch_summary: fanout.dispatch_summary,
    budget_capped: budgetCapped,
    deferred_packet_count: deferredPackets.length,
    largest_packet: largestPacketId
      ? {
          packet_id: largestPacketId,
          total_lines: largestLines,
          estimated_tokens: largestEstimatedTokens,
        }
      : null,
    warning_count: warnings.length,
    dispatch_warnings_path: warningsPath,
  };
}
