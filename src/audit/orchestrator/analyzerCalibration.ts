import { join } from "node:path";
import { readOptionalJsonFile } from "../../shared/io/json.js";
import { AnalyzerSelectionSchema } from "./analyzerSelection.js";
import { z } from "zod";
import { hashContent, stableStringify } from "audit-tools/shared";
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
  })).max(100),
  unresolved: z.array(explanation).max(100),
});

export function analyzerCalibrationRequest(bundle: ArtifactBundle, selection: unknown) {
  const incomplete = new Set(incompleteAnalyzerStatuses(bundle).map(row => row.tool));
  const parsedSelection = AnalyzerSelectionSchema.safeParse(selection);
  const selectedTools = parsedSelection.success
    ? new Set(parsedSelection.data.decisions.filter(row => row.action === "run").map(row => row.tool))
    : new Set<string>();
  const statuses = bundle.external_analyzer_acquisition?.tool_statuses.filter(row =>
    row.status !== "skipped" || selectedTools.has(row.tool)) ?? [];
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
  return { input_sha256, tools };
}

export type AnalyzerCalibrationRequest = ReturnType<typeof analyzerCalibrationRequest>;

export function currentAnalyzerCalibration(value: unknown, request: AnalyzerCalibrationRequest) {
  const answer = AnalyzerCalibrationSchema.safeParse(value);
  if (!answer.success || answer.data.input_sha256 !== request.input_sha256) return;
  const byId = new Map(answer.data.decisions.map(row => [row.tool, row]));
  if (byId.size !== answer.data.decisions.length || byId.size !== request.tools.length) return;
  if (!request.tools.every(tool => byId.has(tool.tool) &&
      (!tool.incomplete || byId.get(tool.tool)?.action !== "accept") &&
      (tool.status !== "skipped" || byId.get(tool.tool)?.action === "limited"))) return;
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
