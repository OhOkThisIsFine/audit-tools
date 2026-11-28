import { join, normalize } from "node:path";
import { readOptionalJsonFile } from "../../shared/io/json.js";
import { analyzerRuntimeOverrides, AnalyzerSelectionSchema, runtimeOverrideFields, validRuntimeOverride } from "./analyzerSelection.js";
import { z } from "zod";
import { hashContent, stableStringify, type ExistingAnalyzerRuntime } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { incompleteAnalyzerStatuses } from "./acquisitionExecutor.js";

const explanation = z.string().trim().min(1).max(2000);
export const AnalyzerCalibrationSchema = z.strictObject({
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  decisions: z.array(z.strictObject({
    tool: z.string().min(1),
    action: z.enum(["accept", "retry", "limited"]),
    reason: explanation,
    coverage: explanation,
    ...runtimeOverrideFields,
    change: z.strictObject({
      kind: z.enum(["environment", "configuration"]),
      detail: explanation,
    }).optional(),
    recovery: z.strictObject({
      disposition: z.enum(["exhausted", "permission_refused"]),
      detail: explanation,
    }).optional(),
  })).max(100),
  unresolved: z.array(explanation).max(100),
});

function retrySignature(runtime: ExistingAnalyzerRuntime | undefined, change: { kind: string; detail: string }) {
  const spelling = (path: string) => process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path);
  return hashContent(stableStringify([
    runtime ? [spelling(runtime.executable), runtime.localRules ? spelling(runtime.localRules) : null] : null,
    change.kind, change.detail.replace(/\s+/gu, " ").trim(),
  ]));
}

export function analyzerCalibrationRequest(bundle: ArtifactBundle, selection: unknown) {
  const incomplete = new Set(incompleteAnalyzerStatuses(bundle).map(row => row.tool));
  const parsedSelection = AnalyzerSelectionSchema.safeParse(selection);
  const selectedTools = parsedSelection.success
    ? new Set(parsedSelection.data.decisions.filter(row => row.action === "run").map(row => row.tool))
    : new Set<string>();
  const statuses = bundle.external_analyzer_acquisition?.tool_statuses.filter(row =>
    row.status !== "skipped" || selectedTools.has(row.tool)) ?? [];
  const runtimes = new Map(Object.entries(analyzerRuntimeOverrides(parsedSelection.success ? parsedSelection.data.decisions : [])));
  const previousRetries = new Map<string, Set<string>>();
  for (const retry of bundle.external_analyzer_acquisition?.calibration_retries ?? []) {
    for (const row of retry.tools) {
      const override = analyzerRuntimeOverrides([row])[row.tool];
      if (override) runtimes.set(row.tool, override);
      if (row.change) {
        const signatures = previousRetries.get(row.tool) ?? new Set<string>();
        signatures.add(retrySignature(runtimes.get(row.tool), row.change));
        previousRetries.set(row.tool, signatures);
      }
    }
  }
  const admitted = new Set(bundle.file_disposition?.files.filter(file => file.status === "included").map(file => file.path));
  const tools = statuses.map(row => {
    const admittedSkipped = row.reported_coverage?.skipped.filter(path => admitted.has(path)) ?? [];
    return { ...row, admittedSkipped, incomplete: row.status === "skipped" || incomplete.has(row.tool) || admittedSkipped.length > 0,
      findings: bundle.external_analyzer_results?.find(entry => entry.tool === row.tool)?.results.length ?? 0 };
  });
  const input_sha256 = hashContent(stableStringify({
    manifest: bundle.repo_manifest?.files, disposition: bundle.file_disposition?.files,
    acquisition: bundle.external_analyzer_acquisition, results: bundle.external_analyzer_results, selection,
  }));
  return { input_sha256, tools, runtimes, previousRetries };
}

export type AnalyzerCalibrationRequest = ReturnType<typeof analyzerCalibrationRequest>;

export function currentAnalyzerCalibration(value: unknown, request: AnalyzerCalibrationRequest) {
  const answer = AnalyzerCalibrationSchema.safeParse(value);
  if (!answer.success || answer.data.input_sha256 !== request.input_sha256) return;
  const byId = new Map(answer.data.decisions.map(row => [row.tool, row]));
  if (byId.size !== answer.data.decisions.length || byId.size !== request.tools.length) return;
  if (!request.tools.every(tool => {
    const row = byId.get(tool.tool);
    if (!row || !validRuntimeOverride(row, row.action === "retry") ||
        (row.action === "retry" && !row.change)) return false;
    if (row.action === "retry" && row.change) {
      const runtime = analyzerRuntimeOverrides([row])[row.tool] ?? request.runtimes.get(row.tool);
      if (request.previousRetries.get(row.tool)?.has(retrySignature(runtime, row.change))) return false;
    }
    if (tool.status === "skipped") return row.action === "limited";
    if (tool.incomplete && row.action === "accept") return false;
    return !(tool.incomplete && row.action === "limited") || Boolean(row.recovery);
  })) return;
  return answer.data;
}

/** Report only operator dispositions bound to the evidence still in use. */
export async function readAnalyzerCoverageGaps(artifactsDir: string, bundle: ArtifactBundle): Promise<string[]> {
  const raw = await readOptionalJsonFile<unknown>(join(artifactsDir, "analyzer-calibration.json"));
  if (!raw) return [];
  const selection = await readOptionalJsonFile<unknown>(join(artifactsDir, "analyzer-selection.json"));
  const receipt = currentAnalyzerCalibration(raw, analyzerCalibrationRequest(bundle, selection));
  if (!receipt || receipt.decisions.some(row => row.action === "retry")) return [];
  const acceptedSelection = AnalyzerSelectionSchema.safeParse(selection);
  const notes = [
    ...receipt.unresolved,
    ...receipt.decisions.flatMap(row => row.action === "limited" ? [row.tool + ": " + row.coverage] : []),
    ...(acceptedSelection.success ? acceptedSelection.data.gaps : []),
  ];
  return [...new Set(notes.map(note => note.replace(/\s+/gu, " ").trim()))];
}
