import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "audit-tools/shared";
import type { AuditTask } from "../../types.js";
import type { ReviewPacket } from "../../types/reviewPlanning.js";
import type { ArtifactBundle } from "../../io/artifacts.js";
import {
  analyzerSignalAnchorsForPath,
  buildFileAnchorSummary,
  type AnalyzerSignalAnchorIndex,
  type FileAnchorSummary,
} from "../../orchestrator/fileAnchors.js";
import {
  classifyKnipLead,
  type KnipGraphIndex,
} from "../../orchestrator/knipGraphCrosscheck.js";
import { artifactNameForId } from "../args.js";
import { withinRoot } from "./paths.js";
import { isIsolatedLargeFilePacket } from "./packetFilter.js";

// Prompt rendering: large-file anchor extraction, packet graph context
// rendering, task section building, and full packet prompt assembly.

function renderAnchorPreview(
  summary: FileAnchorSummary,
  anchorPath: string,
): string[] {
  const preview = summary.anchors.slice(0, 24).map((anchor) => {
    // A symbol anchor carries an approximate body span (increment 2d) → render
    // it as a targeted read range `path:START-END` so the worker reads just the
    // symbol slice instead of the whole god-file. Anchors without a span (or
    // without a line) fall back to the single-line / path-only form.
    const location =
      anchor.line && anchor.end_line && anchor.end_line > anchor.line
        ? `${summary.path}:${anchor.line}-${anchor.end_line}`
        : anchor.line
          ? `${summary.path}:${anchor.line}`
          : summary.path;
    const detail = anchor.detail ? ` - ${anchor.detail}` : "";
    return `- ${location} [${anchor.kind}] ${anchor.name}${detail}`;
  });
  return [
    "## Large File Review Mode",
    "This packet is intentionally isolated because it covers one large file.",
    "Use targeted reads/searches within this file, guided by the mechanical anchors.",
    "Symbol anchors carry an approximate line span (path:START-END): read that slice for the",
    "symbol relevant to your lens rather than the whole file, and expand the range only when",
    "evidence for a finding crosses the span. The spans are a mechanical starting point, not a",
    "hard boundary — never miss a real defect to stay inside a slice.",
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

/**
 * Encapsulates large-file anchor extraction for a single packet.
 * Appends to the provided warnings array on unavailability or failure.
 */
export async function extractPacketAnchor(params: {
  packet: ReviewPacket;
  reviewRoot: string | undefined;
  bundle: ArtifactBundle;
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
 * Renders the specific external-analyzer leads (rule/line/summary) for a
 * task's files — not just the generic `external_analyzer_signal` tag. Reuses
 * the same grounded extraction isolated-large-file anchoring already uses
 * (`analyzerSignalAnchorsForPath`), so a knip/eslint/etc. lead now reaches the
 * worker with enough detail to confirm-or-refute against the packet graph
 * context, in ANY packet — not only isolated-large-file packets.
 */
/**
 * A knip lead's anchor `name` is its `rule`, which for knip is always
 * `knip-<issueType>` (see the knip candidate's `parse`). Only knip leads get the
 * render-time graph cross-check tag — other analyzers (eslint/semgrep/…) are not
 * "unused export" claims the dependency graph can adjudicate.
 */
function isKnipLead(anchorName: string): boolean {
  return anchorName.startsWith("knip-");
}

// Per-task analyzer-signal line cap, mirroring the isolated-large-file anchor
// preview's `.slice(0, 24)` — a task with hundreds of leads would otherwise
// bloat the packet prompt; the omitted count points the worker at packet.json.
const MAX_ANALYZER_SIGNAL_LINES = 24;

function renderTaskAnalyzerSignals(
  task: AuditTask,
  analyzerSignalIndex: AnalyzerSignalAnchorIndex | undefined,
  knipGraphIndex?: KnipGraphIndex,
): string[] {
  if (!task.tags?.includes("external_analyzer_signal") || !analyzerSignalIndex?.size) {
    return [];
  }
  const signals = task.file_paths.flatMap((path) =>
    analyzerSignalAnchorsForPath(path, analyzerSignalIndex).map((signal) => ({ path, signal })),
  );
  if (signals.length === 0) {
    return [];
  }
  const shown = signals.slice(0, MAX_ANALYZER_SIGNAL_LINES);
  const omitted = signals.length - shown.length;
  return [
    "External analyzer signals for this task (leads — confirm or refute against real evidence, do not treat as a finding on their own):",
    ...shown.map(({ path, signal }) => {
      // Advisory-only knip↔graph cross-check tag: LIKELY-DEAD / HAS-IMPORTERS /
      // UNVERIFIED / ENTRYPOINT. Rendered inline; degrades to no tag when the
      // graph index is unavailable or the lead is not a knip lead.
      const tag =
        knipGraphIndex && isKnipLead(signal.name)
          ? ` {graph-crosscheck: ${classifyKnipLead(path, knipGraphIndex)}}`
          : "";
      return `- ${path}${signal.line ? `:${signal.line}` : ""} [${signal.name}]${tag} ${signal.detail ?? ""}`.trimEnd();
    }),
    ...(omitted > 0
      ? [`- …and ${omitted} more analyzer signal(s); see the full set in packet.json.`]
      : []),
  ];
}

/**
 * Extracts the per-task flatMap that builds task section lines.
 */
export function buildTaskSections(
  packetTasks: AuditTask[],
  lensDefs: Record<string, { description: string; do_not_report: string }>,
  lineIndex: Record<string, number>,
  analyzerSignalIndex?: AnalyzerSignalAnchorIndex,
  knipGraphIndex?: KnipGraphIndex,
): string[] {
  return packetTasks.flatMap((task) => {
    const lensDef = lensDefs[task.lens];
    const inputLines = task.inputs
      ? Object.entries(task.inputs)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `input.${key}: ${value}`)
      : [];
    const isLensVerification = task.tags?.includes("lens_verification") ?? false;
    const isSelectiveDeepening = task.tags?.includes("selective_deepening") ?? false;
    const coverageTemplate = task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts?.[path] ?? lineIndex[path] ?? 0,
    }));
    const analyzerSignalLines = renderTaskAnalyzerSignals(
      task,
      analyzerSignalIndex,
      knipGraphIndex,
    );
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
      ...(analyzerSignalLines.length > 0 ? ["", ...analyzerSignalLines] : []),
      ...(isLensVerification
        ? [
            "",
            "Lens verification mode: review the prior result summary in the rationale and use only targeted source checks.",
            "Do not redo every packet and do not write direct findings for this task.",
            "Return findings: [] plus verification metadata. Include followup_tasks only for bounded, specific re-review packets.",
          ]
        : []),
      ...(isSelectiveDeepening
        ? [
            "",
            `Deepening task: your AuditResult.task_id MUST be exactly '${task.task_id}' — copy it verbatim, do NOT use the packet_id.`,
            `Deepening task: set AuditResult.lens to '${task.lens}' and every finding.lens in your result to '${task.lens}'.`,
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
 * The worker writes its own AuditResult[] JSON array to `result_path` (the same
 * path the rolling-dispatch step prompt pre-approves and ingests). The two
 * prompts must agree on this — a worker-prompt-and-result-contract regression
 * test asserts this prompt instructs the write and never forbids it (the prior
 * "emit inline, do not write files" wording silently dropped every result). No
 * shell submit command.
 */
export function buildPacketPrompt(params: {
  packet: ReviewPacket;
  packetTasks: AuditTask[];
  fileList: string;
  largeFileSection: string[];
  taskSections: string[];
  resultPath: string;
  repoRoot?: string;
}): string {
  const { packet, fileList, largeFileSection, taskSections, resultPath, repoRoot } = params;
  const largeFileMode = isIsolatedLargeFilePacket(packet);
  // The user's free-form audit intent is interpreted into lens/priority signals
  // at planning time and is never threaded verbatim into a worker prompt
  // (INV-S04; guarded by no-verbatim-free-form-intent.test.mjs).
  return [
    // ── Fixed prefix: identical across every packet in a run, so it stays a
    //    cache-eligible prompt prefix. All per-packet volatile content (## Packet
    //    / ## Files / ## Tasks / ## Final response, and every resultPath/packet_id
    //    interpolation) lives in the BACK payload below and must never precede
    //    this block. (spec/audit-workflow-design.md §Prompt caching.)
    "You are a code auditor. Review this packet once, then emit exactly one result per listed task.",
    "Set the shell/tool workdir to the repository root (given below) when running backend commands.",
    "",
    "## Output",
    "Produce one JSON array containing exactly one AuditResult object for each listed task,",
    "and WRITE that array (and nothing else) to your result_path (listed in the ## Packet section below).",
    "Use your Write tool to write that one file. Do not edit source files, run shell commands,",
    "or write any other file. After writing, reply with the one-line confirmation below — do not",
    "paste the JSON array into your reply.",
    "Windows PowerShell: do not pipe an inline foreach statement directly into ConvertTo-Json.",
    "Assign the foreach output to a variable first, then pipe that variable to ConvertTo-Json.",
    "PowerShell also unwraps single-element arrays: @(@{...}) collapses to one object, so a",
    "one-result submission serializes as an object (not a 1-element array) and is rejected. Wrap it",
    "yourself: '[' + (ConvertTo-Json $obj -Depth 12) + ']', or build the array with Write-Output -NoEnumerate.",
    "",
    "Schema file (resolve relative to this prompt's directory): audit_result.schema.json",
    "  self-contained (all shapes inlined); finding.schema.json and audit_task.schema.json are also provided for reference.",
    "You MAY validate your JSON array against the schema before emitting. This is optional.",
    "",
    "Required AuditResult fields:",
    "  task_id       copy from the task metadata",
    "  unit_id       copy from the task metadata",
    "  pass_id       copy from the task metadata",
    "  lens          copy from the task metadata",
    "  file_coverage [{path, total_lines}] - copy the exact template from each task section below. You MUST include total_lines. Do not omit or zero it out, as this will cause fatal validation errors.",
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
    "  affected_files  [{path, line_start?, line_end?, symbol?, quoted_text}] - objects, not strings; min 1 entry",
    "  evidence     [\"path/to/file.ts:42 - description of what you see there\"] - min 1 entry",
    "",
    "Grounding (required): at least one affected_files entry per finding MUST include quoted_text —",
    "  a short verbatim span copied EXACTLY from that file at the cited lines. The tool re-reads it",
    "  and content-matches against disk; a finding whose quoted_text is not found on disk (or is",
    "  omitted entirely) is marked ungrounded and surfaced for review, not silently confirmed.",
    "  Quote real code that exists; never paraphrase. Matching is on content (whitespace-normalized),",
    "  so exact line numbers may safely drift. Add a quoted_text span to every affected_files entry",
    "  you can — a finding with no verbatim quote will not survive grounding.",
    "",
    "Constraints:",
    "1. line_end must not exceed the file's actual line count.",
    "2. affected_files entries are objects with a path key, not plain strings.",
    "3. Only reference files from the packet unless a finding genuinely crosses a boundary.",
    "4. findings: [] is correct when you find nothing genuine.",
    "5. Do not use TaskCreate, spawn background agents, or launch sub-agents. Write your results",
    "   directly to your result_path using your Write tool, then reply with the confirmation below.",
    "",
    // ── Volatile back payload: per-packet; must never precede the fixed prefix. ──
    repoRoot ? `Repository root: ${repoRoot}` : "Repository root: use the root from the step contract.",
    "",
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
    "",
    "## Final response",
    `After writing the JSON array to ${resultPath}, reply exactly: valid: ${packet.packet_id}, findings=<total finding count>`,
  ].join("\n");
}

export function buildLargeFileSection(
  largeFileMode: boolean,
  anchorSummary: FileAnchorSummary | null,
  anchorPath: string | null,
): string[] {
  if (anchorSummary && anchorPath) {
    return renderAnchorPreview(anchorSummary, anchorPath);
  }
  if (largeFileMode) {
    return [
      "## Large File Review Mode",
      "This packet is intentionally isolated because it covers one large file.",
      "Use targeted reads/searches within this file only.",
      "No mechanical anchor file was available, so rely on targeted symbol and keyword searches before reading broad ranges.",
      "",
    ];
  }
  return [];
}
