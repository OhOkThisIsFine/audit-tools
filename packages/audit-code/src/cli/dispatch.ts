import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
  DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
} from "@audit-tools/shared";
import type { ProviderRateLimits, SessionConfig, DispatchModelHint } from "@audit-tools/shared";
import { buildQuotaSource } from "@audit-tools/shared/quota/compositeQuotaSource";
import type { ArtifactBundle } from "../io/artifacts.js";
import { loadArtifactBundle } from "../io/artifacts.js";
import type { AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import {
  orderTasksForPacketReview,
  buildReviewPackets,
  sizeIndexFromManifest,
} from "../orchestrator/reviewPackets.js";
import { buildFileAnchorSummary, type FileAnchorSummary } from "../orchestrator/fileAnchors.js";
import { resolveFreshSessionProviderName } from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import {
  scheduleWave,
  buildProviderModelKey,
  resolveHostModel,
  readQuotaState,
  resolveHostActiveSubagentLimit,
  lookupDiscoveredLimits,
  mergeDiscoveredLimits,
} from "../quota/index.js";
import type { DiscoveredRateLimits, DispatchQuota } from "../quota/index.js";
import {
  taskResultPath,
  packetPromptPath,
  artifactNameForId,
  toBase64Url,
  fromBase64Url,
  getFlag,
} from "./args.js";

export const LARGE_FILE_PACKET_TARGET_LINES = 2500;
export const SMALL_MODEL_HINT_MAX_LINES = 500;
export const SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS = 3000;
export const DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS = 9000;

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

export const DISPATCH_RESULT_MAP_FILENAME = "dispatch-result-map.json";
export const ACTIVE_DISPATCH_FILENAME = "active-dispatch.json";

export interface ActiveDispatchState {
  run_id: string;
  created_at: string;
  packet_count: number;
  task_count: number;
  status: "active" | "merged";
}

export interface DispatchResultMapEntry {
  packet_id: string;
  task_id: string;
  result_path: string;
}

export interface DispatchResultMap {
  contract_version: "audit-code-dispatch-results/v1alpha1";
  run_id: string;
  entries: DispatchResultMapEntry[];
}

export interface PrepareDispatchResult {
  run_id: string;
  dispatch_plan_path: string;
  dispatch_quota_path: string | null;
  packet_count: number;
  task_count: number;
  skipped_task_count: number;
  /** Subagent parallelism resolved for this dispatch run. */
  wave_size: number;
  largest_packet: {
    packet_id: string;
    total_lines: number;
    estimated_tokens: number;
  } | null;
  warning_count: number;
  dispatch_warnings_path: string | null;
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

export function buildDispatchModelHint(complexity: DispatchComplexity): DispatchModelHint {
  const deepReasons: string[] = [];
  if (complexity.priority === "high") deepReasons.push("high_priority");
  if (complexity.large_file_mode) deepReasons.push("isolated_large_file");
  if (complexity.estimated_tokens >= DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS) {
    deepReasons.push("high_estimated_tokens");
  }
  if (
    complexity.tags.some(
      (tag) => tag === "critical_flow" || tag.startsWith("critical_flow:"),
    )
  ) {
    deepReasons.push("critical_flow");
  }
  if (
    complexity.tags.some(
      (tag) =>
        tag === "external_analyzer_signal" || tag.startsWith("external_tool:"),
    )
  ) {
    deepReasons.push("external_analyzer_signal");
  }
  if (complexity.tags.includes("lens_verification")) {
    deepReasons.push("lens_verification");
  }
  if (deepReasons.length > 0) {
    return { tier: "deep", reasons: deepReasons };
  }

  const sensitiveLenses = new Set(["security", "data_integrity", "reliability"]);
  const hasSensitiveLens = complexity.lenses.some((lens) =>
    sensitiveLenses.has(lens),
  );
  if (
    complexity.priority === "low" &&
    complexity.total_lines <= SMALL_MODEL_HINT_MAX_LINES &&
    complexity.estimated_tokens <= SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS &&
    !hasSensitiveLens &&
    complexity.tags.length === 0
  ) {
    return { tier: "small", reasons: ["small_low_priority_packet"] };
  }

  const reasons: string[] = [];
  if (complexity.priority === "medium") reasons.push("medium_priority");
  if (hasSensitiveLens) reasons.push("sensitive_lens");
  if (complexity.total_lines > SMALL_MODEL_HINT_MAX_LINES) {
    reasons.push("moderate_size");
  }
  return {
    tier: "standard",
    reasons: reasons.length > 0 ? reasons : ["default_review_packet"],
  };
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

export async function prepareDispatchArtifacts(params: {
  packageRoot: string;
  runId: string;
  artifactsDir: string;
  root?: string;
  sessionConfig?: SessionConfig;
  hostModel?: string | null;
  queryLimits?: (model: string | null) => Promise<ProviderRateLimits | null>;
  hostActiveSubagentLimit?: number | null;
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
  const packets = buildReviewPackets(orderedTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex,
  });
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
  const plan: Array<{
    packet_id: string;
    description: string;
    prompt_path: string;
    complexity: DispatchComplexity;
    model_hint: DispatchModelHint;
  }> = [];
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

  for (const packet of packets) {
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
    let anchorPath: string | null = null;
    let anchorSummary: FileAnchorSummary | null = null;
    if (largeFileMode) {
      const filePath = packet.file_paths[0]!;
      if (!reviewRoot) {
        warnings.push({
          code: "large_file_anchor_unavailable",
          message: `large single-file packet ${packet.packet_id} has no repo root available for anchor extraction`,
        });
      } else {
        try {
          const totalLines = packet.file_line_counts[filePath] ?? packet.total_lines;
          const content = await readFile(withinRoot(reviewRoot, filePath), "utf8");
          anchorSummary = buildFileAnchorSummary({
            path: filePath,
            content,
            totalLines,
            graphBundle: bundle.graph_bundle,
            externalAnalyzerResults: bundle.external_analyzer_results,
          });
          anchorPath = join(taskResultsDir, artifactNameForId(packet.packet_id, "anchors.json"));
          await writeJsonFile(anchorPath, anchorSummary);
        } catch (error) {
          warnings.push({
            code: "large_file_anchor_failed",
            message:
              `large single-file packet ${packet.packet_id} could not be anchored mechanically: ` +
              (error instanceof Error ? error.message : String(error)),
          });
        }
      }
    }
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
    const taskSections = packetTasks.flatMap((task) => {
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
    const submitCommand =
      `node packages/audit-code/audit-code.mjs submit-packet ` +
      `--run-id-b64 ${toBase64Url(runId)} ` +
      `--packet-id-b64 ${toBase64Url(packet.packet_id)} ` +
      `--artifacts-dir-b64 ${toBase64Url(artifactsDir)}`;
    const complexity = buildDispatchComplexity(packet, largeFileMode);
    for (const task of packetTasks) {
      resultMapEntries.push({
        packet_id: packet.packet_id,
        task_id: task.task_id,
        result_path: resultPathByTaskId.get(task.task_id)!,
      });
    }

    const prompt = [
      "You are a code auditor. Review this packet once, then submit exactly one result per listed task.",
      "",
      "## Packet",
      `packet_id: ${packet.packet_id}`,
      `task_count: ${packet.task_ids.length}`,
      `lenses: ${packet.lenses.join(", ")}`,
      `estimated_tokens: ${packet.estimated_tokens}`,
      "",
      "## Files to read",
      largeFileMode
        ? "Use targeted Read/Grep calls. Paths are repo-relative from the current working directory."
        : "Use your Read tool. Paths are repo-relative from the current working directory.",
      "Use host Read and Grep tools for source inspection. Do not use shell search commands.",
      fileList,
      "",
      ...renderPacketGraphContext(packet),
      ...largeFileSection,
      "## Tasks",
      ...taskSections,
      "## Output",
      "Do not write files directly. Do not use a Write tool, create temp files, edit source files,",
      "remediate findings, run unrelated audits, or write any result file yourself (e.g.",
      "packet-*-result.json / audit_result_*.json) — the submit-packet command below is the only",
      "way to record results, and it writes them inside the artifacts directory for you.",
      "Produce one JSON array containing exactly one AuditResult object for each listed task.",
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
      "## Submit",
      "Pipe the JSON array on stdin to this command:",
      `  ${submitCommand}`,
      "  (If using Windows PowerShell, you MUST use `Get-Content <file> | & <command>` instead of the `<` operator.)",
      "",
      "The command validates and writes the packet-owned result files. Exit 0 means accepted.",
      "Non-zero: read the errors, fix the JSON, and run the same submit command again. Retry up to 3 times.",
      "",
      "## Final response",
      `After the submit command succeeds, reply exactly: valid: ${packet.packet_id}, findings=<total finding count>`,
    ].join("\n");

    await writeFile(promptPath, prompt, "utf8");
    plan.push({
      packet_id: packet.packet_id,
      description:
        `Audit ${packet.file_paths.length} file(s), ${packet.task_ids.length} task(s), ${packet.lenses.length} lens(es) (~${packet.total_lines} lines)` +
        (largeFileMode ? " [isolated large-file mode]" : ""),
      prompt_path: promptPath,
      complexity,
      model_hint: buildDispatchModelHint(complexity),
    });
  }

  await writeJsonFile(dispatchPlanPath, plan);
  await writeJsonFile(dispatchResultMapPath(runDir), {
    contract_version: "audit-code-dispatch-results/v1alpha1",
    run_id: runId,
    entries: resultMapEntries,
  } satisfies DispatchResultMap);

  const perPacketTokens = plan.map((p) => p.complexity.estimated_tokens);
  const quotaProviderName = resolveFreshSessionProviderName(undefined, sessionConfig);
  // Resolve the host model (explicit/CLI override → block_quota.host_model → env
  // → per-provider default) so per-model quota detection engages with realistic
  // limits instead of the conservative unknown-model floor. params.hostModel
  // carries any caller/CLI override.
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
    explicitLimit: params.hostActiveSubagentLimit,
    sessionConfig,
  });
  const providerLimits: DiscoveredRateLimits | null =
    await params.queryLimits?.(hostModel)
      .then((r) => r ? { ...r, source: "provider_query" } : null)
      .catch(() => null)
    ?? null;
  const dispatchCachedLimits = await lookupDiscoveredLimits(quotaProviderKey).catch(() => null);
  const discoveredLimits = mergeDiscoveredLimits(providerLimits, dispatchCachedLimits);
  const halfLifeHours =
    sessionConfig.quota?.empirical_half_life_hours ??
    DEFAULT_EMPIRICAL_HALF_LIFE_HOURS;
  const quotaSource = buildQuotaSource({ halfLifeHours });
  const quotaSourceSnapshot = await quotaSource.queryCurrentUsage(quotaProviderKey).catch(() => null);
  const waveSchedule = scheduleWave({
    providerName: quotaProviderName,
    sessionConfig,
    hostModel,
    requestedConcurrency: sessionConfig.parallel_workers ?? plan.length,
    estimatedSlotTokens: perPacketTokens,
    quotaStateEntry,
    hostConcurrencyLimit,
    discoveredLimits,
    quotaSourceSnapshot,
  });
  const dispatchQuota: DispatchQuota = {
    contract_version: "audit-code-dispatch-quota/v1alpha2",
    run_id: runId,
    model: hostModel,
    resolved_limits: waveSchedule.resolved_limits,
    confidence: waveSchedule.confidence,
    source: waveSchedule.source,
    host_concurrency_limit: waveSchedule.host_concurrency_limit,
    wave_size: waveSchedule.wave_size,
    estimated_wave_tokens: waveSchedule.estimated_wave_tokens,
    cooldown_until: waveSchedule.cooldown_until,
    quota_source_snapshot: waveSchedule.quota_source_snapshot ?? null,
    backoff_state: null,
  };
  const dispatchQuotaPath = join(runDir, "dispatch-quota.json");
  await writeJsonFile(dispatchQuotaPath, dispatchQuota);

  if (waveSchedule.confidence !== "low") {
    const contextBudget =
      waveSchedule.resolved_limits.context_tokens - waveSchedule.resolved_limits.output_tokens;
    for (const p of plan) {
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
  }

  const warningsPath = warnings.length > 0
    ? join(runDir, "dispatch-warnings.json")
    : null;
  if (warningsPath) {
    await writeJsonFile(warningsPath, warnings);
  }
  const activeDispatch: ActiveDispatchState = {
    run_id: runId,
    created_at: new Date().toISOString(),
    packet_count: plan.length,
    task_count: orderedTasks.length,
    status: "active",
  };
  await writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), activeDispatch);

  return {
    run_id: runId,
    dispatch_plan_path: dispatchPlanPath,
    dispatch_quota_path: dispatchQuotaPath,
    packet_count: plan.length,
    task_count: orderedTasks.length,
    skipped_task_count: priorResultTaskIds.size,
    wave_size: waveSchedule.wave_size,
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
